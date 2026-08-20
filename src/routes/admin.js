import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { db, getFlag, pruneExpiredSessions, setFlag } from '../db.js';
import { catalogue, translator } from '../i18n.js';
import {
  deleteItemRow,
  deleteMessageRow,
  getItem,
  getMessage,
  listGuests,
  listItems,
  listMessages,
  setItemStatus,
  setMessageStatus,
  stats,
} from '../repo.js';
import { formatBytes, randomName } from '../lib/media.js';
import { deleteFilm, filmPath, jobStatus, listFilms, startJob } from '../lib/film-job.js';
import {
  KINDS as PAPER_KINDS,
  deletePaper,
  jobStatus as paperStatus,
  listPapers,
  paperPath,
  startJob as startPaperJob,
} from '../lib/paper-job.js';
import { STYLES } from '../lib/film-run.js';
import { queueLength } from '../lib/queue.js';
import { qrDataUrl, qrPngBuffer, shareUrl } from '../lib/qr.js';
import { streamArchive } from '../lib/zip.js';
import { createLimiter } from '../lib/ratelimit.js';
import { uploadsOpen } from './gallery.js';

export const adminRouter = express.Router();

const COOKIE = 'admin_session';

const insertSession = db.prepare(
  "INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', ?))",
);
const findSession = db.prepare(
  "SELECT token FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')",
);
const dropSession = db.prepare('DELETE FROM admin_sessions WHERE token = ?');

const loginLimiter = createLimiter({ name: 'admin-login', limit: 10, windowMs: 15 * 60 * 1000 });

function passwordMatches(candidate) {
  const expected = Buffer.from(config.admin.password);
  const given = Buffer.from(String(candidate ?? ''));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

export function isAdmin(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  return Boolean(findSession.get(token));
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.accepts('html')) return res.redirect('/admin');
  return res.status(401).json({ error: req.t('admin.wrong_password') });
}

adminRouter.get('/admin', async (req, res) => {
  if (!isAdmin(req)) {
    return res.render('admin-login', { page: 'admin', error: null });
  }

  const summary = stats();
  // สถานะหนังใส่มาตั้งแต่ตอนเรนเดอร์หน้า เจ้าของที่เปิดหน้ามาแล้วเห็นเลยว่ามีหนัง
  // อยู่ไหม โดยไม่ต้องรอ JavaScript ยิง poll รอบแรก
  const film = await jobStatus();
  const paper = await paperStatus();
  return res.render('admin', {
    film: {
      ...film,
      films: film.films.map((one) => ({ ...one, size: formatBytes(one.bytes) })),
    },
    paper: {
      ...paper,
      papers: paper.papers.map((one) => ({ ...one, size: formatBytes(one.bytes) })),
    },
    // รายชื่อแขกเรนเดอร์มาพร้อมหน้าเลย ช่องค้นหากรองบนรายการที่มีอยู่แล้วในหน้า
    // จำนวนแขกมีขอบเขตชัดเจนไม่กี่ร้อยแถว ไม่คุ้มที่จะยิง API ทุกตัวอักษรที่พิมพ์
    guests: listGuests({ includeHidden: true }),
    page: 'admin',
    stats: { ...summary, storage: formatBytes(summary.bytes) },
    queue: queueLength(),
    uploadsEnabled: getFlag('uploads_enabled', true),
    requireReview: getFlag('require_review', false),
    uploadsOpen: uploadsOpen(),
    items: listItems({ limit: 120, includeHidden: true }),
    messages: listMessages({ limit: 60, includeHidden: true }),
  });
});

adminRouter.post('/admin/login', loginLimiter, express.urlencoded({ extended: false }), (req, res) => {
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).render('admin-login', { page: 'admin', error: req.t('admin.wrong_password') });
  }

  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(token, `+${config.admin.sessionHours} hours`);

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: config.admin.sessionHours * 60 * 60 * 1000,
  });
  res.redirect('/admin');
});

adminRouter.post('/admin/logout', requireAdmin, (req, res) => {
  dropSession.run(req.cookies[COOKIE]);
  res.clearCookie(COOKIE);
  res.redirect('/');
});

adminRouter.post('/admin/settings', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  setFlag('uploads_enabled', req.body?.uploads_enabled === 'on');
  setFlag('require_review', req.body?.require_review === 'on');
  res.redirect('/admin');
});

async function removeFiles(row) {
  const targets = [
    path.join(config.paths.uploads, row.stored_name),
    row.playback_name ? path.join(config.paths.derived, row.playback_name) : null,
    row.thumb_name ? path.join(config.paths.derived, row.thumb_name) : null,
  ].filter(Boolean);

  await Promise.all(targets.map((file) => fs.rm(file, { force: true })));
}

adminRouter.post('/admin/items/:id/:action', requireAdmin, async (req, res) => {
  const row = getItem(Number(req.params.id));
  if (!row) return res.status(404).json({ error: req.t('errors.not_found') });

  switch (req.params.action) {
    case 'approve':
      setItemStatus(row.id, 'visible');
      break;
    case 'hide':
      setItemStatus(row.id, 'hidden');
      break;
    case 'show':
      setItemStatus(row.id, 'visible');
      break;
    case 'delete':
      await removeFiles(row);
      deleteItemRow(row.id);
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }

  if (req.accepts('html') && !req.xhr) return res.redirect('/admin');
  return res.json({ ok: true });
});

adminRouter.post('/admin/messages/:id/:action', requireAdmin, (req, res) => {
  const row = getMessage(Number(req.params.id));
  if (!row) return res.status(404).json({ error: req.t('errors.not_found') });

  if (req.params.action === 'delete') deleteMessageRow(row.id);
  else if (req.params.action === 'hide') setMessageStatus(row.id, 'hidden');
  else if (req.params.action === 'show') setMessageStatus(row.id, 'visible');
  else if (req.params.action === 'approve') setMessageStatus(row.id, 'visible');
  else return res.status(400).json({ error: 'unknown action' });

  if (req.accepts('html') && !req.xhr) return res.redirect('/admin');
  return res.json({ ok: true });
});

adminRouter.get('/admin/zip', requireAdmin, (req, res) => {
  streamArchive(res, {
    includeVideos: req.query.videos !== '0',
    filenamePrefix: (config.event.coupleNames || 'wedding').replace(/[^\w-]+/g, '-').toLowerCase(),
  });
});

adminRouter.get('/admin/qr', requireAdmin, async (req, res) => {
  const url = shareUrl(req);
  // The printed card carries every language at once — guests do not get to
  // pick a language before they have scanned anything.
  const cards = config.i18n.available.map((code) => {
    const translate = translator(code);
    return {
      code,
      // แต่ละบล็อกบอกทิศทางของตัวเอง ภาษาอาหรับบนการ์ดที่พิมพ์จึงเรียงขวาไปซ้าย
      // ได้ถูกต้อง แม้หน้าที่ครอบมันอยู่จะเป็นภาษาไทย
      dir: catalogue(code).lang.dir ?? 'ltr',
      // ภาษาที่ไม่มีธงใน sprite ใช้ตัวอักษรแทน ไม่ใช่ <use> ที่ชี้ไปยัง symbol
      // ที่ไม่มีอยู่ ซึ่งพิมพ์ออกมาเป็นกล่องสี่เหลี่ยมว่าง ๆ
      flag: catalogue(code).lang.flag !== false,
      short: catalogue(code).lang.short,
      title: translate('qr.title'),
      step1: translate('qr.step1'),
      step2: translate('qr.step2'),
      step3: translate('qr.step3'),
    };
  });

  // งานนี้จัดหลายวันคนละที่ (บ้าน 2 วัน ร้าน 1 วัน) การ์ดชุดเดียวที่พิมพ์
  // ชื่อร้านกับเวลาไว้ตายตัว จะบอกข้อมูลผิดให้แขกในวันที่จัดที่บ้าน
  //   /admin/qr           การ์ดเต็ม มีชื่อสถานที่และเวลา — สำหรับวันงานเลี้ยง
  //   /admin/qr?venue=0   ตัดบรรทัดสถานที่ออก — ใช้ได้ทุกวันทุกที่
  const showVenue = req.query.venue !== '0';

  res.render('qr-card', {
    page: 'admin',
    shareUrl: url,
    qrImage: await qrDataUrl(url, { width: 900 }),
    cards,
    showVenue,
  });
});

// ── หนังงานแต่ง: สั่งทำ ดูสถานะ เล่น และดาวน์โหลด จากหน้าเว็บ ────────────────

const MUSIC_MB = 30;

const musicUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.tmp),
    filename: (req, file, cb) => cb(null, randomName('part')),
  }),
  limits: { fileSize: MUSIC_MB * 1024 * 1024, files: 1 },
});

/**
 * เพลงคลอที่แอดมินอัพโหลดไว้ — มีได้ไฟล์เดียว อัพใหม่ทับของเดิม
 *
 * เก็บใน data/music/ ไม่ใช่ใน uploads/ เพราะไฟล์ใน uploads คือของที่แขกส่งมา
 * ซึ่งจะถูกเอาไปทำสไลด์โชว์ ทำ ZIP และเข้าหนัง เพลงไม่ควรหลุดไปอยู่ในนั้น
 */
async function currentMusic() {
  try {
    const names = await fs.readdir(config.paths.music);
    const first = names.find((name) => !name.startsWith('.'));
    if (!first) return null;
    const filePath = path.join(config.paths.music, first);
    const stat = await fs.stat(filePath);
    return { name: first, path: filePath, bytes: stat.size };
  } catch {
    return null;
  }
}

adminRouter.get('/admin/film/status', requireAdmin, async (req, res) => {
  const status = await jobStatus();
  const music = await currentMusic();
  res.json({
    ...status,
    films: status.films.map((film) => ({ ...film, size: formatBytes(film.bytes) })),
    music: music && { name: music.name, size: formatBytes(music.bytes) },
  });
});

adminRouter.post('/admin/film/start', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  const music = await currentMusic();

  // ตัวเลขจากฟอร์มต้องผ่านการตรวจก่อน ไม่ใช่ส่งตรงเข้า ffmpeg — ค่าติดลบหรือ
  // ค่าที่ไม่ใช่ตัวเลขจะทำให้ตัวกรองของ ffmpeg พังกลางทางแบบอ่าน error ไม่รู้เรื่อง
  const clamp = (raw, fallback, low, high) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), low), high);
  };

  try {
    const status = await startJob({
      // รูปแบบต้องอยู่ในรายการที่รู้จักเท่านั้น ค่าที่ส่งมาเองจะตกไปเป็นค่าเริ่มต้น
      style: STYLES.includes(req.body.style) ? req.body.style : 'cinema',
      seconds: clamp(req.body.seconds, 6, 2, 20),
      maxVideoSeconds: clamp(req.body.maxVideoSeconds, 30, 5, 120),
      motion: req.body.motion === 'on',
      music: req.body.music === 'on' && music ? music.path : null,
    });
    res.json({ ok: true, state: status.state });
  } catch (error) {
    res.status(error.code === 'BUSY' || error.code === 'LOCKED' ? 409 : 500)
      .json({ error: error.message });
  }
});

adminRouter.post('/admin/film/music', requireAdmin, (req, res) => {
  musicUpload.single('music')(req, res, async (uploadError) => {
    if (uploadError || !req.file) {
      return res.status(400).json({ error: req.t('errors.too_large_request') });
    }

    // รับเฉพาะไฟล์เสียงที่ ffmpeg อ่านออกแน่ ๆ และตัดสินจากนามสกุลที่เราตั้งเอง
    // ไม่ใช่ชื่อไฟล์ที่ผู้ใช้ส่งมา — ชื่อจากผู้ใช้พาไปที่อื่นในดิสก์ได้
    const ext = path.extname(req.file.originalname).toLowerCase();
    if (!['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac'].includes(ext)) {
      await fs.rm(req.file.path, { force: true });
      return res.status(400).json({ error: req.t('errors.unsupported_type', { name: req.file.originalname }) });
    }

    await fs.mkdir(config.paths.music, { recursive: true });
    const existing = await currentMusic();
    if (existing) await fs.rm(existing.path, { force: true });

    const target = path.join(config.paths.music, `song${ext}`);
    await fs.rename(req.file.path, target).catch(async () => {
      // tmp กับ music อยู่คนละ mount point ได้ ก็ตกไปใช้การคัดลอกแทน
      await fs.copyFile(req.file.path, target);
      await fs.rm(req.file.path, { force: true });
    });

    const stat = await fs.stat(target);
    return res.json({ ok: true, name: path.basename(target), size: formatBytes(stat.size) });
  });
});

adminRouter.post('/admin/film/music/delete', requireAdmin, async (req, res) => {
  const music = await currentMusic();
  if (music) await fs.rm(music.path, { force: true });
  res.json({ ok: true });
});

/**
 * ส่งหนังให้เบราว์เซอร์ — ต้องรองรับ Range ไม่งั้นกดเล่นแล้วเลื่อนหาช่วงกลางไม่ได้
 *
 * res.sendFile รองรับ Range ให้อยู่แล้ว จึงใช้ตัวนั้นแทนการ pipe เอง
 */
/** ส่งไฟล์ใหญ่แบบรองรับการกระโดดข้าม (Range) — ใช้ทั้งกับหนังและกับ PDF */
function sendFilm(res, filmPath, { download }) {
  return new Promise((resolve, reject) => {
    res.sendFile(path.basename(filmPath), {
      root: path.dirname(filmPath),
      dotfiles: 'deny',
      acceptRanges: true,
      // หนังถูกทำใหม่ทับที่เดิมได้ ห้ามให้เบราว์เซอร์แคชยาว ไม่งั้นจะเล่นของเก่า
      maxAge: 0,
      cacheControl: false,
      headers: {
        'Cache-Control': 'no-cache',
        ...(download
          ? { 'Content-Disposition': `attachment; filename="${path.basename(filmPath)}"` }
          : {}),
      },
    }, (error) => (error ? reject(error) : resolve()));
  });
}

async function serveFilm(req, res, next, download) {
  const target = filmPath(req.params.id);
  if (!target) return next();

  try {
    await fs.stat(target);
  } catch {
    return next();
  }

  try {
    return await sendFilm(res, target, { download });
  } catch (error) {
    return next(error);
  }
}

adminRouter.get('/admin/film/:id/video', requireAdmin, (req, res, next) =>
  serveFilm(req, res, next, false));

adminRouter.get('/admin/film/:id/download', requireAdmin, (req, res, next) =>
  serveFilm(req, res, next, true));

adminRouter.post('/admin/film/:id/delete', requireAdmin, async (req, res) => {
  const removed = await deleteFilm(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
});

adminRouter.get('/admin/paper/status', requireAdmin, async (req, res) => {
  const status = await paperStatus();
  res.json({
    ...status,
    papers: status.papers.map((paper) => ({ ...paper, size: formatBytes(paper.bytes) })),
  });
});

adminRouter.post('/admin/paper/start', requireAdmin, express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const status = await startPaperJob({
      // ชนิดต้องอยู่ในรายการที่รู้จักเท่านั้น ค่าที่ส่งมาเองจะถูกปฏิเสธ ไม่ใช่เดาให้
      kind: PAPER_KINDS.includes(req.body.kind) ? req.body.kind : null,
      // เอกสารใช้ภาษาของหน้าที่กดปุ่ม — วันที่กับหัวเรื่องจะได้เป็นภาษาเดียวกันทั้งเล่ม
      t: req.t,
      lang: req.lang,
    });
    res.json({ ok: true, state: status.state, kind: status.kind });
  } catch (error) {
    const code = { BUSY: 409, LOCKED: 409, BAD_KIND: 400 }[error.code] ?? 500;
    res.status(code).json({ error: error.message });
  }
});

async function servePaper(req, res, next, download) {
  const target = paperPath(req.params.id);
  if (!target) return next();

  try {
    await fs.stat(target);
  } catch {
    return next();
  }

  try {
    return await sendFilm(res, target, { download });
  } catch (error) {
    return next(error);
  }
}

adminRouter.get('/admin/paper/:id/view', requireAdmin, (req, res, next) =>
  servePaper(req, res, next, false));

adminRouter.get('/admin/paper/:id/download', requireAdmin, (req, res, next) =>
  servePaper(req, res, next, true));

adminRouter.post('/admin/paper/:id/delete', requireAdmin, async (req, res) => {
  const removed = await deletePaper(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
});

adminRouter.get('/admin/qr.png', requireAdmin, async (req, res) => {
  res.type('png').send(await qrPngBuffer(shareUrl(req), { width: 1200 }));
});
