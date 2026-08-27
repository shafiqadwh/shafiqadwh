import path from 'node:path';
import express from 'express';
import { config, withinUploadWindow } from '../config.js';
import { getFlag, getSetting } from '../db.js';
import { countItems, getItem, listGuests, listItems, newerCount } from '../repo.js';
import { normaliseName } from '../lib/guests.js';
import { ensureDisplayCopy, safeOriginalName } from '../lib/media.js';
import { trackDetails } from '../lib/music.js';
import { wrap } from '../lib/async-route.js';

export const galleryRouter = express.Router();

/** What the browser needs to know about one item, and nothing more. */
export function toPublicItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    width: row.width,
    height: row.height,
    duration: row.duration,
    uploader: row.uploader,
    createdAt: row.created_at,
    thumbUrl: row.thumb_name ? `/thumb/${row.id}` : null,
    mediaUrl: `/media/${row.id}`,
    // รูปย่อขนาดพอดีจอ ใช้กับสไลด์โชว์ วิดีโอไม่มี ให้ใช้ mediaUrl ตามเดิม
    displayUrl: row.kind === 'image' ? `/display/${row.id}` : `/media/${row.id}`,
    downloadUrl: `/download/${row.id}`,
    converting: row.kind === 'video' && ['queued', 'running'].includes(row.convert_state),
  };
}

export function uploadsOpen() {
  return getFlag('uploads_enabled', true) && withinUploadWindow();
}

galleryRouter.get('/', wrap(async (req, res) => {
  // ?who= คือคีย์ที่ normalise แล้ว ไม่ใช่ชื่อดิบ — ชื่อที่ต่างกันแค่ช่องว่างหรือ
  // ตัวพิมพ์จึงเปิดลิงก์เดียวกันได้ และลิงก์ที่ส่งต่อกันไม่พังเพราะพิมพ์ต่างกันนิดเดียว
  const who = typeof req.query.who === 'string' ? normaliseName(req.query.who) : null;
  const guest = who === null ? null : listGuests().find((one) => one.key === who);

  // ไม่เรียก galleryMusic() ตรงนี้แล้ว — ปุ่มเพลงถูกถอดออกจากหน้าแขกไปก่อน
  // (ดู views/gallery.ejs) การหาความยาวเพลงคือ stat ไฟล์ + อ่าน sidecar ทุกครั้ง
  // ที่มีคนเปิดหน้าแรก ซึ่งเป็นหน้าที่แขกพันคนเปิดกันทั้งงาน — เสียเปล่าล้วน ๆ
  // เพราะไม่มีอะไรในหน้าเอาค่านี้ไปใช้ · เส้นทาง /music/track ยังทำงานเหมือนเดิม
  res.render('gallery', {
    page: 'gallery',
    uploadsOpen: uploadsOpen(),
    total: countItems({ who }),
    who,
    guestName: guest && (guest.anonymous ? req.t('gallery.anonymous') : guest.name),
  });
}));

galleryRouter.get('/api/items', (req, res) => {
  const filter = ['all', 'photos', 'videos'].includes(req.query.filter) ? req.query.filter : 'all';
  const limit = Number(req.query.limit) || 60;
  const who = typeof req.query.who === 'string' ? normaliseName(req.query.who) : null;
  const rows = listItems({ filter, limit, beforeId: req.query.before ?? null, who });

  res.json({
    items: rows.map(toPublicItem),
    total: countItems({ filter, who }),
    nextBefore: rows.length === Math.min(limit, 200) ? rows.at(-1).id : null,
  });
});

galleryRouter.get('/api/updates', (req, res) => {
  res.json({ newer: newerCount(req.query.since ?? 0), uploadsOpen: uploadsOpen() });
});

/**
 * ไฟล์นี้ให้คนนอกดึงได้ไหม
 *
 * เดิมกันแค่ของที่ถูก "ซ่อน" ทำให้ของที่ยัง "รอตรวจ" ถูกดึงได้จากภายนอก
 * ทั้งที่เจ้าภาพยังไม่อนุมัติ และอาจกำลังจะปฏิเสธมันอยู่ — เลข id เรียงกัน
 * เดาต่อไปทีละหมายเลขได้ไม่ยาก ทดสอบแล้วได้ HTTP 200 จริงทั้ง /media /thumb
 * และ /download ทั้งที่ไม่ได้ล็อกอิน
 *
 * เจ้าภาพยังต้องเห็นของที่รอตรวจในหน้าแอดมิน จึงอนุญาตเฉพาะคนที่ล็อกอินแล้ว
 */
function mayServe(row, res) {
  if (!row) return false;
  // เช็คถังขยะก่อนเช็ค status เสมอ — แถวที่ถูกลบยัง status = 'visible' ค้างอยู่
  // (การลบไม่แตะ status เลย เป็นคนละมิติกัน) ถ้าเช็ค status ก่อนจะหลุดให้แขก
  // ดึงรูปที่ "ลบ" ไปแล้วได้ตรง ๆ — อนุญาตเฉพาะแอดมิน ให้หน้าถังขยะแสดงรูปย่อได้
  if (row.deleted_at) return res.locals.isAdmin === true;
  if (row.status === 'visible') return true;
  return res.locals.isAdmin === true;
}

function sendMedia(res, root, filename, { download = false, downloadName = null } = {}) {
  return new Promise((resolve, reject) => {
    res.sendFile(
      filename,
      {
        root,
        dotfiles: 'deny',
        maxAge: '365d',
        immutable: true,
        headers: download
          ? { 'Content-Disposition': `attachment; filename="${downloadName}"` }
          : undefined,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * เพลงคลอของหน้าแกลลอรี่ — เพลงเดียวที่เจ้าภาพเลือกไว้ ไม่ใช่คลังทั้งกอง
 *
 * ชื่อไฟล์ไม่ได้มาจาก URL เลย มาจากค่าที่เจ้าภาพบันทึกไว้แล้วผ่าน `trackPath()`
 * อีกชั้น — เส้นทางนี้จึงไม่มีพื้นที่ให้เดินออกนอกคลังตั้งแต่แรก
 */
export async function galleryMusic() {
  const id = getSetting('gallery_music', '');
  if (!id) return null;
  return trackDetails(id);
}

galleryRouter.get('/music/track', wrap(async (req, res, next) => {
  const track = await galleryMusic();
  if (!track) return next();

  try {
    // sendFile จัดการ Range ให้เอง มือถือจึงข้ามไปกลางเพลงได้โดยไม่ต้องโหลดใหม่ทั้งไฟล์
    await sendMedia(res, path.dirname(track.path), path.basename(track.path));
  } catch (error) {
    next(error);
  }
}));

galleryRouter.get('/thumb/:id', wrap(async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!mayServe(row, res) || !row.thumb_name) return next();
  try {
    await sendMedia(res, config.paths.derived, row.thumb_name);
  } catch (error) {
    next(error);
  }
}));

/**
 * รูปขนาดพอดีจอสำหรับสไลด์โชว์ — ไม่ใช่ต้นฉบับ 12 ล้านพิกเซล
 *
 * กล่อง Google TV ถอดรหัสรูปเต็มทุกสไลด์ไม่ไหว จอจะกระตุกและบางครั้งขึ้นดำ
 * ถ้าย่อไม่สำเร็จด้วยเหตุใดก็ตาม ตกกลับไปใช้ /media เพื่อให้ยังมีภาพขึ้นจอ
 */
galleryRouter.get('/display/:id', wrap(async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!mayServe(row, res)) return next();
  if (row.kind !== 'image') return res.redirect(302, `/media/${row.id}`);

  try {
    const displayName = await ensureDisplayCopy(row);
    await sendMedia(res, config.paths.derived, displayName);
  } catch (error) {
    console.error(`[display] could not build a display copy for item ${row.id}:`, error.message);
    if (!res.headersSent) res.redirect(302, `/media/${row.id}`);
  }
}));

galleryRouter.get('/media/:id', wrap(async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!mayServe(row, res)) return next();

  // Prefer the web-friendly copy (converted HEIC or H.264 video) when we made one.
  const usePlayback = Boolean(row.playback_name);
  const root = usePlayback ? config.paths.derived : config.paths.uploads;
  const filename = usePlayback ? row.playback_name : row.stored_name;

  try {
    await sendMedia(res, root, filename);
  } catch (error) {
    next(error);
  }
}));

galleryRouter.get('/download/:id', wrap(async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!mayServe(row, res)) return next();

  const ext = path.extname(row.stored_name);
  const base = path.parse(safeOriginalName(row.original_name)).name || `item-${row.id}`;
  try {
    await sendMedia(res, config.paths.uploads, row.stored_name, {
      download: true,
      downloadName: `${base}-${row.id}${ext}`,
    });
  } catch (error) {
    next(error);
  }
}));
