import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * อัลบั้มรวมของบูธ — QR แบบ "สแกนแล้วดูได้ทุกรูป"
 *
 * เจ้าของงานเลือกโหมดนี้ก่อนตั้งบูธเมื่ออยากให้แขกดูรูปกันได้ทั้งงาน
 * ข้อที่สำคัญที่สุดในไฟล์นี้คือ **อัลบั้มต้องไม่รั่วข้ามงาน**: ลิงก์ของงานหนึ่ง
 * ต้องไม่มีทางเห็นรูปของอีกงาน และรอบที่ถ่ายในโหมด "เห็นเฉพาะรูปตัวเอง"
 * ต้องไม่โผล่ในอัลบั้มไหนเลย — เพราะเจ้าภาพเลือกโหมดนั้นด้วยเหตุผลเรื่องความเป็นส่วนตัว
 */

const KEY = 'booth-album-test-key-2b7e';
process.env.BOOTH_KEY = KEY;

const dataDir = useTempDataDir('booth-album');
const app = await startTestServer();

const ALBUM = 'AB12CD34';
const OTHER = 'ZZ99YY88';

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function jpeg(size = { width: 600, height: 400 }) {
  counter += 1;
  return fs.readFile(await makeJpeg(path.join(dataDir, `a-${counter}.jpg`), size));
}

async function send({ token, album, shots = 1 }) {
  const form = new FormData();
  form.append('manifest', JSON.stringify({
    token,
    album,
    createdAt: `2026-09-02T1${counter % 9}:00:00.000Z`,
    event: { title: 'งานแต่งอัลบั้ม' },
    template: 'strip',
    effect: 'soft',
  }));
  form.append('sheet', new Blob([await jpeg({ width: 1200, height: 1800 })]), 'sheet.jpg');
  for (let i = 0; i < shots; i += 1) {
    form.append('shots', new Blob([await jpeg()]), `shot-${i + 1}.jpg`);
  }
  const response = await fetch(`${app.baseUrl}/api/booth/upload`, {
    method: 'POST', headers: { 'x-booth-key': KEY }, body: form,
  });
  assert.equal(response.status, 201, `อัปโหลด ${token} ไม่สำเร็จ`);
}

// สามรอบ: สองรอบในอัลบั้มเดียวกัน · หนึ่งรอบอัลบั้มอื่น · หนึ่งรอบไม่สังกัดอัลบั้ม
await send({ token: 'AAA111', album: ALBUM });
await send({ token: 'BBB222', album: ALBUM, shots: 2 });
await send({ token: 'CCC333', album: OTHER });
await send({ token: 'DDD444', album: undefined });

test('the album shows every take of this event and nothing from any other', async () => {
  const response = await fetch(`${app.baseUrl}/b/${ALBUM}`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(html.includes('AAA111'), 'รอบในอัลบั้มนี้ต้องอยู่');
  assert.ok(html.includes('BBB222'), 'รอบในอัลบั้มนี้ต้องอยู่ครบทุกรอบ');
  assert.ok(!html.includes('CCC333'), 'รอบของอีกงานต้องไม่หลุดเข้ามา');
  assert.ok(!html.includes('DDD444'),
    'รอบที่ถ่ายในโหมด "เห็นเฉพาะรูปตัวเอง" ต้องไม่โผล่ในอัลบั้มของใครเลย');
});

test('scanning your own sheet puts your take at the top, with the rest below', async () => {
  // เหตุผลทั้งหมดที่ QR โหมดอัลบั้มพก "รหัสรอบ" ไปด้วย — ไม่งั้นแขกต้องไล่หา
  // รูปตัวเองในกองเป็นร้อยใบ ซึ่งทำให้โหมดนี้ใช้ไม่ได้จริงกับคนที่ถือกระดาษใบเดียว
  const html = await (await fetch(`${app.baseUrl}/b/${ALBUM}/BBB222`)).text();

  const mine = html.indexOf('/p/BBB222/sheet');
  const others = html.indexOf('/b/AB12CD34/AAA111');
  assert.ok(mine > 0, 'ต้องมีแผ่นของคนที่สแกนแบบเต็มใบ');
  assert.ok(others > mine, 'รูปของคนที่สแกนต้องมาก่อนของคนอื่น');

  // รูปดิบของรอบตัวเองต้องมีให้โหลดด้วย เหมือนหน้า /p/ ปกติ
  assert.ok(html.includes('/p/BBB222/shot/2'), 'รูปดิบของรอบตัวเองต้องอยู่ครบ');
});

test('a code from another album cannot be used to peek into this one', async () => {
  const html = await (await fetch(`${app.baseUrl}/b/${ALBUM}/CCC333`)).text();
  assert.ok(!html.includes('/p/CCC333/sheet'),
    'รหัสของงานอื่นต้องไม่ถูกยกขึ้นมาแสดงในอัลบั้มนี้');
  assert.ok(html.includes('AAA111'), 'แต่อัลบั้มเองยังต้องแสดงตามปกติ');
});

test('a made-up album code is a plain not-found, not an empty album page', async () => {
  // หน้าอัลบั้มว่างเปล่าบอกคนเดาว่า "รหัสนี้มีรูปแบบถูก" ซึ่งเป็นข้อมูลที่ไม่ควรให้
  assert.equal((await fetch(`${app.baseUrl}/b/QQQQQQQQ`)).status, 200,
    'รหัสรูปแบบถูกแต่ยังไม่มีรูป ต้องได้หน้าที่อธิบาย ไม่ใช่หน้าหาย');
  assert.equal((await fetch(`${app.baseUrl}/b/SHORT`)).status, 404);
  assert.equal((await fetch(`${app.baseUrl}/b/AB12CD34/NOPE`)).status, 404);
});

test('the host can take the whole event home in one file', async () => {
  const zip = await fetch(`${app.baseUrl}/b/${ALBUM}/zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition'), /photobooth-AB12CD34-\d{4}-\d{2}-\d{2}\.zip/);

  const body = Buffer.from(await zip.arrayBuffer());
  assert.equal(body.subarray(0, 2).toString(), 'PK', 'ต้องเป็นไฟล์ zip จริง');

  // ชื่อไฟล์ข้างในอ่านได้ตรง ๆ จากไบต์ (เก็บแบบ store ไม่ได้บีบอัด) · ต้องจบที่ .jpg
  // ไม่ใช่ปล่อยให้กินไบต์ลายเซ็น PK ที่ตามมาติด ๆ จนนับชื่อเดียวกันได้สองแบบ
  const names = [...body.toString('latin1').matchAll(/(?:sheets|originals)\/[\w.-]+?\.jpg/g)]
    .map((match) => match[0]);
  const sheets = new Set(names.filter((name) => name.startsWith('sheets/')));
  const originals = new Set(names.filter((name) => name.startsWith('originals/')));

  assert.equal(sheets.size, 2, 'แผ่นครบทั้งสองรอบของอัลบั้มนี้');
  assert.equal(originals.size, 3, 'รูปดิบครบทุกใบ (1 + 2)');
  assert.ok(![...sheets, ...originals].some((name) => name.includes('CCC333')),
    'ไฟล์ของงานอื่นต้องไม่ติดไปใน ZIP ที่เจ้าภาพเก็บไว้ตลอดชีวิต');

  assert.equal((await fetch(`${app.baseUrl}/b/ZQZQZQZQ/zip`)).status, 404,
    'อัลบั้มที่ไม่มีรูปต้องไม่ให้ดาวน์โหลดไฟล์เปล่า');
});

test('the per-take page still works on its own, album or not', async () => {
  // โหมดอัลบั้มไม่ได้แทนที่หน้าเดิม — การ์ดในอัลบั้มลิงก์ไปหาหน้านี้ และ QR แบบเดิม
  // ที่พิมพ์ไปแล้วในงานก่อน ๆ ต้องใช้ได้ตลอดไป
  assert.equal((await fetch(`${app.baseUrl}/p/DDD444`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/p/AAA111/sheet`)).status, 200);
});
