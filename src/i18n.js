import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { currentEvent } from './lib/tenancy.js';

const catalogues = new Map();

for (const code of config.i18n.available) {
  const file = path.join(config.paths.locales, `${code}.json`);
  catalogues.set(code, JSON.parse(fs.readFileSync(file, 'utf8')));
}

const ALL_LANGUAGES = config.i18n.available.map((code) => ({
  code,
  name: catalogues.get(code).lang.name,
  short: catalogues.get(code).lang.short,
  // แต่ละภาษาประกาศเองว่ามีธงใน sprite ไหม เดาจาก lang.dir ไม่ได้ —
  // ภาษา RTL ภาษาถัดไปที่เพิ่มเข้ามาอาจมีธงหรือไม่มีก็ได้ ไม่เกี่ยวกับทิศทางเลย
  flag: catalogues.get(code).lang.flag !== false,
}));

export const languages = ALL_LANGUAGES;

/**
 * ภาษาที่ **งานนี้** เปิดให้เลือก และภาษาหลักของงาน
 *
 * ระบบเดียวรับงานของลูกค้าหลายรายแล้ว ชุดภาษาจึงเป็นของงาน ไม่ใช่ของเครื่อง
 * งานโรงเรียนในยะลาไม่ต้องมีปุ่มภาษาอาหรับ ส่วนงานฝั่งมาเลย์ต้องขึ้นมลายูก่อนไทย
 *
 * ตกกลับไปทุกภาษาเมื่องานยังไม่ได้ระบุ — ซึ่งเป็นสภาพของทุกงานที่มีอยู่วันนี้
 * และเป็นพฤติกรรมเดิมเป๊ะ ๆ · เรียกได้แม้อยู่นอกคำขอ (สคริปต์ งานเบื้องหลัง)
 */
function eventLanguages() {
  try {
    const picked = currentEvent()?.branding?.languages;
    return Array.isArray(picked) && picked.length > 0 ? picked : config.i18n.available;
  } catch {
    return config.i18n.available;
  }
}

const offered = () => {
  const codes = eventLanguages();
  return ALL_LANGUAGES.filter((one) => codes.includes(one.code))
    // ลำดับต้องตามที่งานตั้งไว้ ไม่ใช่ตามลำดับในระบบ — ตัวแรกคือภาษาหลักของงาน
    .sort((a, b) => codes.indexOf(a.code) - codes.indexOf(b.code));
};

/** ภาษาหลักของงานนี้ — ตัวแรกในรายการที่ตั้งไว้ */
const defaultLanguage = () => eventLanguages()[0] ?? config.i18n.default;

function lookup(catalogue, key) {
  return key.split('.').reduce((node, part) => (node == null ? undefined : node[part]), catalogue);
}

function interpolate(template, vars) {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : match,
  );
}

/**
 * Translator for one language. Falls back to the default language, then to the
 * key itself, so a missing string never renders as an empty box on screen.
 */
/**
 * คำที่ต่างกันตามประเภทงาน — หาคีย์ที่ลงท้ายด้วยประเภทงานก่อน แล้วค่อยตกกลับ
 *
 * `t('site.welcome')` ในงานวันเกิดจะได้ `site.welcome_birthday` ถ้ามี ไม่มีก็ได้
 * `site.welcome` ตัวปกติ — ทำที่นี่ที่เดียว จุดที่เรียก t() กว่ายี่สิบแห่งจึงไม่ต้องแก้เลย
 * และภาษาที่ยังไม่ได้แปลคำเฉพาะของประเภทงานนั้นก็ยังใช้งานได้ ไม่ขึ้นเป็นชื่อคีย์ดิบ
 */
function resolve(catalogue, fallback, key, kind) {
  if (kind && kind !== 'wedding') {
    const specific = `${key}_${kind}`;
    const found = lookup(catalogue, specific) ?? lookup(fallback, specific);
    if (typeof found === 'string') return found;
  }
  return lookup(catalogue, key) ?? lookup(fallback, key);
}

export function translator(code, kind = currentEvent().branding.kind) {
  const catalogue = catalogues.get(code) ?? catalogues.get(config.i18n.default);
  const fallback = catalogues.get(config.i18n.default);
  return function t(key, vars) {
    const value = resolve(catalogue, fallback, key, kind);
    return typeof value === 'string' ? interpolate(value, vars) : key;
  };
}

export function catalogue(code) {
  return catalogues.get(code) ?? catalogues.get(config.i18n.default);
}

/**
 * Parse an Accept-Language header into codes we support, best match first.
 *
 * `allowed` แคบลงได้ตามชุดภาษาของงาน — ต้องกรองที่นี่ ไม่ใช่กรองผลลัพธ์ทีหลัง
 * เบราว์เซอร์ที่ส่ง "ms,en" มาที่งานซึ่งเปิดแค่ไทยกับอังกฤษ ต้องได้อังกฤษ
 * (ตัวเลือกถัดไปของแขกเอง) ไม่ใช่ตกไปที่ภาษาหลักของงานเพราะตัวเลือกแรกไม่ผ่าน
 */
export function fromAcceptLanguage(header, allowed = config.i18n.available) {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      return { tag: tag.trim().toLowerCase(), q: q ? Number(q.split('=')[1]) || 0 : 1 };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    const base = tag.split('-')[0];
    // Indonesian speakers are served Malay, which is far closer than English.
    const normalised = base === 'id' || base === 'zsm' ? 'ms' : base;
    if (allowed.includes(normalised)) return normalised;
  }
  return null;
}

/**
 * ?lang= → cookie → Accept-Language → ภาษาหลักของงาน
 *
 * ทุกชั้นถูกกรองด้วยชุดภาษาของงานนี้ ไม่ใช่ของทั้งเครื่อง — คุกกี้จากงานก่อนหน้า
 * (แขกคนเดียวไปหลายงานบนเครื่องเดียวกัน) ต้องไม่ลากภาษาที่งานนี้ไม่ได้เปิดมาด้วย
 * ไม่งั้นแขกจะเห็นหน้าเว็บในภาษาที่ไม่มีปุ่มให้กดสลับกลับ
 */
export function pickLanguage(req) {
  const allowed = eventLanguages();
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : null;
  if (queryLang && allowed.includes(queryLang)) return queryLang;

  const cookieLang = req.cookies?.lang;
  if (cookieLang && allowed.includes(cookieLang)) return cookieLang;

  return fromAcceptLanguage(req.headers?.['accept-language'], allowed) ?? defaultLanguage();
}

export function languageMiddleware(req, res, next) {
  const lang = pickLanguage(req);
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : null;

  if (queryLang && queryLang === lang && req.cookies?.lang !== lang) {
    res.cookie('lang', lang, {
      maxAge: 1000 * 60 * 60 * 24 * 180,
      httpOnly: false,
      sameSite: 'lax',
    });
  }

  req.lang = lang;
  req.t = translator(lang);
  res.locals.lang = lang;
  res.locals.t = req.t;
  res.locals.languages = offered();
  res.locals.htmlLang = catalogue(lang).lang.html;
  // ทิศทางของหน้าอ่านจาก catalogue ไม่ใช่จากรายชื่อรหัสภาษาที่ hardcode ไว้
  // เพิ่มภาษา RTL ภาษาถัดไปจึงไม่ต้องกลับมาแก้ตรงนี้อีก
  res.locals.htmlDir = catalogue(lang).lang.dir ?? 'ltr';
  next();
}
