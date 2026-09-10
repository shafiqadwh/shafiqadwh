import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * CI ที่ขึ้นเขียวแล้วเชื่อไม่ได้ แย่กว่าไม่มี CI เลย
 *
 * **เกิดขึ้นจริงในรอบแรกของ `.github/workflows/tests.yml`**: ขึ้น ✓ ทั้ง job
 * ทั้งที่รันไปแค่ 128 ข้อจาก 181 — อีก 53 ข้อ (ทุกข้อที่เปิดหน้าต่าง Electron
 * จริง ซึ่งเป็นชุดเดียวที่ตรวจว่าชิ้นส่วนต่อกันติด) ถูก **ข้าม** เพราะ
 * Electron 44 เลิกมี postinstall แล้ว `npm ci` จึงไม่ได้โหลดตัวโปรแกรมมาให้
 * สรุปผลของ node:test นับข้อที่ข้ามเป็น `ok` จึงไม่มีอะไรเป็นสีแดงให้เห็น
 *
 * เทสต์นี้เฝ้าเงื่อนไขสามข้อที่ทำให้เรื่องนั้นเกิดซ้ำไม่ได้ · ตรวจจากตัวไฟล์
 * workflow ตรง ๆ เพราะรัน workflow จากที่นี่ไม่ได้
 */

const workflow = await fs.readFile(path.join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');

test('CI downloads the Electron runtime before it runs the booth suite', () => {
  // `npm ci` ไม่พอแล้ว — ต้องมีขั้นที่เรียก install ของ electron เองอีกขั้น
  assert.match(workflow, /npm run install:electron/);

  const installStep = workflow.indexOf('npm run install:electron');
  const boothStep = workflow.indexOf('photobooth/test/*.test.js');
  assert.ok(installStep > 0 && boothStep > 0);
  // ลำดับสำคัญ: โหลดไบนารีก่อนรันเทสต์ ไม่ใช่หลัง
  assert.ok(installStep < boothStep, 'ขั้นลง Electron ต้องมาก่อนขั้นเทสต์ฝั่งบูธ');
});

test('on CI a booth test that cannot open a window fails instead of being skipped', () => {
  assert.match(workflow, /BOOTH_REQUIRE_ELECTRON/);

  // ต้องอยู่กับขั้นเทสต์ฝั่งบูธ ไม่ใช่ลอยอยู่ในไฟล์เฉย ๆ
  const booth = workflow.slice(workflow.indexOf('เทสต์ฝั่งบูธ'));
  assert.match(booth, /BOOTH_REQUIRE_ELECTRON/);
});

test('CI downloads Chromium, not just the libraries it needs', () => {
  // `install-deps` ลงไลบรารีของระบบ · ตัวเบราว์เซอร์ต้องสั่งแยก — ข้อนี้ตกไป
  // ตั้งแต่รอบแรก เทสต์ฝั่งเว็บที่ขับเบราว์เซอร์จริง 11 ข้อจึงถูกข้ามทุกรอบ
  assert.match(workflow, /playwright install chromium/);

  const install = workflow.indexOf('playwright install chromium');
  const webStep = workflow.indexOf('node --test test/*.test.js');
  assert.ok(install > 0 && webStep > 0);
  assert.ok(install < webStep, 'ขั้นลงเบราว์เซอร์ต้องมาก่อนขั้นเทสต์ฝั่งเว็บ');
});

test('on CI a web test that cannot open a browser fails instead of being skipped', () => {
  const web = workflow.slice(workflow.indexOf('เทสต์ฝั่งเว็บ'), workflow.indexOf('เทสต์ฝั่งบูธ'));
  assert.match(web, /WEB_REQUIRE_BROWSER/);
});

test('no booth test hardcodes the Linux name of the Electron binary', async () => {
  // ชื่อไบนารีต่างกันทุกระบบ (`electron`, `electron.exe`, `Electron.app/…`)
  // ฮาร์ดโค้ด `dist/electron` ไว้ = เทสต์ชุดนี้ถูกข้ามตลอดไปบนวินโดวส์
  // ซึ่งเป็นเครื่องของเจ้าของ · ตัวช่วยอ่านชื่อที่ถูกจาก path.txt ให้แล้ว
  const dir = path.join(ROOT, 'photobooth', 'test');
  const names = (await fs.readdir(dir)).filter((name) => name.endsWith('.test.js'));
  assert.ok(names.length > 0);

  for (const name of names) {
    const source = await fs.readFile(path.join(dir, name), 'utf8');
    assert.doesNotMatch(source, /'electron',\s*'dist'/, `${name} ฮาร์ดโค้ดเส้นทางไบนารีไว้`);
  }
});
