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
 */

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

export async function uploadSession(root, token, { baseUrl, key, fetchImpl = fetch }) {
  if (!isToken(token)) throw new UploadError(`โทเคนไม่ถูกต้อง: ${token}`, { token });
  const manifest = await readSession(root, token);
  if (!manifest) throw new UploadError('ไม่พบรอบถ่ายนี้ หรือรอบนี้บันทึกไม่ครบ', { token });

  let response;
  try {
    response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/api/booth/upload`, {
      method: 'POST',
      headers: { 'x-booth-key': key },
      body: await bundleFor(root, manifest),
    });
  } catch (error) {
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

  const result = await response.json().catch(() => ({}));
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
