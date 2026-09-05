import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * แผ่นจากบูธขึ้นจอสไลด์โชว์
 *
 * ลูกค้าที่ซื้อทั้งเว็บและบูธเคยได้ของสองอย่างที่ไม่เห็นกันเลย — แผ่นที่พิมพ์อยู่ใน
 * กระเป๋าแขก ส่วนจอบนกำแพงขึ้นแต่รูปจากมือถือ · เอาแผ่นขึ้นจอด้วยทำให้แพ็กคู่มีค่า
 * มากกว่าผลรวมของสองอย่าง และเป็นป้ายโฆษณาบูธที่ดีที่สุดในงาน
 *
 * ข้อที่ตรึงแน่นที่สุดคือ **รหัสของแผ่นต้องไม่ชนกับรหัสรูปของแขก** สองตารางนับเลข
 * ของตัวเองแยกกัน ถ้าปล่อยให้ชนกัน ตัวกันซ้ำฝั่งหน้าจอจะมองว่าเป็นใบเดียวกัน
 * แล้ว **รูปของแขกจะหายไปจากจอเงียบ ๆ** โดยไม่มี error ให้ใครเห็น
 */

const KEY = 'booth-key-slideshow-test-9f3';
process.env.BOOTH_KEY = KEY;

const dataDir = useTempDataDir('booth-slideshow');
const app = await startTestServer();

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function jpeg({ width = 1200, height = 1800 } = {}) {
  counter += 1;
  const file = path.join(dataDir, `s-${counter}.jpg`);
  await makeJpeg(file, { width, height, colour: '#8899aa' });
  return fs.readFile(file);
}

/** ส่งรอบถ่ายขึ้นมาเหมือนที่บูธจริงทำ */
async function sendSheet(token) {
  const form = new FormData();
  form.append('manifest', JSON.stringify({
    token,
    createdAt: new Date().toISOString(),
    event: { title: 'งานทดสอบ' },
    template: 'strip',
    effect: 'clean',
    shots: [],
  }));
  form.append('sheet', new Blob([await jpeg()]), 'sheet.jpg');
  const response = await fetch(`${app.baseUrl}/api/booth/upload`, {
    method: 'POST', headers: { 'x-booth-key': KEY }, body: form,
  });
  assert.equal(response.status, 201, await response.text());
}

const screen = async () => (await (await fetch(`${app.baseUrl}/api/slideshow`)).json());

const login = async () => {
  const response = await fetch(`${app.baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: process.env.ADMIN_PASSWORD ?? 'test-password-1234' }),
    redirect: 'manual',
  });
  return response.headers.getSetCookie().find((one) => one.startsWith('admin_session='))?.split(';')[0];
};

test('a booth print reaches the screen looking like any other photo', async () => {
  await sendSheet('AAA111');

  const { items } = await screen();
  const sheet = items.find((one) => one.id === 'b:AAA111');
  assert.ok(sheet, 'แผ่นที่บูธส่งขึ้นมาต้องไปโผล่บนจอ');

  /*
   * ต้องมีช่องครบเท่ากับรูปของแขก — หน้าจอไม่ได้ถูกแก้ให้รู้จักแผ่นจากบูธเลย
   * มันจึงต้องอ่านแผ่นได้ด้วยกติกาเดิมทุกข้อ ขาดช่องไหนไปคือกรอบว่างบนจอ
   */
  assert.equal(sheet.kind, 'image');
  assert.equal(sheet.converting, false);
  assert.equal(sheet.displayUrl, '/p/AAA111/sheet');
  assert.equal(sheet.thumbUrl, '/p/AAA111/thumb');
  assert.ok(sheet.createdAt);

  // สัดส่วนต้องมาจากไฟล์จริง ไม่ใช่ค่าเดา — ไม่งั้นกรอบบนกำแพงกระพริบตอนรูปโหลดเสร็จ
  assert.equal(sheet.width, 1200);
  assert.equal(sheet.height, 1800);

  // และที่อยู่ที่บอกไว้ต้องเปิดได้จริง ไม่ใช่ 404 ที่กลายเป็นกรอบว่างบนจอ
  assert.equal((await fetch(`${app.baseUrl}${sheet.displayUrl}`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}${sheet.thumbUrl}`)).status, 200);
});

test('booth ids never collide with guest photo ids', async () => {
  /*
   * รูปของแขกมี id เป็นตัวเลขนับจาก 1 · ถ้าแผ่นจากบูธใช้เลขของตัวเองด้วย
   * รูปแขกใบที่ 1 กับแผ่นใบที่ 1 จะเป็น "ใบเดียวกัน" ในสายตาตัวกันซ้ำฝั่งหน้าจอ
   * แล้วใบหนึ่งจะหายไปจากจอโดยไม่มีอะไรบอก — ข้อนี้คือตัวกันของนั้น
   */
  const form = new FormData();
  form.append('files', new Blob([await jpeg({ width: 800, height: 600 })]), 'guest.jpg');
  form.append('uploader', 'แขกคนหนึ่ง');
  assert.equal((await fetch(`${app.baseUrl}/api/upload`, { method: 'POST', body: form })).status, 201);

  const { items } = await screen();
  const ids = items.map((one) => one.id);
  assert.equal(new Set(ids).size, ids.length, 'รหัสต้องไม่ซ้ำกันเลยสักคู่');
  assert.ok(ids.includes(1), 'รูปของแขกยังต้องอยู่');
  assert.ok(ids.includes('b:AAA111'), 'แผ่นจากบูธยังต้องอยู่');
});

test('prints and photos are mixed by time, not piled at the end', async () => {
  // กองไว้ท้ายสำรับ = โหมดโรงหนังขึ้นแผ่นทั้งหมดรวดเดียวตอนจบ ซึ่งไม่ใช่สไลด์โชว์
  await sendSheet('BBB222');

  const { items } = await screen();
  const times = items.map((one) => String(one.createdAt ?? ''));
  assert.deepEqual(times, [...times].sort().reverse(), 'ทั้งสำรับต้องเรียงตามเวลา ใหม่สุดก่อน');
});

test('an expired round is left off the screen, not shown as an empty frame', async () => {
  /*
   * รอบที่หมดอายุถูกลบไฟล์ทิ้งแล้ว แต่แถวยังอยู่เพื่อให้ QR บนกระดาษตอบได้ว่า
   * "รูปหมดอายุแล้ว" — เอาขึ้นจอจะได้กรอบที่โหลดรูปไม่ขึ้นค้างอยู่บนกำแพงทั้งงาน
   */
  const { db } = await import('../src/db.js');
  db.prepare("UPDATE booth_sessions SET expired_at = datetime('now') WHERE token = ?").run('BBB222');

  const ids = (await screen()).items.map((one) => one.id);
  assert.equal(ids.includes('b:BBB222'), false, 'รอบที่ไฟล์ถูกลบไปแล้วต้องไม่ขึ้นจอ');
  assert.ok(ids.includes('b:AAA111'), 'รอบที่ยังอยู่ต้องไม่ถูกลบตามไปด้วย');
});

test('the host can switch booth prints off, and the switch only shows when it does something', async () => {
  const cookie = await login();
  assert.ok(cookie, 'ต้องล็อกอินแอดมินได้');

  // สวิตช์ต้องมีให้เห็น เพราะงานนี้มีแผ่นจากบูธจริง
  const page = await (await fetch(`${app.baseUrl}/admin`, { headers: { cookie } })).text();
  assert.match(page, /name="slideshow_booth"/);

  await fetch(`${app.baseUrl}/admin/settings`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ uploads_enabled: 'on' }),
    redirect: 'manual',
  });

  const ids = (await screen()).items.map((one) => one.id);
  assert.equal(ids.some((id) => String(id).startsWith('b:')), false, 'ปิดแล้วต้องไม่มีแผ่นเหลืออยู่');
  assert.ok(ids.includes(1), 'รูปของแขกต้องไม่หายไปด้วย');
});
