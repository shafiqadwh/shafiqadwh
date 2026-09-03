import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';

/**
 * เปิดสไลด์โชว์บนทีวีโดยไม่ต้องพิมพ์อะไรด้วยรีโมต
 *
 * การพิมพ์ URL ด้วยปุ่มลูกศรบนรีโมตคือขั้นตอนที่ช้าที่สุดและพิมพ์ผิดบ่อยที่สุด
 * ของการติดตั้งหน้างาน · แทนด้วยรหัสหกตัวบนจอ + ยืนยันจากมือถือที่ล็อกอินอยู่แล้ว
 *
 * ข้อที่สำคัญที่สุดในไฟล์นี้: **รหัสบนจอทีวีต้องไม่ใช่กุญแจ** ใครถ่ายรูปหน้าจอ
 * ทีวีไว้แล้วเอาไปใช้ทีหลังต้องทำอะไรไม่ได้เลย เพราะการยืนยันต้องผ่านแอดมินเสมอ
 */

const dataDir = useTempDataDir('tv-pairing');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

const { registry } = await import('../src/lib/tenancy.js');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** เปิดหน้าทีวีหนึ่งครั้ง คืนรหัสจับคู่กับคุกกี้ของ "เครื่องทีวี" เครื่องนั้น */
async function openTv(deviceCookie = null) {
  const response = await fetch(`${app.baseUrl}/tv`, {
    headers: deviceCookie ? { cookie: deviceCookie } : {},
    redirect: 'manual',
  });
  // เว็บตั้งคุกกี้หลายตัวในคำขอเดียว (ภาษา, โควตารายเครื่อง) — `get` คืนตัวแรก
  // ซึ่งไม่ใช่ของทีวี · ต้องเลือกตัวที่ต้องการจริง ๆ ไม่ใช่หยิบตัวแรกที่เจอ
  const fresh = response.headers.getSetCookie().find((one) => one.startsWith('tv_device='));
  const jar = deviceCookie ?? (fresh ? fresh.split(';')[0] : '');
  const html = response.status === 200 ? await response.text() : '';
  const code = html.match(/class="tv__code">([0-9A-Z]{6})</)?.[1] ?? null;
  return { response, jar, code, html };
}

const claim = (code, mode, extra = {}) => fetch(`${app.baseUrl}/admin/tv`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ code, mode, ...extra }),
  redirect: 'manual',
});

test('the TV shows a code and a QR, and asks nobody to type a URL', async () => {
  const { response, code, html } = await openTv();
  assert.equal(response.status, 200);
  assert.match(code ?? '', /^[0-9A-Z]{6}$/, 'ต้องมีรหัสหกตัวบนจอ');

  // QR พาไปหน้ายืนยันพร้อมรหัสในลิงก์ — กล้องมือถือเปิดให้เองโดยไม่ต้องมีแอปสแกน
  assert.match(html, /\/admin\/tv\?code=/, 'QR ต้องพาไปหน้ายืนยันพร้อมรหัส');
  assert.match(html, /data:image\/png;base64,/, 'ต้องมีภาพ QR จริง');

  // ตัวอักษรที่คนอ่านสลับกันถูกตัดออกจากชุดแล้ว (I L O U) เหมือนโทเคนของบูธ
  assert.ok(!/[ILOU]/.test(code), `รหัส ${code} มีตัวที่อ่านสลับกันได้`);
});

test('a code from the TV screen is not a key to anything', async () => {
  const { code } = await openTv();

  // คนที่ถ่ายรูปจอทีวีไว้ ไม่มีทางใช้รหัสนั้นทำอะไรได้เลยถ้าไม่ได้ล็อกอินแอดมิน
  const nobody = await fetch(`${app.baseUrl}/admin/tv`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, mode: 'cinema' }),
    redirect: 'manual',
  });
  assert.equal(nobody.status, 401);

  // และหน้ายืนยันเองก็ต้องพากลับไปล็อกอินก่อน โดยจำรหัสไว้ให้
  const page = await fetch(`${app.baseUrl}/admin/tv?code=${code}`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.match(page.headers.get('location'), /^\/admin\?next=/,
    'ต้องพาไปล็อกอินพร้อมจำปลายทางไว้ ไม่ใช่ทิ้งให้เดินกลับไปอ่านรหัสใหม่');
});

test('the host confirms from their phone and the TV walks itself in', async () => {
  const tv = await openTv();

  // ก่อนยืนยัน ทีวีถามแล้วต้องยังไม่ได้อะไร
  const before = await (await fetch(`${app.baseUrl}/api/tv/state`, { headers: { cookie: tv.jar } })).json();
  assert.deepEqual(before, { paired: false });

  const done = await claim(tv.code, 'wall', { label: 'จอหน้าห้อง' });
  assert.equal(done.status, 302);
  assert.match(done.headers.get('location'), /done=1/);

  // ทีวีถามรอบถัดไปแล้วต้องได้ที่อยู่ของสไลด์โชว์แบบที่เจ้าภาพเลือก
  const after_ = await (await fetch(`${app.baseUrl}/api/tv/state`, { headers: { cookie: tv.jar } })).json();
  assert.equal(after_.paired, true);
  assert.match(after_.next, /^\/slideshow\?mode=wall/, `ได้ ${after_.next}`);

  // และเปิด /tv ใหม่ (รีบูตทีวี) ต้องเข้าสไลด์โชว์เลย ไม่ต้องจับคู่ใหม่ทุกเช้า
  const again = await openTv(tv.jar);
  assert.equal(again.response.status, 302);
  assert.match(again.response.headers.get('location'), /mode=wall/);
});

test('a used code cannot be used again, and neither can a made-up one', async () => {
  const tv = await openTv();
  assert.equal((await claim(tv.code, 'cinema')).headers.get('location'), '/admin/tv?done=1');

  // รหัสถูกล้างทิ้งทันทีที่ใช้ — รูปถ่ายจอทีวีที่ค้างอยู่ในมือถือใครก็ใช้ไม่ได้อีก
  const reused = await claim(tv.code, 'wall');
  assert.match(reused.headers.get('location'), /bad=1/, 'รหัสที่ใช้ไปแล้วต้องใช้ซ้ำไม่ได้');

  const madeUp = await claim('ZZ9999', 'cinema');
  assert.match(madeUp.headers.get('location'), /bad=1/);

  // โหมดที่ไม่มีอยู่จริงต้องไม่ผ่าน ไม่งั้นทีวีถูกส่งไปหน้าที่ไม่มีอะไรเล่น
  const tv2 = await openTv();
  assert.match((await claim(tv2.code, 'ทั้งจอ')).headers.get('location'), /bad=1/);
});

test('an expired code stops working, even though the TV still shows it', async () => {
  const tv = await openTv();
  // ทีวีเปิดค้างข้ามคืน — รหัสบนจอยังอยู่ แต่ต้องหมดอายุไปแล้ว
  // ทะเบียนจอเป็นของทั้งเครื่อง ไม่ได้อยู่ในฐานข้อมูลของงาน (ดู src/lib/tenancy.js)
  registry().prepare("UPDATE tv_screens SET code_at = datetime('now', '-40 minutes') WHERE code = ?")
    .run(tv.code);

  assert.match((await claim(tv.code, 'cinema')).headers.get('location'), /bad=1/,
    'รหัสที่หมดอายุต้องใช้ไม่ได้ แม้จะยังอ่านได้จากจอ');
});

test('two TVs in the same day never collide', async () => {
  // งานเดียวมีสองจอ (โถงหน้า + ในห้อง) หรือสองงานคนละจอในวันเดียว
  const hall = await openTv();
  const room = await openTv();
  assert.notEqual(hall.jar, room.jar, 'สองเครื่องต้องได้โทเคนคนละตัว');
  assert.notEqual(hall.code, room.code);

  await claim(hall.code, 'wall', { label: 'โถงหน้า' });
  await claim(room.code, 'cinema', { label: 'ในห้อง' });

  const hallState = await (await fetch(`${app.baseUrl}/api/tv/state`, { headers: { cookie: hall.jar } })).json();
  const roomState = await (await fetch(`${app.baseUrl}/api/tv/state`, { headers: { cookie: room.jar } })).json();
  assert.match(hallState.next, /mode=wall/);
  assert.match(roomState.next, /mode=cinema/, 'จอที่สองต้องไม่โดนทับด้วยการจับคู่ของจอแรก');

  // และเจ้าภาพต้องเห็นทั้งสองจอในหน้าแอดมิน พร้อมชื่อที่ตั้งไว้
  const page = await (await fetch(`${app.baseUrl}/admin/tv`, { headers: { cookie } })).text();
  assert.ok(page.includes('โถงหน้า') && page.includes('ในห้อง'));
});

test('unpairing sends the TV back to the pairing screen on its own', async () => {
  const tv = await openTv();
  await claim(tv.code, 'cinema');

  // เอาโทเคนจากคุกกี้ของทีวีเครื่องนี้ตรง ๆ · ค้นจากตารางด้วย mode แล้วเรียงตาม
  // paired_at ไม่ได้ เพราะเวลาละเอียดแค่ระดับวินาที เทสต์ก่อนหน้าจับคู่ cinema
  // ไว้ในวินาทีเดียวกันแล้วได้แถวคนละเครื่อง
  const device = tv.jar.split('=')[1];
  const dropped = await fetch(`${app.baseUrl}/admin/tv/unpair`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ device }),
    redirect: 'manual',
  });
  assert.equal(dropped.status, 302);

  const state = await (await fetch(`${app.baseUrl}/api/tv/state`, { headers: { cookie: tv.jar } })).json();
  assert.equal(state.paired, false, 'ทีวีต้องกลับไปหน้าจับคู่เองในรอบถามถัดไป');
});

test('login sends you back where you were headed, but never off-site', async () => {
  // ?next= ที่รับลิงก์ข้ามเว็บได้คือวิธีมาตรฐานของการหลอกให้คนล็อกอินแล้วถูกส่ง
  // ไปหน้าปลอม — `//evil.example` หน้าตาเหมือนเส้นทางภายในแต่ไม่ใช่
  const post = (next) => fetch(`${app.baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password', next }),
    redirect: 'manual',
  });

  assert.equal((await post('/admin/tv?code=ABC123')).headers.get('location'), '/admin/tv?code=ABC123');
  assert.equal((await post('//evil.example/steal')).headers.get('location'), '/admin');
  assert.equal((await post('https://evil.example')).headers.get('location'), '/admin');
  assert.equal((await post('')).headers.get('location'), '/admin');
});
