import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import {
  getBoothSession, insertBoothSession, listBoothShots,
} from '../repo.js';
import { randomName, readMagic, sniffType } from '../lib/media.js';
import { createLimiter } from '../lib/ratelimit.js';
import { byIp } from '../lib/device.js';
import { wrap } from '../lib/async-route.js';

export const boothRouter = express.Router();

/**
 * ปลายทางของ QR ที่พิมพ์อยู่บนกระดาษจากบูธ
 *
 * บูธทำงานแบบไม่ต่อเน็ต (เต็นท์ในงาน ไม่มี WiFi) รอบถ่ายจึงถูกส่งขึ้นมาทีหลัง
 * ตอนกลับถึงบ้าน · โทเคนถูกจองไว้ตั้งแต่ตอนพิมพ์แล้ว ลิงก์บนกระดาษจึงถูกต้อง
 * มาตั้งแต่แรกแม้ตอนนั้นยังไม่มีอะไรอยู่ปลายทาง
 *
 * **แขกที่มาสแกนก่อนเราอัปโหลดต้องเจอคำอธิบาย ไม่ใช่หน้า 404 เปล่า ๆ** —
 * เขาไม่ได้พิมพ์ผิด และเขาจะกลับมาใหม่ก็ต่อเมื่อรู้ว่าต้องกลับมา
 */

// โทเคนจากบูธ: Crockford base32 6 ตัว (ตัด I L O U ออก) — ต้องตรงกับ
// photobooth/src/main/session.js · ตัวนี้ถูกเอาไปต่อเป็นชื่อไฟล์และคิวรี จึงกรองก่อนเสมอ
const TOKEN = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{6}$/;
const isToken = (value) => typeof value === 'string' && TOKEN.test(value);

const MB = 1024 * 1024;
const MAX_SHOTS = 8;

const uploadLimiter = createLimiter({
  name: 'booth-upload',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  key: byIp,
});

const bundle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.tmp),
    filename: (req, file, cb) => cb(null, randomName('part')),
  }),
  // แผ่นหนึ่งใบราว 0.5 MB รูปดิบใบละไม่กี่ MB · 25 MB ต่อไฟล์เหลือเฟือ
  limits: { fileSize: 25 * MB, files: MAX_SHOTS + 1, fields: 10 },
});

/**
 * กุญแจต้องตรงแบบเทียบเวลาคงที่ และต้องมีกุญแจตั้งไว้จริงถึงจะเปิดรับ
 *
 * ค่าว่างไม่ใช่ "กุญแจว่าง" แต่คือ **ปิดทั้งเส้นทาง** — เว็บที่เปิดอยู่บนเน็ต
 * ไม่ควรมีปากทางให้ใครก็ได้ยัดไฟล์เข้ามาเพียงเพราะเจ้าของยังไม่ได้ตั้งค่า
 */
function keyMatches(given) {
  if (!config.boothKey) return false;
  const expected = Buffer.from(config.boothKey);
  const candidate = Buffer.from(String(given ?? ''));
  if (expected.length !== candidate.length) return false;
  return crypto.timingSafeEqual(expected, candidate);
}

const discard = (files) =>
  Promise.all((files ?? []).map((file) => fs.rm(file.path, { force: true })));

/** ไฟล์ที่ส่งมาต้องเป็นรูปจริง ตัดสินจากไบต์ต้นไฟล์ เหมือนเส้นทางของแขก */
async function acceptImage(file) {
  const sniffed = sniffType(await readMagic(file.path));
  return sniffed?.kind === 'image' ? sniffed : null;
}

boothRouter.post('/api/booth/upload', uploadLimiter, (req, res) => {
  // multer ทิ้ง Promise ที่ callback คืนมา — rejection จึงหลุดเป็น unhandled
  // แล้ว Node 22 ฆ่าทั้งโปรเซส (เหตุผลเดียวกับ /api/upload)
  bundle.fields([{ name: 'sheet', maxCount: 1 }, { name: 'shots', maxCount: MAX_SHOTS }])(
    req,
    res,
    (uploadError) => {
      void receive(req, res, uploadError).catch(async (error) => {
        console.error('[booth] รับรอบถ่ายไม่สำเร็จ:', error);
        await discard(Object.values(req.files ?? {}).flat());
        if (!res.headersSent) res.status(500).json({ error: 'server_error' });
      });
    },
  );
});

async function receive(req, res, uploadError) {
  const sheet = req.files?.sheet?.[0] ?? null;
  const shots = req.files?.shots ?? [];
  const everything = [sheet, ...shots].filter(Boolean);

  if (!keyMatches(req.get('x-booth-key'))) {
    await discard(everything);
    return res.status(401).json({ error: 'bad_key' });
  }
  if (uploadError) {
    await discard(everything);
    const tooBig = uploadError.code === 'LIMIT_FILE_SIZE';
    return res.status(tooBig ? 413 : 400).json({ error: tooBig ? 'too_large' : 'bad_request' });
  }

  let manifest;
  try {
    manifest = JSON.parse(String(req.body?.manifest ?? ''));
  } catch {
    await discard(everything);
    return res.status(400).json({ error: 'bad_manifest' });
  }

  const token = manifest?.token;
  if (!isToken(token) || !sheet) {
    await discard(everything);
    return res.status(400).json({ error: 'bad_manifest' });
  }

  /*
   * ส่งซ้ำโทเคนเดิมไม่ใช่ความผิดพลาด — เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกเสร็จแต่ก่อน
   * ตอบกลับ ทำให้บูธคิดว่ายังไม่สำเร็จแล้วส่งใหม่ · ตอบว่าเรียบร้อยไปเลย
   * ไม่งั้นตัวอัปโหลดจะติดวนพยายามส่งรอบเดิมไปเรื่อย ๆ ไม่มีวันจบ
   */
  if (getBoothSession(token)) {
    await discard(everything);
    return res.status(200).json({ ok: true, token, duplicate: true });
  }

  const accepted = [];
  for (const file of everything) {
    const sniffed = await acceptImage(file);
    if (!sniffed) {
      await discard(everything);
      return res.status(415).json({ error: 'not_an_image' });
    }
    accepted.push({ file, sniffed });
  }

  await fs.mkdir(config.paths.booth, { recursive: true });
  const written = [];

  try {
    const place = async (entry, label) => {
      const name = `${token}-${label}.${entry.sniffed.ext}`;
      const target = path.join(config.paths.booth, name);
      await fs.rename(entry.file.path, target).catch(async (error) => {
        // tmp กับ booth อยู่คนละ mount ได้ — คัดลอกแล้วลบต้นทางแทน
        if (error.code !== 'EXDEV') throw error;
        await fs.copyFile(entry.file.path, target);
        await fs.rm(entry.file.path, { force: true });
      });
      written.push(target);
      return { name, bytes: entry.file.size };
    };

    const [sheetEntry, ...shotEntries] = accepted;
    const savedSheet = await place(sheetEntry, 'sheet');
    const savedShots = [];
    for (const [index, entry] of shotEntries.entries()) {
      savedShots.push(await place(entry, `shot-${index + 1}`));
    }

    insertBoothSession({
      token,
      takenAt: String(manifest.createdAt ?? new Date().toISOString()).slice(0, 40),
      eventTitle: String(manifest.event?.title ?? '').slice(0, 120) || null,
      template: String(manifest.template ?? '').slice(0, 40) || null,
      effect: String(manifest.effect ?? '').slice(0, 40) || null,
      sheetName: savedSheet.name,
      bytes: savedSheet.bytes,
    }, savedShots.map((shot) => ({ storedName: shot.name, bytes: shot.bytes })));

    return res.status(201).json({ ok: true, token, shots: savedShots.length });
  } catch (error) {
    // ไฟล์ที่วางไปแล้วต้องเก็บกวาด ไม่ปล่อยเป็นขยะที่ไม่มีแถวไหนอ้างถึง
    await Promise.all(written.map((file) => fs.rm(file, { force: true })));
    await discard(everything);
    throw error;
  }
}

function sendBoothFile(res, name) {
  return new Promise((resolve, reject) => {
    res.sendFile(name, {
      root: config.paths.booth,
      dotfiles: 'deny',
      maxAge: '365d',
      immutable: true,
    }, (error) => (error ? reject(error) : resolve()));
  });
}

boothRouter.get('/p/:token', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  if (!isToken(token)) return next();

  const session = getBoothSession(token);
  return res.status(session ? 200 : 404).render('booth-photos', {
    page: 'booth',
    pageTitle: req.t('booth.title'),
    token,
    session,
    shots: session ? listBoothShots(token) : [],
  });
}));

boothRouter.get('/p/:token/sheet', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  const session = isToken(token) ? getBoothSession(token) : null;
  if (!session) return next();
  return sendBoothFile(res, session.sheet_name);
}));

boothRouter.get('/p/:token/shot/:n', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  if (!isToken(token)) return next();

  // ลำดับรูป ไม่ใช่ชื่อไฟล์ — ชื่อไฟล์จริงมาจากฐานข้อมูลเสมอ ไม่มีทางมาจาก URL
  const shots = listBoothShots(token);
  const shot = shots[Number(req.params.n) - 1];
  if (!shot) return next();
  return sendBoothFile(res, shot.stored_name);
}));
