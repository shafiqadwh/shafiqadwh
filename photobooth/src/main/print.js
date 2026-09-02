import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { PAPERS } from '../core/paper.js';

const run = promisify(execFile);

/**
 * ส่งแผ่นไปเครื่องพิมพ์
 *
 * ⚠️ **ส่วนนี้ยังไม่เคยทดสอบกับเครื่องพิมพ์จริง** เครื่องที่พัฒนาไม่มี CUPS
 * และไม่มี dye-sub ต่ออยู่ · เทสต์ครอบได้แค่ "คำสั่งที่ประกอบขึ้นถูกต้องไหม"
 * กับ "ล้มแล้วบอกเหตุที่อ่านรู้เรื่องไหม" — ตัวตัดสินจริงคือกระดาษที่ออกมา
 *
 * มีสองตัวขับ และค่าเริ่มต้นคือตัวที่ทำงานได้ทุกเครื่องเสมอ
 *
 * - `file` (ค่าเริ่มต้น) เขียนแผ่นลงโฟลเดอร์ขาออก แล้วให้คนสั่งพิมพ์จากระบบเอง
 *   ช้ากว่าแต่ **ไม่มีทางล้มเพราะไดรเวอร์** ซึ่งสำคัญกว่าในงานแรก ๆ
 * - `cups` เรียก `lp` ให้จบในปุ่มเดียว ต้องตั้งเครื่องพิมพ์ในระบบไว้ก่อน
 */

export const DRIVERS = Object.freeze(['file', 'cups']);

/**
 * ชื่อสื่อของ CUPS สำหรับกระดาษแต่ละขนาด
 *
 * `-o media=` ต้องเป็นชื่อที่ CUPS รู้จัก ไม่ใช่ "4x6" ที่เราใช้เรียกกันเอง
 * ไดรเวอร์ dye-sub ส่วนใหญ่ประกาศเป็นขนาดนิ้วแบบนี้ แต่ **บางรุ่นใช้ชื่อของตัวเอง**
 * ตรวจของจริงด้วย `lpoptions -p <ชื่อเครื่อง> -l | grep PageSize` ก่อนงานเสมอ
 */
const CUPS_MEDIA = Object.freeze({
  '4x6': '4x6',
  '5x7': '5x7',
  '6x8': '6x8',
});

/**
 * ประกอบอาร์กิวเมนต์ของ `lp` — แยกเป็นฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบได้
 *
 * ไม่ผ่านเชลล์ (`execFile` ไม่ใช่ `exec`) ชื่อเครื่องพิมพ์ที่มีช่องว่างหรือ
 * เครื่องหมายแปลก ๆ จึงไม่กลายเป็นคำสั่งเพิ่ม
 */
export function lpArgs({ printerName, paper, copies, file }) {
  const media = CUPS_MEDIA[paper] ?? CUPS_MEDIA['4x6'];
  const args = [];
  if (printerName) args.push('-d', printerName);
  args.push('-n', String(Math.max(1, Math.round(copies) || 1)));
  args.push('-o', `media=${media}`);
  // เต็มหน้าไม่มีขอบขาว — แผ่นถูกประกอบมาเต็มขนาดกระดาษแล้ว ให้ CUPS ย่อซ้ำไม่ได้
  args.push('-o', 'fit-to-page');
  args.push('-o', 'StpBorderless=True');
  args.push(file);
  return args;
}

async function printViaCups({ sheetPath, settings, copies }) {
  const args = lpArgs({
    printerName: settings.printer.name,
    paper: settings.paper,
    copies,
    file: sheetPath,
  });

  try {
    const { stdout } = await run('lp', args, { timeout: 60000 });
    return { ok: true, driver: 'cups', detail: String(stdout).trim() };
  } catch (error) {
    // ข้อความของ lp อ่านรู้เรื่องกว่าที่เราจะเขียนเอง — ส่งต่อไปให้คนหน้าบูธเห็น
    const why = String(error.stderr || error.message).trim().split('\n').at(-1);
    const missing = error.code === 'ENOENT';
    throw new Error(
      missing
        ? 'สั่งพิมพ์ไม่ได้: ไม่พบคำสั่ง lp บนเครื่องนี้ — ติดตั้ง CUPS ก่อน หรือสลับไปใช้โหมด file'
        : `สั่งพิมพ์ไม่ได้: ${why}`,
      { cause: error },
    );
  }
}

/**
 * โหมดแฟ้ม — คัดลอกแผ่นไปโฟลเดอร์ขาออกพร้อมชื่อที่เรียงตามเวลา
 *
 * ชื่อไฟล์ขึ้นต้นด้วยเวลาเพื่อให้เรียงตามลำดับที่ถ่ายจริงเมื่อเปิดดูในโฟลเดอร์
 * และมีโทเคนต่อท้ายเพื่อให้ย้อนกลับไปหารอบถ่ายต้นทางได้
 */
async function printViaFile({ sheetPath, outbox, token, copies }) {
  await fs.mkdir(outbox, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const written = [];

  for (let i = 1; i <= copies; i += 1) {
    const suffix = copies > 1 ? `-${i}` : '';
    const target = path.join(outbox, `${stamp}-${token}${suffix}.jpg`);
    await fs.copyFile(sheetPath, target);
    written.push(target);
  }
  return { ok: true, driver: 'file', detail: `เขียนลง ${outbox}`, files: written };
}

export async function printSheet({ sheetPath, settings, token, outbox }) {
  const copies = Math.min(4, Math.max(1, Math.round(settings.copies) || 1));

  if (settings.printer.driver === 'cups') {
    return printViaCups({ sheetPath, settings, copies });
  }
  return printViaFile({ sheetPath, outbox, token, copies });
}

/** ขนาดกระดาษที่ตั้งไว้มีชื่อสื่อของ CUPS รองรับไหม — ใช้เตือนตอนตั้งค่า ไม่ใช่ตอนพิมพ์ */
export const paperIsPrintable = (paper) => Object.hasOwn(PAPERS, paper) && Boolean(CUPS_MEDIA[paper]);
