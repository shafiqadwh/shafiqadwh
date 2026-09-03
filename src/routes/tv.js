import express from 'express';
import { config } from '../config.js';
import { qrDataUrl, shareUrl } from '../lib/qr.js';
import {
  CODE_TTL_MINUTES, MODES, claimScreen, findScreen, isCode, issueCode, listScreens,
  newDeviceToken, screenForCode, touchScreen, unpairScreen,
} from '../lib/tv.js';
import { createLimiter } from '../lib/ratelimit.js';
import { byIp } from '../lib/device.js';
import { isAdmin } from './admin.js';
import { currentEvent, eventForHost, findEvent } from '../lib/tenancy.js';
import { wrap } from '../lib/async-route.js';

export const tvRouter = express.Router();

/**
 * เปิดสไลด์โชว์บนทีวีโดยไม่ต้องพิมพ์อะไรด้วยรีโมต
 *
 *   ทีวีเปิด /tv → โชว์รหัส 6 ตัว + QR
 *   เจ้าภาพสแกน QR ด้วยกล้องมือถือ (หรือกดเมนู "เชื่อมต่อทีวี" แล้วพิมพ์รหัส)
 *   → เข้าหน้าแอดมิน → เลือกรูปแบบสไลด์โชว์ → ทีวีเด้งเข้าสไลด์โชว์เอง
 *
 * **สิทธิ์ทั้งหมดอยู่ฝั่งมือถือ** ทีวีไม่เคยถือรหัสผ่าน · จอที่ถูกขโมยหรือถูกถ่ายรูป
 * หน้าจอไว้ก็เปิดหน้าแอดมินไม่ได้ เพราะรหัสจับคู่ทำได้อย่างเดียวคือ "ขอให้แอดมินเลือกโหมด"
 */

const COOKIE = 'tv_device';
const COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000;

// ทีวีถามทุก 3 วินาที = 1,200 ครั้ง/ชม. ต่อจอ · เผื่อไว้สามจอในไอพีเดียวกัน
const pollLimiter = createLimiter({
  name: 'tv-poll', limit: 4000, windowMs: 60 * 60 * 1000, key: byIp,
});

const cookieOptions = {
  httpOnly: true,
  sameSite: 'lax',
  maxAge: COOKIE_MAX_AGE,
  secure: config.trustProxy !== false && process.env.NODE_ENV === 'production',
};

/** ทีวีเครื่องนี้คือใคร — ไม่มีคุกกี้ก็แจกโทเคนใหม่ให้ตรงนี้เลย */
function deviceOf(req, res) {
  const existing = req.cookies?.[COOKIE];
  if (typeof existing === 'string' && existing.length >= 20) return existing;
  const fresh = newDeviceToken();
  res.cookie(COOKIE, fresh, cookieOptions);
  return fresh;
}

/**
 * ทีวีเครื่องนี้ต้องไปเปิดสไลด์โชว์ที่ไหน
 *
 * แอปบนทีวีเปิดที่อยู่เดิมเสมอ แต่จอถูกจับคู่ไปเป็นของงานไหนก็ได้ในเครื่องนี้
 * (วันนี้มีสองงาน ทีวีเครื่องเดียวกันย้ายไปอีกงานได้ด้วยการจับคู่ใหม่)
 * สามกรณี เรียงตามที่เกิดจริงบ่อยที่สุด
 *
 * 1. จอเป็นของงานเดียวกับที่อยู่ที่มันเปิดอยู่ → เส้นทางภายในเหมือนเดิมทุกอย่าง
 * 2. จอเป็นของงานอื่นที่ **มีโดเมนของตัวเอง** → ส่งที่อยู่เต็มของโดเมนนั้นไป
 * 3. จอเป็นของงานอื่นที่ยังไม่มีโดเมน และที่อยู่ปัจจุบันยังไม่ถูกงานไหนจอง
 *    → ต่อ `?event=` ให้ · ถ้าที่อยู่ปัจจุบันเป็นของงานอื่นอยู่แล้ว ทำไม่ได้
 *    และต้องกันไว้ตั้งแต่ตอนกดยืนยัน ไม่ใช่ปล่อยให้ทีวีไปขึ้นรูปผิดงาน
 */
function slideshowLink(screen, req) {
  const params = new URLSearchParams({ mode: screen.mode, tv: '1' });
  if (typeof req.query.lite === 'string') params.set('lite', req.query.lite);
  if (typeof req.query.lang === 'string') params.set('lang', req.query.lang);

  if (!screen.event || screen.event === req.event.slug) return `/slideshow?${params}`;

  const target = findEvent(screen.event);
  if (target?.host) return `${req.protocol}://${target.host}/slideshow?${params}`;

  params.set('event', screen.event);
  return `/slideshow?${params}`;
}

/** ที่อยู่ที่ทีวีเปิดอยู่ พาไปงานที่จับคู่ไว้ได้จริงไหม (กรณีที่ 3 ข้างบน) */
const canReach = (event, host) => Boolean(event?.host) || !eventForHost(host);

/**
 * หน้าแรกของแอปบนทีวี
 *
 * จับคู่แล้วเข้าสไลด์โชว์เลย — รีบูตทีวีกี่ครั้งก็ไม่ต้องจับคู่ใหม่ ซึ่งเป็นเรื่องใหญ่
 * สำหรับงานที่กินเวลาสามวันและมีคนเผลอถอดปลั๊กทีวีทุกคืน
 * `?pair=1` บังคับจับคู่ใหม่ (ย้ายทีวีไปอีกงาน หรือเปลี่ยนรูปแบบสไลด์โชว์)
 */
tvRouter.get('/tv', wrap(async (req, res) => {
  const device = deviceOf(req, res);
  const screen = findScreen(device);
  const repair = req.query.pair === '1';

  if (screen?.mode && !repair) {
    touchScreen(device);
    return res.redirect(slideshowLink(screen, req));
  }
  if (repair && screen?.mode) unpairScreen(device);

  const code = issueCode(device, req.hostname);
  // QR พาไปหน้ายืนยันพร้อมรหัสในลิงก์ — กล้องมือถือเปิดให้เองโดยไม่ต้องมีแอปสแกน
  const claimUrl = `${shareUrl(req).replace(/\/+$/, '')}/admin/tv?code=${code}`;

  return res.render('tv-pair', {
    page: 'tv',
    code,
    claimUrl,
    qrImage: await qrDataUrl(claimUrl, { width: 640 }),
    minutes: CODE_TTL_MINUTES,
  });
}));

/** ทีวีถามว่าจับคู่หรือยัง · ไม่บอกอะไรมากกว่า "จับคู่แล้วไปที่ไหนต่อ" */
tvRouter.get('/api/tv/state', pollLimiter, (req, res) => {
  const device = req.cookies?.[COOKIE];
  const screen = findScreen(device);
  if (!screen) return res.json({ paired: false });

  touchScreen(device);
  return res.json(screen.mode
    ? { paired: true, next: slideshowLink(screen, req) }
    : { paired: false });
});

/**
 * หน้ายืนยันฝั่งมือถือ — ต้องล็อกอินแอดมินก่อนเสมอ
 *
 * ยังไม่ล็อกอินให้ส่งไป /admin **พร้อมจำรหัสไว้ในลิงก์** จะได้กลับมาที่หน้านี้เอง
 * หลังใส่รหัสผ่าน · ไม่งั้นเจ้าภาพต้องเดินกลับไปหน้าทีวีเพื่ออ่านรหัสใหม่อีกรอบ
 */
tvRouter.get('/admin/tv', wrap(async (req, res) => {
  const code = String(req.query.code ?? '').toUpperCase();
  if (!isAdmin(req)) {
    return res.redirect(`/admin?next=${encodeURIComponent(`/admin/tv?code=${code}`)}`);
  }

  return res.render('admin-tv', {
    page: 'admin',
    // ?done= / ?bad= มาจาก redirect หลังกดยืนยัน ใช้เลือกข้อความแจ้งผลด้านบน
    query: req.query,
    code: isCode(code) ? code : '',
    // จอที่ยังจับคู่อยู่ทั้งหมด — งานเดียวอาจมีทีวีหลายเครื่อง (โถงหน้า + ในห้อง)
    screens: listScreens(req.event.slug),
    modes: MODES,
    found: isCode(code) ? Boolean(screenForCode(code)) : null,
  });
}));

tvRouter.post('/admin/tv', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorised' });

  const code = String(req.body?.code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  /*
   * จอที่เปิดอยู่บนโดเมนของงานอื่น และงานนี้ยังไม่มีโดเมนของตัวเอง — จับคู่ไม่ได้
   *
   * ถ้าปล่อยผ่าน ทีวีจะถูกส่งกลับไปที่โดเมนเดิมพร้อม `?event=` ซึ่งโดเมนของลูกค้า
   * ไม่รับอยู่แล้วโดยตั้งใจ (กติกา: โดเมนของลูกค้าหมายถึงงานของลูกค้าเท่านั้น)
   * ผลคือทีวีขึ้นรูปของงานอื่นทั้งงานโดยที่ทุกอย่างดูเหมือนสำเร็จ · บอกตรงนี้เลย
   * ว่าต้องตั้งโดเมนก่อน ดีกว่าให้ไปรู้ตอนแขกเริ่มเดินเข้างาน
   */
  const waiting = screenForCode(code);
  if (waiting && !canReach(currentEvent(), waiting.host)) {
    return res.redirect(`/admin/tv?code=${code}&nodomain=1`);
  }

  const screen = claimScreen(code, {
    mode: String(req.body?.mode ?? ''),
    label: String(req.body?.label ?? ''),
    event: req.event.slug,
  });

  // รหัสผิด/หมดอายุ ต้องบอกที่หน้าเดิม ไม่ใช่โยนหน้าพัง — คนกำลังยืนอยู่หน้าทีวี
  if (!screen) return res.redirect(`/admin/tv?code=${code}&bad=1`);
  return res.redirect('/admin/tv?done=1');
}));

/** เลิกใช้จอนี้ — ทีวีจะกลับไปหน้าจับคู่เองในรอบถามถัดไป */
tvRouter.post('/admin/tv/unpair', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorised' });

  // ทะเบียนจอเป็นของทั้งเครื่อง เจ้าภาพจึงต้องปลดได้เฉพาะจอของงานตัวเอง —
  // ไม่งั้นโทเคนที่เดามาถูกจะไปเตะจอของอีกงานที่กำลังฉายอยู่ให้ดับกลางงาน
  const device = String(req.body?.device ?? '');
  if (findScreen(device)?.event === req.event.slug) unpairScreen(device);
  return res.redirect('/admin/tv');
}));
