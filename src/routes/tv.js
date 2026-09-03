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

const slideshowLink = (screen, req) => {
  const params = new URLSearchParams({ mode: screen.mode, tv: '1' });
  if (typeof req.query.lite === 'string') params.set('lite', req.query.lite);
  if (typeof req.query.lang === 'string') params.set('lang', req.query.lang);
  return `/slideshow?${params}`;
};

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

  const code = issueCode(device);
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
    screens: listScreens(),
    modes: MODES,
    found: isCode(code) ? Boolean(screenForCode(code)) : null,
  });
}));

tvRouter.post('/admin/tv', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorised' });

  const code = String(req.body?.code ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');
  const screen = claimScreen(code, {
    mode: String(req.body?.mode ?? ''),
    label: String(req.body?.label ?? ''),
  });

  // รหัสผิด/หมดอายุ ต้องบอกที่หน้าเดิม ไม่ใช่โยนหน้าพัง — คนกำลังยืนอยู่หน้าทีวี
  if (!screen) return res.redirect(`/admin/tv?code=${code}&bad=1`);
  return res.redirect('/admin/tv?done=1');
}));

/** เลิกใช้จอนี้ — ทีวีจะกลับไปหน้าจับคู่เองในรอบถามถัดไป */
tvRouter.post('/admin/tv/unpair', express.urlencoded({ extended: false }), wrap(async (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorised' });
  unpairScreen(String(req.body?.device ?? ''));
  return res.redirect('/admin/tv');
}));
