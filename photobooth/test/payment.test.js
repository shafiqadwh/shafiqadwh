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
 * เก็บเงินหน้าบูธด้วย QR พร้อมเพย์ — เปิดบูธเอง ออกงาน หรือกางหน้าบ้าน
 *
 * สองข้อที่ไฟล์นี้มีไว้ตรึงไว้ให้แน่น
 *
 * 1. **แขกกดยืนยันเงินให้ตัวเองไม่ได้** เมื่อมีจอช่างภาพ · ปุ่ม "ได้รับเงินแล้ว"
 *    ต้องอยู่ที่จอหลังที่เดียว เพราะคนที่เห็นแอปธนาคารคือเจ้าของบูธ ไม่ใช่แขก
 * 2. **QR ที่แขกสแกน ต้องเป็นสตริงพร้อมเพย์ของเบอร์และยอดที่ตั้งไว้จริง ๆ**
 *    ไม่ใช่รูปอะไรก็ได้ที่ขึ้นถูกที่ — QR ที่ผิดคือเงินเข้าบัญชีคนอื่นทั้งวัน
 *
 * ตัวตัดสินสุดท้ายยังเป็นเจ้าของบูธที่ต้องสแกนด้วยแอปธนาคารจริงหนึ่งครั้ง
 * ก่อนเปิดขาย — เทสต์ตรวจได้แค่ว่าสตริงถูกตามมาตรฐาน ไม่ได้ตรวจว่าธนาคารรับ
 */

const PHONE = '0812345678';
const PRICE = 150;

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

let app;
let guest;
let operator;
let userData;
let xvfb = null;
let launchError = null;

const ensureDisplay = async () => { xvfb = await startDisplay([97, 87, 77]); };

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-pay-'));
  try {
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'บูธหน้าบ้าน',
      template: 'classic',
      countdownSeconds: 2,
      // พิมพ์ลงไฟล์ ไม่ต้องมีเครื่องพิมพ์จริงตอนรันเทสต์
      printer: { driver: 'file', name: '' },
      sale: { enabled: true, target: PHONE, price: PRICE },
    });

    await ensureDisplay();
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
      /*
       * ใจเย็นกับการเปิด Electron — หมดเวลาแล้ว "ข้าม" ทั้งไฟล์ คือไม่ได้ทดสอบอะไรเลย
       *
       * `npm test` รันไฟล์เทสต์พร้อมกันหลายไฟล์ และมีอีกสามไฟล์ที่เปิด Electron
       * ของตัวเองด้วย · วัดแล้ว: เปิดไฟล์นี้ลำพังใช้เวลาไม่ถึงครึ่งนาที แต่ตอนรัน
       * ทั้งชุดพร้อมกันเกินสามนาทีได้ แล้วหกข้อในไฟล์นี้ถูกข้ามไปแบบเงียบ ๆ
       */
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

/** ถ่ายหนึ่งรอบจนถึงหน้าจ่ายเงิน */
async function shootUntilPayment() {
  if (await guest.getAttribute('body', 'data-stage') !== 'ready') {
    await guest.locator('#restart').click().catch(() => {});
    await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
  }
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  await guest.locator('#deliver').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
}

const ledger = async () => {
  const dir = path.join(userData, 'booth', 'sales');
  const files = await fs.readdir(dir).catch(() => []);
  const lines = await Promise.all(files.map((name) =>
    fs.readFile(path.join(dir, name), 'utf8')));
  return lines.join('').split('\n').filter(Boolean).map((line) => JSON.parse(line));
};

test('the guest is asked to pay before anything is printed', async (t) => {
  if (skipUnlessBoth(t)) return;
  await shootUntilPayment();

  // ยอดต้องอ่านออกจากระยะยืน และต้องเป็นยอดที่ตั้งไว้ ไม่ใช่ค่าเริ่มต้นอะไรก็ตาม
  assert.match(await guest.locator('#pay-price').textContent(), /150/);
  assert.equal(await operator.getAttribute('body', 'data-stage'), 'pay');
  assert.match(await operator.locator('#pay-price').textContent(), /150/);

  // ยังไม่มีใครยืนยัน = ยังไม่มีบรรทัดในสมุดบัญชี และยังไม่ได้พิมพ์
  assert.deepEqual(await ledger(), []);
});

test('the QR on the screen really is this booth\'s PromptPay, for this amount', async (t) => {
  if (skipUnlessBoth(t)) return;

  /*
   * เทียบทั้งรูป ไม่ใช่แค่ว่ามี src — รูป QR ที่ขึ้นถูกที่แต่เข้ารหัสผิดคือ
   * เงินเข้าบัญชีคนอื่นทั้งวันโดยไม่มีอะไรบนหน้าจอผิดปกติเลยสักอย่าง
   *
   * สตริงที่คาดหวังสร้างจากตัวสร้างเดียวกับที่ test/promptpay.test.js ตรวจไว้แล้ว
   * ทีละช่องตามมาตรฐาน — สองไฟล์รวมกันจึงครอบตั้งแต่ไบต์แรกจนถึงพิกเซลบนจอ
   */
  const expected = await QRCode.toDataURL(
    promptPayPayload({ target: PHONE, amount: PRICE }),
    { width: 720, margin: 1 },
  );

  assert.equal(await guest.locator('#pay-qr').getAttribute('src'), expected);
  assert.equal(await operator.locator('#pay-qr').getAttribute('src'), expected,
    'จอช่างภาพต้องเห็น QR ใบเดียวกับที่แขกกำลังสแกนอยู่');
});

test('with a photographer screen, only the photographer can say the money arrived', async (t) => {
  if (skipUnlessBoth(t)) return;

  // ปุ่ม "จ่ายแล้ว" บนจอแขกต้องไม่โผล่เลยเมื่อมีจอหลัง — ไม่ใช่แค่จาง ๆ กดไม่ได้
  assert.equal(await guest.locator('#pay-buttons').isHidden(), true);
  assert.equal(await guest.locator('#pay-wait').isHidden(), false,
    'แขกต้องรู้ว่ากำลังรออะไรอยู่ ไม่ใช่ยืนหาปุ่มที่ไม่มี');

  // และปุ่มบนจอช่างภาพต้องบอกตรง ๆ ว่ากดแล้วเกิดอะไร ไม่ใช่ "ต่อไป"
  assert.match(await operator.locator('#go').textContent(), /ได้รับเงินแล้ว/);
});

test('confirming payment records the sale, then prints', async (t) => {
  if (skipUnlessBoth(t)) return;

  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });

  const rows = await ledger();
  assert.equal(rows.length, 1, 'หนึ่งรอบที่เก็บเงินแล้ว = หนึ่งบรรทัด');
  assert.equal(rows[0].amount, PRICE);
  assert.equal(rows[0].free, false);
  assert.match(rows[0].token, /^[0-9A-Z]{6}$/, 'ต้องผูกกับรอบถ่ายจริง เพื่อกระทบยอดย้อนหลังได้');

  // ยอดวันนี้ต้องขึ้นให้เจ้าของเห็นทันที ไม่ใช่ต้องไปเปิดไฟล์อ่านเอง
  assert.match(await operator.locator('#takings').textContent(), /150/);
});

test('a free round still goes in the book, so the paper count still adds up', async (t) => {
  if (skipUnlessBoth(t)) return;
  await shootUntilPayment();

  await operator.locator('#pay-free').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });

  const rows = await ledger();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].amount, 0);
  assert.equal(rows[1].free, true);

  // เงินไม่เพิ่ม แต่จำนวนรอบเพิ่ม — ตรงกับกระดาษที่หายไปจริงหนึ่งแผ่น
  const line = await operator.locator('#takings').textContent();
  assert.match(line, /150/);
  assert.match(line, /2 รอบ/);
  assert.match(line, /ฟรี 1/);
});

test('backing out at the payment screen prints nothing and charges nothing', async (t) => {
  if (skipUnlessBoth(t)) return;
  await shootUntilPayment();

  const before = (await ledger()).length;
  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });

  assert.equal((await ledger()).length, before, 'แขกเปลี่ยนใจต้องไม่มีบรรทัดในสมุดบัญชี');
});
