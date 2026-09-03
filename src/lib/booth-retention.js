import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getSetting, setSetting } from '../db.js';
import { expireBoothSession, listBoothShots, listOverdueBoothSessions } from '../repo.js';

/**
 * รูปจากบูธมีอายุ — QR บนกระดาษไม่มี
 *
 * แผ่นที่แขกถือกลับบ้านมี QR พิมพ์อยู่ตลอดไป แต่เราเก็บไฟล์ไว้แค่ช่วงหนึ่ง
 * (`BOOTH_RETENTION_DAYS` ค่าเริ่มต้น 7 วัน · 0 = เก็บถาวร) · สิ่งที่ต้องไม่เกิดคือ
 * แขกสแกนหลังหมดอายุแล้วเจอหน้า "รูปยังไม่ขึ้นระบบ กลับมาสแกนใหม่ได้" ซึ่งเป็น
 * ข้อความของอีกสถานะหนึ่ง และจะทำให้เขารอเก้อไปตลอด
 *
 * จึงลบเฉพาะ *ไฟล์* แล้วเก็บ *แถว* ไว้เป็นทะเบียน — QR ยังพาไปถึงหน้าที่บอกความจริง
 */

const HOUR = 60 * 60 * 1000;
const LAST_SWEEP = 'booth_purged_at';

/** วันสุดท้ายที่รูปชุดนี้ยังอยู่ · null = เก็บถาวร */
export function boothKeepsUntil(session) {
  const days = config.boothRetentionDays;
  if (!(days > 0) || !session?.created_at) return null;
  const born = new Date(`${String(session.created_at).replace(' ', 'T')}Z`);
  if (Number.isNaN(born.getTime())) return null;
  return new Date(born.getTime() + days * 24 * HOUR);
}

async function removeFiles(session) {
  const names = [
    session.sheet_name,
    session.gif_name,
    ...listBoothShots(session.token).map((s) => s.stored_name),
  ];
  for (const name of names.filter(Boolean)) {
    await fs.rm(path.join(config.paths.booth, name), { force: true });
  }
}

/**
 * กวาดรอบที่พ้นกำหนดเก็บ — เรียกได้บ่อยเท่าที่อยาก ทำจริงชั่วโมงละครั้ง
 *
 * ตามแบบเดียวกับถังขยะของรูปแขก (`purgeExpiredTrash`): ไม่มีตัวตั้งเวลาเบื้องหลัง
 * ให้ต้องคอยดูแล แค่ตรวจตอนมีคนเปิดหน้า · หน้าที่ถูกเรียกคือหน้าที่ QR ชี้มา
 * ซึ่งเป็นหน้าที่มีคนเข้าอยู่แล้วทุกวันในช่วงที่รูปยังไม่หมดอายุ
 *
 * `force` ข้ามการหน่วงเวลา — ใช้ตอนบูตเซิร์ฟเวอร์และในเทสต์
 */
export async function sweepExpiredBooth({ force = false } = {}) {
  const days = config.boothRetentionDays;
  if (!(days > 0)) return { swept: 0, skipped: true };

  if (!force) {
    const lastMs = Date.parse(getSetting(LAST_SWEEP) ?? '');
    if (Number.isFinite(lastMs) && Date.now() - lastMs < HOUR) return { swept: 0, skipped: true };
  }
  setSetting(LAST_SWEEP, new Date().toISOString());

  let swept = 0;
  for (const session of listOverdueBoothSessions(days)) {
    // ลบไฟล์ก่อนแล้วค่อยทำเครื่องหมาย — สลับกันแล้วไฟดับคั่นกลาง จะเหลือแถวที่บอกว่า
    // หมดอายุแล้วแต่ไฟล์ยังกินพื้นที่อยู่ และไม่มีอะไรกลับมาเก็บกวาดให้อีกเลย
    await removeFiles(session);
    if (expireBoothSession(session.token)) swept += 1;
  }
  return { swept, skipped: false };
}
