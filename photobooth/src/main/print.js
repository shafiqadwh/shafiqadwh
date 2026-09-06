import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { PAGES, PAPERS } from '../core/paper.js';
import { mountOnPage } from '../core/mount.js';

const run = promisify(execFile);

/**
 * ส่งแผ่นไปเครื่องพิมพ์
 *
 * ⚠️ **ส่วนนี้ยังไม่เคยทดสอบกับเครื่องพิมพ์จริง** เครื่องที่พัฒนาไม่มี CUPS
 * และไม่มี dye-sub ต่ออยู่ · เทสต์ครอบได้แค่ "คำสั่งที่ประกอบขึ้นถูกต้องไหม"
 * กับ "ล้มแล้วบอกเหตุที่อ่านรู้เรื่องไหม" — ตัวตัดสินจริงคือกระดาษที่ออกมา
 *
 * มีสามตัวขับ และค่าเริ่มต้นคือตัวที่ทำงานได้ทุกเครื่องเสมอ
 *
 * - `file` (ค่าเริ่มต้น) เขียนแผ่นลงโฟลเดอร์ขาออก แล้วให้คนสั่งพิมพ์จากระบบเอง
 *   ช้ากว่าแต่ **ไม่มีทางล้มเพราะไดรเวอร์** ซึ่งสำคัญกว่าในงานแรก ๆ
 * - `system` สั่งพิมพ์ผ่านตัวพิมพ์ของ Electron เอง — **ใช้ได้ทั้ง Windows, macOS
 *   และ Linux** เพราะไม่ต้องพึ่งคำสั่งของระบบปฏิบัติการเลย และเลือกเครื่องพิมพ์
 *   จากรายการที่ระบบรู้จักได้ ไม่ต้องพิมพ์ชื่อเอง
 * - `cups` เรียก `lp` ให้จบในปุ่มเดียว · **Linux/macOS เท่านั้น** Windows ไม่มี `lp`
 */

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
export function lpArgs({ printerName, paper, page = 'same', copies, file }) {
  const args = [];
  if (printerName) args.push('-d', printerName);
  args.push('-n', String(Math.max(1, Math.round(copies) || 1)));

  if (page === 'same') {
    // พิมพ์เต็มแผ่นไม่มีขอบ — กระดาษในเครื่องมีขนาดเท่าสินค้าพอดี (dye-sub / กระดาษรูป)
    args.push('-o', `media=${CUPS_MEDIA[paper] ?? CUPS_MEDIA['4x6']}`);
    args.push('-o', 'fit-to-page');
    args.push('-o', 'StpBorderless=True');
  } else {
    /*
     * วางบนหน้ากระดาษแล้ว — **ห้าม fit-to-page เด็ดขาด**
     *
     * ภาพมีขนาดเท่าหน้ากระดาษพอดีอยู่แล้ว · `fit-to-page` จะย่อมันลงให้พอดี
     * "พื้นที่ที่พิมพ์ได้" ซึ่งเล็กกว่าหน้ากระดาษราว 3 มม. รอบด้าน → สินค้า 4×6
     * จะหดเหลือราว 3.9×5.8 นิ้วโดยไม่มีใครสังเกต จนกว่าจะเอาไม้บรรทัดไปวัด
     * ขอบเผื่อ 5 มม. ที่ mount.js กันไว้แล้วทำให้ไม่มีอะไรสำคัญโดนตัด
     */
    args.push('-o', `media=${PAGES[page]?.id ?? 'A4'}`);
    args.push('-o', 'scaling=100');
  }

  args.push(file);
  return args;
}

/**
 * ตัวเลือกของ `webContents.print()` — ฟังก์ชันบริสุทธิ์เพื่อให้ทดสอบได้
 *
 * `pageSize` เป็นไมโครเมตร และ **ต้องบอกขนาดจริงเสมอ ไม่ปล่อยให้ไดรเวอร์เดา**
 * เพราะการเดาจะได้ A4 ซึ่งทำให้แผ่น 4×6 ไปนั่งอยู่มุมกระดาษ · ค่าคงที่ 25400
 * คือไมโครเมตรต่อนิ้ว
 *
 * `margins: none` คู่กับ `pageSize` ที่เท่าสินค้าพอดี = พิมพ์เต็มแผ่นไม่มีขอบ
 * ซึ่งเป็นสิ่งที่ dye-sub ต้องการ · โหมดวางบนหน้ากระดาษไม่ใช้ margins none
 * เพราะ mount.js เผื่อขอบไว้ในภาพให้แล้ว การบังคับ none ซ้ำจะไปดันภาพเกินขอบ
 * ที่เครื่องพิมพ์ทำได้จริง
 */
const MICRON_PER_INCH = 25400;
const MICRON_PER_MM = 1000;

export function electronPrintOptions({ printerName, paper, page = 'same', copies }) {
  const options = {
    // ห้ามเด้งกล่องโต้ตอบ — บูธเป็นจอสัมผัสที่ไม่มีเมาส์ และแขกยืนรออยู่
    silent: true,
    printBackground: true,
    copies: Math.max(1, Math.round(copies) || 1),
  };
  if (printerName) options.deviceName = printerName;

  if (page === 'same') {
    const size = PAPERS[paper] ?? PAPERS['4x6'];
    options.pageSize = {
      width: Math.round(size.widthIn * MICRON_PER_INCH),
      height: Math.round(size.heightIn * MICRON_PER_INCH),
    };
    options.margins = { marginType: 'none' };
  } else {
    const sheet = PAGES[page] ?? PAGES.A4;
    options.pageSize = {
      width: Math.round(sheet.widthMm * MICRON_PER_MM),
      height: Math.round(sheet.heightMm * MICRON_PER_MM),
    };
    options.margins = { marginType: 'none' };
  }
  return options;
}

/**
 * หน้าเว็บหนึ่งหน้าที่มีแต่รูปแผ่น เต็มหน้าพอดี ไม่มีอะไรอื่น
 *
 * ส่งเป็น data URL ไม่ใช่ path — ไฟล์ที่อ้างด้วย `file://` จากหน้าที่โหลดด้วย
 * data URL จะโดนกฎ origin ของ Chromium บล็อก แล้วได้กระดาษเปล่าออกมาโดยไม่มี
 * error ให้ใครเห็น ซึ่งเป็นความล้มเหลวที่แย่ที่สุดของงานพิมพ์
 */
export const printPageHtml = (dataUrl) => `<!doctype html><meta charset="utf-8">
<style>
  @page { margin: 0; }
  html, body { margin: 0; padding: 0; }
  img { display: block; width: 100%; height: 100%; object-fit: contain; }
</style><img src="${dataUrl}">`;

async function printViaCups({ sheetPath, settings, copies }) {
  const args = lpArgs({
    printerName: settings.printer.name,
    paper: settings.paper,
    page: settings.printPage,
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

/**
 * เตรียมไฟล์ที่จะส่งเข้าเครื่องพิมพ์จริง
 *
 * กระดาษเท่าขนาดสินค้า (dye-sub / กระดาษรูป 4×6) ส่งแผ่นไปตรง ๆ ได้เลย
 * กระดาษ A4 ต้องวางแผ่นลงกลางหน้าพร้อมเส้นตัดก่อน
 *
 * ไฟล์ที่วางแล้วเก็บแยกเป็น `page.jpg` **ไม่ทับ `sheet.jpg`** — แผ่นขนาดสินค้า
 * คือของที่จะอัปโหลดขึ้นเว็บให้แขกโหลด ส่วนหน้ากระดาษเป็นเรื่องของเครื่องพิมพ์
 * ปนกันเมื่อไรแขกจะได้ไฟล์ที่มีขอบขาวกับเส้นตัดติดไปด้วย
 *
 * อยู่ที่นี่ไม่ใช่ใน main.js เพราะ main.js เรียก Electron จึงทดสอบไม่ได้ —
 * และนี่คือตรรกะที่ผิดแล้วกระดาษเสียทุกใบ ต้องมีเทสต์คุม
 */
export async function preparePrintFile({ dir, sheetPath, settings }) {
  if (settings.printPage === 'same') {
    return { path: sheetPath, perPage: 1, pages: settings.copies };
  }

  const meta = await sharp(sheetPath).metadata();
  const mounted = await mountOnPage(await fs.readFile(sheetPath), {
    sheet: { width: meta.width, height: meta.height },
    page: settings.printPage,
    copies: settings.copies,
  });

  const target = path.join(dir, 'page.jpg');
  await fs.writeFile(target, mounted.data);
  return {
    path: target,
    perPage: mounted.perPage,
    // หนึ่งหน้ามีหลายใบอยู่ในตัวแล้ว จึงสั่งพิมพ์เท่าจำนวนหน้า ไม่ใช่จำนวนใบ
    pages: Math.max(1, Math.ceil(settings.copies / mounted.perPage)),
  };
}

/**
 * `viaSystem` ถูกฉีดเข้ามาจาก main.js — ตัวพิมพ์ของ Electron ต้องมีหน้าต่างจริง
 *
 * ไฟล์นี้จึงไม่ import Electron เลย และยังทดสอบได้ทั้งไฟล์โดยไม่ต้องเปิดแอป
 * ซึ่งจำเป็น เพราะนี่คือตรรกะที่ผิดแล้วกระดาษเสียทุกใบ
 */
export async function printSheet({
  sheetPath, settings, token, outbox, copies: want, viaSystem,
}) {
  // จำนวนหน้าที่จะสั่งพิมพ์ · ต่างจาก settings.copies เมื่อหนึ่งหน้ามีหลายใบอยู่ในตัว
  const copies = Math.min(8, Math.max(1, Math.round(want ?? settings.copies) || 1));

  if (settings.printer.driver === 'system') {
    if (typeof viaSystem !== 'function') {
      throw new Error('สั่งพิมพ์ผ่านระบบไม่ได้: ไม่มีตัวพิมพ์ให้ใช้');
    }
    await viaSystem({
      sheetPath,
      options: electronPrintOptions({
        printerName: settings.printer.name,
        paper: settings.paper,
        page: settings.printPage,
        copies,
      }),
    });
    return { ok: true, driver: 'system', detail: settings.printer.name || 'เครื่องพิมพ์เริ่มต้น' };
  }

  if (settings.printer.driver === 'cups') {
    return printViaCups({ sheetPath, settings, copies });
  }
  return printViaFile({ sheetPath, outbox, token, copies });
}
