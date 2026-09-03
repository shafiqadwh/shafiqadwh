import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { currentEvent } from './lib/tenancy.js';

const catalogues = new Map();

for (const code of config.i18n.available) {
  const file = path.join(config.paths.locales, `${code}.json`);
  catalogues.set(code, JSON.parse(fs.readFileSync(file, 'utf8')));
}

export const languages = config.i18n.available.map((code) => ({
  code,
  name: catalogues.get(code).lang.name,
  short: catalogues.get(code).lang.short,
  // แต่ละภาษาประกาศเองว่ามีธงใน sprite ไหม เดาจาก lang.dir ไม่ได้ —
  // ภาษา RTL ภาษาถัดไปที่เพิ่มเข้ามาอาจมีธงหรือไม่มีก็ได้ ไม่เกี่ยวกับทิศทางเลย
  flag: catalogues.get(code).lang.flag !== false,
}));

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

/** Parse an Accept-Language header into codes we support, best match first. */
export function fromAcceptLanguage(header) {
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
    if (config.i18n.available.includes(normalised)) return normalised;
  }
  return null;
}

/** cookie → ?lang= → Accept-Language → configured default. */
export function pickLanguage(req) {
  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : null;
  if (queryLang && config.i18n.available.includes(queryLang)) return queryLang;

  const cookieLang = req.cookies?.lang;
  if (cookieLang && config.i18n.available.includes(cookieLang)) return cookieLang;

  return fromAcceptLanguage(req.headers?.['accept-language']) ?? config.i18n.default;
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
  res.locals.languages = languages;
  res.locals.htmlLang = catalogue(lang).lang.html;
  // ทิศทางของหน้าอ่านจาก catalogue ไม่ใช่จากรายชื่อรหัสภาษาที่ hardcode ไว้
  // เพิ่มภาษา RTL ภาษาถัดไปจึงไม่ต้องกลับมาแก้ตรงนี้อีก
  res.locals.htmlDir = catalogue(lang).lang.dir ?? 'ltr';
  next();
}
