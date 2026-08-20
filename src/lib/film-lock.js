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

const STALE_AFTER_MS = 60_000;
const HEARTBEAT_MS = 15_000;

/**
 * โรงงานล็อก — งานหนักแต่ละชนิดมีไฟล์ล็อกของตัวเอง
 *
 * ตอนแรกมีแต่ export หนัง ไฟล์ล็อกจึงเป็นค่าคงที่ในโมดูล พอมี export PDF เพิ่มเข้ามา
 * การใช้ล็อกร่วมกันจะแปลว่าสร้าง PDF ไม่ได้ระหว่างหนังกำลังเรนเดอร์ ทั้งที่สองงานนี้
 * ไม่ได้แย่งไฟล์อะไรกันเลย — แยกไฟล์ล็อก ส่วนกลไก mtime กับ heartbeat คงเดิมทุกอย่าง
 */
export function createLock(fileName, { busyMessage } = {}) {
  const lockPath = path.join(config.paths.export, fileName);

  const read = async () => {
    try {
      return JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      return null;
    }
  };

  const isHeld = async () => {
    let stat;
    try {
      stat = await fs.stat(lockPath);
    } catch {
      return false;
    }
    return Date.now() - stat.mtimeMs < STALE_AFTER_MS;
  };

  const owner = async () => ((await isHeld()) ? read() : null);

  async function acquire(source) {
    if (await isHeld()) {
      const held = await read();
      const error = new Error(busyMessage ? busyMessage(held) : 'มีงานกำลังรันอยู่แล้ว');
      error.code = 'LOCKED';
      throw error;
    }

    await fs.mkdir(config.paths.export, { recursive: true });
    const write = () => fs.writeFile(lockPath, JSON.stringify({ source, startedAt: new Date().toISOString() }));
    await write();

    const timer = setInterval(() => {
      write().catch(() => {}); // ล็อกหายกลางทางแค่ทำให้ตรวจสถานะพลาด ไม่ใช่เรื่องร้ายแรง
    }, HEARTBEAT_MS);
    timer.unref?.();

    return {
      async release() {
        clearInterval(timer);
        await fs.rm(lockPath, { force: true });
      },
    };
  }

  return { path: lockPath, owner, acquire };
}

const filmLock = createLock('.lock', {
  busyMessage: (held) => (held?.source === 'web'
    ? 'มีงาน export กำลังรันอยู่แล้วจากหน้าเว็บ'
    : 'มีงาน export กำลังรันอยู่แล้ว (เริ่มจาก SSH)'),
});

/** ใครกำลังถือล็อกอยู่ — ใช้บอกแอดมินว่างานที่รันอยู่เริ่มจากไหน */
export const lockOwner = filmLock.owner;

/**
 * ขอถือล็อกของงาน export หนัง โยน error ถ้ามีคนถืออยู่แล้วจริง ๆ
 * (ไม่ใช่ล็อกค้างที่หมดอายุ) คืนฟังก์ชัน release ให้ผู้เรียกเอาไปใช้ต่อ
 */
export const acquireLock = filmLock.acquire;
