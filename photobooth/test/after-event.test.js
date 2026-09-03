import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';
import { spawn } from 'node:child_process';
import { startDisplay } from './helpers/display.js';

/**
 * "พิมพ์ตอนนี้ ส่งขึ้นเว็บทีหลัง" — คำสัญญาที่พิมพ์อยู่บนกระดาษของแขกทุกใบ
 *
 * บูธทำงานในเต็นท์ที่ไม่มีเน็ต โทเคนถูกจองตั้งแต่ตอนถ่าย QR บนกระดาษจึงถูกต้อง
 * ตั้งแต่แรก **แต่ปลายทางว่างอยู่จนกว่าจะมีคนสั่งส่ง** — ถ้าไม่มีทางสั่ง แขกที่
 * ถือกระดาษกลับบ้านไปสแกนก็ไม่มีวันได้รูป และไม่มีใครในบูธรู้เลยว่าเกิดอะไรขึ้น
 *
 * เทสต์นี้จึงเดินทั้งเส้นของจริง: พิมพ์ (ไม่ต่อเน็ต) → กดปุ่มบนจอช่างภาพ →
 * เปิดลิงก์ที่ QR ชี้ไปแล้วต้องเจอรูป
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const repoRoot = path.join(appDir, '..');
const KEY = 'after-event-test-key-9c1d';

let web = null;
let webUrl = '';
let app;
let guest;
let operator;
let userData;
let xvfb = null;
let launchError = null;
let printedCode = '';

function startWeb(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'server.js')], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        ADMIN_PASSWORD: 'after-event-admin',
        BOOTH_KEY: KEY,
        PORT: '0',
        HOST: '127.0.0.1',
        NODE_ENV: 'test',
        TRUST_PROXY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => reject(new Error('เว็บไม่ขึ้นภายใน 30 วินาที')), 30000);
    child.stdout.on('data', (chunk) => {
      const found = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!found) return;
      clearTimeout(timer);
      resolve({ child, url: `http://127.0.0.1:${found[1]}` });
    });
    child.stderr.on('data', (chunk) => {
      if (String(chunk).includes('Error')) reject(new Error(String(chunk).slice(0, 300)));
    });
  });
}

const ensureDisplay = async () => { xvfb = await startDisplay([92, 82, 72]); };

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-after-'));
  try {
    const started = await startWeb(path.join(userData, 'web'));
    web = started.child;
    webUrl = started.url;

    /*
     * โหมดพิมพ์ล้วน — **ไม่ส่งอะไรขึ้นเว็บตอนถ่าย** เหมือนบูธในเต็นท์ที่ไม่มีเน็ต
     * แต่ตั้งที่อยู่กับกุญแจไว้ให้ครบ เพื่อให้ส่งทีหลังได้เมื่อกลับถึงบ้าน
     */
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'งานที่เต็นท์ไม่มีเน็ต',
      template: 'classic',
      countdownSeconds: 2,
      deliver: 'print',
      qrMode: 'later',
      baseUrl: webUrl,
      uploadKey: KEY,
    });

    await ensureDisplay();
    const { _electron } = await import('playwright');
    app = await _electron.launch({
      executablePath: path.join(appDir, 'node_modules', 'electron', 'dist', 'electron'),
      args: [appDir, '--no-sandbox',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: {
        ...process.env, BOOTH_WINDOWED: '1', BOOTH_USER_DATA: userData, BOOTH_OPERATOR: '1',
      },
      timeout: 60000,
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
  web?.kill('SIGTERM');
  xvfb?.kill('SIGTERM');
  await fs.rm(userData, { recursive: true, force: true });
});

const skipUnlessReady = (t) => {
  if (app && guest && operator && web) return false;
  t.skip(`ยกบูธหรือเว็บไม่ขึ้น — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
  return true;
};

test('with nothing taken yet, the button says so instead of sitting there grey', async (t) => {
  if (skipUnlessReady(t)) return;
  const send = operator.locator('#send');
  assert.equal((await send.textContent()).trim(), 'ส่งขึ้นเว็บครบแล้ว');
  assert.equal(await send.isDisabled(), true);
});

test('printing at the tent sends nothing — the guest leaves with a QR pointing at nothing yet',
  async (t) => {
    if (skipUnlessReady(t)) return;

    await guest.locator('#start').click();
    await guest.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
    const code = (await guest.locator('#token').textContent()).replace('รหัส', '').trim();
    assert.match(code, /^[0-9A-Z]{6}$/);

    await guest.locator('#deliver').click();
    await guest.waitForSelector('body[data-stage="done"]', { timeout: 30000 });

    // พิมพ์แล้วจริง แต่ยังไม่มีอะไรขึ้นเว็บ · แขกที่สแกนตอนนี้ต้องได้ "หน้าอธิบาย"
    // ไม่ใช่หน้าเปล่า — เขาไม่ได้พิมพ์รหัสผิด และเขาจะกลับมาใหม่ก็ต่อเมื่อรู้ว่าต้องกลับมา
    assert.equal((await fs.readdir(path.join(userData, 'booth', 'outbox'))).length, 1);
    const landing = await fetch(`${webUrl}/p/${code}`);
    const html = await landing.text();
    assert.ok(html.includes(code), 'หน้ารอต้องบอกรหัสของแขกไว้ด้วย');
    assert.ok(!html.includes(`/p/${code}/sheet`), 'ยังไม่ได้ส่ง จึงยังไม่ควรมีลิงก์แผ่นให้กด');
    assert.equal((await fetch(`${webUrl}/p/${code}/sheet`)).status, 404,
      'ยังไม่ได้ส่ง จึงยังไม่ควรมีแผ่นให้โหลด');

    printedCode = code;
  });

test('the photographer presses one button and every printed QR starts working', async (t) => {
  if (skipUnlessReady(t)) return;

  const send = operator.locator('#send');
  assert.equal((await send.textContent()).trim(), 'ส่งขึ้นเว็บ 1 รอบ');
  assert.equal(await send.isDisabled(), false);

  await send.click();
  await operator.waitForFunction(
    () => document.getElementById('send').textContent.includes('ครบแล้ว'), { timeout: 60000 });

  // ตัวตัดสิน: ลิงก์ที่พิมพ์ไปบนกระดาษแล้วต้องมีรูปอยู่จริง
  assert.ok(printedCode, 'ต้องมีรหัสจากรอบที่พิมพ์ไปแล้ว');
  const sheet = await fetch(`${webUrl}/p/${printedCode}/sheet`);
  assert.equal(sheet.status, 200, 'กดส่งแล้ว QR บนกระดาษต้องพาไปถึงแผ่นจริง');
  assert.equal(sheet.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(sheet.headers.get('content-length')) > 5000);

  assert.match(await operator.locator('#progress').textContent(), /ส่งขึ้นเว็บแล้ว 1 รอบ/);
});

test('pressing it again sends nothing twice', async (t) => {
  if (skipUnlessReady(t)) return;

  // ส่งซ้ำต้องไม่สร้างรอบซ้ำบนเว็บ · รอบที่ส่งสำเร็จถูกทำเครื่องหมายไว้แล้ว
  const { pending } = await operator.evaluate(() => window.booth.pending());
  assert.equal(pending, 0, 'รอบที่ส่งแล้วต้องไม่ค้างอยู่ในคิวอีก');

  const again = await operator.evaluate(() => window.booth.upload());
  assert.equal(again.total, 0);
  assert.deepEqual(again.failed, []);
});

test('a booth with nowhere to send to says so, instead of failing when pressed', async (t) => {
  if (skipUnlessReady(t)) return;
  const booth = path.join(userData, 'booth');

  // ตั้งค่าไม่ครบ = ปุ่มบอกเหตุตั้งแต่ยังไม่กด · "ส่งไม่ได้" กับ "ไม่มีอะไรให้ส่ง"
  // คนละเรื่องกันคนละทางแก้ ปุ่มเทา ๆ เหมือนกันหมดจึงไม่พอ
  await saveSettings(booth, { baseUrl: '' });
  await operator.reload();
  await operator.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  assert.equal((await operator.locator('#send').textContent()).trim(), 'ยังตั้งที่อยู่เว็บไม่ครบ');

  // และถ้าฝืนสั่งจริง ต้องล้มพร้อมเหตุผล ไม่ใช่ยิงไปที่ที่อยู่ว่างแล้วค้าง
  const denied = await operator.evaluate(() => window.booth.upload()
    .then(() => null, (error) => error.message));
  assert.match(denied ?? '', /ที่อยู่เว็บ/);

  await saveSettings(booth, { baseUrl: webUrl });
});
