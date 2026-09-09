import fs from 'node:fs/promises';
import path from 'node:path';
import { isToken, listSessions, readSession } from './session.js';

/**
 * ส่งรอบถ่ายขึ้นเว็บ — ทำหลังงาน ไม่ใช่ระหว่างงาน
 *
 * บูธทำงานในเต็นท์ที่ไม่มีเน็ต · โทเคนถูกจองไว้ตั้งแต่ตอนพิมพ์แล้ว ลิงก์บนกระดาษ
 * จึงถูกต้องมาตั้งแต่แรก แค่ยังไม่มีอะไรอยู่ปลายทางจนกว่าจะส่งขึ้นไป
 *
 * กติกาที่ยึด
 * - **ส่งซ้ำต้องปลอดภัยเสมอ** เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกเสร็จแต่ก่อนตอบกลับ
 *   เป็นเรื่องที่เกิดจริง · ฝั่งเซิร์ฟเวอร์ตอบ duplicate กลับมา เราถือว่าสำเร็จ
 * - **ทำเครื่องหมายว่าส่งแล้วหลังเซิร์ฟเวอร์ยืนยัน ไม่ใช่ก่อน** เขียนก่อนแล้ว
 *   เน็ตหลุด = รอบนั้นหายไปตลอดกาลโดยไม่มีใครรู้
 * - **รอบหนึ่งล้มไม่ทำให้ทั้งชุดหยุด** ส่งต่อให้ครบแล้วค่อยรายงานว่าอันไหนไม่ผ่าน
 * - **200 ไม่ใช่หลักฐานว่าถึงเว็บเรา** ต้องเห็นคำตอบของเว็บเราจริง ๆ ดู `uploadSession`
 */

/*
 * เพดานเวลาต่อหนึ่งรอบ
 *
 * `fetch` ของ Node **ไม่มี timeout ติดมาเลย** ปลายทางที่รับซ็อกเก็ตแล้วไม่ตอบอะไร
 * (หน้าล็อกอิน WiFi, เราเตอร์ค้าง, พอร์ตที่ forward ไปผิดเครื่อง) ทำให้ตัวส่งค้าง
 * อยู่อย่างนั้นตลอดไป ไม่มีทั้งข้อความและทางหยุด — และมันค้างที่รอบแรก
 * แปลว่าอีกหลายร้อยรอบไม่ได้ถูกส่งเลยโดยไม่มีอะไรบอก
 *
 * 4 นาทีเผื่อไว้เยอะ: หนึ่งรอบคือแผ่นหนึ่งใบกับรูปดิบไม่เกินแปดใบ ราว 15 MB
 * ที่ขาออกบ้าน 1 Mbps ใช้เวลาราวสองนาที · ไม่ใช่ตัวเลขที่จะไปตัดงานที่เดินอยู่จริง
 * แต่กันการค้างไม่มีที่สิ้นสุดได้
 */
const UPLOAD_TIMEOUT_MS = 4 * 60 * 1000;

/**
 * เพดานเวลาตอนส่งสด ๆ ระหว่างที่แขกยังยืนอยู่หน้าบูธ
 *
 * คนละเรื่องกับการส่งทีหลัง: ตรงนั้นไม่มีใครรอ รอให้นานหน่อยก็ได้ · ตรงนี้มีคนรอ
 * และ **การส่งไม่สำเร็จไม่เสียอะไรเลย** — QR บนกระดาษถูกต้องอยู่แล้ว รอบนี้ค้างใน
 * คิวและตามขึ้นไปทีหลังเอง · รออีกสี่นาทีคือคิวที่ยาวขึ้นเรื่อย ๆ เพื่อแลกกับศูนย์
 */
export const LIVE_TIMEOUT_MS = 20 * 1000;

export class UploadError extends Error {
  constructor(message, { status = 0, token = null } = {}) {
    super(message);
    this.status = status;
    this.token = token;
  }
}

/** อ่านไฟล์ของรอบถ่ายหนึ่งรอบขึ้นมาเป็นฟอร์มพร้อมส่ง */
async function bundleFor(root, manifest) {
  const dir = path.join(root, manifest.token);
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest));
  form.append('sheet', new Blob([await fs.readFile(path.join(dir, 'sheet.jpg'))]), 'sheet.jpg');

  for (const name of manifest.shots ?? []) {
    form.append('shots', new Blob([await fs.readFile(path.join(dir, 'shots', name))]), name);
  }

  // รอบเก่าที่บันทึกไว้ก่อนมีฟีเจอร์นี้ไม่มีไฟล์ GIF — ส่งเท่าที่มี ไม่ใช่ล้มทั้งรอบ
  if (manifest.gif) {
    const gif = await fs.readFile(path.join(dir, manifest.gif)).catch(() => null);
    if (gif) form.append('gif', new Blob([gif]), manifest.gif);
  }
  return form;
}

/** จดว่าส่งขึ้นไปแล้ว — เขียนทับ session.json แบบเขียนไฟล์ชั่วคราวก่อนแล้ว rename */
async function markUploaded(root, token) {
  const file = path.join(root, token, 'session.json');
  const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
  manifest.uploaded = true;
  manifest.uploadedAt = new Date().toISOString();

  const tmp = `${file}.part`;
  await fs.writeFile(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.rename(tmp, file);
}

export async function uploadSession(root, token, {
  baseUrl, key, fetchImpl = fetch, timeoutMs = UPLOAD_TIMEOUT_MS,
} = {}) {
  if (!isToken(token)) throw new UploadError(`โทเคนไม่ถูกต้อง: ${token}`, { token });
  const manifest = await readSession(root, token);
  if (!manifest) throw new UploadError('ไม่พบรอบถ่ายนี้ หรือรอบนี้บันทึกไม่ครบ', { token });

  /*
   * **รอบถ่ายขึ้นได้เฉพาะเว็บที่มันถูกพิมพ์ไว้ให้ขึ้น**
   *
   * บูธตัวเดียววิ่งหลายงาน และการส่งเกิดทีหลัง (มักเป็นวันรุ่งขึ้น) · เจ้าของที่รับงาน
   * ที่สองแล้วเปลี่ยนที่อยู่เว็บในหน้าตั้งค่าก่อนจะได้กดส่งงานแรก จะส่งรอบของงานแรก
   * ขึ้นเว็บของงานที่สองโดยไม่มีอะไรเตือน — รูปของลูกค้าคนหนึ่งไปโผล่ในอัลบั้มของ
   * ลูกค้าอีกคน และเอากลับไม่ได้เมื่อเกิดแล้ว
   *
   * ปฏิเสธพร้อมบอกที่อยู่ทั้งสองฝั่ง ดีกว่าเดาแทนคน — ตั้งที่อยู่กลับไปแล้วกดส่งอีกที
   * คือทางแก้ที่ทำได้เองทันทีและไม่เสียอะไรเลย
   */
  const intended = String(manifest.uploadTo ?? '').replace(/\/+$/, '');
  if (intended && intended !== baseUrl.replace(/\/+$/, '')) {
    throw new UploadError(
      `รอบนี้เป็นของงานที่ส่งขึ้น ${intended} ไม่ใช่ ${baseUrl}`
      + ' — ตั้งที่อยู่เว็บกลับเป็นของงานนั้นก่อนแล้วกดส่งอีกครั้ง',
      { token },
    );
  }

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/booth/upload`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'x-booth-key': key },
      body: await bundleFor(root, manifest),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // หมดเวลารอ ≠ ต่อไม่ติด — อันแรกคือปลายทางรับสายแล้วเงียบ (หน้าล็อกอิน WiFi,
    // เราเตอร์ค้าง) อันหลังคือไปไม่ถึงเลย · คนอ่านต้องแยกสองอย่างนี้ออกจากกัน
    if (error.name === 'TimeoutError' || error.cause?.name === 'TimeoutError') {
      throw new UploadError(
        `${baseUrl} รับสายแล้วไม่ตอบภายใน ${Math.round(timeoutMs / 60000)} นาที`
        + ' — ถ้าเน็ตที่ใช้มีหน้าล็อกอิน ต้องล็อกอินให้ผ่านก่อน',
        { token },
      );
    }
    // เน็ตไม่ถึงปลายทาง — ต่างจาก "ปลายทางปฏิเสธ" ตรงที่ลองใหม่ทีหลังได้เลย
    throw new UploadError(`ต่อไปที่ ${baseUrl} ไม่ได้: ${error.message}`, { token });
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new UploadError(
      response.status === 401
        ? 'กุญแจไม่ถูกต้อง — ตรวจ BOOTH_KEY ทั้งฝั่งเว็บและฝั่งบูธว่าตรงกัน'
        : `เซิร์ฟเวอร์ปฏิเสธ (${response.status}) ${body.slice(0, 120)}`,
      { status: response.status, token },
    );
  }

  /*
   * **200 ไม่ได้แปลว่าถึงเว็บเรา** — ต้องเห็นคำตอบของเว็บเราจริง ๆ ถึงจะจดว่าส่งแล้ว
   *
   * เน็ตที่มีหน้าล็อกอิน (โรงแรม ร้านกาแฟ WiFi ของสถานที่) ตอบ 200 พร้อมหน้า HTML
   * ให้กับทุก URL ที่ยิงไป · ที่อยู่ที่พิมพ์ผิดไปชนเว็บอื่นก็ตอบ 200 ได้เหมือนกัน
   * ของเดิมเชื่อแค่สถานะ แล้วจด `uploaded: true` ทับลงไป — ผลคือ **รอบนั้นไม่ถูกส่ง
   * ซ้ำอีกตลอดกาล** ทั้งที่ไม่มีอะไรขึ้นเว็บเลย และ QR บนกระดาษในมือแขกก็ตายถาวร
   * ซึ่งเป็นความเสียหายที่ย้อนไม่ได้ ต่างจากการส่งไม่สำเร็จที่กดส่งใหม่ได้
   *
   * เว็บเราตอบ `{ ok: true, token }` ทั้งตอนบันทึกใหม่ (201) และตอนซ้ำ (200)
   */
  const result = await response.json().catch(() => null);
  if (result?.ok !== true || result.token !== token) {
    throw new UploadError(
      `${baseUrl} ตอบ ${response.status} แต่ไม่ใช่คำตอบของเว็บเรา`
      + ' — ตรวจที่อยู่เว็บ และถ้าเน็ตที่ใช้มีหน้าล็อกอิน ต้องล็อกอินให้ผ่านก่อน',
      { status: response.status, token },
    );
  }

  await markUploaded(root, token);
  return { token, duplicate: Boolean(result.duplicate) };
}

/**
 * ส่งทุกรอบที่ยังไม่ได้ส่ง
 *
 * `onProgress` ให้ผู้เรียกรายงานความคืบหน้าได้ — งานสามวันมีหลายร้อยรอบ
 * และการส่งใช้เวลาเป็นนาที คนสั่งต้องเห็นว่ามันเดินอยู่ ไม่ใช่ค้าง
 */
export async function uploadPending(root, { baseUrl, key, fetchImpl = fetch, onProgress } = {}) {
  if (!baseUrl || !key) {
    throw new UploadError('ยังไม่ได้ตั้งที่อยู่เว็บหรือกุญแจสำหรับส่งรูปขึ้นระบบ');
  }

  const pending = (await listSessions(root)).filter((one) => !one.uploaded);
  const sent = [];
  const failed = [];

  for (const [index, manifest] of pending.entries()) {
    try {
      sent.push(await uploadSession(root, manifest.token, { baseUrl, key, fetchImpl }));
    } catch (error) {
      failed.push({ token: manifest.token, reason: error.message });
    }
    onProgress?.({ done: index + 1, total: pending.length, token: manifest.token });
  }

  return { total: pending.length, sent, failed };
}
