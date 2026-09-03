import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * รูปมีอายุ — QR บนกระดาษไม่มี
 *
 * เราเก็บรูปจากบูธไว้ 7 วันแล้วลบ แต่แผ่นที่แขกถือกลับบ้านมี QR พิมพ์อยู่ตลอดไป
 * สิ่งที่ต้องไม่เกิดคือแขกสแกนหลังหมดอายุแล้วเจอ **หน้าเดียวกับตอนที่รูปยังไม่ขึ้นระบบ**
 * ("เก็บรหัสไว้แล้วกลับมาใหม่") เพราะเขาจะรอเก้อไปตลอด รูปนั้นไม่มีวันกลับมาแล้ว
 *
 * ไฟล์นี้จึงตรวจสามสถานะให้แยกออกจากกันจริง ๆ ไม่ใช่แค่ "ไม่ error"
 */

const KEY = 'booth-expiry-test-key-5d1c';
process.env.BOOTH_KEY = KEY;
process.env.BOOTH_RETENTION_DAYS = '7';

const dataDir = useTempDataDir('booth-expiry');
const app = await startTestServer();

const { db } = await import('../src/db.js');
const { getBoothSession } = await import('../src/repo.js');
const { sweepExpiredBooth, boothKeepsUntil } = await import('../src/lib/booth-retention.js');

const ALBUM = 'EX12CD34';

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function send(token, { album = ALBUM, shots = 2 } = {}) {
  const form = new FormData();
  form.append('manifest', JSON.stringify({
    token, album, createdAt: '2026-09-02T10:00:00.000Z', event: { title: 'งานที่รูปมีอายุ' },
  }));
  counter += 1;
  const sheet = await fs.readFile(
    await makeJpeg(path.join(dataDir, `e-${counter}.jpg`), { width: 1200, height: 1800 }));
  form.append('sheet', new Blob([sheet]), 'sheet.jpg');
  for (let i = 0; i < shots; i += 1) {
    counter += 1;
    form.append('shots', new Blob([
      await fs.readFile(await makeJpeg(path.join(dataDir, `e-${counter}.jpg`))),
    ]), `shot-${i + 1}.jpg`);
  }
  const response = await fetch(`${app.baseUrl}/api/booth/upload`, {
    method: 'POST', headers: { 'x-booth-key': KEY }, body: form,
  });
  assert.equal(response.status, 201);
}

/** ย้อนวันที่ขึ้นระบบให้เก่ากว่ากำหนดเก็บ — จำลองว่าเวลาผ่านไปจริง */
const ageBy = (token, days) => db
  .prepare("UPDATE booth_sessions SET created_at = datetime('now', ?) WHERE token = ?")
  .run(`-${days} days`, token);

await send('GD1111');
await send('NW2222');

test('a fresh take tells the guest the deadline, before it becomes a problem', async () => {
  const html = await (await fetch(`${app.baseUrl}/p/NW2222?lang=th`)).text();
  // แขกต้องรู้ว่าต้องโหลดภายในวันไหน ตอนที่ยังโหลดได้ ไม่ใช่รู้ตอนที่มันหายไปแล้ว
  assert.match(html, /อยู่ถึง/, 'หน้ารูปที่ยังไม่หมดอายุต้องบอกวันหมดอายุ');

  const until = boothKeepsUntil(getBoothSession('NW2222'));
  const days = Math.round((until - Date.now()) / 86400000);
  assert.equal(days, 7, `นับจากวันที่ขึ้นระบบ ต้องได้ 7 วัน ไม่ใช่ ${days}`);
});

test('the sweep deletes the files but never the row the QR points at', async () => {
  const before = getBoothSession('GD1111');
  const boothDir = path.join(dataDir, 'booth');
  const files = await fs.readdir(boothDir);
  assert.ok(files.includes(before.sheet_name), 'ไฟล์ต้องมีอยู่ก่อนกวาด');

  ageBy('GD1111', 9);
  const { swept } = await sweepExpiredBooth({ force: true });
  assert.equal(swept, 1, 'รอบที่พ้นกำหนดต้องถูกกวาด');

  const after_ = getBoothSession('GD1111');
  assert.ok(after_, '**แถวต้องอยู่** — มันคือสิ่งเดียวที่ทำให้ QR บนกระดาษยังตอบได้');
  assert.ok(after_.expired_at, 'และต้องมีวันหมดอายุกำกับไว้');
  assert.equal(after_.bytes, 0, 'ไฟล์ไม่กินพื้นที่แล้ว สถิติต้องไม่นับต่อ');

  const left = await fs.readdir(boothDir);
  assert.ok(!left.includes(before.sheet_name), 'แผ่นต้องถูกลบจากดิสก์จริง');
  assert.equal(left.filter((name) => name.startsWith('GD1111')).length, 0,
    'รูปดิบของรอบนั้นต้องถูกลบด้วยทุกใบ');

  // รอบที่ยังไม่ถึงกำหนดต้องรอดจากการกวาดรอบเดียวกัน
  assert.equal(getBoothSession('NW2222').expired_at, null);
});

/*
 * ทุกหน้าฝังพจนานุกรมข้อความทั้งชุดไว้ให้ JS ฝั่งเบราว์เซอร์ใช้ (server.js: clientStrings)
 * ค้นข้อความดิบ ๆ จึงเจอทุกคำเสมอไม่ว่าหน้าจะเรนเดอร์อะไรออกมา — ต้องตัดสคริปต์ทิ้งก่อน
 * ไม่งั้นเทสต์จะ "ผ่าน" ทั้งที่หน้าจริงพูดผิดข้อ
 */
const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');

test('scanning an expired sheet says "expired", never "not uploaded yet"', async () => {
  const response = await fetch(`${app.baseUrl}/p/GD1111?lang=th`);
  const html = visible(await response.text());

  assert.match(html, /หมดอายุ/, 'ต้องบอกว่าหมดอายุ');
  assert.ok(!html.includes('กลับมาสแกนใหม่'),
    'ห้ามบอกให้กลับมาใหม่ — รูปชุดนี้ไม่มีวันกลับมาแล้ว แขกจะรอเก้อไปตลอด');
  assert.ok(html.includes('GD1111'), 'ยังต้องบอกรหัสไว้ให้แขกไปคุยกับเจ้าภาพได้');
  assert.match(html, /ติดต่อเจ้าภาพ/, 'ต้องบอกทางออกที่ยังเหลืออยู่');

  // โทเคนที่ไม่เคยมีใครถ่ายเลย ต้องยังได้ข้อความคนละอันกับที่หมดอายุ
  const never = visible(await (await fetch(`${app.baseUrl}/p/ZZ9999?lang=th`)).text());
  assert.match(never, /กลับมาสแกนใหม่/, 'รอบที่ยังไม่ขึ้นระบบต้องบอกให้กลับมาใหม่');
  assert.ok(!never.includes('หมดอายุ'));
});

test('the files really are gone, not just hidden behind a flag', async () => {
  assert.equal((await fetch(`${app.baseUrl}/p/GD1111/sheet`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/p/GD1111/shot/1`)).status, 404);
  // ของรอบที่ยังไม่หมดอายุต้องเสิร์ฟได้ตามปกติ
  assert.equal((await fetch(`${app.baseUrl}/p/NW2222/sheet`)).status, 200);
});

test('the album drops expired takes but says how many went', async () => {
  const html = visible(await (await fetch(`${app.baseUrl}/b/${ALBUM}?lang=th`)).text());
  assert.ok(!html.includes('GD1111'), 'รอบที่หมดอายุต้องไม่อยู่ในกริดแล้ว');
  assert.ok(html.includes('NW2222'), 'รอบที่ยังอยู่ต้องอยู่ครบ');
  // หายไปเงียบ ๆ ราวกับไม่เคยมี คือสิ่งที่ทำให้เจ้าภาพคิดว่าระบบทำรูปหาย
  assert.match(html, /หมดอายุและถูกลบไปแล้ว/, 'ต้องนับรอบที่หมดอายุให้เห็น');

  // แขกที่สแกนแผ่นของตัวเองซึ่งหมดอายุแล้ว ต้องรู้ว่าทำไมหาของตัวเองไม่เจอ
  const mine = visible(await (await fetch(`${app.baseUrl}/b/${ALBUM}/GD1111?lang=th`)).text());
  assert.match(mine, /หมดอายุ/);
  assert.ok(mine.includes('NW2222'), 'แต่อัลบั้มยังแสดงรูปที่เหลือตามปกติ');
});

test('the zip and the counts stop including what was deleted', async () => {
  const zip = Buffer.from(await (await fetch(`${app.baseUrl}/b/${ALBUM}/zip`)).arrayBuffer());
  const names = [...zip.toString('latin1').matchAll(/(?:sheets|originals)\/[\w.-]+?\.jpg/g)]
    .map((match) => match[0]);
  assert.ok(names.length > 0, 'รอบที่ยังอยู่ต้องยังโหลดได้');
  assert.ok(!names.some((name) => name.includes('GD1111')),
    'ZIP ต้องไม่อ้างไฟล์ที่ลบไปแล้ว — ไม่งั้นได้ไฟล์ที่เปิดไม่ออกหรือขาดไปเงียบ ๆ');
});

test('sweeping twice changes nothing, and a booth kept forever expires nothing', async () => {
  // รันซ้ำต้องปลอดภัยเสมอ — ตัวกวาดถูกเรียกทุกครั้งที่มีคนเปิดหน้า
  assert.deepEqual(await sweepExpiredBooth({ force: true }), { swept: 0, skipped: false });

  // การหน่วงชั่วโมงละครั้งต้องทำงาน ไม่งั้นทุกคำขอไล่อ่านตารางใหม่หมด
  assert.equal((await sweepExpiredBooth()).skipped, true);
});
