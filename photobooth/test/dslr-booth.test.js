import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';
import { startDisplay } from './helpers/display.js';

/**
 * โหมดกล้องใหญ่ — ขับบูธจริงทั้งตัวโดยมีกล้องจำลองต่ออยู่
 *
 * `test/camera.test.js` ตรวจตัวคุมกล้องทีละฟังก์ชัน · ไฟล์นี้ตรวจสิ่งที่ต่างออกไป
 * และสำคัญกว่า: **รูปจากกล้องเดินทางไปถึงแผ่นที่พิมพ์จริงหรือเปล่า** ตั้งแต่แขก
 * กดปุ่ม ผ่าน IPC ผ่านตัวประกอบแผ่น จนไปนั่งอยู่ในโฟลเดอร์ของรอบนั้น
 *
 * ข้อที่สองสำคัญที่สุดในไฟล์นี้: **กล้องพังแล้วบูธต้องไม่พังตาม** สายหลุดกลางงาน
 * เป็นเรื่องที่จะเกิดขึ้นจริง และตอนนั้นแขกจ่ายเงินมาแล้วยืนอยู่ตรงหน้า
 *
 * ⚠️ กล้องจำลองพิสูจน์ได้แค่ว่า "เราคุยกับ gphoto2 ถูกวิธี" ไม่ได้พิสูจน์ว่า
 * D7000 ตัวจริงจะตอบแบบเดียวกัน — ตัวตัดสินยังเป็นการเสียบกล้องจริงลองหนึ่งรอบ
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

let app;
let guest;
let operator;
let userData;
let fakeDir;
let cameraJpeg;
let xvfb = null;
let launchError = null;

const sessions = () => path.join(userData, 'booth', 'sessions');
const failFlag = () => path.join(fakeDir, 'fail');

/**
 * gphoto2 ปลอม — ตอบเหมือนของจริงพอที่จะเดินได้ทั้งเส้น
 *
 * สลับให้ล้มได้ระหว่างเทสต์ด้วยการวางไฟล์ `fail` ไว้ข้าง ๆ · ไม่ต้องรีสตาร์ตแอป
 * เพราะสคริปต์ถูกอ่านใหม่ทุกครั้งที่ถูกเรียก ซึ่งตรงกับของจริงที่กล้องหลุดได้ตลอดเวลา
 */
const FAKE = `#!/bin/sh
DIR=$(dirname "$0")
case "$*" in
  *--auto-detect*)
    if [ -f "$DIR/fail" ]; then printf 'Model  Port\\n------\\n'; exit 0; fi
    printf 'Model                          Port\\n'
    printf -- '----------------------------------------\\n'
    printf 'Nikon DSC D7000 (PTP mode)     usb:001,011\\n'
    exit 0
    ;;
esac
if [ -f "$DIR/fail" ]; then
  echo "*** Error: Could not claim the USB device" >&2
  exit 1
fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--filename" ]; then shift; out="$1"; fi
  shift
done
[ -n "$out" ] && cp "$DIR/shot.jpg" "$out"
exit 0
`;

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-dslr-'));
  fakeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fake-cam-'));

  try {
    /*
     * รูปของ "กล้อง" ต้องหน้าตาไม่เหมือนภาพจากเว็บแคมจำลองของ Chromium เลย
     * จะได้ชี้ชัดว่ารูปที่ไปอยู่ในแผ่นมาจากทางไหน — ขนาดต่างกันคือหลักฐานที่อ่านง่ายสุด
     */
    const file = path.join(fakeDir, 'shot.jpg');
    await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#2d6a4f' },
    }).jpeg({ quality: 92 }).toFile(file);
    cameraJpeg = await fs.readFile(file);

    const script = path.join(fakeDir, 'gphoto2');
    await fs.writeFile(script, FAKE);
    await fs.chmod(script, 0o755);

    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'ทดสอบกล้องใหญ่',
      template: 'classic',
      countdownSeconds: 2,
      gif: false,
      printer: { driver: 'file', name: '' },
      camera: { source: 'dslr', keepOnCard: true },
    });

    xvfb = await startDisplay([94, 84, 74]);
    const { _electron } = await import('playwright');
    const electronPath = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
    await fs.access(electronPath);

    app = await _electron.launch({
      executablePath: electronPath,
      args: [appDir, '--no-sandbox',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: {
        ...process.env,
        BOOTH_WINDOWED: '1',
        BOOTH_USER_DATA: userData,
        BOOTH_OPERATOR: '1',
        BOOTH_GPHOTO2: script,
      },
      timeout: 420000,
    });

    await app.firstWindow();
    for (let i = 0; i < 60 && app.windows().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 250));
    }
    for (const page of app.windows()) {
      if (page.url().endsWith('operator.html')) operator = page;
      else guest = page;
    }
    await guest?.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
    await operator?.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  } catch (error) {
    launchError = error;
  }
});

after(async () => {
  await app?.close().catch(() => {});
  xvfb?.kill('SIGTERM');
  await fs.rm(userData, { recursive: true, force: true });
  await fs.rm(fakeDir, { recursive: true, force: true });
});

const skipUnlessBoth = (t) => {
  if (guest && operator) return false;
  t.skip(`เปิดสองหน้าต่างไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
  return true;
};

/** ถ่ายหนึ่งรอบจนเห็นแผ่น แล้วคืนโทเคนของรอบนั้น */
async function shootOnce() {
  const stage = await guest.getAttribute('body', 'data-stage');
  if (stage !== 'ready') {
    await operator.locator(stage === 'done' ? '#go' : '#back').click();
    await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
  }
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  return (await operator.locator('#code').textContent()).match(/[0-9A-Z]{6}/)?.[0];
}

test('the picture on the sheet comes from the camera, not from the webcam', async (t) => {
  if (skipUnlessBoth(t)) return;

  const token = await shootOnce();
  assert.ok(token, 'ต้องได้โทเคนของรอบนี้');

  /*
   * เทียบไบต์ทั้งไฟล์ ไม่ใช่แค่ "มีไฟล์อยู่"
   *
   * ถ้าเทียบแค่ว่ามีไฟล์ เทสต์นี้จะผ่านทั้งที่โหมดกล้องใหญ่ไม่เคยทำงานเลยสักครั้ง
   * (เฟรมจากเว็บแคมก็สร้างไฟล์ให้เหมือนกัน) — ซึ่งคือการทดสอบที่ไม่ได้ทดสอบอะไร
   */
  const saved = await fs.readFile(path.join(sessions(), token, 'shots', 'shot-1.jpg'));
  assert.ok(saved.equals(cameraJpeg), 'รูปที่บันทึกต้องเป็นไฟล์เดียวกับที่กล้องส่งมา');

  // และต้องประกอบเป็นแผ่นพร้อมพิมพ์ได้จริง ไม่ใช่แค่เก็บไฟล์ดิบไว้เฉย ๆ
  const sheet = await sharp(path.join(sessions(), token, 'sheet.jpg')).metadata();
  assert.equal(sheet.width, 1200);
  assert.equal(sheet.height, 1800);

  // จอช่างภาพต้องไม่ขึ้นคำเตือนอะไร เพราะรอบนี้ไม่มีอะไรผิด
  assert.equal(await operator.locator('#notice').isHidden(), true);
});

test('a camera that drops out mid-event does not stop the booth', async (t) => {
  if (skipUnlessBoth(t)) return;

  /*
   * สายหลุด แบตกล้องหมด หรือมีโปรแกรมอื่นจับกล้องไว้ — เกิดจริงทั้งสามอย่าง
   * และตอนนั้นแขกจ่ายเงินมาแล้วยืนอยู่ตรงหน้า · **ห้ามจบลงที่แขกกลับมือเปล่า**
   */
  await fs.writeFile(failFlag(), '');
  try {
    const token = await shootOnce();
    assert.ok(token, 'กล้องพังแล้วต้องยังถ่ายจนได้แผ่นเหมือนเดิม');

    const saved = await fs.readFile(path.join(sessions(), token, 'shots', 'shot-1.jpg'));
    assert.ok(!saved.equals(cameraJpeg), 'รอบนี้ต้องมาจากเว็บแคม ไม่ใช่จากกล้องที่พังไปแล้ว');
    await fs.access(path.join(sessions(), token, 'sheet.jpg'));

    /*
     * ช่างภาพต้องรู้ว่าเกิดอะไรขึ้น **และคำเตือนต้องยังอยู่ตอนที่เขาหันมามอง**
     * ข้อความที่ถูกลบทิ้งในเสี้ยววินาทีถัดมามีค่าเท่ากับไม่เคยขึ้นเลย
     */
    assert.equal(await operator.locator('#notice').isHidden(), false);
    assert.match(await operator.locator('#notice').textContent(), /เว็บแคม/);

    // และต้องบอกทางแก้ ไม่ใช่แค่บอกว่าพัง
    assert.match(await operator.locator('#notice').textContent(), /pkill/);
  } finally {
    await fs.rm(failFlag(), { force: true });
  }
});

test('the camera coming back does not need the app restarted', async (t) => {
  if (skipUnlessBoth(t)) return;

  // เสียบสายกลับเข้าไปแล้วต้องใช้ได้ต่อทันที — บูธที่ต้องปิดเปิดใหม่ทุกครั้งที่สาย
  // หลุดคือบูธที่เสียคิวทุกครั้ง และค่าตั้งกับรอบที่ค้างอยู่จะหายไปด้วย
  const token = await shootOnce();
  const saved = await fs.readFile(path.join(sessions(), token, 'shots', 'shot-1.jpg'));
  assert.ok(saved.equals(cameraJpeg), 'กล้องกลับมาแล้วต้องได้รูปจากกล้องอีกครั้ง');
  assert.equal(await operator.locator('#notice').isHidden(), true, 'คำเตือนของรอบก่อนต้องไม่ค้าง');
});

/**
 * แบบแถบยาวสามรูป — **แบบที่ใช้จริงในงาน** (ค่าเริ่มต้นของบูธ)
 *
 * ข้ออื่นในไฟล์นี้ใช้แบบรูปเดียวเพราะเร็วกว่า แต่ทั้งงานจะเดินด้วยแบบสามรูป
 * ซึ่งลั่นชัตเตอร์สามครั้งติดกัน · สิ่งที่ต้องตรึงคือ **ครบสามใบ เรียงถูก และ
 * ทุกใบมาจากกล้องจริง** ไม่ใช่บางใบหลุดไปใช้เว็บแคมโดยไม่มีใครสังเกต ซึ่งจะเห็น
 * เป็นแค่ "รูปหนึ่งในสามใบเบลอกว่าเพื่อน" บนกระดาษที่ขายไปแล้ว
 */
test('a three-photo strip fires the shutter three times, all from the camera', async (t) => {
  if (skipUnlessBoth(t)) return;

  await saveSettings(path.join(userData, 'booth'), { template: 'strip' });
  await Promise.all([guest.reload(), operator.reload()]);
  await guest.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await operator.waitForSelector('body[data-ready="1"]', { timeout: 30000 });

  const token = await shootOnce();
  const dir = path.join(sessions(), token, 'shots');

  assert.deepEqual((await fs.readdir(dir)).sort(),
    ['shot-1.jpg', 'shot-2.jpg', 'shot-3.jpg'], 'ต้องได้ครบสามใบ เรียงตามลำดับที่ถ่าย');

  for (const name of await fs.readdir(dir)) {
    assert.ok((await fs.readFile(path.join(dir, name))).equals(cameraJpeg),
      `${name} ต้องมาจากกล้อง ไม่ใช่หลุดไปใช้เว็บแคม`);
  }

  // และประกอบเป็นแผ่นแถบยาวได้จริง ไม่ใช่ค้างเพราะรูปใหญ่กว่าที่เคยเจอ
  const sheet = await sharp(path.join(sessions(), token, 'sheet.jpg')).metadata();
  assert.equal(sheet.width, 1200);
  assert.equal(sheet.height, 1800);
  assert.equal(await operator.locator('#notice').isHidden(), true);
});

test('the settings screen can tell you whether the camera is really there', async (t) => {
  if (skipUnlessBoth(t)) return;

  // หน้าตั้งค่าเปิดได้เฉพาะขั้นพร้อมถ่าย (บันทึกแล้วจอบูธโหลดใหม่) — ข้อก่อนหน้า
  // ทิ้งบูธไว้ที่ขั้นดูแผ่น ต้องพากลับมาก่อน
  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });

  await operator.locator('#setup').click();
  let setup;
  for (let i = 0; i < 80 && !setup; i += 1) {
    setup = app.windows().find((page) => page.url().endsWith('setup.html'));
    if (!setup) await new Promise((done) => setTimeout(done, 250));
  }
  await setup.waitForSelector('body[data-ready="1"]', { timeout: 30000 });

  // ตอบด้วยชื่อรุ่นที่เจอจริง ไม่ใช่แค่ "เจอ/ไม่เจอ" — บูธที่มีกล้องสองตัววางอยู่
  // ต้องรู้ว่าเสียบสายถูกตัวหรือเปล่า ตั้งแต่ตอนตั้งบูธ ไม่ใช่ตอนแขกคนแรกยืนอยู่
  await setup.locator('#check-camera').click();
  await setup.waitForFunction(
    () => document.getElementById('camera-note').textContent.includes('D7000'),
    { timeout: 30000 },
  );

  // ถอดกล้องออกแล้วต้องบอกวิธีแก้ ไม่ใช่บอกว่าไม่เจอเฉย ๆ
  await fs.writeFile(failFlag(), '');
  await setup.locator('#check-camera').click();
  await setup.waitForFunction(
    () => document.getElementById('camera-note').textContent.includes('สาย USB'),
    { timeout: 30000 },
  );
  await fs.rm(failFlag(), { force: true });

  const closed = setup.waitForEvent('close', { timeout: 15000 });
  await setup.locator('#cancel').click().catch(() => {});
  await closed;
});
