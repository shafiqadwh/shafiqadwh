import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * หนึ่งรอบถ่าย = หนึ่งโฟลเดอร์บนดิสก์
 *
 * เก็บทั้งรูปดิบและแผ่นที่ประกอบแล้ว เพราะสองอย่างนี้ใช้คนละงาน: แผ่นเอาไปพิมพ์
 * ส่วนรูปดิบคือของที่แขกจะได้ตอนสแกน QR (และเป็นทางกลับถ้าอยากประกอบใหม่ด้วย
 * แบบอื่นหลังงาน) · ไม่มีฐานข้อมูล — โฟลเดอร์คือทะเบียน อ่านจากของจริงเสมอ
 * ลบโฟลเดอร์ทิ้งเองแล้วรายการต้องหายตาม ซึ่งเป็นกติกาเดิมของโปรเจกต์นี้
 */

/*
 * Crockford base32 — ตัดตัวที่คนอ่านสลับกันออก (I L O U)
 *
 * โทเคนนี้ไปอยู่บนกระดาษที่แขกถือกลับบ้าน · สแกน QR ไม่ติดเมื่อไร (กระดาษยับ
 * แสงสะท้อน) แขกจะพิมพ์เอง — "0" กับ "O" หรือ "1" กับ "I" ทำให้พิมพ์ผิดแน่นอน
 * 6 ตัวจากอักษร 32 ตัว = 1,073,741,824 แบบ พอสำหรับงานหลายพันงาน
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TOKEN_LENGTH = 6;

export function newToken(length = TOKEN_LENGTH) {
  // ใช้ randomInt ไม่ใช่ % ของ randomBytes — 256 หารด้วย 32 ลงตัวก็จริง แต่การ
  // เขียนแบบ % ทำให้คนแก้ทีหลังเผลอเปลี่ยนความยาวตัวอักษรแล้วได้ค่าที่เอนไปทางหนึ่ง
  let out = '';
  for (let i = 0; i < length; i += 1) out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return out;
}

export const isToken = (value) =>
  typeof value === 'string'
  && value.length === TOKEN_LENGTH
  && [...value].every((char) => ALPHABET.includes(char));

const dirFor = (root, token) => path.join(root, token);

/**
 * จองโทเคนที่ยังไม่มีใครใช้ โดยการสร้างโฟลเดอร์ให้สำเร็จ
 *
 * `mkdir` แบบไม่ใส่ recursive จะล้มด้วย EEXIST ถ้ามีอยู่แล้ว — ใช้ตัวระบบไฟล์เอง
 * เป็นตัวตัดสินว่าใครได้โทเคนนี้ แทนที่จะ "เช็คก่อนแล้วค่อยสร้าง" ซึ่งมีช่องว่าง
 * ระหว่างสองขั้นให้อีกรอบถ่ายแทรกเข้ามาได้ (บูธสองตัวเขียนลงโฟลเดอร์แชร์เดียวกัน)
 *
 * แยกออกมาให้เรียกก่อนประกอบแผ่นได้ เพราะ QR ต้องมีโทเคนอยู่ในนั้นตั้งแต่ตอน
 * ประกอบ — ไม่งั้นต้องประกอบสองรอบ (รอบแรกเพื่อเอาไปจองที่ รอบสองใส่โทเคนจริง)
 * ซึ่งเสียเวลาไปฟรี ๆ หนึ่งวินาทีต่อแขกหนึ่งคน โดยที่แขกยืนรออยู่
 */
export async function reserveSession(root, attempts = 8) {
  const token = await claimToken(root, attempts);
  return { token, dir: dirFor(root, token) };
}

async function claimToken(root, attempts = 8) {
  await fs.mkdir(root, { recursive: true });
  for (let i = 0; i < attempts; i += 1) {
    const token = newToken();
    try {
      await fs.mkdir(dirFor(root, token));
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`หาโทเคนที่ว่างไม่ได้หลังลอง ${attempts} ครั้ง — โฟลเดอร์ ${root} เต็มผิดปกติ`);
}

/**
 * บันทึกรอบถ่ายหนึ่งรอบ
 *
 * เขียนรูปดิบและแผ่นก่อน แล้วค่อยเขียน `session.json` เป็นชิ้นสุดท้ายเสมอ —
 * ไฟล์นั้นคือสัญญาณว่า "รอบนี้ครบแล้ว" ตัวอ่านจึงข้ามโฟลเดอร์ที่ไฟดับกลางทาง
 * ไปได้เองโดยไม่ต้องมีใครมาเก็บกวาด และไม่มีทางอัปโหลดของครึ่ง ๆ กลาง ๆ ขึ้นเว็บ
 */
export async function saveSession(root, { token, photos, sheet, gif, settings, effect, template }) {
  if (!isToken(token)) throw new Error(`โทเคนไม่ถูกต้อง: ${token}`);
  const dir = dirFor(root, token);
  const shotNames = [];

  try {
    await fs.mkdir(path.join(dir, 'shots'));
    for (const [index, photo] of photos.entries()) {
      const name = `shot-${index + 1}.jpg`;
      await fs.writeFile(path.join(dir, 'shots', name), photo);
      shotNames.push(name);
    }
    await fs.writeFile(path.join(dir, 'sheet.jpg'), sheet.data);
    // ภาพเคลื่อนไหวเป็นของแถม ไม่ใช่ของหลัก · รอบที่ทำไม่ได้ (ถ่ายใบเดียว) ต้อง
    // บันทึกได้ตามปกติ ไม่ใช่ล้มทั้งรอบเพราะขาดไฟล์นี้
    if (gif) await fs.writeFile(path.join(dir, 'strip.gif'), gif);

    const manifest = {
      token,
      createdAt: new Date().toISOString(),
      // รอบนี้สังกัดอัลบั้มไหน · โหมด "เห็นเฉพาะรูปตัวเอง" ไม่สังกัดอัลบั้มใดเลย
      // และต้องเป็น null จริง ๆ ไม่ใช่รหัสว่าง ไม่งั้นทุกรอบของทุกงานจะไปกองรวมกัน
      // อยู่ในอัลบั้มชื่อ "" เดียวกันบนเว็บ
      album: settings.qrTarget === 'album' ? settings.albumCode || null : null,
      event: { title: settings.eventTitle, subtitle: settings.eventSubtitle, theme: settings.theme },
      template,
      effect,
      paper: settings.paper,
      sheet: { file: 'sheet.jpg', width: sheet.width, height: sheet.height, dpi: sheet.dpi },
      gif: gif ? 'strip.gif' : null,
      shots: shotNames,
      uploaded: false,
    };
    await fs.writeFile(path.join(dir, 'session.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { token, dir, sheetPath: path.join(dir, 'sheet.jpg'), manifest };
  } catch (error) {
    // เก็บกวาดโฟลเดอร์ที่ไม่ครบทิ้งไป ไม่ปล่อยให้ค้างเป็นขยะที่ไม่มีใครรู้ว่าคืออะไร
    await fs.rm(dir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * ทิ้งรอบถ่ายที่แขกกด "ถ่ายใหม่"
 *
 * ไม่ลบแล้วจะเหลือรูปเต็มความละเอียดสามใบบวกแผ่นขนาดพิมพ์ค้างไว้ทุกครั้งที่มีคน
 * ถ่ายไม่ถูกใจ — ซึ่งเกิดบ่อยมาก · ที่แย่กว่าเปลืองดิสก์คือรอบที่แขกตั้งใจทิ้ง
 * จะถูกอัปโหลดขึ้นเว็บไปให้คนอื่นดูทีหลังพร้อมกับรอบที่เขาเลือกเอา
 */
export async function discardSession(root, token) {
  if (!isToken(token)) throw new Error(`โทเคนไม่ถูกต้อง: ${token}`);
  await fs.rm(dirFor(root, token), { recursive: true, force: true });
}

export async function readSession(root, token) {
  if (!isToken(token)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(dirFor(root, token), 'session.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** ทุกรอบที่บันทึกครบแล้ว ใหม่สุดก่อน — อ่านจากโฟลเดอร์จริง ไม่ใช่ทะเบียนแยก */
export async function listSessions(root) {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[session] อ่านโฟลเดอร์รอบถ่ายไม่ได้:', error.message);
    return [];
  }

  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isToken(entry.name)) continue;
    const manifest = await readSession(root, entry.name);
    if (manifest) found.push(manifest);
  }
  return found.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
