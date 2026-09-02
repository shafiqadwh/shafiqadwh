import fs from 'node:fs/promises';
import path from 'node:path';
import { THEME_IDS } from '../../../shared/themes.js';
import { EFFECT_IDS } from '../core/effects.js';
import { TEMPLATE_IDS } from '../core/templates.js';
import { PAPERS } from '../core/paper.js';

/**
 * ค่าตั้งของบูธ — ตั้งไว้ก่อนงาน แล้วหน้างานแตะให้น้อยที่สุด
 *
 * **ค่าที่อ่านมาไม่ถูกต้องต้องตกกลับไปค่าเริ่มต้น ไม่ใช่ทำให้บูธไม่ขึ้น**
 * ไฟล์นี้ถูกแก้ด้วยมือหน้างานได้ (ลูกค้าเปลี่ยนชื่องานนาทีสุดท้าย พิมพ์ JSON พัง)
 * และบูธที่เปิดไม่ติดตอนแขกต่อแถวอยู่แล้วคือความเสียหายที่แก้ไม่ทัน
 * — เสียชื่องานที่พิมพ์ผิดหนึ่งค่า ดีกว่าเสียทั้งงาน
 */

export const DEFAULTS = Object.freeze({
  lang: 'th',
  eventTitle: '',
  eventSubtitle: '',
  theme: 'wedding',
  template: 'strip',
  paper: '4x6',
  // เอฟเฟคที่จะโชว์ให้แขกเลือกหน้างาน · เลือกไว้ตั้งแต่แรกว่าจะให้มีกี่แบบ
  // แขกยืนหน้าบูธเลือกจากเจ็ดแบบคือแถวยาว — สองสามแบบพอ
  effects: ['clean', 'soft', 'film'],
  countdownSeconds: 3,
  copies: 1,
  // off = ไม่มี QR เลย · later = ชี้ไปที่ลิงก์ที่จะมีของหลังงาน · live = บูธอยู่บนเน็ตแล้ว
  qrMode: 'later',
  baseUrl: '',
  printer: { driver: 'file', name: '' },
});

const MAX_EFFECTS_AT_EVENT = 4;

const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

const clampInt = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const text = (value, max, fallback = '') => {
  if (typeof value !== 'string') return fallback;
  return value.trim().replace(/\s+/g, ' ').slice(0, max);
};

/** ที่อยู่ที่ QR จะชี้ไป — ต้องเป็น http(s) จริง ไม่งั้น QR ที่พิมพ์ไปแล้วพาไปไหนไม่ได้ */
function baseUrl(value) {
  const raw = text(value, 200);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? raw.replace(/\/+$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * เอฟเฟคที่จะให้เลือกหน้างาน — ต้องมีอย่างน้อยหนึ่ง และไม่เกินที่ปุ่มจะวางได้
 *
 * ว่างเปล่าแปลว่าแขกเลือกอะไรไม่ได้เลย ซึ่งไม่ใช่การตั้งค่าที่ใครตั้งใจ
 * เป็นผลของการพิมพ์ผิดมากกว่า — ตกกลับไปค่าเริ่มต้นดีกว่าได้บูธที่กดอะไรไม่ได้
 */
function effects(value) {
  if (!Array.isArray(value)) return [...DEFAULTS.effects];
  const picked = [...new Set(value.filter((id) => EFFECT_IDS.includes(id)))];
  return picked.length > 0 ? picked.slice(0, MAX_EFFECTS_AT_EVENT) : [...DEFAULTS.effects];
}

function printer(value) {
  const given = value && typeof value === 'object' ? value : {};
  return {
    driver: oneOf(given.driver, ['file', 'cups'], DEFAULTS.printer.driver),
    name: text(given.name, 100),
  };
}

/** ทุกค่าถูกบีบให้อยู่ในช่วงที่ใช้ได้เสมอ — ผลลัพธ์ของฟังก์ชันนี้เชื่อถือได้ทั้งก้อน */
export function normaliseSettings(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  return {
    lang: oneOf(given.lang, ['th', 'ms', 'en', 'ar'], DEFAULTS.lang),
    eventTitle: text(given.eventTitle, 42),
    eventSubtitle: text(given.eventSubtitle, 54),
    theme: oneOf(given.theme, THEME_IDS, DEFAULTS.theme),
    template: oneOf(given.template, TEMPLATE_IDS, DEFAULTS.template),
    paper: oneOf(given.paper, Object.keys(PAPERS), DEFAULTS.paper),
    effects: effects(given.effects),
    // นับถอยหลังสั้นกว่า 2 วิ แขกยังไม่ทันตั้งท่า ยาวกว่า 10 วิ แถวเริ่มยาว
    countdownSeconds: clampInt(given.countdownSeconds, 2, 10, DEFAULTS.countdownSeconds),
    // เพดาน 4 ใบต่อครั้ง กันมือลั่นสั่งพิมพ์ทีละร้อยใบซึ่งกินม้วนหมดใน 20 นาที
    copies: clampInt(given.copies, 1, 4, DEFAULTS.copies),
    qrMode: oneOf(given.qrMode, ['off', 'later', 'live'], DEFAULTS.qrMode),
    baseUrl: baseUrl(given.baseUrl),
    printer: printer(given.printer),
  };
}

/**
 * QR จะชี้ไปที่ไหน — คืน null ถ้าไม่ควรมี QR บนแผ่นนี้
 *
 * ตั้ง qrMode ไว้แต่ลืมใส่ baseUrl เป็นความผิดพลาดที่เกิดง่ายมาก และผลของมัน
 * คือ QR ที่สแกนแล้วพาไปหน้าว่าง ซึ่งแย่กว่าไม่มี QR เลย — ไม่มีดีกว่ามีแล้วพัง
 */
export function qrUrlFor(settings, token) {
  if (settings.qrMode === 'off' || !settings.baseUrl || !token) return null;
  return `${settings.baseUrl}/p/${token}`;
}

const FILE = 'settings.json';

export async function loadSettings(dir) {
  try {
    return normaliseSettings(JSON.parse(await fs.readFile(path.join(dir, FILE), 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[settings] อ่านค่าตั้งไม่ได้ ใช้ค่าเริ่มต้นแทน:', error.message);
    }
    return normaliseSettings({});
  }
}

/**
 * เขียนลงไฟล์ชั่วคราวก่อนแล้วค่อย rename ทับ
 *
 * ไฟฟ้าดับกลางเขียน (บูธรันด้วยแบตเตอรี่ในเต็นท์) แล้วได้ JSON ครึ่งไฟล์
 * คือบูธที่เปิดไม่ขึ้นในงานถัดไป · rename เป็นการกระทำเดียวจบในระบบไฟล์
 */
export async function saveSettings(dir, patch) {
  const merged = normaliseSettings({ ...(await loadSettings(dir)), ...patch });
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.part`);
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  await fs.rename(tmp, path.join(dir, FILE));
  return merged;
}
