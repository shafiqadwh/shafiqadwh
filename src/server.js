import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { assertConfig, config } from './config.js';
import { assetVersion } from './lib/assets.js';
import { deviceMiddleware } from './lib/device.js';
import { catalogue, languageMiddleware } from './i18n.js';
import { ensureDirs } from './lib/media.js';
import { resumeQueue } from './lib/queue.js';
import { startLimiterCleanup } from './lib/ratelimit.js';
import { themeStyle } from './lib/theme.js';
import {
  defaultEvent, enterEvent, eventForHost, findEvent, forEachEvent,
} from './lib/tenancy.js';
import { adminRouter, isAdmin } from './routes/admin.js';
import { boothRouter } from './routes/booth.js';
import { consoleRouter } from './routes/console.js';
import { tvRouter } from './routes/tv.js';
import { sweepExpiredBooth } from './lib/booth-retention.js';
import { galleryRouter } from './routes/gallery.js';
import { guestbookRouter } from './routes/guestbook.js';
import { slideshowRouter } from './routes/slideshow.js';
import { uploadRouter } from './routes/upload.js';

/**
 * คำขอนี้เป็นของงานไหน
 *
 * ลำดับการตัดสินใจ และเหตุผลของแต่ละชั้น
 *
 * 1. **โดเมนของคำขอ** — ทางหลัก ลูกค้าแต่ละรายได้โดเมนของตัวเอง
 *    (`rina-adam.example.com`) แขกที่สแกน QR จึงมาถึงงานที่ถูกต้องเสมอ
 * 2. **`?event=<ชื่อย่อ>`** — เฉพาะเมื่อโดเมนที่เข้ามา **ไม่ได้เป็นของงานไหนเลย**
 *    ใช้ตอนพัฒนา ตอนเทสต์ และตอนที่งานใหม่ยังไม่ได้ตั้งโดเมน
 *    ที่ต้องมีเงื่อนไข "โดเมนต้องไม่ถูกจอง" กำกับ เพราะไม่อย่างนั้นใครก็ได้ที่เปิด
 *    โดเมนของลูกค้า ก. แล้วต่อท้าย `?event=ข.` จะเห็นงานของลูกค้าอีกราย —
 *    โดเมนของลูกค้าต้องหมายถึงงานของลูกค้ารายนั้นเท่านั้น ไม่มีทางลัด
 * 3. **คุกกี้จากข้อ 2** — `?event=` ติดมากับลิงก์แรกเท่านั้น ลิงก์ในหน้าเว็บทั้งเว็บ
 *    (แกลลอรี่ `/media/:id` `/api/items`) เป็นเส้นทางเปล่า ๆ ไม่มีพารามิเตอร์
 *    ถ้าไม่จำไว้ คลิกเดียวก็เด้งกลับไปงานเริ่มต้นแล้ว
 * 4. **งานเริ่มต้น** — เครื่องที่ติดตั้งไว้ก่อนมีหลายงาน ทำงานต่อเหมือนเดิมทุกอย่าง
 */
const EVENT_COOKIE = 'event';

export function eventMiddleware(req, res, next) {
  const claimed = eventForHost(req.hostname);
  let chosen = null;

  if (!claimed) {
    if (typeof req.query.event === 'string') {
      chosen = findEvent(req.query.event);
      if (chosen) res.cookie(EVENT_COOKIE, chosen.slug, { httpOnly: true, sameSite: 'lax' });
    } else if (req.cookies?.[EVENT_COOKIE]) {
      chosen = findEvent(req.cookies[EVENT_COOKIE]);
    }
  }

  req.event = claimed ?? chosen ?? defaultEvent();
  enterEvent(req.event);
  return next();
}

export function createApp() {
  const app = express();
  const pageTheme = themeStyle();

  if (config.trustProxy) app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', config.paths.views);
  app.disable('x-powered-by');

  app.use(cookieParser());
  /*
   * งานไหน — ต้องตอบให้ได้ก่อนทุกอย่าง
   *
   * ตัวกลางตัวนี้ต้องอยู่ก่อน middleware ตัวอื่นทั้งหมด เพราะตั้งแต่ `deviceMiddleware`
   * เป็นต้นไปมีการแตะฐานข้อมูล และ "ฐานข้อมูลไหน" คือคำตอบของบรรทัดนี้
   * ทุกอย่างหลังจากนี้ (รวมถึง await ที่ต่อกันไปจนจบคำขอ) วิ่งอยู่ในบริบทของงานนั้น
   */
  app.use(eventMiddleware);
  app.use(deviceMiddleware);
  app.use(languageMiddleware);

  app.use((req, res, next) => {
    res.locals.event = req.event.branding;
    // คำนวณครั้งเดียวตอนบูตก็พอ ค่ามาจาก .env ที่เปลี่ยนไม่ได้ระหว่างรัน
    res.locals.themeStyle = pageTheme;
    res.locals.limits = config.limits;
    res.locals.isAdmin = isAdmin(req);
    res.locals.currentPath = req.path;
    // ต่อท้ายที่อยู่ไฟล์ static ทุกอัน เปลี่ยนทุกครั้งที่เนื้อไฟล์เปลี่ยน
    // เครื่องที่เคยแคชไว้จะเห็นเป็นคนละที่อยู่แล้วโหลดใหม่เอง
    res.locals.assetVersion = assetVersion;
    // Everything the browser-side scripts need, in the guest's language.
    res.locals.clientStrings = catalogue(req.lang);
    res.locals.clientConfig = {
      lang: req.lang,
      limits: {
        imageMb: config.limits.imageMb,
        videoMb: config.limits.videoMb,
        videoSeconds: config.limits.videoSeconds,
        filesPerRequest: config.limits.filesPerRequest,
      },
    };
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });

  app.use('/static', express.static(config.paths.public, { maxAge: '7d' }));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.use(consoleRouter);
  app.use(boothRouter);
  app.use(tvRouter);
  app.use(galleryRouter);
  app.use(uploadRouter);
  app.use(guestbookRouter);
  app.use(slideshowRouter);
  app.use(adminRouter);

  app.use((req, res) => {
    res.status(404);
    if (req.accepts('html')) return res.render('error', { page: 'error', message: req.t('errors.not_found') });
    return res.json({ error: req.t('errors.not_found') });
  });

  /*
   * ตัวรับ error ตัวสุดท้าย — ตอบให้ตรงกับสาเหตุ ไม่ใช่เหมาเป็น 500 ทุกอย่าง
   *
   * `res.sendFile` ติด `statusCode` มากับ error ให้อยู่แล้ว: ไฟล์ไม่อยู่บนดิสก์
   * คือ 404 · เดิมเหมาเป็น 500 ทั้งหมด ซึ่งพาเจ้าของไล่หาสาเหตุผิดทาง (ไฟล์หาย
   * จากดิสก์เกิดขึ้นจริงบนเครื่องนี้มาแล้วตอนคลังเพลงกลายเป็นของ root) และ log
   * เต็มไปด้วย stack ยาว ๆ พร้อมพาธเต็มของเครื่อง ทั้งที่บรรทัดเดียวก็พอ
   */
  app.use((error, req, res, next) => {
    const declared = Number(error?.status ?? error?.statusCode);
    const code = Number.isInteger(declared) && declared >= 400 && declared <= 599 ? declared : 500;

    // 5xx คือความผิดของเรา ต้องเห็น stack เต็ม · 4xx คือคำขอที่ไม่มีของให้ ไม่ใช่เหตุ
    if (code >= 500) console.error('[error]', error);
    else console.warn(`[${code}] ${req.method} ${req.originalUrl} — ${error.message}`);

    if (res.headersSent) return next(error);
    res.status(code);
    const key = code === 404 ? 'errors.not_found' : 'errors.server_error';
    const message = req.t ? req.t(key) : 'Server error';
    if (req.accepts('html')) return res.render('error', { page: 'error', message });
    return res.json({ error: message });
  });

  return app;
}

export async function start() {
  assertConfig();

  /*
   * ตาข่ายชั้นสุดท้าย — Promise ที่ถูก reject โดยไม่มีใครรับ ต้องไม่ฆ่าเว็บทั้งงาน
   *
   * ค่าเริ่มต้นของ Node 22 คือ **จบโปรเซสทันที** เมื่อเจอ unhandled rejection
   * (ทดสอบแล้วบน Express 4: handler ที่โยน error ทำให้เซิร์ฟเวอร์ดับจริง)
   * บนเครื่องจริง Docker ยกกลับมาให้ในสิบกว่าวินาที แต่ถ้าสาเหตุยังอยู่ เช่นดิสก์เต็ม
   * คำขอถัดไปก็ฆ่าซ้ำได้เรื่อย ๆ จนกลายเป็นเว็บที่ล่ม ๆ ติด ๆ ตลอดงาน
   *
   * route ทุกเส้นห่อด้วย wrap() ให้ error ไหลเข้า error middleware อยู่แล้ว
   * ตรงนี้จึงมีไว้รับเฉพาะของที่หลุดจากนอกเส้นทางคำขอ (งานเบื้องหลัง คิว ตัวจับเวลา)
   * ซึ่งดับเว็บทิ้งไม่ได้เด็ดขาด — บันทึกไว้ให้สืบทีหลัง แล้วให้เว็บวิ่งต่อ
   */
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal] มี Promise ที่ไม่มีใครรับ error — เว็บยังทำงานต่อ:', reason);
  });

  /*
   * งานเบื้องหลังตอนบูตต้องทำให้ **ทุกงาน** ไม่ใช่แค่งานเริ่มต้น
   *
   * เดิมทั้งสามบรรทัดนี้ทำกับฐานข้อมูลเดียวเพราะมีอยู่ฐานเดียว · ตอนนี้เครื่องเดียว
   * ถือหลายงาน วิดีโอที่ค้างคิวอยู่ของงานเมื่อวานจะไม่มีวันถูกแปลงต่อถ้าไม่วนให้ครบ
   */
  await forEachEvent(async () => {
    await ensureDirs();
    resumeQueue();
  });
  startLimiterCleanup();

  /*
   * รูปจากบูธที่พ้นกำหนดเก็บ — กวาดตอนบูตหนึ่งครั้ง
   *
   * ปกติกวาดตอนมีคนเปิดหน้าที่ QR ชี้มา (ชั่วโมงละครั้ง) แต่ถ้าไม่มีใครสแกนเลย
   * หลายวัน รูปจะยังนอนอยู่บนดิสก์เกินที่สัญญาไว้กับลูกค้า · ตัวนี้ทำให้การรีสตาร์ต
   * (หรือรีบูต NAS) เป็นอีกจังหวะที่ได้กวาดเสมอ
   */
  forEachEvent(() => sweepExpiredBooth({ force: true }))
    .then((results) => {
      const swept = results.reduce((total, one) => total + one.swept, 0);
      if (swept > 0) console.log(`[booth] ลบรูปที่พ้นกำหนดเก็บ ${swept} รอบ`);
    })
    .catch((error) => console.error('[booth] กวาดรูปที่หมดอายุไม่สำเร็จ:', error));

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    // พอร์ตที่ผูกได้จริง ไม่ใช่ค่าที่ขอไป — PORT=0 แปลว่า "ขอพอร์ตว่างพอร์ตไหนก็ได้"
    // แล้วบรรทัดนี้จะพิมพ์ :0 ซึ่งพาไปต่อไม่ได้ (เจอตอนเขียนเทสต์ที่ต้องอ่านพอร์ตจาก log)
    const bound = server.address()?.port ?? config.port;
    console.log(`${config.event.title} — listening on http://${config.host}:${bound}`);
    if (config.baseUrl) console.log(`Guests will scan: ${config.baseUrl}`);
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received, shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  return server;
}

const invokedDirectly =
  process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  start().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
