import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * หาตัวโปรแกรม Electron · และกันไม่ให้ CI ขึ้นเขียวตอนที่หาไม่เจอ
 *
 * **Electron 44 เลิกมี postinstall แล้ว** (`scripts` ใน package.json ของมันว่าง
 * เปล่า) `npm ci` จึงลงแต่ไฟล์ JS ส่วนตัวโปรแกรมจริงราว 150 MB ถูกโหลดตอน
 * `require('electron')` ครั้งแรกแทน · เครื่องที่โคลนใหม่แล้วรันเทสต์เลยจึงไม่มี
 * `dist/` และเทสต์ที่ต้องเปิดหน้าต่าง **53 ข้อถูกข้าม** แล้วสรุปผลขึ้นว่าผ่าน
 * — เกิดขึ้นจริงใน GitHub Actions รอบแรก (run #1 เขียวทั้งที่รันไป 128 จาก 181)
 *
 * และชื่อไฟล์ไบนารีไม่เหมือนกันทุกระบบ (`electron`, `electron.exe`,
 * `Electron.app/Contents/MacOS/Electron`) · `install.js` เขียนชื่อที่ถูกของ
 * เครื่องนั้นไว้ใน `path.txt` ให้แล้ว จึงอ่านจากไฟล์นั้น ไม่ใช่ฮาร์ดโค้ด
 * `dist/electron` แบบเดิม ซึ่ง **ผิดบนวินโดวส์** — เครื่องของเจ้าของเป็นวินโดวส์
 * เทสต์ชุดนี้จึงไม่มีทางรันที่นั่นได้เลย ไม่ว่าจะลงไบนารีไว้หรือไม่
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.join(here, '..', '..', 'node_modules', 'electron');

export async function electronBinary() {
  let name;
  try {
    // path.txt ไม่ได้มากับแพ็กเกจ — `install.js` เขียนขึ้นตอนโหลดไบนารีสำเร็จ
    // ไม่มีไฟล์นี้ = ยังไม่เคยลงไบนารี ไม่ใช่แค่ชื่อไฟล์หาย
    name = (await fs.readFile(path.join(packageDir, 'path.txt'), 'utf8')).trim();
  } catch {
    throw new Error('ยังไม่ได้ลงตัวโปรแกรม Electron — รัน `npm run install:electron` ในโฟลเดอร์ photobooth');
  }
  const binary = path.join(packageDir, 'dist', name);
  await fs.access(binary);
  return binary;
}

/**
 * ข้ามเมื่อเปิดหน้าต่างไม่ได้ — ยกเว้นตอนที่ห้ามข้าม
 *
 * คนที่เพิ่งโคลนมาแล้วยังไม่ได้โหลดไบนารี ได้ประโยชน์จากการรันเทสต์ที่เหลือต่อ
 * แต่บน CI การข้ามคือการรายงานเท็จ · ตั้ง `BOOTH_REQUIRE_ELECTRON=1` แล้วเคส
 * เดียวกันกลายเป็นล้มพร้อมเหตุผล แทนที่จะเขียวพร้อมเทสต์ที่ไม่ได้รันห้าสิบข้อ
 */
export function skipOrFail(t, error, what) {
  const why = `${what} — ${error?.message ?? 'ไม่ทราบสาเหตุ'}`;
  if (process.env.BOOTH_REQUIRE_ELECTRON) throw new Error(why);
  t.skip(why);
  return true;
}
