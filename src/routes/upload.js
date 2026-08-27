import fs, { open } from 'node:fs/promises';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { getFlag } from '../db.js';
import { insertItem, stats } from '../repo.js';
import { processImage, processVideo, randomName, safeOriginalName, sniffType } from '../lib/media.js';
import { enqueueConversion } from '../lib/queue.js';
import { createLimiter } from '../lib/ratelimit.js';
import { byDevice, byIp } from '../lib/device.js';
import { uploadsOpen } from './gallery.js';

export const uploadRouter = express.Router();

const MB = 1024 * 1024;

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.paths.tmp),
  filename: (req, file, cb) => cb(null, randomName('part')),
});

const upload = multer({
  storage,
  limits: {
    fileSize: Math.max(config.limits.imageMb, config.limits.videoMb) * MB,
    files: config.limits.filesPerRequest,
    fields: 10,
  },
});

// สองชั้น: ชั้นแรกคุมเครื่องของแขกทีละคน ชั้นที่สองเป็นเพดานรวมกันการยิงถล่ม
// เดิมมีแต่ชั้นไอพี ซึ่งพังในงานจริงเพราะแขกทั้งงานใช้ไอพีเดียวกัน
const uploadLimiter = createLimiter({
  name: 'upload-device',
  limit: config.limits.uploadsPerHourPerDevice,
  windowMs: 60 * 60 * 1000,
  key: byDevice,
});

const uploadCeiling = createLimiter({
  name: 'upload-ip',
  limit: config.limits.uploadsPerHourPerIp,
  windowMs: 60 * 60 * 1000,
  key: byIp,
});

async function readMagic(filePath) {
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, 32, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function storageExceeded() {
  if (config.limits.totalStorageGb <= 0) return false;
  return stats().bytes >= config.limits.totalStorageGb * 1024 * MB;
}

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ');
  return name ? name.slice(0, 60) : null;
}

/**
 * Validate and ingest one temporary file. Returns either the created row or a
 * message already translated into the guest's language.
 */
export async function ingestFile(file, { uploader, t, status }) {
  const displayName = safeOriginalName(file.originalname);
  const sniffed = sniffType(await readMagic(file.path));

  if (!sniffed) {
    await fs.rm(file.path, { force: true });
    return { error: t('errors.unsupported_type', { name: displayName }) };
  }

  if (sniffed.kind === 'image' && file.size > config.limits.imageMb * MB) {
    await fs.rm(file.path, { force: true });
    return { error: t('errors.image_too_large', { name: displayName, max: config.limits.imageMb }) };
  }

  if (sniffed.kind === 'video' && file.size > config.limits.videoMb * MB) {
    await fs.rm(file.path, { force: true });
    return { error: t('errors.video_too_large', { name: displayName, max: config.limits.videoMb }) };
  }

  try {
    const processed =
      sniffed.kind === 'image'
        ? await processImage(file.path, sniffed)
        : await processVideo(file.path, sniffed);

    const row = insertItem({ ...processed, originalName: displayName, uploader, status });

    if (processed.convertState === 'queued') {
      enqueueConversion(row.id, row.stored_name);
    }
    return { row };
  } catch (error) {
    await fs.rm(file.path, { force: true });
    if (error.code === 'VIDEO_TOO_LONG') {
      return {
        error: t('errors.video_too_long', { name: displayName, max: config.limits.videoSeconds }),
      };
    }
    // Log the code as well as the message: the guest only ever sees a generic
    // apology, so this line is the whole diagnosis when something goes wrong
    // on the night.
    console.error(
      `[upload] failed to process "${displayName}" (${sniffed.kind}/${sniffed.ext}):`,
      error.code ?? '',
      error.message,
    );
    return { error: t('errors.server_error') };
  }
}

uploadRouter.post('/api/upload', uploadCeiling, uploadLimiter, (req, res) => {
  if (!uploadsOpen()) {
    return res.status(403).json({ error: req.t('errors.upload_closed') });
  }
  if (storageExceeded()) {
    return res.status(507).json({ error: req.t('errors.storage_full') });
  }

  // multer เรียก callback นี้แล้ว **ทิ้ง Promise ที่ได้กลับมา** — ถ้าปล่อยให้เป็น
  // async แล้วมันโยน error ออกมา จะกลายเป็น unhandled rejection ซึ่ง Node 22
  // ฆ่าทั้งโปรเซส (ทดสอบแล้ว) เว็บดับทั้งงานเพราะแขกคนเดียวอัพไฟล์ที่มีปัญหา
  //
  // ingestFile() ดักไว้เกือบหมดแล้ว แต่ readMagic() กับ fs.rm() สามตัวแรกอยู่
  // นอก try ของมัน — ดิสก์เต็มหรือสิทธิ์ไฟล์เพี้ยนเมื่อไรก็หลุดออกมาได้จริง
  upload.array('files', config.limits.filesPerRequest)(req, res, (uploadError) => {
    void ingestBatch(req, res, uploadError).catch((error) => {
      console.error('[upload] ชุดอัพโหลดล้มทั้งชุด:', error);
      if (!res.headersSent) res.status(500).json({ error: req.t('errors.server_error') });
    });
  });
});

async function ingestBatch(req, res, uploadError) {
  {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: req.t(tooLarge ? 'errors.too_large_request' : 'errors.server_error'),
      });
    }

    const files = req.files ?? [];
    if (files.length === 0) {
      return res.status(400).json({ error: req.t('errors.no_files') });
    }

    const uploader = cleanName(req.body?.uploader);
    const status = getFlag('require_review', false) ? 'pending' : 'visible';
    const created = [];
    const errors = [];

    for (const file of files) {
      const result = await ingestFile(file, { uploader, t: req.t, status });
      if (result.error) errors.push(result.error);
      else created.push(result.row.id);
    }

    res.status(created.length > 0 ? 201 : 400).json({
      created: created.length,
      ids: created,
      pending: status === 'pending',
      errors,
    });
  }
}

/** Shared with the guest book, which accepts a single optional attachment. */
export const singleAttachment = upload.single('attachment');
