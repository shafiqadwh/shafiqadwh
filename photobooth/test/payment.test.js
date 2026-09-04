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

/**
 * พาบูธกลับหน้าเริ่ม ไม่ว่าข้อก่อนหน้าจะทิ้งไว้ที่ขั้นไหน
 *
 * ปุ่มที่ใช้ต่างกันตามขั้น: "ถ่ายใหม่" มีเฉพาะขั้นดูแผ่นกับขั้นเก็บเงิน
 * ส่วนขั้นเสร็จแล้วใช้ปุ่มหลัก
 */
async function backToReady() {
  const stage = await guest.getAttribute('body', 'data-stage');
  if (stage === 'ready') return;
  await operator.locator(stage === 'done' ? '#go' : '#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
}

/** ถ่ายหนึ่งรอบจนถึงหน้าจ่ายเงิน */
async function shootUntilPayment() {
  await backToReady();
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

  const before = await ledger();
  await operator.locator('#pay-free').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });

  const rows = await ledger();
  assert.equal(rows.length, before.length + 1);
  assert.equal(rows.at(-1).amount, 0);
  assert.equal(rows.at(-1).free, true);

  // เงินไม่เพิ่ม แต่จำนวนรอบเพิ่ม — ตรงกับกระดาษที่หายไปจริงหนึ่งแผ่น
  const paid = before.reduce((sum, row) => sum + row.amount, 0);
  const line = await operator.locator('#takings').textContent();
  assert.match(line, new RegExp(`${paid.toLocaleString('th-TH')} บาท`));
  assert.match(line, new RegExp(`${rows.length} รอบ`));
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

/**
 * โหมดจ่ายก่อนถ่าย — สำหรับงานที่คนเข้าถึงบูธได้ฟรีและคนเยอะ
 *
 * ปัญหาที่โหมดนี้แก้ไม่ใช่แค่ "เสียรายได้" แต่คือ **เสียคิว** — คนที่แวะมาลองเล่น
 * แล้วเดินหนีตอนเห็นราคา ทำให้คนที่ตั้งใจจะซื้อต้องยืนรอ · งานปัจฉิม ม.6
 * คือกรณีตัวอย่างตรง ๆ
 *
 * สลับค่าตั้งแล้วโหลดหน้าใหม่ในบูธตัวเดิม แทนที่จะเปิด Electron อีกตัว — เปิด
 * เพิ่มอีกตัวคือเทสต์ทั้งไฟล์แย่งเครื่องกันจนถูกข้ามเงียบ ๆ ซึ่งเคยเกิดมาแล้ว
 */
async function switchToPayFirst() {
  await saveSettings(path.join(userData, 'booth'), {
    sale: { enabled: true, target: PHONE, price: PRICE, payWhen: 'before' },
  });
  // จอหน้าอ่านค่าตั้งตอนบูตครั้งเดียว — ต้องโหลดใหม่ถึงจะเห็นโหมดใหม่
  await Promise.all([guest.reload(), operator.reload()]);
  await guest.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  await operator.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
}

test('paying first: the price is on the very first button, before anyone touches it', async (t) => {
  if (skipUnlessBoth(t)) return;
  await switchToPayFirst();

  // นี่คือส่วนที่กันคิวจริง ๆ — คนที่ไม่ได้ตั้งใจซื้อเห็นราคาตั้งแต่ยังไม่แตะจอ
  assert.match(await guest.locator('#start-label').textContent(), /150/);
  assert.match(await operator.locator('#go').textContent(), /150/);
});

test('paying first: pressing start takes payment instead of taking photos', async (t) => {
  if (skipUnlessBoth(t)) return;

  const before = (await ledger()).length;
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });

  // ยังไม่ได้ถ่ายอะไรเลย และยังไม่มีบรรทัดในสมุดบัญชี — แค่ยืนดูราคาอยู่
  assert.equal(await guest.locator('#pay-price').textContent(), '150 บาท');
  assert.equal((await ledger()).length, before);

  // เดินหนีตอนเห็นราคา = ไม่เสียอะไรทั้งสองฝ่าย และไม่มีรอบค้างบนดิสก์
  const sessionsBefore = await fs.readdir(path.join(userData, 'booth', 'sessions'));
  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });
  assert.deepEqual(
    await fs.readdir(path.join(userData, 'booth', 'sessions')),
    sessionsBefore,
    'คนที่ไม่จ่ายต้องไม่ทิ้งรอบเปล่าไว้บนดิสก์',
  );
  assert.equal((await ledger()).length, before);
});

test('paying first: the money and the photos end up on the same ticket', async (t) => {
  if (skipUnlessBoth(t)) return;

  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await operator.locator('#go').click();

  // จ่ายแล้วถึงจะได้ถ่าย — ไปที่ขั้นถ่ายเอง ไม่ต้องกดซ้ำ
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });

  const rows = await ledger();
  const paid = rows.at(-1);
  assert.equal(paid.amount, PRICE);
  assert.match(paid.token, /^[0-9A-Z]{6}$/);

  /*
   * ข้อที่สำคัญที่สุดของโหมดนี้: บรรทัดในสมุดบัญชีต้องผูกกับรอบถ่ายจริง
   *
   * จ่ายก่อนถ่ายแปลว่าตอนรับเงินยังไม่มีรูป — ถ้าจดโดยไม่มีโทเคน เวลาลูกค้าทักมา
   * ว่า "จ่ายแล้วไม่ได้รูป" จะไม่มีอะไรให้ค้นเลย · โทเคนที่จองตอนรับเงินต้องเป็น
   * ใบเดียวกับที่รูปไปนั่งอยู่
   */
  // ดูจากจอช่างภาพ ไม่ใช่จอแขก — จอแขกซ่อนรหัสเมื่อบูธไม่ได้ตั้งที่อยู่เว็บไว้
  // (รหัสที่พาไปไหนไม่ได้ไม่ต้องขึ้นให้แขกอ่าน) แต่คนกระทบยอดคือเจ้าของบูธ
  assert.match(await operator.locator('#code').textContent(), new RegExp(paid.token));
  await fs.access(path.join(userData, 'booth', 'sessions', paid.token, 'sheet.jpg'));

  // และจากตรงนี้ไม่ต้องจ่ายอีก — กดต่อได้เลย จ่ายไปแล้วรอบหนึ่ง
  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });
  assert.equal((await ledger()).length, rows.length, 'จ่ายรอบเดียวต้องถูกจดครั้งเดียว');
});

/**
 * รอบที่ล้มกลางทาง **ต้องไม่ลากบูธล้มตามไปด้วย**
 *
 * ดิสก์เต็ม สิทธิ์ไฟล์เพี้ยน การ์ด SD สะดุด — เกิดได้จริงกับเครื่องที่รันด้วยแบตในเต็นท์
 * และเกิดตอนไหนก็ได้ · สิ่งที่ยอมไม่ได้ไม่ใช่ "รอบนั้นเสีย" (เสียได้ ขอโทษแล้วถ่ายใหม่ให้)
 * แต่คือ **บูธที่ถ่ายไม่ได้อีกเลยตลอดคืน** ทั้งที่ดิสก์กลับมาปกติแล้ว ซึ่งคนหน้าบูธ
 * แก้เองไม่ได้เพราะไม่มีอะไรบนจอบอกว่าเกิดอะไรขึ้น
 *
 * จำลองด้วยการเอา **ไฟล์ธรรมดา** ไปวางแทนโฟลเดอร์ของรอบที่จองไว้ หลังรับเงินแล้ว
 * → `mkdir` ข้างในล้มด้วย ENOTDIR ตอนกำลังบันทึกรอบ · ใช้วิธีนี้แทนการถอดสิทธิ์ไฟล์
 * เพราะเทสต์ในคอนเทนเนอร์รันเป็น root ซึ่งข้ามบิตสิทธิ์ไปทั้งหมด chmod จึงไม่ล้มอะไรเลย
 */
test('one failed round does not take the booth down with it', async (t) => {
  if (skipUnlessBoth(t)) return;

  await backToReady();
  const before = (await ledger()).length;
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await operator.locator('#go').click();

  // รอจนโทเคนถูกจองแล้ว (บรรทัดในสมุดบัญชีคือสัญญาณ) แล้วค่อยทำให้เขียนไม่ได้
  let rows = await ledger();
  for (let i = 0; i < 200 && rows.length === before; i += 1) {
    await new Promise((done) => setTimeout(done, 100));
    rows = await ledger();
  }
  assert.equal(rows.length, before + 1, 'ต้องรับเงินไปแล้วก่อนถึงจะจำลองรอบที่ล้มได้');

  const dead = path.join(userData, 'booth', 'sessions', rows.at(-1).token);
  await fs.rmdir(dead);
  await fs.writeFile(dead, '');

  // ประกอบแผ่นไม่สำเร็จ → กลับไปหน้าเริ่ม พร้อมข้อความบอกเหตุ
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });

  /*
   * **ตั๋วที่จ่ายมาแล้วต้องยังอยู่** และทั้งสองจอต้องบอกตรงกันว่าถืออยู่
   *
   * ถ้าปุ่มยังเขียนว่า "จ่าย 50 บาท" คนที่เพิ่งจ่ายไปจะถูกเก็บอีกรอบ และถ้าปุ่มบน
   * จอช่างภาพยังเขียนว่า "เก็บเงิน 50" เจ้าของบูธก็จะเก็บซ้ำจากคนเดิมด้วยมือตัวเอง
   */
  assert.match(await guest.locator('#start-label').textContent(), /จ่ายแล้ว/);
  assert.match(await operator.locator('#go').textContent(), /จ่ายแล้ว/);

  /*
   * กดแล้วถ่ายได้เลย — นี่คือทั้งหมดของข้อนี้
   *
   * รอบที่แล้วเสียไปเพราะดิสก์สะดุด แต่บูธต้องไม่ค้างอยู่กับโทเคนของรอบที่ตายไปแล้ว
   * จนทุกรอบหลังจากนั้นล้มตามกันหมดทั้งคืน · และคนที่จ่ายมาแล้วต้องไม่จ่ายซ้ำ
   */
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  assert.equal((await ledger()).length, before + 1, 'รอบที่ล้มไปแล้วต้องไม่ถูกเก็บเงินซ้ำ');

  // แผ่นต้องไปนั่งอยู่บนตั๋วใบเดิมที่จ่ายมาแล้ว ไม่ใช่ตั๋วใบใหม่ที่ไม่มีเงินผูกอยู่
  await fs.access(path.join(userData, 'booth', 'sessions', rows.at(-1).token, 'sheet.jpg'));

  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });
});

/**
 * ตั๋วที่จ่ายแล้วแต่ถูกทิ้งไว้ ต้องปลดได้ — ไม่งั้นคนถัดไปได้ของฟรี
 *
 * ตั๋วค้างเกิดจากรอบที่ล้มหลังรับเงิน (ข้อที่แล้ว) · ถ้าคนที่จ่ายเดินหายไปเลย
 * บูธจะยืนถือตั๋วนั้นอยู่ แล้วคนถัดไปที่เดินมากดปุ่มจะได้ถ่ายฟรีโดยไม่มีใครรู้
 * — **การถือตั๋วไว้จึงต้องมาคู่กับทางปลดเสมอ** ไม่งั้นมันคือรูรั่วแทนที่จะเป็นตาข่าย
 */
test('a paid ticket left behind can be released, and then the next guest pays', async (t) => {
  if (skipUnlessBoth(t)) return;
  await backToReady();

  const before = (await ledger()).length;
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await operator.locator('#go').click();

  let rows = await ledger();
  for (let i = 0; i < 200 && rows.length === before; i += 1) {
    await new Promise((done) => setTimeout(done, 100));
    rows = await ledger();
  }
  const dead = path.join(userData, 'booth', 'sessions', rows.at(-1).token);
  await fs.rmdir(dead);
  await fs.writeFile(dead, '');
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });

  // ปุ่มปลดต้องโผล่บนจอช่างภาพ และต้องบอกตรง ๆ ว่ากดแล้วเกิดอะไร
  assert.equal(await operator.locator('#back').isHidden(), false);
  assert.match(await operator.locator('#back').textContent(), /ยกเลิกตั๋ว/);

  await operator.locator('#back').click();
  await guest.waitForFunction(
    () => !document.getElementById('start-label').textContent.includes('จ่ายแล้ว'),
    { timeout: 30000 },
  );

  // ปลดแล้วบูธกลับมาเก็บเงินคนถัดไปตามปกติ — และไม่มีบรรทัดใหม่จากการปลด
  assert.match(await guest.locator('#start-label').textContent(), /จ่าย 150 บาท/);
  assert.match(await operator.locator('#go').textContent(), /เก็บเงิน/);
  assert.equal((await ledger()).length, rows.length,
    'การปลดตั๋วไม่ใช่การขาย และไม่ใช่การคืนเงิน — สมุดบัญชีต้องไม่ขยับ');

  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 30000 });
});

/**
 * จ่ายแล้วกด "ถ่ายใหม่" — **ต้องได้ถ่ายใหม่ ไม่ใช่ต้องจ่ายใหม่**
 *
 * รูปไม่ถูกใจแล้วขอถ่ายใหม่คือสิ่งที่เกิดแทบทุกรอบในงานที่คนถ่ายเป็นนักเรียน
 * ถ้าการกดปุ่มนั้นทิ้งเงินที่จ่ายมาแล้วไปด้วย เจ้าของบูธจะต้องยืนเถียงกับแขก
 * ทั้งคืน หรือไม่ก็ต้องกด "ไม่คิดเงิน" ให้ทุกครั้งจนสมุดบัญชีเต็มไปด้วยรอบฟรี
 * ที่ไม่ได้ฟรีจริง — ทั้งสองทางทำให้ตัวเลขที่ใช้กระทบยอดตอนเก็บบูธเชื่อไม่ได้
 *
 * รอบที่จ่ายแล้วผูกกับ **โทเคนใบเดิม** ตลอด ถ่ายกี่ครั้งก็ยังเป็นรอบเดียวกัน
 */
test('paying first: a retake is a retake, not a second sale', async (t) => {
  if (skipUnlessBoth(t)) return;

  await backToReady();
  await guest.locator('#start').click();
  await guest.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });

  const rows = await ledger();
  const ticket = rows.at(-1).token;

  // รูปไม่ถูกใจ — กดถ่ายใหม่
  await guest.locator('#again').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 70000 });

  assert.equal((await ledger()).length, rows.length,
    'ถ่ายใหม่ต้องไม่เก็บเงินเพิ่ม และต้องไม่ต้องกลับไปหน้าจ่ายเงินอีก');
  assert.match(await operator.locator('#code').textContent(), new RegExp(ticket),
    'รอบเดิมที่จ่ายไปแล้ว — ต้องยังเป็นโทเคนใบเดียวกัน');

  // และแผ่นใหม่ต้องทับของเก่าจริง ไม่ใช่ไปกองรวมกันในโฟลเดอร์เดียว
  assert.deepEqual(
    (await fs.readdir(path.join(userData, 'booth', 'sessions', ticket, 'shots'))).sort(),
    ['shot-1.jpg'],
    'รูปของรอบก่อนหน้าต้องไม่ค้างอยู่ในรอบที่ถ่ายใหม่',
  );

  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 70000 });
  assert.equal((await ledger()).length, rows.length);
});
