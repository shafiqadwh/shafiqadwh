import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * ตรวจก่อนส่ง — เลือกไฟล์แล้วต้อง "ไม่มีอะไรถูกส่ง" จนกว่าจะกดยืนยัน
 *
 * เดิม `public/js/upload.js` ผูก `handleFiles()` ไว้กับ event `change` ตรง ๆ
 * กดเลือกในหน้าต่างของมือถือปุ๊บ ไฟล์วิ่งขึ้น NAS ปั๊บ ไม่มีจังหวะให้ถอยถ้าแตะพลาด
 * ไปโดนรูปข้าง ๆ ในคลังภาพ (ซึ่งเรียงตามเวลา รูปที่ไม่ได้ตั้งใจส่งจึงอยู่ติดกัน)
 *
 * **ทำไมต้องเป็นเบราว์เซอร์จริง ไม่ใช่ grep หาข้อความในซอร์สแบบ slideshow.test.js**
 * ใจความของฟีเจอร์นี้คือเรื่อง event binding ล้วน ๆ เทสต์ที่อ่านซอร์สแล้วเห็นคำว่า
 * `stageFiles` ผ่านได้สบายทั้งที่ยังมี handler เก่าค้างอยู่อีกตัวแล้วส่งทันทีเหมือนเดิม
 * มีทางเดียวที่จะรู้คือเปิดหน้าเว็บจริง เลือกไฟล์จริง แล้วดูว่าเซิร์ฟเวอร์ได้อะไรไปบ้าง
 *
 * ไฟล์นี้เป็นเทสต์ตัวแรกของโปรเจกต์ที่ขับเบราว์เซอร์ (playwright อยู่ใน
 * devDependencies อยู่แล้ว) เปิดไม่ได้ให้ skip พร้อมบอกเหตุผล ห้ามผ่านเงียบ ๆ
 */

const dataDir = useTempDataDir('upload-confirm');

let app;
let browser;
let launchError = null;

/**
 * playwright ที่ติดตั้งไว้กับ Chromium ที่มีในอิมเมจอาจคนละ revision กัน
 * (แพ็กเกจมองหา build ตามเลขที่มันปักไว้ ส่วนอิมเมจมีเลขอื่น) — ลองแบบปกติก่อน
 * แล้วค่อยชี้ไปที่ไบนารีที่มีอยู่จริง แทนที่จะยอมแพ้แล้ว skip ทั้งไฟล์
 */
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

/** จำนวนรูปที่ "ถึงเซิร์ฟเวอร์จริง" — ตัวตัดสินของทุกข้อในไฟล์นี้ */
async function itemCount() {
  const response = await fetch(`${app.baseUrl}/api/items`);
  const payload = await response.json();
  return payload.total;
}

/**
 * รอจนเซิร์ฟเวอร์นับได้ตามที่คาด แล้วคืนจำนวนจริง
 *
 * ถามจากฝั่งเทสต์ ไม่ใช่ยิง fetch ในหน้าเว็บผ่าน waitForFunction — ตัวนั้นได้ Promise
 * กลับมาเป็นค่า ซึ่ง "จริง" เสมอ เงื่อนไขจึงผ่านทันทีตั้งแต่รอบแรกโดยไม่ได้รออะไรเลย
 */
async function waitForCount(target, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let seen = await itemCount();
  while (seen !== target && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    seen = await itemCount();
  }
  return seen;
}

async function openUploader() {
  const page = await browser.newPage();
  const uploadRequests = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/upload')) uploadRequests.push(request.url());
  });
  await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#file-input', { state: 'attached' });
  return { page, uploadRequests };
}

async function pickFiles(page, files) {
  await page.setInputFiles('#file-input', files);
  // แผงตรวจโผล่ = สคริปต์รับไฟล์ไปแล้ว ไม่ใช่แค่ยังไม่ทันทำอะไร
  await page.waitForSelector('#upload-review:not([hidden])');
}

test('choosing files stages them for review without sending anything', async (t) => {
  if (!browser) return t.skip(`เปิดเบราว์เซอร์ไม่ได้: ${launchError?.message}`);

  const one = await makeJpeg(path.join(dataDir, 'first.jpg'), { colour: '#b45f4d' });
  const two = await makeJpeg(path.join(dataDir, 'second.jpg'), { colour: '#4d7fb4' });

  const { page, uploadRequests } = await openUploader();
  await page.setInputFiles('#file-input', [one, two]);

  // ให้เวลาพอที่ของเดิม (ซึ่งส่งทันทีตอน change) จะส่งเสร็จไปแล้วหนึ่งรอบ
  // ก่อนจะสรุปว่า "ไม่มีอะไรถูกส่ง" — ไม่งั้นเทสต์ผ่านเพราะถามเร็วเกินไปเฉย ๆ
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // สองชั้น: ไม่มีคำขอออกจากเบราว์เซอร์ **และ** เซิร์ฟเวอร์ไม่ได้อะไรไปเลย
  // ชั้นหลังคือตัวตัดสิน — พิสูจน์ว่าไม่มีอะไรถึงปลายทางจริง ๆ
  assert.deepEqual(uploadRequests, [], 'เลือกไฟล์เฉย ๆ แต่มีการยิงไป /api/upload');
  assert.equal(await itemCount(), 0, 'ยังไม่ได้กดยืนยัน แต่มีรูปขึ้นเซิร์ฟเวอร์แล้ว');

  // แล้วค่อยยืนยันว่าไฟล์ไม่ได้หายไปไหน — ถูกพักไว้ให้ตรวจ พร้อมรูปย่อครบทุกใบ
  assert.equal(await page.locator('#upload-review').isVisible(), true, 'ไม่มีแผงให้ตรวจ');
  assert.equal(await page.locator('.review__tile').count(), 2, 'ต้องเห็นรูปย่อครบทั้งสองใบ');

  await page.close();
});

test('removing a tile takes that file out of what actually gets sent', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  const one = await makeJpeg(path.join(dataDir, 'keep.jpg'), { colour: '#6f8f5a' });
  const two = await makeJpeg(path.join(dataDir, 'drop.jpg'), { colour: '#8f5a6f' });

  const { page } = await openUploader();
  await pickFiles(page, [one, two]);

  await page.locator('.review__tile').first().locator('.review__remove').click();
  assert.equal(await page.locator('.review__tile').count(), 1, 'กด ✕ แล้วรูปย่อไม่ได้หายไป');

  const before = await itemCount();
  await page.click('#upload-confirm');

  // ต้องได้ "หนึ่ง" ใบ ไม่ใช่สองใบที่เลือกตอนแรก — พิสูจน์ว่าปุ่ม ✕ มีผลกับสิ่งที่
  // ถูกส่งจริง ไม่ใช่แค่หายไปจากหน้าจอแล้วยังแอบส่งอยู่ดี
  assert.equal(await waitForCount(before + 1), before + 1,
    'ไฟล์ที่กดเอาออกไปแล้วยังถูกส่งขึ้นไปด้วย (หรือไม่มีอะไรถูกส่งเลย)');

  await page.close();
});

test('cancelling throws the whole selection away and sends nothing', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  const file = await makeJpeg(path.join(dataDir, 'never.jpg'), { colour: '#3f3a35' });

  const { page, uploadRequests } = await openUploader();
  await pickFiles(page, [file]);

  const before = await itemCount();
  await page.click('#upload-cancel');

  await page.waitForSelector('#upload-review', { state: 'hidden' });
  // เผื่อเวลาให้คำขอที่ (ไม่ควรมี) เดินทางถึงเซิร์ฟเวอร์ ก่อนจะสรุปว่าไม่มีอะไรถูกส่ง
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.deepEqual(uploadRequests, [], 'กดยกเลิกแล้วแต่ยังยิงไป /api/upload');
  assert.equal(await itemCount(), before, 'กดยกเลิกแล้วแต่รูปยังขึ้นเซิร์ฟเวอร์');

  await page.close();
});

test('a second pick adds to the selection instead of replacing it', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  // แขกที่เลือกรูปสองใบแล้วกดเลือกเพิ่ม ต้องไม่ทำให้สองใบแรกหายไปเงียบ ๆ
  const one = await makeJpeg(path.join(dataDir, 'batch-a.jpg'), { colour: '#a8743f' });
  const two = await makeJpeg(path.join(dataDir, 'batch-b.jpg'), { colour: '#3fa874' });

  const { page } = await openUploader();
  await pickFiles(page, [one]);
  await page.setInputFiles('#file-input', [two]);
  await page.waitForFunction(() => document.querySelectorAll('.review__tile').length === 2);

  assert.equal(await page.locator('.review__tile').count(), 2, 'เลือกรอบสองแล้วรอบแรกหายไป');

  await page.close();
});

test('the confirm button counts what is staged, in the guest own language', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  const one = await makeJpeg(path.join(dataDir, 'count-a.jpg'));
  const two = await makeJpeg(path.join(dataDir, 'count-b.jpg'));

  const { page } = await openUploader();
  await pickFiles(page, [one, two]);

  // ค่าเริ่มต้นเป็นภาษาไทย — ปุ่มต้องบอกจำนวนจริง ไม่ใช่ป้ายตายตัวที่โกหกตอนลบใบหนึ่งออก
  assert.match(await page.textContent('#upload-confirm'), /2/);
  await page.locator('.review__tile').first().locator('.review__remove').click();
  assert.match(await page.textContent('#upload-confirm'), /1/);

  await page.close();
});

test('a file the browser cannot preview still shows its name and can still be removed', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  // HEIC ของ iPhone เรนเดอร์ได้บน Safari แต่ Chrome บน Android เรนเดอร์ไม่ได้
  // ต้องได้กล่องชื่อไฟล์ ไม่ใช่ไอคอนรูปแตกที่อ่านแล้วเหมือนไฟล์เสีย
  const broken = path.join(dataDir, 'IMG_4823.heic');
  await fs.writeFile(broken, Buffer.from('ไม่ใช่รูปที่เบราว์เซอร์ถอดรหัสได้'));
  const fine = await makeJpeg(path.join(dataDir, 'fine.jpg'));

  const { page } = await openUploader();
  await pickFiles(page, [broken, fine]);

  await page.waitForSelector('.review__fallback');
  assert.match(await page.textContent('.review__fallback'), /IMG_4823\.heic/);

  // event error ยิงหลังปุ่ม ✕ ถูกใส่ลงไปแล้ว — เคยพลาดตรงนี้ด้วยการล้างทั้งกล่อง
  // ทิ้ง ซึ่งลบปุ่มไปด้วย แล้วไฟล์ใบที่ดูไม่ได้จะเอาออกไม่ได้เลย
  const stuck = page.locator('.review__tile').filter({ has: page.locator('.review__fallback') });
  await stuck.locator('.review__remove').click();
  assert.equal(await page.locator('.review__tile').count(), 1, 'ไฟล์ที่ดูรูปย่อไม่ได้ กดเอาออกไม่ได้');

  await page.close();
});

test('the send button is brought into view, not left somewhere the guest never looks', async (t) => {
  if (!browser) return t.skip('เปิดเบราว์เซอร์ไม่ได้');

  // ถ้าแขกเลือกรูปเสร็จแล้วไม่เห็นปุ่ม "ส่ง N ไฟล์" จะเดินจากไปโดยคิดว่าส่งแล้ว
  // เงียบ ไม่มี error ไม่มีใครรู้ทั้งงาน ซึ่งทำลายจุดประสงค์ทั้งหมดของระบบ
  const file = await makeJpeg(path.join(dataDir, 'scroll.jpg'));

  const page = await browser.newPage({ viewport: { width: 390, height: 700 } });
  await page.goto(`${app.baseUrl}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#file-input', { state: 'attached' });

  // ทำให้หน้ายาวพอจะเลื่อนได้จริงก่อน — งานจริงแกลลอรี่มีรูปเป็นร้อยใบต่อท้ายอยู่แล้ว
  // แต่ในเทสต์มีไม่กี่ใบ ถ้าไม่ยืดหน้าให้ยาว เลื่อนยังไงแผงอัพโหลดก็ยังอยู่ในจอ
  // แล้วเทสต์จะผ่านโดยไม่ได้ทดสอบอะไรเลย
  await page.evaluate(() => {
    const filler = document.createElement('div');
    filler.style.height = '4000px';
    document.body.appendChild(filler);
    window.scrollTo(0, document.body.scrollHeight);
  });

  const before = await page.locator('#upload-confirm').boundingBox();
  assert.ok(before === null || before.y > page.viewportSize().height,
    'ปุ่มยังอยู่ในจอตั้งแต่ก่อนเลือกไฟล์ — เทสต์นี้จะผ่านโดยไม่ได้ทดสอบอะไร');

  await page.setInputFiles('#file-input', [file]);
  await page.waitForSelector('#upload-review:not([hidden])');
  await page.waitForTimeout(1200); // เผื่อ smooth scroll เดินให้จบ

  const box = await page.locator('#upload-confirm').boundingBox();
  const height = page.viewportSize().height;
  assert.ok(box, 'ไม่เจอปุ่มยืนยัน');
  assert.ok(box.y + box.height > 0 && box.y < height,
    `ปุ่มยืนยันอยู่นอกจอ (y=${box.y}, จอสูง ${height}) — แขกจะไม่รู้ว่าต้องกดอะไรต่อ`);

  await page.close();
});

test('nothing in the uploader still reaches for the old send-on-pick path', async () => {
  const js = await fs.readFile(new URL('../public/js/upload.js', import.meta.url), 'utf8');

  // กันคนแก้ทีหลังเผลอผูก handleFiles กลับเข้า event change อีกครั้ง ซึ่งจะทำให้
  // จังหวะยืนยันถูกข้ามไปเงียบ ๆ โดยที่หน้าตายังเหมือนเดิมทุกอย่าง
  assert.ok(!/addEventListener\('change'[\s\S]{0,120}handleFiles\(/.test(js),
    'ยังมี change handler ที่เรียก handleFiles ตรง ๆ อยู่');
  assert.match(js, /stageFiles\(/, 'ต้องพักไฟล์ไว้ให้ตรวจก่อน');

  // object URL ที่ไม่ revoke ค้างรูปเต็มความละเอียดไว้ในแรมจนกว่าจะปิดแท็บ
  // มือถือรุ่นเก่าที่เลือกรูปหลายรอบจะโดนเบราว์เซอร์ฆ่าทิ้งกลางงาน
  assert.match(js, /revokeObjectURL/, 'ต้องคืนหน่วยความจำของรูปย่อที่เอาออกแล้ว');
});
