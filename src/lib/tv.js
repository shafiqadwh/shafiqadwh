import crypto from 'node:crypto';
import { registry } from './tenancy.js';

/**
 * จับคู่ทีวีด้วยรหัสหกตัว แทนการพิมพ์ URL ด้วยรีโมต
 *
 * ทีวีอยู่ไกลมือและมีแต่ปุ่มลูกศร — การพิมพ์ที่อยู่เว็บด้วยรีโมตคือขั้นตอนที่ช้าที่สุด
 * และพิมพ์ผิดบ่อยที่สุดของการติดตั้งหน้างาน (ยิ่งเป็นเจ้าภาพที่ทำเองยิ่งหนัก)
 *
 * แทนด้วย: ทีวีโชว์รหัส + QR → เจ้าภาพยืนยันจากมือถือที่ล็อกอินแอดมินอยู่แล้ว
 * → ทีวีเด้งเข้าสไลด์โชว์เอง · **สิทธิ์ทั้งหมดอยู่ที่ฝั่งมือถือ** ทีวีไม่เคยถือรหัสผ่าน
 * และไม่มีอะไรบนจอทีวีที่หลุดออกไปแล้วเปิดหน้าแอดมินได้
 */

// อักษรชุดเดียวกับโทเคนของบูธ (Crockford ตัด I L O U) — คนอ่านจากจอทีวีแล้วพิมพ์
// ใส่มือถือได้โดยไม่สับสนระหว่าง 0 กับ O
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 6;

/** รหัสมีอายุสั้น — จอที่เปิดค้างไว้ข้ามคืนต้องไม่ถูกจับคู่ด้วยรหัสที่ใครถ่ายรูปเก็บไว้ */
export const CODE_TTL_MINUTES = 15;

export const MODES = Object.freeze(['cinema', 'wall']);
export const isMode = (value) => MODES.includes(value);
export const isCode = (value) => typeof value === 'string'
  && value.length === CODE_LENGTH
  && [...value].every((char) => ALPHABET.includes(char));

const randomCode = () => Array.from(
  { length: CODE_LENGTH },
  () => ALPHABET[crypto.randomInt(ALPHABET.length)],
).join('');

/*
 * ทะเบียนจอทีวีอยู่นอกฐานข้อมูลของงาน — เหตุผลอยู่ที่ตาราง `tv_screens`
 * ใน `src/lib/tenancy.js` · สั้น ๆ คือ APK ตัวเดียวเปิดที่อยู่เดิมเสมอ แต่ต้อง
 * ให้เจ้าภาพของงานไหนก็ได้ในเครื่องนี้จับคู่มันไปเป็นของงานตัวเองได้
 *
 * ทะเบียนมีไฟล์เดียวต่อโปรเซส เตรียมคำสั่งครั้งแรกที่ใช้แล้วจำไว้ก็พอ
 */
const prepared = new Map();
const q = (sql) => {
  if (!prepared.has(sql)) prepared.set(sql, registry().prepare(sql));
  return prepared.get(sql);
};

const statements = {
  byDevice: () => q('SELECT * FROM tv_screens WHERE device = ?'),
  byCode: () => q("SELECT * FROM tv_screens WHERE code = ? AND code_at > datetime('now', ?)"),
  upsert: () => q(`
    INSERT INTO tv_screens (device, code, code_at, host)
    VALUES (@device, @code, datetime('now'), @host)
    ON CONFLICT (device) DO UPDATE
      SET code = @code, code_at = datetime('now'), host = @host, seen_at = datetime('now')
  `),
  touch: () => q("UPDATE tv_screens SET seen_at = datetime('now') WHERE device = ?"),
  claim: () => q(`
    UPDATE tv_screens
    SET event = @event, mode = @mode, label = @label,
        paired_at = datetime('now'), code = NULL, code_at = NULL
    WHERE device = @device
  `),
  unpair: () => q('UPDATE tv_screens SET event = NULL, mode = NULL, paired_at = NULL WHERE device = ?'),
  list: () => q(`
    SELECT * FROM tv_screens
    WHERE mode IS NOT NULL AND event = ?
    ORDER BY paired_at DESC
  `),
};

export const newDeviceToken = () => crypto.randomBytes(24).toString('base64url');

export const findScreen = (device) => (device ? statements.byDevice().get(device) : undefined);

/**
 * ขอรหัสใหม่ให้จอนี้ · เรียกซ้ำได้ รหัสเดิมถูกแทนที่ทุกครั้งที่จอเปิดหน้าจับคู่
 *
 * รหัสซ้ำกับจออื่นเป็นไปได้ในทางทฤษฎี (32^6 = พันล้านแบบ แต่ก็ยังชนกันได้)
 * และดัชนี unique จะปฏิเสธ — ลองใหม่ไม่กี่ครั้งก็พอ ดีกว่าปล่อยให้จอสองเครื่อง
 * ถือรหัสเดียวกันแล้วเจ้าภาพจับคู่โดนผิดเครื่อง
 */
export function issueCode(device, host = '', attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    const code = randomCode();
    try {
      statements.upsert().run({ device, code, host: String(host || '') || null });
      return code;
    } catch (error) {
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
  }
  throw new Error('ออกรหัสจับคู่ทีวีไม่ได้ — รหัสชนกันติดกันหลายครั้งผิดปกติ');
}

/** จอที่ถือรหัสนี้อยู่ และรหัสยังไม่หมดอายุ */
export const screenForCode = (code) => (isCode(code)
  ? statements.byCode().get(code, `-${CODE_TTL_MINUTES} minutes`)
  : undefined);

/**
 * ยืนยันการจับคู่ — เรียกจากฝั่งแอดมินของงานที่จะเอาจอไปใช้เท่านั้น
 *
 * ล้างรหัสทิ้งทันทีที่ใช้แล้ว (`code = NULL`) รหัสจึงใช้ได้ครั้งเดียว · ใครถ่ายรูป
 * จอทีวีไว้ตอนงานแล้วเอามาลองทีหลังก็ไม่เจออะไร
 *
 * `event` คืองานที่กดยืนยัน — จอเครื่องเดียวกันจึงย้ายข้ามงานได้ด้วยการจับคู่ใหม่
 * โดยเจ้าภาพของอีกงาน ไม่ต้องไปตั้งค่าอะไรที่ตัวทีวีเลย
 */
export function claimScreen(code, { mode, label = '', event }) {
  const screen = screenForCode(code);
  if (!screen) return null;
  if (!isMode(mode) || !event) return null;

  statements.claim().run({
    device: screen.device, event, mode, label: label.slice(0, 60) || null,
  });
  return statements.byDevice().get(screen.device);
}

export const unpairScreen = (device) => statements.unpair().run(device);
export const listScreens = (event) => statements.list().all(String(event ?? ''));
export const touchScreen = (device) => statements.touch().run(device);
