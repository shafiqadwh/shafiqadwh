import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { canPublish, normaliseSettings, saveSettings } from '../src/main/settings.js';
import { spawn } from 'node:child_process';
import { startDisplay } from './helpers/display.js';

/**
 * โหมด "ไม่ต้องพิมพ์" — ถ่ายเสร็จขึ้น QR บนจอ แขกสแกนรับไฟล์ทันที
 *
 * เป็นโหมดที่ขายได้โดยไม่ต้องมีเครื่องพิมพ์เลย · ต่างจากโหมดพิมพ์ตรงที่
 * **ต้องส่งรูปขึ้นเว็บ ณ ตอนนั้น** เพราะแขกยืนสแกนอยู่ตรงหน้า ไม่ใช่ส่งทีหลัง
 *
 * เทสต์ชุดนี้ยกทั้งเว็บจริงและบูธจริงขึ้นมาคุยกัน — จุดที่พังคือรอยต่อ
 * ระหว่างสองโปรแกรม ซึ่งเทสต์ที่ดูทีละฝั่งมองไม่เห็น
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const repoRoot = path.join(appDir, '..');
const KEY = 'screen-mode-test-key-4f7a';

let web = null;
let webUrl = '';
let app;
let page;
let userData;
let xvfb = null;
let launchError = null;

/** ยกเว็บแชร์รูปขึ้นมาเป็นกระบวนการแยก — บูธจะยิงเข้ามาจริงผ่าน HTTP */
function startWeb(dataDir) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'src', 'server.js')], {
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        ADMIN_PASSWORD: 'screen-mode-admin',
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

const ensureDisplay = async () => { xvfb = await startDisplay([96, 86, 76]); };

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-screen-'));
  try {
    const started = await startWeb(path.join(userData, 'web'));
    web = started.child;
    webUrl = started.url;

    // ตั้งบูธเป็นโหมดจอ ก่อนเปิดแอป — แอปอ่านค่าตอนบูต
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'งานเดโมไม่ต้องพิมพ์',
      template: 'classic',
      deliver: 'screen',
      // ตั้ง off ไว้โดยตั้งใจ — โหมดจอไม่ได้พิมพ์อะไร การปิด QR บนแผ่นจึงสมเหตุสมผล
      // และเป็นคู่ค่าที่เคยทำให้พังตอนกดปุ่ม (สองคำถามใช้ฟังก์ชันเดียวกัน)
      qrMode: 'off',
      baseUrl: webUrl,
      uploadKey: KEY,
      countdownSeconds: 2,
    });

    await ensureDisplay();
    const { _electron } = await import('playwright');
    app = await _electron.launch({
      executablePath: path.join(appDir, 'node_modules', 'electron', 'dist', 'electron'),
      args: [appDir, '--no-sandbox',
        '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      env: { ...process.env, BOOTH_WINDOWED: '1', BOOTH_USER_DATA: userData },
      timeout: 60000,
    });
    page = await app.firstWindow();
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
  if (app && page && web) return false;
  t.skip(`ยกบูธหรือเว็บไม่ขึ้น — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
  return true;
};

test('a booth that cannot publish refuses to promise a screen QR', () => {
  // ขอโหมดจอไว้แต่ส่งขึ้นเว็บไม่ได้ = จอที่ขึ้น QR ที่สแกนแล้วไม่มีอะไร
  // ซึ่งแย่กว่าไม่มีโหมดนั้นเลย — บีบกลับเป็นพิมพ์ตั้งแต่ตอนอ่านค่า
  const good = normaliseSettings({ deliver: 'screen', baseUrl: 'https://a.bc', uploadKey: 'k'.repeat(20) });
  assert.equal(good.deliver, 'screen');
  assert.equal(canPublish(good), true);

  for (const broken of [
    { deliver: 'screen', uploadKey: 'k'.repeat(20) },
    { deliver: 'screen', baseUrl: 'https://a.bc' },
    { deliver: 'both', baseUrl: 'https://a.bc', uploadKey: 'sh0rt' },
    { deliver: 'screen', baseUrl: 'https://a.bc', uploadKey: 'กุญแจไทยยาวพอสมควรเลยนะ' },
  ]) {
    assert.equal(normaliseSettings(broken).deliver, 'print', JSON.stringify(broken));
  }
});

test('the button says what it will do, not always "print"', async (t) => {
  if (skipUnlessReady(t)) return;
  await page.waitForSelector('body[data-ready="1"]', { timeout: 30000 });
  assert.equal((await page.locator('#deliver').textContent()).trim(), 'รับรูป',
    'โหมดจอไม่ได้พิมพ์อะไร ปุ่มจึงต้องไม่เขียนว่าพิมพ์');
});

test('a guest gets a QR on screen, and it really leads to their photos', async (t) => {
  if (skipUnlessReady(t)) return;

  await page.locator('#start').click();
  await page.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
  await page.locator('#deliver').click();
  await page.waitForSelector('body[data-stage="done"]', { timeout: 30000 });

  const qr = page.locator('#done-qr');
  assert.equal(await qr.isVisible(), true, 'ต้องขึ้น QR บนจอ');
  assert.match(await qr.getAttribute('src'), /^data:image\/png;base64,/);

  const box = await qr.boundingBox();
  assert.ok(box.width >= 300, `QR กว้างแค่ ${Math.round(box.width)}px — สแกนจากระยะยืนไม่ติด`);

  const code = (await page.locator('#done-code').textContent()).replace('รหัส', '').trim();
  assert.match(code, /^[0-9A-Z]{6}$/, `รหัสผิดรูปแบบ: ${code}`);

  // ตัวชี้ขาด: เปิดลิงก์ที่ QR ชี้ไปแล้วต้องมีรูปอยู่จริง ไม่ใช่หน้า "ยังไม่ขึ้นระบบ"
  const landing = await fetch(`${webUrl}/p/${code}`);
  assert.equal(landing.status, 200, 'สแกนแล้วต้องเจอรูป ไม่ใช่หน้ารอ');
  const html = await landing.text();
  assert.ok(html.includes(`/p/${code}/sheet`));
  assert.equal((await fetch(`${webUrl}/p/${code}/sheet`)).status, 200);
});

test('nothing was printed, because there is no printer in this mode', async (t) => {
  if (skipUnlessReady(t)) return;
  // โหมดจอไม่แตะเครื่องพิมพ์เลย · โฟลเดอร์ขาออกต้องว่าง
  const outbox = path.join(userData, 'booth', 'outbox');
  const written = await fs.readdir(outbox).catch(() => []);
  assert.deepEqual(written, [], 'โหมดจอต้องไม่เขียนอะไรลงโฟลเดอร์ขาออก');
});

test('the next guest never sees the last guest QR', async (t) => {
  if (skipUnlessReady(t)) return;
  // QR ค้างอยู่ = คนถัดไปสแกนแล้วได้รูปของคนอื่น ซึ่งเป็นเรื่องความเป็นส่วนตัว
  // ไม่ใช่แค่ความเรียบร้อยของหน้าจอ
  await page.locator('#restart').click();
  await page.waitForSelector('body[data-stage="ready"]', { timeout: 5000 });
  assert.equal(await page.locator('#done-qr').getAttribute('src'), null);
  assert.equal((await page.locator('#done-code').textContent()).trim(), '');
});
