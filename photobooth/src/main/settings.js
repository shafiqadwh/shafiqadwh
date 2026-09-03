import { randomInt } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { THEME_IDS } from '../../../shared/themes.js';
import { EFFECT_IDS } from '../core/effects.js';
import { TEMPLATE_IDS } from '../core/templates.js';
import { PAGES, PAPERS } from '../core/paper.js';
import { KEY_ACTIONS } from '../core/keys.js';
import { isPrice, payTarget } from '../core/promptpay.js';

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
  // กระดาษที่ใส่ในเครื่องพิมพ์จริง · `same` = เท่าขนาดสินค้า (dye-sub หรือกระดาษรูป 4×6)
  // ตั้งเป็น A4 เมื่อใช้อิงค์เจ็ทกระดาษธรรมดา แล้วแผ่นจะไปนั่งกลางหน้าพร้อมเส้นตัด
  printPage: 'same',
  // เอฟเฟคที่จะโชว์ให้แขกเลือกหน้างาน · เลือกไว้ตั้งแต่แรกว่าจะให้มีกี่แบบ
  // แขกยืนหน้าบูธเลือกจากเจ็ดแบบคือแถวยาว — สองสามแบบพอ
  effects: ['clean', 'soft', 'film'],
  countdownSeconds: 3,
  copies: 1,
  /*
   * แขกได้รูปกลับไปทางไหน — คนละเรื่องกับ `qrMode` ที่คุม QR *บนกระดาษ*
   *
   * print  = พิมพ์อย่างเดียว (ต้องมีเครื่องพิมพ์)
   * screen = ขึ้น QR บนจอให้สแกนรับไฟล์ทันที **ไม่ต้องมีเครื่องพิมพ์เลย**
   * both   = ทั้งสองอย่าง
   *
   * โหมด screen ต้องส่งรูปขึ้นเว็บทันทีตอนนั้น จึงต้องมี baseUrl กับ uploadKey
   * ครบ — ขาดอย่างใดอย่างหนึ่งจะถูกบีบกลับเป็น print ให้เอง ไม่ใช่ปล่อยให้ไปเจอ
   * จอที่ขึ้น QR ที่สแกนแล้วไม่มีอะไร
   */
  deliver: 'print',
  // off = ไม่มี QR เลย · later = ชี้ไปที่ลิงก์ที่จะมีของหลังงาน · live = บูธอยู่บนเน็ตแล้ว
  qrMode: 'later',
  /*
   * QR พาไปไหน — **เลือกก่อนตั้งบูธ เปลี่ยนกลางงานไม่ได้**
   *
   * session = เห็นเฉพาะรอบของตัวเอง (ค่าเริ่มต้น · เหมาะกับงานที่แขกไม่รู้จักกัน)
   * album   = เห็นรูปทั้งงานและโหลดทั้งหมดได้ โดยรอบของคนที่สแกนถูกยกขึ้นมาบนสุด
   *
   * เปลี่ยนกลางงานแล้วแผ่นที่พิมพ์ไปก่อนหน้าจะพาไปคนละที่กับแผ่นหลังจากนั้น
   * และแขกที่ถือกระดาษกลับบ้านไปแล้วเราตามไปแก้ไม่ได้
   */
  qrTarget: 'session',
  // รหัสอัลบั้มของงานนี้ · สร้างครั้งเดียวตอนเปิดบูธในโหมด album แล้วห้ามเปลี่ยน
  albumCode: '',
  /*
   * ทำภาพเคลื่อนไหว (GIF) จากรูปชุดเดียวกับที่พิมพ์
   *
   * เป็นของที่แขกได้กลับไปใช้จริงมากที่สุด — แผ่นอยู่ในกระเป๋า แต่ GIF ถูกส่งต่อ
   * ในไลน์กลุ่มครอบครัวคืนนั้นเลย · ปิดได้ถ้าเครื่องช้าหรือแบบที่ใช้ถ่ายใบเดียว
   */
  gif: true,
  baseUrl: '',
  // กุญแจเดียวกับ BOOTH_KEY ฝั่งเว็บ · เดินทางเป็น HTTP header จึงต้องเป็น ASCII
  uploadKey: '',
  /*
   * ขายรูปหน้าบูธด้วย QR พร้อมเพย์
   *
   * เปิดใช้ตอนเปิดบูธเอง (ออกงาน หรือกางหน้าบ้าน) · ปิดไว้ตอนรับจ้างงานที่
   * เจ้าภาพจ่ายค่าบูธไปแล้ว ซึ่งเป็นค่าเริ่มต้น — แขกในงานแต่งต้องไม่เจอหน้าจ่ายเงิน
   *
   * `target` = เบอร์พร้อมเพย์/เลขบัตร/e-Wallet ที่รับเงิน · `price` = บาทต่อหนึ่งรอบ
   * **โปรแกรมรู้ได้แค่ว่าโชว์ QR ไปแล้ว ไม่มีทางรู้ว่าเงินเข้าหรือยัง** คนกดยืนยันเสมอ
   *
   * `payWhen` — จ่ายตอนไหน · เลือกตามงาน ไม่ใช่ตามความชอบ
   *
   * `after`  (ค่าเริ่มต้น) ถ่าย → ดูแผ่น → จ่าย → พิมพ์
   *          แขกเห็นของก่อนจ่าย ไม่มีเรื่องขอเงินคืนเพราะรูปไม่ถูกใจ
   *          เหมาะกับงานที่คนมาถ่ายเพราะตั้งใจจะซื้ออยู่แล้ว
   *
   * `before` จ่าย → ถ่าย → ดูแผ่น → พิมพ์
   *          **กันคนเข้ามาลองเล่นแล้วเดินหนี** ซึ่งไม่ใช่แค่เสียรายได้ แต่เสีย
   *          "คิว" ด้วย — คนที่ตั้งใจจะซื้อต้องยืนรอคนที่ไม่ได้ตั้งใจจะซื้อ
   *          เหมาะกับงานที่คนเยอะและเข้าถึงบูธได้ฟรี (งานโรงเรียน งานวัด ตลาดนัด)
   */
  sale: { enabled: false, target: '', price: 0, payWhen: 'after' },
  printer: { driver: 'file', name: '' },
  // จอที่สองสำหรับช่างภาพ · auto = ใช้เมื่อเสียบจอไว้จริง, off = ไม่ใช้แม้จะมีจอ
  operatorScreen: 'auto',
  /*
   * รีโมทกดถ่าย — รับปุ่มจากหน้าต่างที่โฟกัสอยู่เสมอ (ดู remote.js)
   *
   * `globalKeys` คือปุ่มที่ยอมให้ยึดทั้งเครื่อง สำหรับปุ่มที่เดสก์ท็อปกินไปก่อน
   * (ปุ่มเสียงบน Linux) · ว่างไว้เป็นค่าเริ่มต้นโดยตั้งใจ เพราะการยึด Enter
   * ทั้งเครื่องแปลว่าโปรแกรมอื่นบนเครื่องนั้นใช้ปุ่มนั้นไม่ได้ไปจนกว่าจะปิดบูธ
   */
  remote: { enabled: true, globalKeys: [] },
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

// กุญแจเดินทางเป็น HTTP header ซึ่งรับได้แค่ ASCII พิมพ์ได้ · ตั้งเป็นภาษาไทยแล้ว
// `fetch` จะโยน error ตั้งแต่ยังไม่ได้ส่ง โดยไม่มีอะไรชี้ว่าเป็นเพราะกุญแจ
const usableKey = (value) =>
  typeof value === 'string' && value.length >= 16 && /^[\x20-\x7e]+$/.test(value);

/*
 * รหัสอัลบั้มของงาน — 8 ตัวจากอักษรชุดเดียวกับโทเคนรอบถ่าย (Crockford ตัด I L O U)
 *
 * ยาวกว่าโทเคนรอบถ่ายเพราะมันเปิดรูป **ทั้งงาน** ไม่ใช่รอบเดียว · ต้องตรงกับ
 * ตัวตรวจฝั่งเว็บใน src/routes/booth.js — รหัสที่ฝั่งนั้นไม่รับ จะกลายเป็นรอบที่
 * ไม่สังกัดอัลบั้มไหนเลย แล้ว QR ที่พิมพ์ไปแล้วจะเปิดอัลบั้มว่าง
 */
const ALBUM_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ALBUM_LENGTH = 8;

export const isAlbumCode = (value) =>
  typeof value === 'string'
  && value.length === ALBUM_LENGTH
  && [...value].every((char) => ALBUM_ALPHABET.includes(char));

export const newAlbumCode = () => Array.from(
  { length: ALBUM_LENGTH },
  () => ALBUM_ALPHABET[randomInt(ALBUM_ALPHABET.length)],
).join('');

/** ส่งรูปขึ้นเว็บได้จริงไหม — โหมด screen ทั้งหมดขึ้นอยู่กับข้อนี้ */
export const canPublish = (settings) =>
  Boolean(settings.baseUrl) && usableKey(settings.uploadKey);

/**
 * ค่าการขาย — เปิดได้ก็ต่อเมื่อ **ทั้งเบอร์และราคาใช้ได้จริง**
 *
 * ตั้ง enabled ไว้แต่ลืมใส่เบอร์ = หน้าจ่ายเงินที่ไม่มี QR ให้สแกน ซึ่งแขกยืนงง
 * อยู่หน้าบูธแล้วช่างภาพต้องมาแก้กลางแถว · บีบกลับเป็น "ไม่ขาย" ให้เลย
 * (กติกาเดียวกับที่ `deliver` ถูกบีบกลับเป็น print เมื่อส่งขึ้นเว็บไม่ได้)
 */
function sale(value) {
  const given = value && typeof value === 'object' ? value : {};
  // เก็บเฉพาะตัวเลข — เบอร์ที่พิมพ์มาพร้อมขีดยังใช้ได้ แต่ในไฟล์เก็บรูปเดียว
  const target = payTarget(given.target) ? String(given.target).replace(/\D/g, '') : '';
  const price = isPrice(given.price) ? Math.round(Number(given.price) * 100) / 100 : 0;
  return {
    enabled: given.enabled === true && Boolean(target) && price > 0,
    target,
    price,
    payWhen: oneOf(given.payWhen, ['after', 'before'], DEFAULTS.sale.payWhen),
  };
}

function printer(value) {
  const given = value && typeof value === 'object' ? value : {};
  return {
    driver: oneOf(given.driver, ['file', 'cups'], DEFAULTS.printer.driver),
    name: text(given.name, 100),
  };
}

/**
 * ปุ่มรีโมทที่ยอมให้ยึดทั้งเครื่อง — เฉพาะปุ่มที่บูธรู้จักเท่านั้น
 *
 * ปุ่มที่ไม่มีในตารางแปลว่ากดแล้วไม่เกิดอะไรขึ้น · ยึดปุ่มทั้งเครื่องไว้เฉย ๆ
 * โดยไม่ได้ใช้ คือการทำให้โปรแกรมอื่นบนเครื่องนั้นเสียปุ่มไปเปล่า ๆ
 */
function remote(value) {
  const given = value && typeof value === 'object' ? value : {};
  const keys = Array.isArray(given.globalKeys) ? given.globalKeys : [];
  return {
    enabled: given.enabled !== false,
    globalKeys: [...new Set(keys.filter((key) => KEY_ACTIONS[key]))],
  };
}

/** ทุกค่าถูกบีบให้อยู่ในช่วงที่ใช้ได้เสมอ — ผลลัพธ์ของฟังก์ชันนี้เชื่อถือได้ทั้งก้อน */
export function normaliseSettings(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const settings = {
    lang: oneOf(given.lang, ['th', 'ms', 'en', 'ar'], DEFAULTS.lang),
    eventTitle: text(given.eventTitle, 42),
    eventSubtitle: text(given.eventSubtitle, 54),
    theme: oneOf(given.theme, THEME_IDS, DEFAULTS.theme),
    template: oneOf(given.template, TEMPLATE_IDS, DEFAULTS.template),
    paper: oneOf(given.paper, Object.keys(PAPERS), DEFAULTS.paper),
    printPage: oneOf(given.printPage, Object.keys(PAGES), DEFAULTS.printPage),
    effects: effects(given.effects),
    // นับถอยหลังสั้นกว่า 2 วิ แขกยังไม่ทันตั้งท่า ยาวกว่า 10 วิ แถวเริ่มยาว
    countdownSeconds: clampInt(given.countdownSeconds, 2, 10, DEFAULTS.countdownSeconds),
    // เพดาน 4 ใบต่อครั้ง กันมือลั่นสั่งพิมพ์ทีละร้อยใบซึ่งกินม้วนหมดใน 20 นาที
    copies: clampInt(given.copies, 1, 4, DEFAULTS.copies),
    qrMode: oneOf(given.qrMode, ['off', 'later', 'live'], DEFAULTS.qrMode),
    qrTarget: oneOf(given.qrTarget, ['session', 'album'], DEFAULTS.qrTarget),
    gif: given.gif !== false,
    albumCode: isAlbumCode(given.albumCode) ? given.albumCode : '',
    baseUrl: baseUrl(given.baseUrl),
    uploadKey: usableKey(given.uploadKey) ? given.uploadKey : '',
    sale: sale(given.sale),
    printer: printer(given.printer),
    operatorScreen: oneOf(given.operatorScreen, ['auto', 'off'], DEFAULTS.operatorScreen),
    remote: remote(given.remote),
  };

  // บีบ deliver ให้ตรงกับความจริง — ขอ screen ไว้แต่ส่งขึ้นเว็บไม่ได้ คือจอที่
  // ขึ้น QR ที่สแกนแล้วไม่มีอะไร ซึ่งแย่กว่าไม่มีโหมดนั้นเลย
  const wanted = oneOf(given.deliver, ['print', 'screen', 'both'], DEFAULTS.deliver);
  settings.deliver = wanted === 'print' || canPublish(settings) ? wanted : 'print';
  return settings;
}

/**
 * ที่อยู่ของรูปชุดนี้บนเว็บ — คำถาม "รูปอยู่ที่ไหน" ล้วน ๆ
 *
 * ขึ้นกับ baseUrl อย่างเดียว ไม่เกี่ยวกับ qrMode เลย · โหมดจอใช้ตัวนี้ เพราะ QR
 * บนจอ **คือตัวส่งมอบ** ไม่ใช่ของแถมที่ปิดได้
 *
 * โหมดอัลบั้มพาไปที่อัลบั้มของทั้งงาน **โดยมีรหัสรอบติดไปด้วย** เพื่อให้หน้านั้น
 * ยกรูปของคนที่สแกนขึ้นมาไว้บนสุด — ถ้า QR ทุกใบเหมือนกันหมด แขกจะต้องไล่หา
 * รูปตัวเองในกองเป็นร้อยใบ ซึ่งทำให้โหมดนี้ใช้ไม่ได้จริงกับคนที่ถือกระดาษมาใบเดียว
 */
export function photoUrl(settings, token) {
  if (!settings.baseUrl || !token) return null;
  if (settings.qrTarget === 'album') {
    // ตั้งโหมดอัลบั้มไว้แต่ยังไม่มีรหัสอัลบั้ม = ยังไม่มีที่ให้ไป · ตกกลับไปหน้า
    // ของรอบตัวเอง ซึ่งถูกต้องเสมอ ดีกว่า QR ที่พาไปหน้าที่ไม่มีอยู่จริง
    if (isAlbumCode(settings.albumCode)) return `${settings.baseUrl}/b/${settings.albumCode}/${token}`;
    console.warn('[settings] โหมดอัลบั้มแต่ยังไม่มีรหัสอัลบั้ม — ใช้ลิงก์รอบเดี่ยวแทน');
  }
  return `${settings.baseUrl}/p/${token}`;
}

/**
 * QR ที่จะ *พิมพ์ลงบนแผ่น* — คนละคำถามกับข้างบน จึงคนละฟังก์ชัน
 *
 * เดิมเป็นฟังก์ชันเดียวกัน แล้วโหมดจอที่ตั้ง `qrMode: 'off'` ไว้ (ซึ่งสมเหตุสมผล
 * มาก เพราะโหมดจอไม่ได้พิมพ์อะไร) ได้ที่อยู่เป็น null แล้วพังตอนสร้าง QR ขึ้นจอ
 * — คำถามสองข้อที่ต่างกันไม่ควรใช้ทางเดียวกัน
 *
 * และตั้ง qrMode ไว้แต่ลืมใส่ baseUrl ยังคงแปลว่าไม่มี QR บนกระดาษ:
 * QR ที่สแกนแล้วพาไปหน้าว่าง แย่กว่าไม่มี QR เลย
 */
export function sheetQrUrl(settings, token) {
  return settings.qrMode === 'off' ? null : photoUrl(settings, token);
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
/**
 * โหมดอัลบั้มต้องมีรหัสอัลบั้มก่อนถ่ายรูปแรก
 *
 * สร้างครั้งเดียวแล้วเขียนลงไฟล์ทันที · **ห้ามสร้างใหม่ถ้ามีอยู่แล้ว** เพราะแผ่นที่
 * พิมพ์ไปแล้วมี QR ที่ชี้ไปที่รหัสเดิม — สร้างใหม่กลางงานแปลว่าแขกครึ่งแรกถือกระดาษ
 * ที่พาไปอัลบั้มที่ไม่มีรูปของใครเลย และเราตามไปแก้ไม่ได้
 */
export async function ensureAlbumCode(dir, settings) {
  if (settings.qrTarget !== 'album' || isAlbumCode(settings.albumCode)) return settings;
  const saved = await saveSettings(dir, { albumCode: newAlbumCode() });
  console.log(`[booth] สร้างรหัสอัลบั้มของงานนี้: ${saved.albumCode} (ห้ามเปลี่ยนระหว่างงาน)`);
  return saved;
}

export async function saveSettings(dir, patch) {
  const merged = normaliseSettings({ ...(await loadSettings(dir)), ...patch });
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `${FILE}.part`);
  await fs.writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`);
  await fs.rename(tmp, path.join(dir, FILE));
  return merged;
}
