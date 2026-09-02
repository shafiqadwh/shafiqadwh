import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { db, getFlag, getSetting, pruneExpiredSessions, setFlag, setSetting } from '../db.js';
import { catalogue, translator } from '../i18n.js';
import {
  HOST_SLOTS,
  countHostMedia,
  deleteHostMediaRow,
  deleteItemRow,
  deleteMessageRow,
  getHostMedia,
  insertHostMedia,
  listAllHostMedia,
  listHostMedia,
  moveHostMedia,
  getItem,
  getMessage,
  getTrashedByIds,
  listExpiredTrash,
  listGuests,
  listItems,
  listMessages,
  listTrash,
  restoreItems,
  setItemStatus,
  setMessageStatus,
  softDeleteItems,
  stats,
} from '../repo.js';
import {
  formatBytes, processHostImage, randomName, readMagic, removeHostFiles, sniffType,
} from '../lib/media.js';
import { deleteFilm, filmPath, jobStatus, startJob } from '../lib/film-job.js';
import { deleteTrack, listLibrary, resolveTracks, totalSeconds, trackPath } from '../lib/music.js';
import { buildTimeline, dedupe, planLength } from '../lib/film-plan.js';
import { readDeck } from '../lib/film-plan.js';
import {
  KINDS as PAPER_KINDS,
  deletePaper,
  jobStatus as paperStatus,
  paperPath,
  startJob as startPaperJob,
} from '../lib/paper-job.js';
import { STYLES } from '../lib/film-run.js';
import { queueLength } from '../lib/queue.js';
import { qrDataUrl, qrPngBuffer, shareUrl } from '../lib/qr.js';
import { streamArchive } from '../lib/zip.js';
import { createLimiter } from '../lib/ratelimit.js';
import { uploadsOpen } from './gallery.js';
import { wrap } from '../lib/async-route.js';

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

adminRouter.get('/admin', wrap(async (req, res) => {
  if (!isAdmin(req)) {
    return res.render('admin-login', { page: 'admin', error: null });
  }

  await purgeExpiredTrash();

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
    // เพลงคลอของหน้าแกลลอรี่ — เลือกจากคลังเดียวกับที่หนังใช้ ไม่ต้องอัพซ้ำ
    galleryMusic: { picked: getSetting('gallery_music', ''), library: await listLibrary() },
    trash: listTrash().map((one) => ({ ...one, size: formatBytes(one.bytes) })),
    // รูปที่เจ้าภาพอัพเองสำหรับหน้าแรก — แยกเป็นช่อง ๆ ให้ view วนได้ตรง ๆ
    home: {
      limits: HOST_SLOTS,
      cover: listHostMedia('cover'),
      invitation: listHostMedia('invitation'),
      photo: listHostMedia('photo'),
    },
    trashRetentionDays: config.admin.trashRetentionDays,
    // ?undo= มาจาก redirect หลังกดลบ — เอาเฉพาะ id ที่ยังอยู่ในถังขยะจริงเท่านั้น
    // ลิงก์ค้าง (กู้คืนไปแล้วก่อนหน้า หรือถูกกวาดทิ้งถาวรไปแล้ว) แบนเนอร์แค่ไม่ขึ้น ไม่ error
    undoItems: getTrashedByIds(String(req.query.undo ?? '').split(',')),
    // ?home= มาจาก redirect หลังจัดการรูปหน้าแรก ใช้เลือกข้อความแจ้งผลด้านบนแผง
    query: req.query,
  });
}));

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

/**
 * เพลงคลอในหน้าแกลลอรี่ — เก็บแค่ "ชื่อเพลงที่เลือก" ไม่ได้ก๊อปไฟล์ไปไหน
 *
 * ค่าว่างคือปิด ซึ่งเป็นค่าเริ่มต้น · ชื่อที่ส่งมาต้องผ่าน `trackPath()` ก่อนเสมอ
 * เพราะมันมาจากฟอร์มในเบราว์เซอร์ แก้ค่าใน DOM แล้วส่งอะไรมาก็ได้
 */
adminRouter.post('/admin/music/gallery', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const wanted = String(req.body?.track ?? '');
  setSetting('gallery_music', wanted && trackPath(wanted) ? wanted : '');
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

/**
 * กวาดถังขยะที่หมดอายุแล้วจริง ๆ — ลบไฟล์บนดิสก์ + แถวใน DB ถาวร ทำได้ทางเดียว
 *
 * ไม่กวาดทุกครั้งที่เปิด /admin — งาน 3 วันเจ้าภาพเปิดหน้านี้ค้างในมือถือทั้งงาน
 * กวาดทุกครั้งที่โหลดหน้าคือ I/O ลบไฟล์เปล่า ๆ ระหว่างงานชุลมุน จึงกวาดจริงเมื่อ
 * ผ่านไปแล้วอย่างน้อยหนึ่งชั่วโมง เก็บเวลาไว้ใน settings ตัวเดิมที่มีอยู่แล้ว
 */
async function purgeExpiredTrash() {
  const last = getSetting('trash_purged_at');
  const lastMs = last ? Date.parse(last) : 0;
  if (Number.isFinite(lastMs) && Date.now() - lastMs < 60 * 60 * 1000) return;

  setSetting('trash_purged_at', new Date().toISOString());
  const expired = listExpiredTrash(config.admin.trashRetentionDays);
  for (const row of expired) {
    await removeFiles(row);
    deleteItemRow(row.id);
  }
}

adminRouter.post('/admin/items/:id/:action', requireAdmin, wrap(async (req, res) => {
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
      // เข้าถังขยะ ไม่ลบไฟล์จริงทันที — กันพลาดกลางงาน กู้คืนได้จากแบนเนอร์ทันที
      // หรือจากหน้าถังขยะทีหลัง ไฟล์จริงถูกลบก็ต่อเมื่อพ้นระยะเก็บ (purgeExpiredTrash)
      softDeleteItems([row.id]);
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }

  if (req.accepts('html') && !req.xhr) {
    const undo = req.params.action === 'delete' ? `?undo=${row.id}` : '';
    return res.redirect(`/admin${undo}`);
  }
  return res.json({ ok: true });
}));

/** ids จากฟอร์ม — checkbox เดียวส่งมาเป็นสตริง หลายอันส่งมาเป็นอาร์เรย์ ต้องรวมให้เป็นแบบเดียวเสมอ */
function idsFromBody(body) {
  return [].concat(body?.ids ?? []);
}

adminRouter.post('/admin/items/bulk-delete', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  const ids = softDeleteItems(idsFromBody(req.body));
  const undo = ids.length > 0 ? `?undo=${ids.join(',')}` : '';
  res.redirect(`/admin${undo}`);
});

adminRouter.post('/admin/items/restore', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  restoreItems(idsFromBody(req.body));
  res.redirect('/admin');
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
    filenamePrefix: (config.event.names || 'wedding').replace(/[^\w-]+/g, '-').toLowerCase(),
  });
});

adminRouter.get('/admin/qr', requireAdmin, wrap(async (req, res) => {
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

  // กี่ใบต่อกระดาษ A4 หนึ่งแผ่น
  //   1 (ค่าเริ่มต้น) การ์ด A5 แผ่นละใบ — เหมือนเดิมทุกประการ ของที่พิมพ์ไปแล้วไม่เปลี่ยน
  //   2             การ์ด A5 สองใบเต็มแผ่น ตัดครึ่งเดียว
  //   4             การ์ด A6 สี่ใบ — งานพันคนหลายสิบโต๊ะ พิมพ์แผ่นละใบคือกระดาษเปล่ามหาศาล
  const sheet = [2, 4].includes(Number(req.query.sheet)) ? Number(req.query.sheet) : 1;

  res.render('qr-card', {
    page: 'admin',
    shareUrl: url,
    // การ์ด A6 ใส่ QR ได้ ~32 มม. ซึ่งที่ 300 dpi คือ ~380 px · ขอ 500 ไว้เผื่อ
    // แล้วยังเบากว่า 900 ที่ถูกฝังซ้ำสี่ครั้งในหน้าเดียว
    qrImage: await qrDataUrl(url, { width: sheet === 4 ? 500 : 900 }),
    cards,
    showVenue,
    sheet,
  });
}));

// ── หน้าแรกของงาน: ภาพปก การ์ดเชิญ รูปงาน ที่เจ้าภาพอัพเอง ──────────────────

const homeUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.paths.tmp),
    filename: (req, file, cb) => cb(null, randomName('part')),
  }),
  limits: { fileSize: config.limits.imageMb * 1024 * 1024, files: HOST_SLOTS.photo },
});

/**
 * อัพรูปเข้าช่องใดช่องหนึ่ง — ภาพปกได้ใบเดียวและอัพใหม่ทับของเดิม
 *
 * ชนิดไฟล์ตัดสินจากไบต์จริงในไฟล์ ไม่ใช่จากนามสกุลที่ผู้ใช้ส่งมา (เหมือนเส้นทาง
 * ของแขก) และรับเฉพาะรูป — วิดีโอบนหน้าแรกทำให้หน้าเว็บหนักโดยไม่ได้อะไรกลับมา
 */
adminRouter.post('/admin/home/:slot', requireAdmin, (req, res) => {
  const slot = String(req.params.slot);
  if (!Object.hasOwn(HOST_SLOTS, slot)) return res.redirect('/admin');

  homeUpload.array('files', HOST_SLOTS[slot])(req, res, (uploadError) => {
    void ingestHomeMedia(req, res, slot, uploadError).catch(async (error) => {
      console.error('[home] อัพรูปหน้าแรกล้ม:', error);
      await discard(req.files);
      if (!res.headersSent) res.redirect('/admin?home=error');
    });
  });
});

const discard = (files) =>
  Promise.all((files ?? []).map((file) => fs.rm(file.path, { force: true })));

/** multer บอกได้ว่าล้มเพราะอะไร — แปลเป็นข้อความที่ตรงกับสาเหตุ ไม่ใช่ "ไฟล์ใหญ่ไป" เสมอ */
function multerOutcome(error) {
  if (error.code === 'LIMIT_FILE_SIZE') return 'toobig';
  // ส่งไฟล์เกินจำนวนที่ช่องนั้นรับได้ — ภาพปกรับใบเดียว เลือกมาสามใบจะมาทางนี้
  if (['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)) return 'toomany';
  return 'error';
}

async function ingestHomeMedia(req, res, slot, uploadError) {
  const files = req.files ?? [];
  const done = (outcome) => res.redirect(outcome ? `/admin?home=${outcome}` : '/admin');

  if (uploadError || files.length === 0) {
    await discard(files);
    return done(uploadError ? multerOutcome(uploadError) : 'empty');
  }

  /*
   * ตรวจไฟล์ให้ครบ *ก่อน* แตะของเดิม
   *
   * ภาพปกอัพใหม่คือแทนที่ของเก่า · เดิมโค้ดลบใบเก่าทิ้งก่อนแล้วค่อยตรวจใบใหม่
   * เจ้าภาพที่เผลออัพไฟล์ PDF ทับจึงเสียภาพปกไปเลยโดยไม่มีอะไรมาแทน และไม่มี
   * ข้อความบอกด้วย (ทดสอบยืนยันแล้ว) — รูปเจ้าภาพไม่มีถังขยะ กู้คืนไม่ได้
   */
  // ภาพปกมีได้ใบเดียวและใบใหม่ทับใบเก่า ที่ว่างจึงเป็น 1 เสมอ ไม่ใช่ 1 ลบของที่มีอยู่
  const room = slot === 'cover' ? HOST_SLOTS.cover : HOST_SLOTS[slot] - countHostMedia(slot);
  const keep = [];
  let rejected = 0;

  for (const file of files) {
    // ชนิดไฟล์ตัดสินจากไบต์จริง ไม่ใช่จากนามสกุลที่เบราว์เซอร์ส่งมา (เหมือนเส้นทางของแขก)
    const sniffed = sniffType(await readMagic(file.path));
    const usable = sniffed?.kind === 'image';
    if (!usable) rejected += 1;

    if (usable && keep.length < room) keep.push({ file, sniffed });
    else await fs.rm(file.path, { force: true }); // ใช้ไม่ได้ หรือเกินโควตาช่อง
  }

  // ไม่มีไฟล์ที่ใช้ได้เลย = ไม่ต้องแตะของเดิม บอกสาเหตุแล้วจบ
  if (keep.length === 0) return done(rejected > 0 ? 'badtype' : 'full');

  if (slot === 'cover') {
    for (const old of listHostMedia('cover')) {
      await removeHostFiles(old);
      deleteHostMediaRow(old.id);
    }
  }

  for (const { file, sniffed } of keep) {
    insertHostMedia({ slot, ...(await processHostImage(file.path, sniffed)) });
  }

  // ของที่เข้าไม่ได้เพราะชนิดไฟล์เป็นเรื่องน่าแปลกใจกว่าโควตาเต็ม จึงบอกอันนั้นก่อน
  if (rejected > 0) return done('badtype');
  return done(keep.length < files.length ? 'full' : null);
}

adminRouter.post('/admin/home/item/:id/delete', requireAdmin, wrap(async (req, res) => {
  const row = getHostMedia(Number(req.params.id));
  if (row) {
    // ลบไฟล์ก่อนลบแถว — สลับกันแล้วถ้าล้มกลางทางจะเหลือไฟล์กำพร้าที่ไม่มีใครรู้ว่ามี
    await removeHostFiles(row);
    deleteHostMediaRow(row.id);
  }
  res.redirect('/admin');
}));

adminRouter.post('/admin/home/item/:id/move', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  moveHostMedia(Number(req.params.id), req.body?.direction === 'up' ? 'up' : 'down');
  res.redirect('/admin');
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
adminRouter.get('/admin/film/status', requireAdmin, wrap(async (req, res) => {
  const status = await jobStatus();
  res.json({
    ...status,
    films: status.films.map((film) => ({ ...film, size: formatBytes(film.bytes) })),
  });
}));

adminRouter.post('/admin/film/start', requireAdmin, express.urlencoded({ extended: false }), wrap(async (req, res) => {
  // ตัวเลขจากฟอร์มต้องผ่านการตรวจก่อน ไม่ใช่ส่งตรงเข้า ffmpeg — ค่าติดลบหรือ
  // ค่าที่ไม่ใช่ตัวเลขจะทำให้ตัวกรองของ ffmpeg พังกลางทางแบบอ่าน error ไม่รู้เรื่อง
  const clamp = (raw, fallback, low, high) => {
    const value = Number(raw);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), low), high);
  };

  // ฟอร์มส่ง style มาได้หลายค่า express รวมเป็น array ให้เอง แต่ค่าเดียวยังเป็นสตริง
  const asked = [req.body.style ?? []].flat();
  const styles = asked.filter((style) => STYLES.includes(style));

  // เพลงที่เลือกมาต้องผ่านการตรวจว่ามีไฟล์อยู่จริง ไม่ใช่ส่ง path จากฟอร์มเข้า ffmpeg
  const tracks = await resolveTracks([req.body.track ?? []].flat());

  try {
    const status = await startJob({
      styles: styles.length > 0 ? styles : ['cinema'],
      // ว่างไว้ = ให้โปรแกรมคิดเองจากจำนวนรูป
      seconds: req.body.seconds ? clamp(req.body.seconds, 6, 2, 20) : 'auto',
      maxVideoSeconds: clamp(req.body.maxVideoSeconds, 30, 5, 120),
      motion: req.body.motion === 'on',
      tracks,
    });
    res.json({ ok: true, state: status.state, styles: status.styles, tracks: tracks.length });
  } catch (error) {
    res.status(error.code === 'BUSY' || error.code === 'LOCKED' ? 409 : 500)
      .json({ error: error.message });
  }
}));

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

    // เพลงที่อัพเองเข้ากลุ่ม "ของฉัน" ในคลัง — เก็บได้หลายเพลง ไม่ทับของเดิม
    const mine = path.join(config.paths.music, 'library', 'mine');
    await fs.mkdir(mine, { recursive: true });

    // ชื่อไฟล์เอามาจากผู้ใช้ จึงตัดเหลือแค่ชื่อฐานและอักขระที่ปลอดภัย
    // ส่วนนามสกุลใช้ตัวที่เราตรวจแล้วข้างบน ไม่ใช่ที่ผู้ใช้ส่งมา
    const stem = path.basename(req.file.originalname, path.extname(req.file.originalname))
      .replace(/[^\p{L}\p{N} ._-]/gu, '')
      .trim()
      .slice(0, 60) || 'song';

    let target = path.join(mine, `${stem}${ext}`);
    for (let n = 2; n < 100; n += 1) {
      try {
        await fs.access(target);
        target = path.join(mine, `${stem} (${n})${ext}`);
      } catch {
        break;
      }
    }

    await fs.rename(req.file.path, target).catch(async () => {
      // tmp กับ music อยู่คนละ mount point ได้ ก็ตกไปใช้การคัดลอกแทน
      await fs.copyFile(req.file.path, target);
      await fs.rm(req.file.path, { force: true });
    });

    const stat = await fs.stat(target);
    return res.json({ ok: true, name: path.basename(target), size: formatBytes(stat.size) });
  });
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

/**
 * ตัวเลขที่คำนวณไว้ก่อนกดปุ่ม — กี่วินาทีต่อรูป หนังจะยาวเท่าไร ต้องใช้เพลงยาวรวมเท่าไร
 * อ่านอย่างเดียว ไม่เริ่มเรนเดอร์อะไรทั้งนั้น
 */
adminRouter.get('/admin/film/plan', requireAdmin, wrap(async (req, res) => {
  const deck = readDeck();

  // ต้องตัดไฟล์ซ้ำแบบเดียวกับตอนเรนเดอร์จริง (`runExport`) ไม่งั้นงานที่แขกอัพรูปซ้ำ
  // จะโชว์ตัวเลขสูงเกินจริง แล้วคำที่เขียนไว้ในเอกสารว่า "ตัวเลขที่โชว์คือตัวเลขที่ใช้จริง"
  // ก็ไม่จริงขึ้นมาทันที
  deck.items = await dedupe(deck.items);

  const maxVideoSeconds = Math.min(Math.max(Number(req.query.maxVideoSeconds) || 30, 5), 120);
  const timeline = buildTimeline(deck, { limit: 0 });
  const plan = planLength(timeline, { seconds: 'auto', maxVideoSeconds });
  const picked = await totalSeconds([req.query.track ?? []].flat());

  res.json({
    ...plan,
    videos: timeline.filter((entry) => entry.kind === 'video').length,
    wishes: timeline.filter((entry) => entry.kind === 'wish').length,
    pickedSeconds: picked,
    library: await listLibrary(),
  });
}));

adminRouter.post('/admin/film/track/delete', requireAdmin, express.urlencoded({ extended: false }), wrap(async (req, res) => {
  const removed = await deleteTrack(req.body.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

adminRouter.get('/admin/film/:id/video', requireAdmin, (req, res, next) =>
  serveFilm(req, res, next, false));

adminRouter.get('/admin/film/:id/download', requireAdmin, (req, res, next) =>
  serveFilm(req, res, next, true));

adminRouter.post('/admin/film/:id/delete', requireAdmin, wrap(async (req, res) => {
  const removed = await deleteFilm(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

adminRouter.get('/admin/paper/status', requireAdmin, wrap(async (req, res) => {
  const status = await paperStatus();
  res.json({
    ...status,
    papers: status.papers.map((paper) => ({ ...paper, size: formatBytes(paper.bytes) })),
  });
}));

adminRouter.post('/admin/paper/start', requireAdmin, express.urlencoded({ extended: false }), wrap(async (req, res) => {
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
}));

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

adminRouter.post('/admin/paper/:id/delete', requireAdmin, wrap(async (req, res) => {
  const removed = await deletePaper(req.params.id);
  res.status(removed ? 200 : 404).json({ ok: removed });
}));

adminRouter.get('/admin/qr.png', requireAdmin, wrap(async (req, res) => {
  res.type('png').send(await qrPngBuffer(shareUrl(req), { width: 1200 }));
}));
