import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

/**
 * ล็อกกันสอง export ทับกัน — ต้องกันได้ทั้งสองทาง คนละทางเข้า
 *
 * export หนังทำได้สองทาง: กดปุ่มในเว็บ (รันในคอนเทนเนอร์ wedding-share เดียวกับ
 * เว็บ) หรือ ssh แล้วรัน scripts/export-film.sh (รันในคอนเทนเนอร์ชั่วคราวแยกต่างหาก)
 * สอง entry point นี้เป็นคนละโปรเซสคนละคอนเทนเนอร์ จะเช็ก PID ข้ามกันไม่ได้เลย
 * (คนละ PID namespace) จึงล็อกด้วยไฟล์บนดิสก์ที่ทั้งคู่มองเห็นร่วมกัน — โฟลเดอร์
 * ข้อมูลคือจุดเดียวที่ mount เข้าทั้งสองคอนเทนเนอร์เสมอ
 *
 * ไฟล์ล็อกไม่ได้ตรวจว่าโปรเซสเดิมยังมีชีวิตอยู่ (ข้ามคอนเทนเนอร์ทำแบบนั้นไม่ได้)
 * แต่ใช้ "เวลาที่แก้ไขล่าสุด" แทน — ตราบใดที่งานยังรันอยู่จริง มันจะแตะไฟล์ทุก 15
 * วินาที ถ้าไฟล์ไม่ถูกแตะเกิน 60 วินาที ถือว่าโปรเซสเดิมตายไปแล้วแบบไม่ทันเก็บกวาด
 * (เช่นคอนเทนเนอร์ถูก kill กลางทาง) แล้วปล่อยให้เริ่มใหม่ได้เอง โดยไม่ต้องมีใคร
 * มานั่งลบไฟล์ล็อกทิ้งเอง
 */

const LOCK_PATH = path.join(config.paths.export, '.lock');
const STALE_AFTER_MS = 60_000;
const HEARTBEAT_MS = 15_000;

async function readLock() {
  try {
    return JSON.parse(await fs.readFile(LOCK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

async function isHeld() {
  let stat;
  try {
    stat = await fs.stat(LOCK_PATH);
  } catch {
    return false;
  }
  return Date.now() - stat.mtimeMs < STALE_AFTER_MS;
}

/** ใครกำลังถือล็อกอยู่ — ใช้บอกแอดมินว่างานที่รันอยู่เริ่มจากไหน */
export async function lockOwner() {
  if (!(await isHeld())) return null;
  return readLock();
}

/**
 * ขอถือล็อก โยน error ถ้ามีคนถืออยู่แล้วจริง ๆ (ไม่ใช่ล็อกค้างที่หมดอายุ)
 * คืนฟังก์ชัน heartbeat กับ release ให้ผู้เรียกเอาไปใช้ต่อ
 */
export async function acquireLock(source) {
  if (await isHeld()) {
    const owner = await readLock();
    const error = new Error(
      owner?.source === 'web'
        ? 'มีงาน export กำลังรันอยู่แล้วจากหน้าเว็บ'
        : 'มีงาน export กำลังรันอยู่แล้ว (เริ่มจาก SSH)',
    );
    error.code = 'LOCKED';
    throw error;
  }

  await fs.mkdir(config.paths.export, { recursive: true });
  const write = () => fs.writeFile(LOCK_PATH, JSON.stringify({ source, startedAt: new Date().toISOString() }));
  await write();

  const timer = setInterval(() => {
    write().catch(() => {}); // ล็อกหายกลางทางแค่ทำให้ตรวจสถานะพลาด ไม่ใช่เรื่องร้ายแรง
  }, HEARTBEAT_MS);
  timer.unref?.();

  return {
    async release() {
      clearInterval(timer);
      await fs.rm(LOCK_PATH, { force: true });
    },
  };
}
