import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * ภาพปกต้องไม่ดันปุ่มอัปโหลดตกจอ
 *
 * หน้านี้มีหน้าที่เดียวคือทำให้แขกส่งรูป · เคยถอดปุ่มเปิดเพลงออกไปแล้วเพราะแค่ปุ่มเดียว
 * ก็ยัง "เกะกะ" และเคยต้องใส่การเลื่อนจออัตโนมัติเพราะกลัวแขกไม่เห็นปุ่มยืนยัน
 * — ภาพปกใหญ่กว่าปุ่มเพลงหลายเท่า วางผิดที่เมื่อไรคือทำลายหน้าที่หลักของหน้านี้เพื่อความสวย
 *
 * ข้อนี้เถียงกันด้วยการอ่านโค้ดไม่ได้ ต้องวัดจากเบราว์เซอร์จริงที่ขนาดจอจริง
 * เปิดเบราว์เซอร์ไม่ได้ให้ skip พร้อมบอกเหตุผล ห้ามผ่านเงียบ ๆ
 */

const dataDir = useTempDataDir('home-fold');

// ขนาดจอมือถือที่เล็กที่สุดที่ยังพบได้ทั่วไป — ถ้าผ่านที่นี่ก็ผ่านทุกเครื่องที่ใหญ่กว่า
const VIEWPORT = { width: 390, height: 667 };

let app;
let browser;
let launchError = null;

async function launchChromium(chromium) {
  try {
    return await chromium.launch();
  } catch (error) {
    launchError = error;
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  let entries = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const entry of entries.filter((name) => name.startsWith('chromium-'))) {
    const executablePath = path.join(root, entry, 'chrome-linux', 'chrome');
    try {
      await fs.access(executablePath);
      return await chromium.launch({ executablePath });
    } catch (error) {
      launchError = error;
    }
  }
  return null;
}

before(async () => {
  app = await startTestServer();
  const cookie = await login(app.baseUrl);

  // ภาพปกแนวนอนหนึ่งใบ กับรูปงานอีกสองใบ — สภาพที่งานจริงจะเป็น
  for (const [slot, size] of [
    ['cover', { width: 2400, height: 1600 }],
    ['photo', { width: 1600, height: 1200 }],
    ['photo', { width: 1600, height: 1200 }],
  ]) {
    const file = await makeJpeg(path.join(dataDir, `${slot}-${Math.random()}.jpg`), size);
    const form = new FormData();
    form.append('files', new Blob([await fs.readFile(file)]), 'x.jpg');
    await fetch(`${app.baseUrl}/admin/home/${slot}`, {
      method: 'POST', headers: { cookie }, body: form, redirect: 'manual',
    });
  }

  try {
    const { chromium } = await import('playwright');
    browser = await launchChromium(chromium);
  } catch (error) {
    launchError = error;
  }
});

after(async () => {
  await browser?.close();
  await app?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('the upload button stays on screen with a cover image above it', async (t) => {
  if (!browser) {
    t.skip(`เปิดเบราว์เซอร์ไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
    return;
  }

  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`${app.baseUrl}/`, { waitUntil: 'networkidle' });

  // ภาพปกต้องขึ้นจริง ไม่งั้นเทสต์นี้วัดหน้าที่ไม่มีภาพแล้วผ่านฟรี
  const cover = await page.locator('.hero--cover').count();
  assert.equal(cover, 1, 'หน้านี้ต้องมีภาพปกอยู่จริงตอนวัด');

  const button = page.locator('#file-input').locator('xpath=ancestor::label[1]');
  const box = await button.boundingBox();
  assert.ok(box, 'ต้องหาปุ่มเลือกรูปเจอ');

  assert.ok(
    box.y + box.height <= VIEWPORT.height,
    `ปุ่มเลือกรูปตกขอบล่างของจอไปแล้ว — ล่างสุดของปุ่มอยู่ที่ ${Math.round(box.y + box.height)}px `
      + `แต่จอสูงแค่ ${VIEWPORT.height}px · ภาพปกกินที่มากเกินไป`,
  );

  await page.close();
});

test('the cover never grows past its share of the screen', async (t) => {
  if (!browser) {
    t.skip(`เปิดเบราว์เซอร์ไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
    return;
  }

  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`${app.baseUrl}/`, { waitUntil: 'networkidle' });

  const box = await page.locator('.hero--cover').boundingBox();
  // 30% ของ 667 คือ 200px · เผื่อขอบบนล่างไว้เล็กน้อย แต่ต้องไม่เกินหนึ่งในสามของจอ
  assert.ok(
    box.height <= VIEWPORT.height / 3,
    `ภาพปกสูง ${Math.round(box.height)}px ซึ่งเกินหนึ่งในสามของจอ (${Math.round(VIEWPORT.height / 3)}px)`,
  );

  await page.close();
});

test('tapping a host photo opens it in the viewer the gallery already uses', async (t) => {
  if (!browser) {
    t.skip(`เปิดเบราว์เซอร์ไม่ได้ — ${launchError?.message ?? 'ไม่ทราบสาเหตุ'}`);
    return;
  }

  const page = await browser.newPage({ viewport: VIEWPORT });
  await page.goto(`${app.baseUrl}/`, { waitUntil: 'networkidle' });

  assert.equal(await page.locator('#lightbox').isVisible(), false, 'ตัวดูรูปต้องยังปิดอยู่');

  await page.locator('[data-host]').first().click();
  await page.waitForSelector('#lightbox:not([hidden])', { timeout: 5000 });

  const shown = await page.locator('#lightbox-stage img').getAttribute('src');
  assert.match(shown ?? '', /^\/host\/\d+$/, 'ต้องเปิดรูปของเจ้าภาพ ไม่ใช่รูปของแขก');

  // รูปเจ้าภาพเป็นของประกอบหน้าเว็บ ไม่ใช่ของที่แขกมารับ จึงไม่มีปุ่มดาวน์โหลด
  assert.equal(await page.locator('#lightbox-download').isVisible(), false,
    'รูปของเจ้าภาพต้องไม่มีปุ่มดาวน์โหลด');

  await page.close();
});
