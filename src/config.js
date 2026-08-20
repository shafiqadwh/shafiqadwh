import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`Environment variable ${name} must be a number, got "${raw}"`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/**
 * อาร์กิวเมนต์บรรทัดคำสั่งที่คั่นด้วยช่องว่าง เช่น "-preset p4 -cq 24"
 *
 * ส่งเข้า execFile เป็นอาร์เรย์ ไม่ได้ผ่านเชลล์ จึงไม่มีเรื่อง shell injection
 * แต่ก็ยังไม่รับอักขระแปลก ๆ ไว้ก่อน กันคนพิมพ์ผิดแล้วได้ error ที่อ่านไม่ออก
 */
function words(name, fallback) {
  const raw = str(name, fallback).trim();
  if (!raw) return [];
  const parts = raw.split(/\s+/);
  const bad = parts.find((part) => !/^[\w.:=+/,-]+$/.test(part));
  if (bad) {
    throw new Error(`Environment variable ${name} contains an unexpected argument: "${bad}"`);
  }
  return parts;
}

/**
 * Upload windows, e.g. "2026-11-14 09:00 / 2026-11-15 02:00".
 * Comma separates several windows. Empty means always open.
 */
function parseWindows(raw) {
  if (!raw) return [];
  return raw.split(',').map((chunk) => {
    const [from, to] = chunk.split('/').map((s) => s.trim());
    const start = from ? new Date(from.replace(' ', 'T')) : null;
    const end = to ? new Date(to.replace(' ', 'T')) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime()))) {
      throw new Error(`UPLOAD_WINDOW has an unreadable date: "${chunk.trim()}"`);
    }
    return { start, end };
  });
}

/** "Sofwan & 'Aishah Nadhirah" → "S & A", for the monogram on the printed card. */
function initialsFrom(names) {
  const letters = names
    .split(/\s*&\s*|\s+and\s+/i)
    .map((part) => part.trim().replace(/^['’"]+/, '').charAt(0).toUpperCase())
    .filter(Boolean);
  return letters.length >= 2 ? `${letters[0]} & ${letters[1]}` : '';
}

const dataDir = path.resolve(rootDir, str('DATA_DIR', 'data'));

export const config = {
  rootDir,
  env: str('NODE_ENV', 'production'),
  port: num('PORT', 3000),
  host: str('HOST', '0.0.0.0'),
  baseUrl: str('BASE_URL', '').replace(/\/+$/, ''),

  event: {
    title: str('EVENT_TITLE', 'Our Wedding'),
    coupleNames: str('COUPLE_NAMES', ''),
    date: str('EVENT_DATE', ''),
    venue: str('EVENT_VENUE', ''),
    time: str('EVENT_TIME', ''),
    monogram: str('EVENT_MONOGRAM', '') || initialsFrom(str('COUPLE_NAMES', '')),
  },

  paths: {
    root: rootDir,
    data: dataDir,
    uploads: path.join(dataDir, 'uploads'),
    derived: path.join(dataDir, 'derived'),
    db: path.join(dataDir, 'db', 'wedding.db'),
    tmp: path.join(dataDir, 'tmp'),
    locales: path.join(rootDir, 'locales'),
    views: path.join(rootDir, 'views'),
    public: path.join(rootDir, 'public'),
    // หนังงานแต่งที่ export แล้ว กับเพลงคลอที่แอดมินอัพโหลดผ่านหน้าเว็บ
    export: path.join(dataDir, 'export'),
    films: path.join(dataDir, 'export', 'films'),
    // PDF สมุดคำอวยพร กับ รายชื่อผู้ส่งภาพ ที่สร้างจากหน้าแอดมิน
    papers: path.join(dataDir, 'export', 'papers'),
    music: path.join(dataDir, 'music'),
  },

  limits: {
    imageMb: num('MAX_IMAGE_MB', 25),
    videoMb: num('MAX_VIDEO_MB', 300),
    videoSeconds: num('MAX_VIDEO_SECONDS', 180),
    filesPerRequest: num('MAX_FILES_PER_UPLOAD', 20),
    totalStorageGb: num('MAX_TOTAL_STORAGE_GB', 0), // 0 = no cap beyond the disk itself
    // โควตาต่อ "เครื่อง" ของแขกหนึ่งคน — เลขที่คนปกติไม่มีทางชน
    uploadsPerHourPerDevice: num('UPLOADS_PER_HOUR_PER_DEVICE', 80),
    messagesPerHourPerDevice: num('MESSAGES_PER_HOUR_PER_DEVICE', 12),
    // เพดานรวมต่อไอพี เป็นชั้นกันการยิงถล่มเท่านั้น ต้องสูงพอไม่ให้ไปโดนแขกปกติ
    // ที่ออกเน็ตผ่านไอพีเดียวกันเป็นร้อยเครื่อง (WiFi งาน หรือ CGNAT ของค่ายมือถือ)
    uploadsPerHourPerIp: num('UPLOADS_PER_HOUR_PER_IP', 4000),
    messagesPerHourPerIp: num('MESSAGES_PER_HOUR_PER_IP', 800),
  },

  uploads: {
    windows: parseWindows(str('UPLOAD_WINDOW', '')),
    defaultEnabled: bool('UPLOADS_ENABLED', true),
    defaultRequireReview: bool('REQUIRE_REVIEW', false),
  },

  media: {
    thumbnailSize: num('THUMBNAIL_SIZE', 720),
    // ขนาดสำเนาที่ส่งให้สไลด์โชว์ — ใหญ่พอสำหรับจอ 1080p แต่เบาพอให้กล่องทีวีไหว
    displaySize: num('DISPLAY_SIZE', 1920),
    convertVideos: bool('CONVERT_VIDEOS', true),
    ffmpegThreads: num('FFMPEG_THREADS', 2),
    // จำนวนงาน ffmpeg ที่ทำพร้อมกันได้ตอนแขกยืนรอ (อ่านข้อมูล + ดึงภาพปก)
    // มากกว่านี้ไม่ได้เร็วขึ้น เพราะคอขวดคือดิสก์กับ CPU ของ NAS
    concurrency: num('MEDIA_CONCURRENCY', 2),

    // ตัวเข้ารหัสวิดีโอ ใช้เฉพาะตอนที่ต้องบีบอัดใหม่จริง ๆ (ไฟล์ HEVC)
    // ไฟล์ที่เป็น H.264 อยู่แล้วจะถูกคัดลอกสตรีมตรง ๆ ไม่ผ่านตัวนี้
    //
    // ค่าเริ่มต้น libx264 = ใช้ CPU ทำงานได้ทุกเครื่อง
    // ถ้ามี GPU NVIDIA ที่ผ่านเข้ามาถึงคอนเทนเนอร์ได้แล้วจริง ๆ ตั้ง
    //   VIDEO_ENCODER=h264_nvenc
    //   VIDEO_ENCODER_ARGS=-preset p4 -cq 24
    //   VIDEO_DECODER_ARGS=-hwaccel cuda
    // ตรวจก่อนว่าใช้ได้จริงด้วย: docker exec wedding-share ffmpeg -encoders | grep nvenc
    videoEncoder: str('VIDEO_ENCODER', 'libx264'),
    encoderArgs: words('VIDEO_ENCODER_ARGS', '-preset veryfast -crf 24 -profile:v high'),
    decoderArgs: words('VIDEO_DECODER_ARGS', ''),
    // หนังงานแต่งใช้ตัวเข้ารหัสตัวเดียวกับคิวแปลงวิดีโอ (VIDEO_ENCODER) แต่คนละ
    // อาร์กิวเมนต์ — หนังคือของที่เก็บไว้ตลอดชีวิต จึงให้คุณภาพสูงกว่า (crf 20 ไม่ใช่ 24)
    // ⚠️ เปลี่ยนเป็น nvenc ต้องเปลี่ยนคู่กันเสมอ เพราะ nvenc ไม่รู้จัก -crf ต้องใช้ -cq
    filmEncoderArgs: words('FILM_ENCODER_ARGS', '-preset veryfast -crf 20 -profile:v high -level 4.1'),
    ffmpegPath: str('FFMPEG_PATH', ''),
    ffprobePath: str('FFPROBE_PATH', ''),
  },

  slideshow: {
    seconds: num('SLIDESHOW_SECONDS', 8),
    videoMaxSeconds: num('SLIDESHOW_VIDEO_MAX_SECONDS', 30),
    qrEverySlides: num('SLIDESHOW_QR_EVERY', 12),
    muted: bool('SLIDESHOW_MUTED', true),
    // คำอวยพรแทรกถี่กว่า QR เพราะเป็นของที่แขกอยากอ่าน ไม่ใช่ของที่เราอยากบอก
    messageEverySlides: num('SLIDESHOW_MESSAGE_EVERY', 5),
    titleEverySlides: num('SLIDESHOW_TITLE_EVERY', 24),
    // คำอวยพรยาว ๆ ต้องมีเวลาอ่านมากกว่ารูป — คิดจากจำนวนตัวอักษร
    messageSeconds: num('SLIDESHOW_MESSAGE_SECONDS', 11),
    // ซูมช้า ๆ แบบ Ken Burns ทำให้ภาพนิ่งบนจอใหญ่ไม่ดูตาย ปิดได้ถ้าเครื่องฉายอืด
    kenBurns: bool('SLIDESHOW_KEN_BURNS', true),
    // cinema = ทีละรูปเต็มจอ · wall = กระจายทั้งจอเหมือนรูปโพลารอยด์แล้ววนไฮไลท์
    mode: str('SLIDESHOW_MODE', 'cinema'),
  },

  admin: {
    password: str('ADMIN_PASSWORD', ''),
    sessionHours: num('ADMIN_SESSION_HOURS', 12),
  },

  i18n: {
    default: str('DEFAULT_LANGUAGE', 'th'),
    available: ['th', 'ms', 'en', 'ar'],
  },

  trustProxy: bool('TRUST_PROXY', true),
};

export function assertConfig() {
  const problems = [];
  if (!config.admin.password) {
    problems.push('ADMIN_PASSWORD is required — set it in your .env file.');
  } else if (config.admin.password.length < 8) {
    problems.push('ADMIN_PASSWORD must be at least 8 characters long.');
  }
  if (!config.i18n.available.includes(config.i18n.default)) {
    problems.push(`DEFAULT_LANGUAGE must be one of: ${config.i18n.available.join(', ')}`);
  }
  if (config.baseUrl && !/^https?:\/\//.test(config.baseUrl)) {
    problems.push('BASE_URL must start with http:// or https://');
  }
  if (problems.length) {
    throw new Error(`Configuration problems:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Is guest uploading allowed right now, according to UPLOAD_WINDOW? */
export function withinUploadWindow(now = new Date()) {
  if (config.uploads.windows.length === 0) return true;
  return config.uploads.windows.some(({ start, end }) => {
    if (start && now < start) return false;
    if (end && now > end) return false;
    return true;
  });
}
