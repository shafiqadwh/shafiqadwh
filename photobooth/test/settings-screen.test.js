import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';
import { promptPayPayload } from '../src/core/promptpay.js';
import { startDisplay } from './helpers/display.js';

/**
 * หน้าตั้งค่าในแอป — เลิกแก้ settings.json ด้วยมือหน้างาน
 *
 * ที่ไฟล์นี้ตรึงไว้ ไม่ใช่ว่า "ฟอร์มมีช่องครบ" แต่คือสามข้อที่ผิดแล้วเสียเงินจริง
 *
 * 1. **บันทึกแล้วจอบูธต้องเห็นค่าใหม่ทันที** ไม่ใช่ต้องปิดเปิดแอป — ถ้าต้องปิดเปิด
 *    หน้านี้ก็ไม่ได้ดีกว่าการแก้ไฟล์ด้วยมือเลย
 * 2. **ค่าที่บันทึกไม่ได้ต้องบอก ไม่ใช่เงียบ** เบอร์พร้อมเพย์ผิดแล้วการขายถูกปิด
 *    ให้เอง (ซึ่งถูกแล้ว) แต่ถ้าไม่บอก เจ้าของจะเปิดบูธทั้งวันโดยเชื่อว่าตั้งขายไว้แล้ว
 * 3. **เปิดกลางรอบถ่ายไม่ได้** เพราะการบันทึกทำให้จอบูธโหลดใหม่ = ทิ้งรอบของแขก
 *    ที่ยืนอยู่ตรงนั้น
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

let app;
let guest;
let operator;
let userData;
let xvfb = null;
let launchError = null;

const settingsFile = () => path.join(userData, 'booth', 'settings.json');
const readSettings = async () => JSON.parse(await fs.readFile(settingsFile(), 'utf8'));

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-setup-'));
  try {
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'งานเดิม',
      template: 'classic',
      countdownSeconds: 2,
      printer: { driver: 'file', name: '' },
    });

    xvfb = await startDisplay([95, 85, 75]);
    const { _electron } = await import('playwright');
    const electronPath = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron');
    await fs.access(electronPath);

    app = await _electron.launch({
      executablePath: electronPath,
      args: [appDir, '--no-sandbox',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: {
        ...process.env, BOOTH_WINDOWED: '1', BOOTH_USER_DATA: userData, BOOTH_OPERATOR: '1',
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
});

const skipUnlessBoth = (t) => {
  if (guest && operator) return false;
  t.skip(`เปิดสองหน้าต่างไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
  return true;
};

/** เปิดหน้าตั้งค่าจากปุ่มบนจอช่างภาพ แล้วคืนหน้าต่างของมัน */
async function openSetup() {
  await operator.locator('#setup').click();
  for (let i = 0; i < 80; i += 1) {
    const found = app.windows().find((page) => page.url().endsWith('setup.html'));
    if (found) {
      await found.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
      return found;
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error('หน้าตั้งค่าไม่เปิด');
}

test('the settings screen opens with what the booth is actually running', async (t) => {
  if (skipUnlessBoth(t)) return;
  const setup = await openSetup();

  // ค่าที่เห็นต้องมาจากไฟล์จริง ไม่ใช่ค่าเริ่มต้นของฟอร์ม — ไม่งั้นกดบันทึกทีเดียว
  // แล้วค่าที่ตั้งไว้ก่อนหน้าถูกทับหายไปทั้งชุดโดยไม่ได้ตั้งใจแก้
  assert.equal(await setup.locator('#eventTitle').inputValue(), 'งานเดิม');
  assert.equal(await setup.locator('#template').inputValue(), 'classic');
  assert.equal(await setup.locator('#countdownSeconds').inputValue(), '2');

  // บูธนี้ยังไม่ได้ตั้งที่อยู่เว็บ — โหมด QR บนจอจึงต้องเลือกไม่ได้ พร้อมบอกเหตุ
  assert.equal(await setup.locator('#deliver-hint').isHidden(), false);
  // อ่าน property ตรง ๆ — `isDisabled()` ของ Playwright ตอบ <option> ไม่คงเส้นคงวา
  // (วัดแล้ว: รันเดิมซ้ำได้คนละคำตอบ) และสิ่งที่ต้องรู้คือเบราว์เซอร์ให้เลือกไหม
  assert.equal(
    await setup.locator('#deliver').evaluate((box) =>
      box.querySelector('option[value="screen"]').disabled),
    true,
  );
});

test('saving reaches the booth screen without restarting the app', async (t) => {
  if (skipUnlessBoth(t)) return;
  const setup = await openSetup();

  await setup.locator('#eventTitle').fill('ปัจฉิม ม.6');
  await setup.locator('#countdownSeconds').fill('5');
  await setup.locator('#save').click();
  await setup.waitForSelector('#status.is-good', { timeout: 30000 });

  // ลงไฟล์จริง
  const saved = await readSettings();
  assert.equal(saved.eventTitle, 'ปัจฉิม ม.6');
  assert.equal(saved.countdownSeconds, 5);

  // และถึงจอบูธจริง — นี่คือข้อที่ทำให้หน้านี้ต่างจากการแก้ไฟล์ด้วยมือ
  await guest.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await guest.waitForFunction(
    () => document.getElementById('event-title').textContent === 'ปัจฉิม ม.6',
    { timeout: 30000 },
  );
});

test('a PromptPay number that cannot work leaves the sale off, and says so', async (t) => {
  if (skipUnlessBoth(t)) return;
  const setup = await openSetup();

  // เบอร์สั้นไปหนึ่งตัว — พิมพ์ตกหล่นแบบที่เกิดจริงตอนรีบตั้งบูธ
  await setup.locator('#saleEnabled').check();
  await setup.locator('#saleTarget').fill('081234567');
  await setup.locator('#salePrice').fill('50');
  await setup.locator('#save').click();
  await setup.waitForSelector('#status.is-bad', { timeout: 30000 });

  assert.match(await setup.locator('#status').textContent(), /ยังไม่ได้เปิดขาย/);
  assert.equal((await readSettings()).sale.enabled, false);
  // ช่องติ๊กต้องเด้งกลับตามความจริงด้วย ไม่ใช่ค้างเป็นติ๊กอยู่ทั้งที่ไม่ได้เปิด
  assert.equal(await setup.locator('#saleEnabled').isChecked(), false);
});

test('the QR you scan to test is the real one for what you just typed', async (t) => {
  if (skipUnlessBoth(t)) return;
  const setup = await openSetup();

  await setup.locator('#saleTarget').fill('0812345678');
  await setup.locator('#salePrice').fill('50');
  await setup.locator('#check').click();
  await setup.waitForSelector('#check-qr:not([hidden])', { timeout: 30000 });

  /*
   * ต้องเป็น QR ของเบอร์และยอดนั้นจริง ๆ ไม่ใช่รูปอะไรก็ได้ที่ขึ้นถูกที่
   * ปุ่มนี้มีไว้ให้เจ้าของสแกนด้วยแอปธนาคารก่อนเปิดขาย — ถ้ามันไม่ตรงกับสิ่งที่
   * จะถูกบันทึก การสแกนทดสอบก็ไม่ได้พิสูจน์อะไรเลย
   */
  assert.equal(
    await setup.locator('#check-qr').getAttribute('src'),
    await QRCode.toDataURL(promptPayPayload({ target: '0812345678', amount: 50 }),
      { width: 520, margin: 1 }),
  );

  // แก้เบอร์ต่อแล้ว QR ใบเก่าต้องหายไป — ค้างไว้คือให้สแกนใบที่ไม่ตรงกับที่จะบันทึก
  await setup.locator('#saleTarget').fill('0898765432');
  assert.equal(await setup.locator('#check-qr').isHidden(), true);

  // ปุ่มปิดต้องปิดหน้าต่างจริง — คลิกที่ปิดหน้าต่างตัวเองทำให้ Playwright โยน
  // "target closed" ซึ่งเป็นผลที่ถูกต้อง ไม่ใช่ความล้มเหลว · ตัวตัดสินคือ event close
  const closed = setup.waitForEvent('close', { timeout: 15000 });
  await setup.locator('#cancel').click().catch(() => {});
  await closed;
});

/**
 * บูธจอเดียวก็ต้องเข้าหน้าตั้งค่าได้ — และนั่นคือบูธที่ต้องแก้ราคาบ่อยที่สุด
 *
 * บูธที่กางหน้าบ้านหรือออกตลาดนัดมีจอเดียว จึงไม่มีปุ่มบนจอช่างภาพให้กด
 * ถ้าไม่มีทางเข้าอีกทาง หน้าตั้งค่าก็ใช้ไม่ได้เลยกับรูปแบบที่เก็บเงินเองทุกบาท
 *
 * กดค้างแทนปุ่ม เพราะจอนี้หันออกไปทางแขก — ปุ่มที่เห็นคือปุ่มที่จะถูกกด
 */
const setupWindow = () => app.windows().find((page) => page.url().endsWith('setup.html'));

test('a one-screen booth opens settings by holding the event title', async (t) => {
  if (skipUnlessBoth(t)) return;
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });
  assert.equal(setupWindow(), undefined, 'ต้องเริ่มจากที่ยังไม่มีหน้าตั้งค่าเปิดอยู่');

  // แตะธรรมดาต้องไม่เปิด — แขกแตะจอโดนชื่องานได้ตลอดเวลา
  await guest.locator('#event-title').click();
  await new Promise((done) => setTimeout(done, 1200));
  assert.equal(setupWindow(), undefined, 'แตะสั้นต้องไม่เปิดหน้าตั้งค่า');

  await guest.locator('#event-title').click({ delay: 2400 });
  for (let i = 0; i < 40 && !setupWindow(); i += 1) {
    await new Promise((done) => setTimeout(done, 250));
  }
  const setup = setupWindow();
  assert.ok(setup, 'กดค้างที่ชื่องานต้องเปิดหน้าตั้งค่า');

  await setup.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  const closed = setup.waitForEvent('close', { timeout: 15000 });
  await setup.locator('#cancel').click().catch(() => {});
  await closed;
});

test('settings cannot be opened in the middle of a round', async (t) => {
  if (skipUnlessBoth(t)) return;

  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });
  assert.equal(await operator.locator('#setup').isDisabled(), false);

  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });

  // การบันทึกทำให้จอบูธโหลดใหม่ — กลางรอบถ่ายคือทิ้งรอบของแขกที่ยืนอยู่ตรงนั้น
  assert.equal(await operator.locator('#setup').isDisabled(), true);

  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });
  assert.equal(await operator.locator('#setup').isDisabled(), false);
});
