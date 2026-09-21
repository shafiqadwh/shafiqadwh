import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';
import { passFraming } from './helpers/booth.js';
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

  await passFraming(page);
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

  await passFraming(page);
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
  await passFraming(page);
  await page.waitForSelector('body[data-stage="shoot"]', { timeout: 30000 });
  await new Promise((done) => setTimeout(done, IDLE_MS + 500));

  const stage = await stageNow();
  assert.ok(['shoot', 'review'].includes(stage), `ขั้นตอนถูกตัดกลางคัน: ${stage}`);
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
});

test('the framing stage counts down and shoots by itself when nobody touches anything', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  /*
   * บูธจริงเป็นจอสัมผัสล้วน **ไม่มีเมาส์ไม่มีคีย์บอร์ด** — ของเดิมเดินต่อได้ทาง
   * เดียวคือกด Enter ซึ่งหน้างานไม่มีปุ่มนั้น บูธจึงค้างอยู่ตรงนั้นทั้งคืน
   *
   * สามอย่างที่ต้องจริงพร้อมกัน:
   *   1. **มีปุ่มที่แตะถึงจริง** — อยู่ในกรอบจอ และใหญ่พอสำหรับนิ้ว
   *   2. **นับให้เห็น** แขกจะได้รู้ว่าเหลือเวลาเท่าไร ไม่ใช่เดินเงียบ ๆ
   *   3. **หมดเวลาแล้วถ่ายเอง** ครบทุกรูปจนถึงหน้าดูแผ่น โดยไม่มีใครแตะอะไรเลย
   *
   * และข้อ 3 พิสูจน์อีกอย่างไปพร้อมกัน: ตัวจับเวลา "ไม่มีคนอยู่" (สั้นกว่ากันหลายเท่า
   * ในเทสต์นี้) ต้องไม่แตะขั้นนี้ ไม่งั้นจอจะรีเซ็ตทิ้งกลางที่คนกำลังจัดแถวอยู่
   */
  await saveSettings(path.join(userData, 'booth'), { frameSeconds: 10 });
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="frame"]', { timeout: 10000 });

  // ภาพสดต้องมาแล้วตั้งแต่ขั้นนี้ ไม่ใช่รอถึงตอนนับถอยหลัง
  await page.waitForFunction(() => {
    const video = document.getElementById('preview');
    return video && video.videoWidth > 0;
  }, { timeout: 20000 });

  // 1 · ปุ่มต้องอยู่ในกรอบจอจริง — ของเดิมมันหลุดใต้ภาพสดซึ่งสูงเต็มความกว้าง
  // แล้วไม่มีใครเห็น · เทสต์ที่ถามแค่ว่า "มีปุ่มอยู่ใน DOM ไหม" จับข้อนี้ไม่ได้
  const box = await page.locator('#go').boundingBox();
  const view = page.viewportSize() ?? await page.evaluate(() => ({
    width: window.innerWidth, height: window.innerHeight,
  }));
  assert.ok(box, 'ไม่มีปุ่มถ่ายบนขั้นจัดท่า');
  assert.ok(box.y >= 0 && box.y + box.height <= view.height + 1,
    `ปุ่มถ่ายอยู่นอกจอ: y=${box.y} สูง=${box.height} จอสูง=${view.height}`);
  assert.ok(box.height >= 60, `ปุ่มเล็กเกินกว่าจะแตะด้วยนิ้ว: สูง=${box.height}`);

  // 2 · ต้องนับให้เห็น
  const first = Number(await page.locator('#frame-left').textContent());
  assert.ok(first > 0 && first <= 10, `เลขนับถอยหลังผิดช่วง: ${first}`);
  await page.waitForFunction(
    (was) => Number(document.getElementById('frame-left').textContent) < was,
    first, { timeout: 4000 },
  );

  // 3 · ไม่มีใครแตะอะไรเลยตั้งแต่ต้นจนจบ แล้วต้องได้แผ่นมาดู
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
});

test('the button shoots at once, without waiting the clock out', async (t) => {
  if (skipIfNoElectron(t)) return;
  await toReady();

  // นาฬิกาเป็นเพดาน ไม่ใช่การบังคับรอ — ตั้งไว้ยาวมากแล้วกดเอง ต้องไปทันที
  await saveSettings(path.join(userData, 'booth'), { frameSeconds: 120 });
  await page.reload();
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="frame"]', { timeout: 10000 });
  await page.locator('#go').click();
  await page.waitForSelector('body[data-stage="shoot"]', { timeout: 5000 });
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

  await passFraming(page);
  await page.waitForSelector('body[data-stage="pay"]', { timeout: 30000 });
  await page.locator('#pay-done').click();
  // จ่ายแล้วไปหยุดที่ขั้นจัดท่า ไม่ใช่ถ่ายเลย
  await passFraming(page);
  await page.waitForSelector('body[data-stage="review"]', { timeout: 70000 });
  assert.equal((await ledger()).length, 1, 'ต้องจดการขายไว้หนึ่งบรรทัด');

  // แขกเดินไปเฉย ๆ ระหว่างดูแผ่น
  await page.waitForSelector('body[data-stage="ready"]', { timeout: IDLE_MS * 6 });

  assert.match(await page.locator('#start-label').textContent(), /จ่ายแล้ว/,
    'ตั๋วที่จ่ายมาแล้วหายไปพร้อมกับการรีเซ็ต');
  assert.equal((await ledger()).length, 1, 'การรีเซ็ตไม่ใช่การขาย สมุดบัญชีต้องไม่ขยับ');
});
