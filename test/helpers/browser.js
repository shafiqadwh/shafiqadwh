import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * เปิด Chromium ให้เทสต์ที่ต้องขับเบราว์เซอร์จริง · และกันการข้ามแบบเงียบบน CI
 *
 * **`npx playwright install-deps` ไม่ได้โหลดตัวเบราว์เซอร์** มันลงแต่ไลบรารีของ
 * ระบบที่เบราว์เซอร์ต้องใช้ · ตัว Chromium ต้องสั่ง `npx playwright install
 * chromium` แยก · ผลที่เกิดขึ้นจริงบน GitHub Actions: เทสต์ที่เปิดเบราว์เซอร์
 * **11 ข้อถูกข้าม** ทุกรอบ โดยที่สรุปผลไม่มีอะไรเป็นสีแดง (node:test นับข้อที่
 * ข้ามเป็น `ok`) — ชนิดเดียวกับที่เคยเกิดกับ Electron ของบูธมาแล้ว
 *
 * playwright กับ Chromium ที่มีในอิมเมจอาจคนละ revision (แพ็กเกจมองหา build
 * ตามเลขที่มันปักไว้ ส่วนอิมเมจมีเลขอื่น) — ลองแบบปกติก่อน แล้วค่อยชี้ไปที่
 * ไบนารีที่มีอยู่จริง แทนที่จะยอมแพ้แล้วข้ามทั้งไฟล์
 */
export async function launchChromium() {
  const { chromium } = await import('playwright');
  const problems = [];

  try {
    return await chromium.launch();
  } catch (error) {
    problems.push(error.message.split('\n')[0]);
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    throw new Error(`ไม่มีเบราว์เซอร์ให้ใช้ — รัน \`npx playwright install chromium\` · ${problems.join(' · ')}`);
  }

  for (const entry of entries.filter((name) => name.startsWith('chromium-'))) {
    const executablePath = path.join(root, entry, 'chrome-linux', 'chrome');
    try {
      await fs.access(executablePath);
      return await chromium.launch({ executablePath });
    } catch (error) {
      problems.push(error.message.split('\n')[0]);
    }
  }

  throw new Error(`เปิด Chromium ไม่ได้ทุกทาง — รัน \`npx playwright install chromium\` · ${problems.join(' · ')}`);
}

/**
 * ข้ามเมื่อเปิดเบราว์เซอร์ไม่ได้ — ยกเว้นตอนที่ห้ามข้าม
 *
 * เครื่องคนเขียนที่ยังไม่ได้โหลดเบราว์เซอร์ ได้ประโยชน์จากการรันที่เหลือต่อ
 * แต่บน CI การข้ามคือการรายงานเท็จ · ตั้ง `WEB_REQUIRE_BROWSER=1` ใน workflow
 * แล้วเคสเดียวกันกลายเป็นล้มพร้อมเหตุผล คู่กับ BOOTH_REQUIRE_ELECTRON ของบูธ
 */
export function skipOrFail(t, error, what = 'เปิดเบราว์เซอร์ไม่ได้') {
  const why = `${what} — ${error?.message ?? 'ไม่ทราบสาเหตุ'}`;
  if (process.env.WEB_REQUIRE_BROWSER) throw new Error(why);
  t.skip(why);
  return true;
}
