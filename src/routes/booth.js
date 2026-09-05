import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { config } from '../config.js';
import {
  countAlbumSessions, countExpiredAlbumSessions, getBoothSession, insertBoothSession,
  listAlbumSessions, listAlbumShots, listAllAlbumSessions, listBoothShots,
} from '../repo.js';
import { boothKeepsUntil, sweepExpiredBooth } from '../lib/booth-retention.js';
import { streamBoothAlbum, streamBoothSession } from '../lib/booth-zip.js';
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

/*
 * รหัสอัลบั้ม — ยาว 8 ตัวจากอักษรชุดเดียวกัน
 *
 * ยาวกว่าโทเคนรอบถ่ายโดยตั้งใจ เพราะมันเปิดรูป **ทั้งงาน** ไม่ใช่รอบเดียว
 * 8 ตัว = 1.1 ล้านล้านแบบ · เดาสุ่มด้วยตัวจำกัดอัตราข้างล่างนี้ใช้เวลาเป็นล้านปี
 */
const ALBUM = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const isAlbum = (value) => typeof value === 'string' && ALBUM.test(value);

const MB = 1024 * 1024;
const MAX_SHOTS = 8;

const uploadLimiter = createLimiter({
  name: 'booth-upload',
  limit: 600,
  windowMs: 60 * 60 * 1000,
  key: byIp,
});

/*
 * กันเดารหัสอัลบั้ม
 *
 * ลิงก์อัลบั้มคือกุญแจดอกเดียวที่เปิดรูปทั้งงาน · 8 ตัวเดาไม่ไหวอยู่แล้วในทางทฤษฎี
 * แต่การปล่อยให้ยิงได้ไม่จำกัดก็ไม่มีเหตุผลอะไรรองรับ · 300 ครั้ง/ชม./ไอพี
 * เผื่อทั้งงานที่แขกหลายสิบคนอยู่หลัง NAT เดียวกันสแกนพร้อมกันแล้วยังเหลือ
 */
const albumLimiter = createLimiter({
  name: 'booth-album',
  limit: 300,
  windowMs: 60 * 60 * 1000,
  key: byIp,
});

const PER_PAGE = 60;

// กว้างพอสำหรับการ์ดในกริดบนจอมือถือความละเอียดสูง (การ์ดจริงกว้างราว 140 px)
const THUMB_WIDTH = 320;

/**
 * งานบ้านต้องไม่พังหน้าที่แขกเปิด
 *
 * ตัวกวาดรูปหมดอายุถูกเรียกก่อนเรนเดอร์ทุกหน้าที่ QR ชี้มา · ดิสก์เต็มหรือไฟล์ถูก
 * ล็อกอยู่แล้วมันโยน error ออกมา แขกจะได้หน้า 500 แทนรูปของตัวเอง ทั้งที่รูปยังอยู่ดี
 */
const sweep = () => sweepExpiredBooth()
  .catch((error) => console.error('[booth] กวาดรูปหมดอายุไม่สำเร็จ:', error));

const bundle = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.tmp),
    filename: (req, file, cb) => cb(null, randomName('part')),
  }),
  // แผ่นหนึ่งใบราว 0.5 MB รูปดิบใบละไม่กี่ MB · 25 MB ต่อไฟล์เหลือเฟือ
  limits: { fileSize: 25 * MB, files: MAX_SHOTS + 2, fields: 10 },
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

/**
 * ตรวจ GIF แยกจากตัวตรวจกลาง
 *
 * `sniffType` ที่ใช้ร่วมกับเส้นทางอัปโหลดของแขกไม่รู้จัก GIF และ **ไม่ควรไปสอน
 * ให้รู้จัก** เพราะจะเปิดทางให้ไฟล์ GIF ไหลเข้าแกลลอรี่/สไลด์โชว์/คิวแปลงวิดีโอ
 * ซึ่งไม่มีใครออกแบบไว้รองรับ · ของบูธเป็นเส้นทางแยกอยู่แล้ว ตรวจเองตรงนี้จบ
 */
const isGif = (magic) => magic.subarray(0, 6).toString('ascii') === 'GIF89a'
  || magic.subarray(0, 6).toString('ascii') === 'GIF87a';

/** ไฟล์ที่ส่งมาต้องเป็นรูปจริง ตัดสินจากไบต์ต้นไฟล์ เหมือนเส้นทางของแขก */
async function acceptImage(file) {
  const sniffed = sniffType(await readMagic(file.path));
  return sniffed?.kind === 'image' ? sniffed : null;
}

boothRouter.post('/api/booth/upload', uploadLimiter, (req, res) => {
  // multer ทิ้ง Promise ที่ callback คืนมา — rejection จึงหลุดเป็น unhandled
  // แล้ว Node 22 ฆ่าทั้งโปรเซส (เหตุผลเดียวกับ /api/upload)
  bundle.fields([
    { name: 'sheet', maxCount: 1 },
    { name: 'shots', maxCount: MAX_SHOTS },
    { name: 'gif', maxCount: 1 },
  ])(
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
  const gif = req.files?.gif?.[0] ?? null;
  const everything = [sheet, ...shots, gif].filter(Boolean);

  /*
   * กุญแจของบูธคือด่านเดียวของเส้นทางนี้ — **ไม่ผ่าน `uploadsOpen()` โดยตั้งใจ**
   *
   * เส้นทางของแขก (รูป คำอวยพร) ปิดตามสวิตช์ ตามช่วงเวลา และตามการเก็บงานเข้า
   * ลิ้นชัก · เส้นทางนี้ไม่ปิดตามอะไรเลยนอกจากกุญแจ เพราะรอบถ่ายถูกพิมพ์ลงกระดาษ
   * ไปแล้วตั้งแต่คืนงาน แต่ไฟล์ยังค้างอยู่ในเครื่องบูธจนกว่าเจ้าของจะกดส่ง ซึ่งมัก
   * เป็นวันถัดไปหลังกลับถึงบ้าน — ปิดทางนี้ตามไปด้วยเมื่อไร **QR ทุกใบที่แขกถือ
   * กลับบ้านไปกลายเป็นลิงก์ตายถาวร** และแก้ทีหลังไม่ได้เพราะกระดาษอยู่ในมือคนอื่นแล้ว
   *
   * ที่ทำแบบนี้ได้เพราะกุญแจอยู่กับเจ้าของบูธ ไม่ใช่กับแขก — ทางนี้จึงไม่ใช่ทางที่
   * ใครก็ยัดของเข้ามาได้ ต่างจากเส้นทางของแขกที่เปิดให้คนทั้งงาน
   * (เทสต์ที่ตรึงข้อนี้ไว้อยู่ใน test/multi-event.test.js ข้อ "an archived event…")
   */
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
  for (const file of [sheet, ...shots]) {
    const sniffed = await acceptImage(file);
    if (!sniffed) {
      await discard(everything);
      return res.status(415).json({ error: 'not_an_image' });
    }
    accepted.push({ file, sniffed });
  }

  if (gif && !isGif(await readMagic(gif.path))) {
    await discard(everything);
    return res.status(415).json({ error: 'not_a_gif' });
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
    const savedGif = gif
      ? await place({ file: gif, sniffed: { ext: 'gif' } }, 'anim')
      : null;

    /*
     * รูปย่อของแผ่น สำหรับกริดในหน้าอัลบั้ม
     *
     * ทำตอนรับไฟล์ครั้งเดียว ไม่ใช่ย่อสด ๆ ทุกครั้งที่มีคนเปิดหน้า — แขกสี่สิบคน
     * เปิดอัลบั้มพร้อมกันตอนงานเลิกคือ NAS ที่ต้องย่อภาพพันครั้งในนาทีเดียว
     * ล้มก็ไม่เป็นไร กริดจะตกไปใช้แผ่นเต็มแทน (ช้าแต่ยังเห็นรูป)
     */
    /*
     * ขนาดของแผ่น — อ่านครั้งเดียวตอนรับไฟล์ เก็บลงแถวไปเลย
     *
     * สไลด์โชว์ต้องรู้สัดส่วนก่อนรูปจะโหลดเสร็จ ไม่งั้นกรอบจะกระพริบเปลี่ยนขนาด
     * ตอนรูปมาถึง ซึ่งบนกำแพงที่มีสิบห้าใบพร้อมกันคือการกระตุกทั้งจอ
     * อ่านไม่ได้ก็ปล่อยว่าง — ตัวอ่านตกกลับไปสัดส่วนกระดาษ 4×6 ให้เอง
     */
    const size = await sharp(path.join(config.paths.booth, savedSheet.name))
      .metadata()
      .then(({ width, height }) => ({ width, height }))
      .catch(() => ({ width: null, height: null }));

    const thumbName = `${token}-thumb.jpg`;
    const thumb = await sharp(path.join(config.paths.booth, savedSheet.name))
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toFile(path.join(config.paths.booth, thumbName))
      .then(() => {
        written.push(path.join(config.paths.booth, thumbName));
        return thumbName;
      })
      .catch((error) => {
        console.warn('[booth] ย่อรูปแผ่นไม่สำเร็จ ใช้แผ่นเต็มแทน:', error.message);
        return null;
      });

    insertBoothSession({
      token,
      takenAt: String(manifest.createdAt ?? new Date().toISOString()).slice(0, 40),
      eventTitle: String(manifest.event?.title ?? '').slice(0, 120) || null,
      template: String(manifest.template ?? '').slice(0, 40) || null,
      effect: String(manifest.effect ?? '').slice(0, 40) || null,
      sheetName: savedSheet.name,
      // นับไฟล์แถมเข้าไปด้วย ไม่งั้นพื้นที่ใช้ไปในหน้าแอดมินต่ำกว่าความจริงเรื่อย ๆ
      bytes: savedSheet.bytes + (savedGif?.bytes ?? 0),
      // รหัสที่ไม่ได้รูปแบบต้องกลายเป็น "ไม่สังกัดอัลบั้ม" ไม่ใช่เก็บไว้ทั้งอย่างนั้น
      // — คิวรีอัลบั้มเทียบตรง ๆ ค่าที่เพี้ยนจึงเปิดอัลบั้มของใครไม่ได้อยู่แล้ว
      // แต่เก็บไว้ก็ไม่มีประโยชน์อะไรนอกจากทำให้ข้อมูลดูเหมือนมีอัลบั้มทั้งที่ไม่มี
      album: isAlbum(manifest.album) ? manifest.album : null,
      gifName: savedGif?.name ?? null,
      thumbName: thumb,
      width: size.width ?? null,
      height: size.height ?? null,
    }, savedShots.map((shot) => ({ storedName: shot.name, bytes: shot.bytes })));

    return res.status(201).json({
      ok: true, token, shots: savedShots.length, gif: Boolean(savedGif),
    });
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

/**
 * วันที่แบบอ่านง่ายตามภาษาของคนที่เปิดหน้า — ไทยได้ พ.ศ. อาหรับได้เลขอาหรับ
 * แขกต้องรู้ว่า "ต้องโหลดภายในวันไหน" ไม่ใช่รู้ตอนที่มันหายไปแล้ว
 */
const showDate = (date, lang) => (date
  ? new Intl.DateTimeFormat(lang, { day: 'numeric', month: 'long', year: 'numeric' }).format(date)
  : '');

boothRouter.get('/p/:token', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  if (!isToken(token)) return next();
  await sweep();

  const session = getBoothSession(token);
  const expired = Boolean(session?.expired_at);

  /*
   * สามสถานะ ไม่ใช่สองสถานะ — และการแยกสองอันหลังออกจากกันคือหัวใจของหน้านี้
   *
   * ยังไม่ขึ้นระบบ = "เก็บรหัสไว้แล้วกลับมาใหม่" (รูปกำลังจะมา)
   * หมดอายุแล้ว   = "รูปถูกลบไปแล้ว ติดต่อเจ้าภาพ" (รูปไม่มีวันกลับมาอีก)
   * บอกผิดข้อ แขกจะรอเก้อไปตลอด หรือเลิกรอทั้งที่รูปกำลังจะขึ้น
   */
  return res.status(session && !expired ? 200 : 404).render('booth-photos', {
    page: 'booth',
    pageTitle: req.t('booth.title'),
    token,
    session: expired ? null : session,
    expired,
    retentionDays: config.boothRetentionDays,
    expiredOn: expired
      ? showDate(new Date(`${session.expired_at.replace(' ', 'T')}Z`), req.lang) : '',
    keepsUntil: session && !expired
      ? showDate(boothKeepsUntil(session), req.lang) : '',
    shots: session && !expired ? listBoothShots(token) : [],
  });
}));

/**
 * อัลบั้มของทั้งงาน — ปลายทางของ QR แบบ "สแกนแล้วดูได้ทุกรูป"
 *
 * `/b/<รหัสอัลบั้ม>` เปล่า ๆ = เจ้าภาพเปิดดูทั้งงาน
 * `/b/<รหัสอัลบั้ม>/<รหัสรอบ>` = แขกสแกนจากกระดาษของตัวเอง — **รอบของเขาถูกยกขึ้น
 * มาไว้บนสุด** ไม่งั้นต้องไล่หารูปตัวเองในกองเป็นร้อย ซึ่งเป็นเหตุผลเดียวที่ QR
 * บนแผ่นต้องมีรหัสรอบติดไปด้วยแทนที่จะเป็นลิงก์เดียวกันทุกใบ
 *
 * รอบที่ไม่ได้สังกัดอัลบั้มนี้ไม่มีทางโผล่ — คิวรีเทียบ `album = ?` ตรง ๆ
 */
function renderAlbum(req, res, next) {
  const album = String(req.params.album ?? '').toUpperCase();
  const token = String(req.params.token ?? '').toUpperCase();
  if (!isAlbum(album) || (req.params.token && !isToken(token))) return next();

  const page = Math.max(1, Math.min(999, Math.floor(Number(req.query.page)) || 1));
  const total = countAlbumSessions(album);
  const sessions = listAlbumSessions(album, { limit: PER_PAGE, offset: (page - 1) * PER_PAGE });

  // รอบของคนที่สแกนอาจอยู่หน้าอื่น (หรือยังไม่ได้อัปโหลด) — ดึงมาต่างหากเสมอ
  const own = token ? sessions.find((one) => one.token === token)
    ?? [getBoothSession(token)].find((one) => one?.album === album) ?? null : null;
  const mine = own?.expired_at ? null : own;

  return res.render('booth-album', {
    page: 'booth',
    pageTitle: sessions[0]?.event_title || req.t('booth.album_title'),
    album,
    mine,
    mineShots: mine ? listBoothShots(mine.token) : [],
    // รอบของคนที่สแกนหมดอายุไปแล้ว ต้องบอกตรง ๆ ไม่ใช่แสดงอัลบั้มเฉย ๆ แล้วให้เขา
    // หาของตัวเองไม่เจอโดยไม่รู้ว่าทำไม
    mineExpired: Boolean(own?.expired_at),
    retentionDays: config.boothRetentionDays,
    keepsUntil: mine ? showDate(boothKeepsUntil(mine), req.lang) : '',
    expiredCount: countExpiredAlbumSessions(album),
    sessions: sessions.filter((one) => one.token !== mine?.token),
    total,
    pageNumber: page,
    pages: Math.max(1, Math.ceil(total / PER_PAGE)),
  });
}

boothRouter.get('/b/:album', albumLimiter, wrap(async (req, res, next) => {
  await sweep();
  return renderAlbum(req, res, next);
}));

/**
 * โหลดทั้งงานเป็นไฟล์เดียว — สตรีมออกไป ไม่ประกอบไว้ในหน่วยความจำก่อน
 *
 * งานสามวันคือแผ่นหลายร้อยใบบวกรูปดิบอีกหลายเท่า · NAS ที่รันอยู่มีแรมจำกัด
 * และคนกดคือเจ้าภาพที่นั่งรอดูแถบดาวน์โหลดเดินอยู่
 */
boothRouter.get('/b/:album/zip', albumLimiter, wrap(async (req, res, next) => {
  const album = String(req.params.album ?? '').toUpperCase();
  if (!isAlbum(album) || countAlbumSessions(album) === 0) return next();
  return streamBoothAlbum(res, {
    album,
    sessions: listAllAlbumSessions(album),
    shots: listAlbumShots(album),
  });
}));

boothRouter.get('/b/:album/:token', albumLimiter, wrap(async (req, res, next) => {
  await sweep();
  return renderAlbum(req, res, next);
}));

boothRouter.get('/p/:token/sheet', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  const session = isToken(token) ? getBoothSession(token) : null;
  // แถวของรอบที่หมดอายุยังอยู่ (เพื่อให้หน้าอธิบายได้) แต่ไฟล์ถูกลบไปแล้วจริง ๆ
  if (!session || session.expired_at) return next();
  return sendBoothFile(res, session.sheet_name);
}));

/** รูปย่อของแผ่น — ใช้ในกริดอัลบั้มเท่านั้น · ไม่มีรูปย่อก็ตกไปใช้แผ่นเต็ม */
boothRouter.get('/p/:token/thumb', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  const session = isToken(token) ? getBoothSession(token) : null;
  if (!session || session.expired_at) return next();
  return sendBoothFile(res, session.thumb_name || session.sheet_name);
}));

boothRouter.get('/p/:token/gif', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  const session = isToken(token) ? getBoothSession(token) : null;
  if (!session || session.expired_at || !session.gif_name) return next();
  return sendBoothFile(res, session.gif_name);
}));

/**
 * ทั้งรอบถ่ายในไฟล์เดียว — แผ่น + รูปดิบทุกใบ + ภาพเคลื่อนไหว
 *
 * แขกกดปุ่มเดียวแล้วได้ครบ · **ต้องเป็น ZIP ไม่ใช่การสั่งโหลดทีละไฟล์ติด ๆ กัน**
 * เพราะเบราว์เซอร์บนมือถือบล็อกการดาวน์โหลดหลายไฟล์ซ้อน แขกจะได้ไฟล์แรกไฟล์เดียว
 * แล้วเดินจากไปโดยคิดว่าได้ครบแล้ว
 */
boothRouter.get('/p/:token/zip', wrap(async (req, res, next) => {
  const token = String(req.params.token ?? '').toUpperCase();
  const session = isToken(token) ? getBoothSession(token) : null;
  if (!session || session.expired_at) return next();
  return streamBoothSession(res, { session, shots: listBoothShots(token) });
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
