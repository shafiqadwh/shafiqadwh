import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { saveSettings } from '../src/main/settings.js';

/**
 * บูธสองจอ — จอหน้าให้แขก จอหลังให้ช่างภาพ
 *
 * เทสต์ที่ดูทีละจอมองไม่เห็นสิ่งที่พังจริงในงานนี้: **รอยต่อระหว่างสองหน้าต่าง**
 * (ชื่อข้อความไม่ตรงกัน, preload ยื่นท่อให้จอเดียว, จอหลังกดแล้วจอหน้าไม่ขยับ)
 * ไฟล์นี้จึงเปิดสองหน้าต่างจริงแล้วสั่งงานข้ามจอ
 *
 * เครื่องที่รันเทสต์มีจอเดียว — `BOOTH_OPERATOR=1` บังคับให้เปิดจอช่างภาพได้
 * แม้ไม่มีจอที่สอง ซึ่งเป็นสวิตช์เดียวกับที่ใช้ซ้อมก่อนงานบนโน้ตบุ๊กเครื่องเดียว
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');

let app;
let guest;
let operator;
let userData;
let xvfb = null;
let launchError = null;

async function ensureDisplay() {
  if (process.env.DISPLAY) return;
  const child = spawn('Xvfb', [':98', '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
    { stdio: 'ignore', detached: true });
  const ok = await new Promise((done) => {
    child.once('error', () => done(false));
    child.once('exit', () => done(false));
    setTimeout(() => done(true), 1200);
  });
  if (!ok) {
    child.kill('SIGKILL');
    throw new Error('ไม่มีทั้ง DISPLAY และ Xvfb');
  }
  xvfb = child;
  process.env.DISPLAY = ':98';
}

/** หน้าต่างสองบานเปิดพร้อมกัน ลำดับไม่แน่นอน — แยกด้วยไฟล์ที่มันโหลด */
async function windowsByPage() {
  const pages = app.windows();
  const found = {};
  for (const page of pages) {
    found[page.url().endsWith('operator.html') ? 'operator' : 'guest'] = page;
  }
  return found;
}

before(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-two-'));
  try {
    // แบบรูปเดียว นับถอยหลังสั้น — เทสต์นี้ตรวจการคุยกันข้ามจอ ไม่ได้ตรวจการถ่าย
    await saveSettings(path.join(userData, 'booth'), {
      eventTitle: 'งานสองจอ',
      template: 'classic',
      countdownSeconds: 2,
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
        ...process.env,
        BOOTH_WINDOWED: '1',
        BOOTH_USER_DATA: userData,
        BOOTH_OPERATOR: '1',
      },
      timeout: 60000,
    });

    await app.firstWindow();
    // บานที่สองโหลดตามมาไม่กี่ร้อยมิลลิวินาที
    for (let i = 0; i < 60 && app.windows().length < 2; i += 1) {
      await new Promise((done) => setTimeout(done, 250));
    }
    ({ guest, operator } = await windowsByPage());
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

/** พาทั้งสองจอกลับหน้าเริ่ม ไม่ว่าข้อก่อนหน้าจะทิ้งไว้ที่ไหน */
async function toReady() {
  if (await guest.getAttribute('body', 'data-stage') === 'ready') return;
  const back = { review: '#again', done: '#restart' };
  const button = back[await guest.getAttribute('body', 'data-stage')];
  if (button) await guest.locator(button).click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 70000 });
}

test('two windows open, and only the guest one owns the camera', async (t) => {
  if (skipUnlessBoth(t)) return;

  assert.equal(app.windows().length, 2);
  assert.equal(await operator.locator('#event-title').textContent(), 'งานสองจอ',
    'จอหลังต้องอ่านค่าตั้งของงานได้เอง');

  // กล้องตัวหนึ่งเปิดได้ทีละที่เดียว — จอหลังเปิดเองแล้วจะได้จอดำอย่างน้อยหนึ่งจอ
  assert.equal(await operator.locator('#preview').count(), 0,
    'จอช่างภาพต้องไม่มีองค์ประกอบวิดีโอของตัวเอง');
});

test('the photographer screen follows the guest screen, stage by stage', async (t) => {
  if (skipUnlessBoth(t)) return;
  await toReady();

  assert.equal(await operator.getAttribute('body', 'data-stage'), 'ready');

  await guest.locator('#start').click();
  await operator.waitForSelector('body[data-stage="shoot"]', { timeout: 10000 });
  assert.equal((await operator.locator('#stage-label').textContent()).trim(), 'กำลังถ่าย');

  // ภาพสดต้องมาถึงจอหลังจริง ไม่ใช่แค่ตัวหนังสือบอกว่ากำลังถ่าย
  await operator.waitForFunction(() => {
    const image = document.getElementById('view-image');
    return !image.hidden && String(image.src).startsWith('data:image/jpeg');
  }, { timeout: 20000 });

  await operator.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
  assert.equal(await operator.locator('#view-image').isVisible(), true,
    'ถึงขั้นดูแผ่นแล้วจอหลังต้องเห็นแผ่นเดียวกับที่แขกเห็น');
});

test('the photographer can drive the whole take without touching the guest screen', async (t) => {
  if (skipUnlessBoth(t)) return;
  await toReady();

  // ปุ่มเดียวกันทำงานต่างกันตามขั้น — เหมือนปุ่มใหญ่ตรงหน้าแขก ณ ตอนนั้น
  assert.equal((await operator.locator('#go').textContent()).trim(), 'เริ่มถ่าย');
  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 60000 });

  assert.equal((await operator.locator('#go').textContent()).trim(), 'พิมพ์');
  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="done"]', { timeout: 30000 });

  const printed = await fs.readdir(path.join(userData, 'booth', 'outbox'));
  assert.equal(printed.length, 1, 'ช่างภาพกดพิมพ์แล้วต้องมีของออกมาจริง');

  assert.match(await operator.locator('#tally').textContent(), /1 แผ่น/,
    'ตัวนับของช่างภาพต้องเดินตามแผ่นที่พิมพ์จริง');

  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 10000 });
  assert.equal(await operator.getAttribute('body', 'data-stage'), 'ready');
});

test('the photographer can throw a take away from the back screen', async (t) => {
  if (skipUnlessBoth(t)) return;
  await toReady();

  const sessions = path.join(userData, 'booth', 'sessions');
  const before = (await fs.readdir(sessions)).length;

  await operator.locator('#go').click();
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 60000 });
  assert.equal((await fs.readdir(sessions)).length, before + 1);

  await operator.locator('#back').click();
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 10000 });

  // ทิ้งแล้วต้องหายจากดิสก์จริง ไม่งั้นรอบที่ตั้งใจทิ้งจะถูกอัปโหลดขึ้นเว็บทีหลัง
  const gone = async () => (await fs.readdir(sessions)).length === before;
  for (let i = 0; i < 40 && !(await gone()); i += 1) {
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(await gone(), 'รอบที่ช่างภาพกดทิ้งต้องถูกลบเหมือนแขกกดทิ้งเอง');
});

test('a shutter remote is just a keyboard, and the booth answers it', async (t) => {
  if (skipUnlessBoth(t)) return;
  await toReady();

  // รีโมททั้งแบบสายและบลูทูธประกาศตัวเป็นคีย์บอร์ด — กดแล้วส่งปุ่มเดียวออกมา
  // ตรงนี้จึงจำลองด้วยการกดปุ่มจริงใส่หน้าต่าง ซึ่งเป็นเส้นทางเดียวกันทุกขั้น
  await guest.keyboard.press('PageDown');
  await guest.waitForSelector('body[data-stage="review"]', { timeout: 60000 });

  // กดจากจอหลังก็ต้องได้เหมือนกัน — ช่างภาพยืนอยู่หลังบูธ รีโมทอยู่ในมือเขา
  await operator.keyboard.press('PageUp');
  await guest.waitForSelector('body[data-stage="ready"]', { timeout: 10000 });
});
