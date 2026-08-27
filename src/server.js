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
import { adminRouter, isAdmin } from './routes/admin.js';
import { galleryRouter } from './routes/gallery.js';
import { guestbookRouter } from './routes/guestbook.js';
import { slideshowRouter } from './routes/slideshow.js';
import { uploadRouter } from './routes/upload.js';

export function createApp() {
  const app = express();

  if (config.trustProxy) app.set('trust proxy', true);
  app.set('view engine', 'ejs');
  app.set('views', config.paths.views);
  app.disable('x-powered-by');

  app.use(cookieParser());
  app.use(deviceMiddleware);
  app.use(languageMiddleware);

  app.use((req, res, next) => {
    res.locals.event = config.event;
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

  app.use((error, req, res, next) => {
    console.error('[error]', error);
    if (res.headersSent) return next(error);
    res.status(500);
    const message = req.t ? req.t('errors.server_error') : 'Server error';
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

  await ensureDirs();
  resumeQueue();
  startLimiterCleanup();

  const app = createApp();
  const server = app.listen(config.port, config.host, () => {
    console.log(`${config.event.title} — listening on http://${config.host}:${config.port}`);
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
