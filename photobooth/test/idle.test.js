import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';
import { electronBinary, skipOrFail } from './helpers/electron.js';
import { startDisplay } from './helpers/display.js';

/**
 * แขกเดินจากไปกลางคัน — **จอต้องกลับมาพร้อมรับคนถัดไปเอง**
 *
 * เป็นเรื่องปกติที่สุดของบูธ: ได้กระดาษแล้วเดินไปหาโต๊ะตัวเองโดยไม่กดอะไรอีก
 * ของเดิมจอค้างอยู่หน้านั้นตลอดไป ซึ่งเสียสองอย่างพร้อมกัน
 *
 *   1. **QR ของคนก่อนค้างบนจอให้คนถัดไปสแกน** = รูปของแขกคนหนึ่งไปอยู่ในมือ
 *      อีกคน · ความผิดพลาดชนิดเดียวกับที่กันไว้แล้วทุกที่ในฝั่งเว็บ
 *   2. คนที่เดินมาเห็นรูปคนอื่นค้างอยู่ ไม่รู้ว่าบูธว่าง แล้วเดินผ่านไป
 *
 * ไฟล์นี้แยกออกมาเป็นแอปของตัวเองเพราะต้องย่นเวลารอด้วย `BOOTH_IDLE_MS` —
 * ตั้งค่านั้นให้ทั้งไฟล์อื่นด้วยจะทำให้จอรีเซ็ตกลางเทสต์ข้ออื่นโดยไม่มีใครสั่ง
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

// สั้นพอให้เทสต์ไม่ต้องรอนาน ยาวพอที่ขั้นตอนปกติจะไม่ถูกตัดกลางคัน
const IDLE_MS = 2500;

let app;
let page;
let userData;
let xvfb = null;
let launchError = null;

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-idle-'));
  try {
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'บูธที่แขกเดินหนี',
      template: 'classic',
      countdownSeconds: 2,
      printer: { driver: 'file', name: '' },
    });

    xvfb = await startDisplay([96, 86, 76]);
    const { _electron } = await import('playwright');
    const electronPath = await electronBinary();

    app = await _electron.launch({
      executablePath: electronPath,
      args: [appDir, '--no-sandbox',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: {
        ...process.env,
        BOOTH_WINDOWED: '1',
        BOOTH_USER_DATA: userData,
        BOOTH_IDLE_MS: String(IDLE_MS),
      },
      timeout: 60000,
    });
    page = await app.firstWindow();
    await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  } catch (error) {
    launchError = error;
  }
});

after(async () => {
  await app?.close().catch(() => {});
  xvfb?.kill('SIGTERM');
  await fs.rm(userData, { recursive: true, force: true });
});

const skipIfNoElectron = (t) => {
  if (app && page) return false;
  return skipOrFail(t, launchError, 'เปิด Electron ไม่ได้');
};

const stageNow = () => page.getAttribute('body', 'data-stage');

async function toReady() {
  if (await stageNow() === 'ready') return;
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
}

test('a guest who walks off after collecting the print leaves a clean screen', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  await page.locator('#deliver').click();
  await page.waitForSelector('body[data-stage="done"]', { timeout: 30000 });

  // ไม่แตะอะไรเลย — เหมือนแขกที่หยิบกระดาษแล้วเดินไป
  await page.waitForSelector('body[data-stage="ready"]', { timeout: IDLE_MS * 6 });

  // และต้องไม่เหลือร่องรอยของคนก่อนไว้บนจอ
  assert.equal(await page.locator('#done-qr').isHidden(), true, 'QR ของคนก่อนยังค้างอยู่');
  assert.equal((await page.locator('#done-code').textContent()).trim(), '');
});

test('a guest who never decides at the review screen frees the booth too', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  // นับของที่มีอยู่ก่อน — ข้อก่อนหน้าทิ้งรอบที่ **ส่งมอบไปแล้ว** ไว้บนดิสก์อย่างถูกต้อง
  const dir = path.join(userData, 'booth', 'sessions');
  const before_ = (await fs.readdir(dir).catch(() => [])).sort();

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });

  await page.waitForSelector('body[data-stage="ready"]', { timeout: IDLE_MS * 6 });

  // รอบที่ไม่มีใครเอาต้องไม่ค้างอยู่บนดิสก์ — ไม่งั้นงานสามวันได้กองรอบที่ไม่มีเจ้าของ
  // ปนขึ้นเว็บไปพร้อมกับรอบที่แขกตั้งใจเอา
  const after_ = (await fs.readdir(dir).catch(() => [])).sort();
  assert.deepEqual(after_, before_, 'รอบที่แขกไม่เอาต้องถูกลบไปด้วย');
});

test('the countdown is never cut short by the idle timer', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  /*
   * ขั้น `shoot` ต้องไม่มีการตั้งเวลาเลย — มีคนยืนโพสท่าอยู่ตรงหน้า และการนับ
   * ถอยหลังของแบบหลายรูปยาวกว่าเวลาว่างที่ตั้งไว้ในเทสต์นี้ได้ง่าย ๆ
   * ถ้าตัวจับเวลาไปแตะขั้นนี้ รอบถ่ายจะถูกยกเลิกคาหน้ากล้อง
   */
  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="shoot"]', { timeout: 30000 });
  await new Promise((done) => setTimeout(done, IDLE_MS + 500));

  const stage = await stageNow();
  assert.ok(['shoot', 'review'].includes(stage), `ขั้นตอนถูกตัดกลางคัน: ${stage}`);
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
});

test('walking away from a paid round keeps the ticket, it does not eat the money', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  /*
   * **ข้อที่อันตรายที่สุดของทั้งไฟล์** · ตัวจับเวลาที่ทิ้งรอบเสมอจะทิ้งรอบที่
   * จ่ายเงินมาแล้วไปด้วย เพียงเพราะแขกเดินไปเข้าห้องน้ำระหว่างดูแผ่น — เงินรับมาแล้ว
   * แต่ไม่มีตั๋วเหลืออยู่ และไม่มีอะไรบนจอบอกว่าเคยมี
   *
   * ขั้น review จึงใช้ตารางการตัดสินใจเดียวกับปุ่ม "ถ่ายใหม่": จ่ายแล้ว = เก็บตั๋วไว้
   * ยังไม่จ่าย = ทิ้งรอบไปเลย
   */
  await saveSettings(path.join(userData, 'booth'), {
    sale: { enabled: true, target: '0812345678', price: 150, payWhen: 'before' },
  });
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });

  const ledger = async () => {
    const dir = path.join(userData, 'booth', 'sales');
    const files = await fs.readdir(dir).catch(() => []);
    const text = await Promise.all(files.map((n) => fs.readFile(path.join(dir, n), 'utf8')));
    return text.join('').split('\n').filter(Boolean);
  };

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await page.locator('#pay-done').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  assert.equal((await ledger()).length, 1, 'ต้องจดการขายไว้หนึ่งบรรทัด');

  // แขกเดินไปเฉย ๆ ระหว่างดูแผ่น
  await page.waitForSelector('body[data-stage="ready"]', { timeout: IDLE_MS * 6 });

  assert.match(await page.locator('#start-label').textContent(), /จ่ายแล้ว/,
    'ตั๋วที่จ่ายมาแล้วหายไปพร้อมกับการรีเซ็ต');
  assert.equal((await ledger()).length, 1, 'การรีเซ็ตไม่ใช่การขาย สมุดบัญชีต้องไม่ขยับ');
});
