import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { EVENT_KINDS } from '../config.js';
import { countBoothSessions, dailyCounts, stats } from '../repo.js';
import {
  closeConsoleSession,
  consoleSessionValid,
  createEvent,
  findEvent,
  hostTaken,
  isSlug,
  listEvents,
  openConsoleSession,
  runInEvent,
  setEventPassword,
  updateEvent,
} from '../lib/tenancy.js';
import { createLimiter } from '../lib/ratelimit.js';
import { formatBytes } from '../lib/media.js';
import { wrap } from '../lib/async-route.js';

/**
 * คอนโซลของเจ้าของระบบ — ที่เดียวที่มองเห็นทุกงานพร้อมกัน
 *
 * แยกจาก `/admin` โดยสิ้นเชิงและตั้งใจ: `/admin` เป็นของ **ลูกค้า** ซึ่งต้องเห็น
 * เฉพาะงานของตัวเองและไม่ควรรู้ด้วยซ้ำว่ามีงานอื่นอยู่ในเครื่องเดียวกัน · คอนโซล
 * เป็นของ **เจ้าของบริการ** ใช้เปิดงานใหม่ ตั้งโดเมน ตั้งรหัสให้ลูกค้า และดูยอดรวม
 *
 * คุกกี้คนละใบ ตารางคนละตาราง (อยู่ในทะเบียน ไม่ใช่ในฐานข้อมูลของงาน) และกุญแจ
 * คือ ADMIN_PASSWORD จาก `.env` ซึ่งอยู่บนเครื่อง ไม่ได้ตั้งผ่านหน้าเว็บ —
 * คุกกี้แอดมินของลูกค้าจึงไม่มีทางกลายเป็นกุญแจของคอนโซลได้เลยไม่ว่ากรณีไหน
 *
 * **หน้านี้เป็นภาษาไทยล้วน ไม่ผ่านระบบแปล** ต่างจากทุกหน้าที่แขกและลูกค้าเห็น
 * เพราะคนที่ใช้มีคนเดียวคือเจ้าของ · แปลสี่ภาษาให้หน้าที่มีผู้ใช้คนเดียวคือ
 * ค่าดูแลที่จ่ายไปเปล่า ๆ ทุกครั้งที่เพิ่มปุ่ม
 */

export const consoleRouter = express.Router();

const COOKIE = 'console_session';

const loginLimiter = createLimiter({ name: 'console-login', limit: 10, windowMs: 15 * 60 * 1000 });

const form = express.urlencoded({ extended: false });

const isOperator = (req) => consoleSessionValid(req.cookies?.[COOKIE]);

function requireOperator(req, res, next) {
  if (isOperator(req)) return next();
  if (req.accepts('html')) return res.redirect('/console');
  return res.status(401).json({ error: 'unauthorised' });
}

/** ยอดของงานหนึ่งงาน — อ่านจากฐานข้อมูลของงานนั้นโดยตรง */
function summarise(event) {
  return runInEvent(event, () => {
    const summary = stats();
    return {
      ...event,
      stats: { ...summary, storage: formatBytes(summary.bytes) },
      booth: countBoothSessions(),
      days: dailyCounts(),
    };
  });
}

consoleRouter.get('/console', wrap(async (req, res) => {
  if (!isOperator(req)) {
    return res.render('console-login', { page: 'console', error: null });
  }

  const events = listEvents().map(summarise);
  // ยอดรวมข้ามงาน — ตัวเลขที่เอาไปคุยกับตัวเองได้ว่าเดือนนี้รับงานไปเท่าไร
  const total = events.reduce((sum, one) => ({
    photos: sum.photos + one.stats.photos,
    videos: sum.videos + one.stats.videos,
    messages: sum.messages + one.stats.messages,
    booth: sum.booth + one.booth,
    bytes: sum.bytes + one.stats.bytes,
  }), { photos: 0, videos: 0, messages: 0, booth: 0, bytes: 0 });

  return res.render('console', {
    page: 'console',
    events,
    kinds: EVENT_KINDS,
    total: { ...total, storage: formatBytes(total.bytes) },
    query: req.query,
  });
}));

consoleRouter.post('/console/login', loginLimiter, form, (req, res) => {
  const expected = Buffer.from(config.admin.password);
  const given = Buffer.from(String(req.body?.password ?? ''));
  const ok = expected.length === given.length && crypto.timingSafeEqual(expected, given);
  if (!ok) {
    return res.status(401).render('console-login', { page: 'console', error: 'รหัสผ่านไม่ถูกต้อง' });
  }

  res.cookie(COOKIE, openConsoleSession(config.admin.sessionHours), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: config.admin.sessionHours * 60 * 60 * 1000,
  });
  return res.redirect('/console');
});

consoleRouter.post('/console/logout', requireOperator, (req, res) => {
  closeConsoleSession(req.cookies[COOKIE]);
  res.clearCookie(COOKIE);
  res.redirect('/console');
});

/** ช่องข้อความของงาน — อ่านจากฟอร์มชุดเดียวกันทั้งตอนสร้างและตอนแก้ */
const fieldsFrom = (body) => ({
  title: String(body?.title ?? '').trim().slice(0, 120),
  host: String(body?.host ?? '').trim().toLowerCase().slice(0, 200),
  kind: EVENT_KINDS.includes(String(body?.kind)) ? String(body.kind) : '',
  names: String(body?.names ?? '').trim().slice(0, 120),
  venue: String(body?.venue ?? '').trim().slice(0, 160),
  time: String(body?.time ?? '').trim().slice(0, 60),
  monogram: String(body?.monogram ?? '').trim().slice(0, 20),
  startsOn: String(body?.starts_on ?? '').trim().slice(0, 10),
  endsOn: String(body?.ends_on ?? '').trim().slice(0, 10),
});

consoleRouter.post('/console/events', requireOperator, form, (req, res) => {
  const slug = String(req.body?.slug ?? '').trim().toLowerCase();
  if (!isSlug(slug)) return res.redirect('/console?bad=slug');
  if (findEvent(slug)) return res.redirect('/console?bad=taken');

  const fields = fieldsFrom(req.body);
  // ถามก่อนลงมือ — ไม่งั้นแถวกับโฟลเดอร์ถูกสร้างไปแล้วก่อนจะไปชนดัชนี unique
  // แล้วเหลืองานครึ่ง ๆ กลาง ๆ ค้างในทะเบียนพร้อมหน้า 500 ที่อ่านไม่รู้เรื่อง
  if (hostTaken(fields.host)) return res.redirect('/console?bad=host');
  createEvent({ slug, ...fields });
  // รหัสของลูกค้าตั้งตอนสร้างได้เลย · ไม่ตั้งก็เข้าด้วยกุญแจหลักไปก่อนได้
  if (req.body?.password) setEventPassword(slug, String(req.body.password));
  return res.redirect(`/console?made=${encodeURIComponent(slug)}`);
});

consoleRouter.post('/console/events/:slug', requireOperator, form, (req, res) => {
  if (!findEvent(req.params.slug)) return res.redirect('/console?bad=missing');
  const fields = fieldsFrom(req.body);
  if (hostTaken(fields.host, req.params.slug)) return res.redirect('/console?bad=host');
  updateEvent(req.params.slug, fields);
  return res.redirect('/console?saved=1');
});

consoleRouter.post('/console/events/:slug/password', requireOperator, form, (req, res) => {
  if (!findEvent(req.params.slug)) return res.redirect('/console?bad=missing');
  // ช่องว่าง = ล้างรหัสของลูกค้าทิ้ง กลับไปใช้กุญแจหลักอย่างเดียว
  setEventPassword(req.params.slug, String(req.body?.password ?? ''));
  return res.redirect('/console?saved=1');
});

/**
 * ปิดงานที่จบแล้ว — เป็นการ "เก็บเข้าลิ้นชัก" ไม่ใช่การลบ
 *
 * ไม่มีปุ่มลบงานในคอนโซลโดยตั้งใจ · ลบงานคือลบรูปงานแต่งของลูกค้าทั้งงานในคลิกเดียว
 * ซึ่งเป็นปุ่มที่ไม่ควรมีอยู่ข้าง ๆ ปุ่มอื่นที่กดทุกวัน · จะลบจริงต้องไปลบโฟลเดอร์
 * ของงานนั้นบนเครื่องเอง ซึ่งเป็นจังหวะที่ได้คิดอีกรอบ
 */
consoleRouter.post('/console/events/:slug/archive', requireOperator, form, (req, res) => {
  if (!findEvent(req.params.slug)) return res.redirect('/console?bad=missing');
  updateEvent(req.params.slug, { archived: req.body?.archived === 'on' });
  return res.redirect('/console?saved=1');
});
