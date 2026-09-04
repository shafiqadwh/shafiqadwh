import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startDisplay } from './helpers/display.js';

/**
 * ขับแอปจริงทั้งตัว — Electron + หน้าจอ + กล้อง + ประกอบแผ่น + สั่งพิมพ์
 *
 * เทสต์อื่นตรวจชิ้นส่วนทีละชิ้น · ชิ้นที่ต่อกันไม่ติดจะรอดสายตาเทสต์พวกนั้นไปหมด
 * (IPC ชื่อไม่ตรง, preload ไม่ถูกโหลด, ปุ่มผูก event ผิดตัว) และไปโผล่หน้างาน
 *
 * กล้องใช้ภาพจำลองของ Chromium (`--use-fake-device-for-media-stream`) ซึ่งให้
 * ภาพเคลื่อนไหวจริงผ่าน getUserMedia — เส้นทางเดียวกับกล้องจริงทุกขั้น
 *
 * เปิด Electron ไม่ได้ให้ `t.skip()` พร้อมบอกเหตุผล **ห้ามผ่านเงียบ ๆ**
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

let app;
let page;
let userData;
let xvfb = null;
let launchError = null;

/**
 * Electron ต้องมีจอ · เครื่องที่รันเทสต์ไม่มี
 *
 * ยก Xvfb ขึ้นเองถ้ายังไม่มี DISPLAY — ไม่งั้นเทสต์ชุดนี้ (ซึ่งเป็นชุดเดียวที่
 * ตรวจว่าชิ้นส่วนต่อกันติดจริง) จะถูก skip ทิ้งทุกครั้งที่ใครรัน `npm test`
 * เฉย ๆ แล้วค่อย ๆ เน่าไปโดยไม่มีใครสังเกต
 */
const ensureDisplay = async () => { xvfb = await startDisplay([99, 89, 79]); };

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-app-'));
  try {
    await ensureDisplay();
    const { _electron } = await import('playwright');
    // ชี้ไบนารีให้ตรง ๆ — playwright อยู่ใน node_modules ของราก ส่วน electron อยู่ใน
    // ของ photobooth · ปล่อยให้มันหาเองจะไม่เจอ แล้วเทสต์ทั้งไฟล์จะถูก skip ทิ้ง
    // โดยที่ดูเหมือน "ผ่าน" ในสรุปผล
    const electronPath = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
    await fs.access(electronPath);

    app = await _electron.launch({
      executablePath: electronPath,
      args: [
        appDir,
        '--no-sandbox',
        // กล้องจำลอง: ได้ภาพเคลื่อนไหวจริง และไม่มีกล่องขออนุญาตมาค้าง
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
      env: {
        ...process.env,
        BOOTH_WINDOWED: '1', // เต็มจอในเทสต์ทำให้จับขนาดหน้าต่างไม่ได้
        // แยกที่เก็บข้อมูลของเทสต์ออกจากของจริง ไม่ให้ไปทับค่าตั้งของเครื่อง
        BOOTH_USER_DATA: userData,
      },
      timeout: 60000,
    });
    page = await app.firstWindow();
  } catch (error) {
    launchError = error;
  }
});

after(async () => {
  await app?.close().catch(() => {});
  xvfb?.kill('SIGTERM');
  await fs.rm(userData, { recursive: true, force: true });
});

/**
 * พากลับมาที่หน้าเริ่ม ไม่ว่าตอนนี้จะค้างอยู่ฉากไหน
 *
 * เทสต์ทุกข้อในไฟล์นี้ใช้แอปตัวเดียวกันและรันต่อกัน สถานะจึงติดมาจากข้อก่อนหน้า
 * — ข้อที่เดาว่า "ข้อก่อนคงทิ้งไว้ที่หน้าเริ่ม" จะพังทันทีที่มีใครสลับลำดับหรือ
 * แทรกข้อใหม่เข้ามา (เกิดขึ้นจริงตอนเพิ่มข้อเรื่องการทิ้งรอบถ่าย)
 */
async function toReady() {
  if (await page.getAttribute('body', 'data-stage') === 'ready') return;
  const back = { review: '#again', done: '#restart', shoot: null };
  const button = back[await page.getAttribute('body', 'data-stage')];
  if (button) await page.locator(button).click();
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
}

const skipIfNoElectron = (t) => {
  if (app && page) return false;
  t.skip(`เปิด Electron ไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
  return true;
};

test('the booth opens and reaches the ready screen', async (t) => {
  if (skipIfNoElectron(t)) return;

  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  assert.equal(await page.getAttribute('body', 'data-stage'), 'ready');

  // preload ต้องยื่นสะพานให้จริง ไม่ใช่แค่หน้าโหลดขึ้น
  assert.equal(await page.evaluate(() => typeof window.booth?.compose), 'function');
  // และต้องไม่ยื่นอะไรเกินกว่าที่ตั้งใจ
  assert.deepEqual(
    (await page.evaluate(() => Object.keys(window.booth))).sort(),
    // รายการนี้เป็นบัญชีที่ตั้งใจ ไม่ใช่ผลข้างเคียง — เพิ่มชื่อลงมาต้องเป็นการ
    // ตัดสินใจที่มีคนเห็น ไม่ใช่ของที่ไหลเข้ามาเงียบ ๆ พร้อมฟีเจอร์ใหม่
    ['broadcast', 'checkPay', 'closeSettings', 'compose', 'deliver', 'discard', 'onMessage',
      'openSettings', 'paid', 'pending', 'retake', 'sale', 'save', 'settings', 'setup', 'upload'],
  );
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined',
    'หน้าจอต้องไม่มีทางเรียกโมดูลของ Node ได้เอง');
});

test('the effect chips come from the settings, not from all seven', async (t) => {
  if (skipIfNoElectron(t)) return;

  const chips = await page.locator('.chip').allTextContents();
  assert.equal(chips.length, 3, 'ค่าเริ่มต้นให้เลือกสามแบบ');

  // ปุ่มแรกถูกเลือกไว้ให้ตั้งแต่ต้น — แขกที่ไม่เลือกอะไรเลยต้องถ่ายได้ทันที
  assert.equal(await page.locator('.chip[aria-checked="true"]').count(), 1);

  await page.locator('.chip').nth(1).click();
  assert.equal(await page.locator('.chip').nth(1).getAttribute('aria-checked'), 'true');
  assert.equal(await page.locator('.chip').nth(0).getAttribute('aria-checked'), 'false');
});

test('pressing start really takes photos and builds a sheet', async (t) => {
  if (skipIfNoElectron(t)) return;

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="shoot"]', { timeout: 5000 });

  // กล้องต้องเดินจริง ไม่ใช่กรอบดำ
  await page.waitForFunction(() => {
    const video = document.getElementById('preview');
    return video && video.videoWidth > 0;
  }, { timeout: 20000 });

  // ค่าเริ่มต้นคือแบบแถบยาว = 3 รูป × นับถอยหลัง 3 วิ + เว้นจังหวะ ≈ 14 วิ
  await page.waitForSelector('body[data-stage="review"]', { timeout: 60000 });

  const src = await page.locator('#sheet').getAttribute('src');
  assert.match(src ?? '', /^data:image\/jpeg;base64,/, 'ต้องได้ภาพตัวอย่างของแผ่นจริง');
  assert.ok(src.length > 5000, 'ภาพตัวอย่างเล็กผิดปกติ — น่าจะประกอบไม่สำเร็จ');

  assert.equal(await page.locator('#error').isVisible(), false, 'ต้องไม่มีข้อความผิดพลาดค้าง');
});

test('the sheet and the originals really landed on disk', async (t) => {
  if (skipIfNoElectron(t)) return;

  const sessions = path.join(userData, 'booth', 'sessions');
  const tokens = await fs.readdir(sessions);
  assert.equal(tokens.length, 1, 'ถ่ายไปหนึ่งรอบ ต้องได้หนึ่งโฟลเดอร์');

  const dir = path.join(sessions, tokens[0]);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
  assert.equal(manifest.token, tokens[0]);
  assert.equal(manifest.shots.length, 3, 'แบบแถบยาวต้องเก็บรูปดิบครบสามใบ');
  assert.equal(manifest.sheet.width, 1200);
  assert.equal(manifest.sheet.height, 1800);

  const { default: sharp } = await import('sharp');
  const meta = await sharp(path.join(dir, 'sheet.jpg')).metadata();
  assert.equal(meta.width, 1200, 'แผ่นบนดิสก์ต้องเป็นขนาดพิมพ์จริง ไม่ใช่ภาพตัวอย่าง');
  assert.equal(meta.height, 1800);
});

test('delivering puts a file in the outbox and shows the done screen', async (t) => {
  if (skipIfNoElectron(t)) return;

  await page.locator('#deliver').click();
  await page.waitForSelector('body[data-stage="done"]', { timeout: 20000 });

  const outbox = path.join(userData, 'booth', 'outbox');
  const printed = await fs.readdir(outbox);
  assert.equal(printed.length, 1, 'สั่งพิมพ์หนึ่งครั้ง ค่าเริ่มต้นหนึ่งใบ');
  assert.ok(printed[0].endsWith('.jpg'));

  // ชื่อไฟล์ต้องพาย้อนกลับไปหารอบถ่ายได้ ไม่งั้นหลังงานแยกไม่ออกว่าใบไหนของใคร
  const tokens = await fs.readdir(path.join(userData, 'booth', 'sessions'));
  assert.ok(printed[0].includes(tokens[0]), `ชื่อไฟล์ ${printed[0]} ไม่มีโทเคน ${tokens[0]}`);
});

test('a take the guest rejects is deleted, not left on disk', async (t) => {
  if (skipIfNoElectron(t)) return;

  await toReady();
  const sessions = path.join(userData, 'booth', 'sessions');
  const before = (await fs.readdir(sessions)).length;

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
  assert.equal((await fs.readdir(sessions)).length, before + 1, 'ถ่ายแล้วต้องมีรอบเพิ่ม');

  await page.locator('#again').click();
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 5000 });

  // การลบเกิดหลังหน้าจอเปลี่ยนแล้ว — แขกไม่ต้องยืนรอ จึงต้องรอตรงนี้แทน
  const gone = async () => (await fs.readdir(sessions)).length === before;
  for (let i = 0; i < 40 && !(await gone()); i += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(await gone(),
    'รอบที่แขกกด "ถ่ายใหม่" ต้องถูกลบ — ไม่งั้นรูปที่เขาตั้งใจทิ้งจะถูกอัปโหลดขึ้นเว็บด้วย');
});

test('a take that fails to build leaves nothing behind on disk', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  const sessions = path.join(userData, 'booth', 'sessions');
  const before = (await fs.readdir(sessions)).length;

  // เฟรมเสียจากกล้อง (หรือจำนวนรูปไม่ครบแบบที่ตั้งไว้) — ทั้งคู่ล้มหลังจองที่ไปแล้ว
  const failed = await page.evaluate(() => window.booth
    .compose({ shots: ['data:image/jpeg;base64,AAAAAAAA'], effect: 'clean' })
    .then(() => null, (error) => error.message));
  assert.ok(failed, 'ประกอบแผ่นจากเฟรมเสียต้องล้ม ไม่ใช่ผ่านไปเงียบ ๆ');

  assert.equal((await fs.readdir(sessions)).length, before,
    'ที่จองไว้ต้องถูกคืนเมื่อประกอบไม่สำเร็จ — ไม่งั้นทุกครั้งที่กล้องส่งเฟรมเสีย'
    + ' จะเหลือโฟลเดอร์เปล่าค้างไว้หนึ่งใบตลอดงาน');
});

test('the next guest never sees the sheet the last guest left', async (t) => {
  if (skipIfNoElectron(t)) return;

  await toReady();
  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
  assert.ok(await page.locator('#sheet').getAttribute('src'), 'ต้องมีแผ่นให้ดูก่อน');

  await page.locator('#again').click();
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 5000 });
  assert.equal(await page.locator('#sheet').getAttribute('src'), null,
    'แผ่นของรอบก่อนต้องหายไป ไม่ค้างให้แขกคนถัดไปเห็น');
  assert.equal(await page.locator('#token').textContent(), '', 'รหัสของรอบก่อนก็ต้องหายด้วย');
});
