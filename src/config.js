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
  },

  paths: {
    data: dataDir,
    uploads: path.join(dataDir, 'uploads'),
    derived: path.join(dataDir, 'derived'),
    db: path.join(dataDir, 'db', 'wedding.db'),
    tmp: path.join(dataDir, 'tmp'),
    locales: path.join(rootDir, 'locales'),
    views: path.join(rootDir, 'views'),
    public: path.join(rootDir, 'public'),
  },

  limits: {
    imageMb: num('MAX_IMAGE_MB', 25),
    videoMb: num('MAX_VIDEO_MB', 300),
    videoSeconds: num('MAX_VIDEO_SECONDS', 180),
    filesPerRequest: num('MAX_FILES_PER_UPLOAD', 20),
    totalStorageGb: num('MAX_TOTAL_STORAGE_GB', 0), // 0 = no cap beyond the disk itself
    uploadsPerHourPerIp: num('UPLOADS_PER_HOUR_PER_IP', 200),
    messagesPerHourPerIp: num('MESSAGES_PER_HOUR_PER_IP', 30),
  },

  uploads: {
    windows: parseWindows(str('UPLOAD_WINDOW', '')),
    defaultEnabled: bool('UPLOADS_ENABLED', true),
    defaultRequireReview: bool('REQUIRE_REVIEW', false),
  },

  media: {
    thumbnailSize: num('THUMBNAIL_SIZE', 720),
    convertVideos: bool('CONVERT_VIDEOS', true),
    ffmpegThreads: num('FFMPEG_THREADS', 2),
    ffmpegPath: str('FFMPEG_PATH', ''),
    ffprobePath: str('FFPROBE_PATH', ''),
  },

  slideshow: {
    seconds: num('SLIDESHOW_SECONDS', 8),
    videoMaxSeconds: num('SLIDESHOW_VIDEO_MAX_SECONDS', 30),
    qrEverySlides: num('SLIDESHOW_QR_EVERY', 12),
    muted: bool('SLIDESHOW_MUTED', true),
  },

  admin: {
    password: str('ADMIN_PASSWORD', ''),
    sessionHours: num('ADMIN_SESSION_HOURS', 12),
  },

  i18n: {
    default: str('DEFAULT_LANGUAGE', 'th'),
    available: ['th', 'ms', 'en'],
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
