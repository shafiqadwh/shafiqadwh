import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';
import { makeGif } from '../photobooth/src/core/animation.js';

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

const { db } = await import('../src/db.js');
const { getBoothSession } = await import('../src/repo.js');

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

/*
 * เฟรมของ GIF ต้องเป็นคนละภาพจริง ๆ
 *
 * ตัวเข้ารหัส GIF ยุบเฟรมที่เหมือนกันเป๊ะให้เหลือเฟรมเดียว (วัดแล้ว: สามเฟรมสีเดียวกัน
 * ได้ไฟล์ 721 ไบต์ เฟรมเดียว) · fixture ที่คืนภาพสีเดียวกันทุกใบจึงทำให้เทสต์
 * "ผ่าน" หรือ "ล้ม" ด้วยเหตุผลที่ไม่เกี่ยวกับโค้ดเลย — ของจริงคนขยับตัวทุกเฟรม
 */
const poses = () => Promise.all(['#c8a27a', '#7aa2c8', '#8ac87a'].map(async (colour) => {
  counter += 1;
  return fs.readFile(await makeJpeg(
    path.join(dataDir, `pose-${counter}.jpg`), { width: 600, height: 400, colour }));
}));

async function send({ token, album, shots = 1, gif = false }) {
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
  if (gif) {
    // สร้างด้วยตัวสร้างจริงของบูธ ไม่ใช่ไฟล์ปลอม — รอยต่อระหว่างสองโปรแกรมคือ
    // จุดที่พัง และเทสต์ที่ป้อนไฟล์ปลอมเข้าไปจะไม่มีวันจับได้
    const animation = await makeGif(await poses(), { effect: 'clean' });
    form.append('gif', new Blob([animation]), 'strip.gif');
  }
  const response = await fetch(`${app.baseUrl}/api/booth/upload`, {
    method: 'POST', headers: { 'x-booth-key': KEY }, body: form,
  });
  assert.equal(response.status, 201, `อัปโหลด ${token} ไม่สำเร็จ`);
}

// สามรอบ: สองรอบในอัลบั้มเดียวกัน · หนึ่งรอบอัลบั้มอื่น · หนึ่งรอบไม่สังกัดอัลบั้ม
await send({ token: 'AAA111', album: ALBUM });
await send({ token: 'BBB222', album: ALBUM, shots: 3, gif: true });
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
  assert.equal(originals.size, 4, 'รูปดิบครบทุกใบ (1 + 3)');
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


test('the animation the booth made survives the trip and still plays', async () => {
  const response = await fetch(`${app.baseUrl}/p/BBB222/gif`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/gif');

  // ตัวตัดสินคือไฟล์ที่ปลายทางยัง **เล่นได้** ไม่ใช่แค่มีไบต์ตรงกัน
  const meta = await sharp(Buffer.from(await response.arrayBuffer()), { animated: true }).metadata();
  assert.equal(meta.pages, 4, 'ต้องยังเป็นภาพเคลื่อนไหวสี่เฟรม ไม่ใช่ภาพนิ่ง');
  assert.ok(meta.delay.every((one) => one > 0), 'ทุกเฟรมต้องยังมีจังหวะของตัวเอง');

  // รอบที่ไม่มี GIF (ถ่ายใบเดียว) ต้องไม่หลอกว่ามี
  assert.equal((await fetch(`${app.baseUrl}/p/AAA111/gif`)).status, 404);
});

test('one tap gives the guest every photo and the animation together', async () => {
  /*
   * ต้องเป็นไฟล์เดียว ไม่ใช่สั่งโหลดทีละไฟล์ติด ๆ กัน — เบราว์เซอร์บนมือถือบล็อก
   * การดาวน์โหลดหลายไฟล์ซ้อน แขกจะได้ไฟล์แรกไฟล์เดียวแล้วเดินจากไปโดยคิดว่าครบแล้ว
   */
  const zip = await fetch(`${app.baseUrl}/p/BBB222/zip`);
  assert.equal(zip.status, 200);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
  assert.match(zip.headers.get('content-disposition'), /photobooth-BBB222\.zip/);

  const body = Buffer.from(await zip.arrayBuffer());
  const names = new Set([...body.toString('latin1').matchAll(/photobooth-BBB222[\w-]*\.(?:jpg|gif)/g)]
    .map((match) => match[0]));

  assert.ok(names.has('photobooth-BBB222-sheet.jpg'), 'ต้องมีแผ่นที่พิมพ์');
  assert.ok(names.has('photobooth-BBB222.gif'), 'ต้องมีภาพเคลื่อนไหว');
  assert.equal([...names].filter((name) => /-\d\.jpg$/.test(name)).length, 3,
    'ต้องมีรูปดิบครบทั้งสามใบ ไม่ใช่แค่ใบแรก');

  // รอบที่หมดอายุหรือไม่มีจริง ต้องไม่ให้ดาวน์โหลดไฟล์เปล่า
  assert.equal((await fetch(`${app.baseUrl}/p/ZZ9999/zip`)).status, 404);
});


test('the album grid asks for thumbnails, not full sheets', async () => {
  /*
   * วัดของจริงก่อนแก้: อัลบั้ม 30 รอบที่ใช้แผ่นเต็มกินเน็ตมือถือ 17.7 MB
   * หลังใช้รูปย่อเหลือ 0.2 MB · แขกยืนอยู่ในงานใช้ 4G และแบนด์วิดท์ขาออกของบ้าน
   * เจ้าภาพต้องแบ่งให้การอัปโหลดด้วย
   */
  const html = await (await fetch(`${app.baseUrl}/b/${ALBUM}`)).text();
  assert.ok(html.includes('/p/AAA111/thumb'), 'กริดต้องขอรูปย่อ');
  assert.ok(!html.includes('/p/AAA111/sheet'), 'กริดต้องไม่ขอแผ่นเต็ม');

  const thumb = await fetch(`${app.baseUrl}/p/AAA111/thumb`);
  assert.equal(thumb.status, 200);
  const bytes = Number(thumb.headers.get('content-length'));
  const full = Number((await fetch(`${app.baseUrl}/p/AAA111/sheet`)).headers.get('content-length'));
  assert.ok(bytes * 4 < full, `รูปย่อ ${bytes} ไบต์ ไม่เล็กกว่าแผ่นเต็ม ${full} พอ`);

  const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata();
  assert.equal(meta.width, 320);
  assert.equal(meta.format, 'jpeg');
});

test('a take that lost its thumbnail still shows up, using the full sheet', async () => {
  // ย่อรูปไม่สำเร็จเป็นเรื่องที่เกิดได้ (ดิสก์เต็ม) · กริดต้องช้าลง ไม่ใช่มีรูปหาย
  db.prepare('UPDATE booth_sessions SET thumb_name = NULL WHERE token = ?').run('AAA111');
  const response = await fetch(`${app.baseUrl}/p/AAA111/thumb`);
  assert.equal(response.status, 200, 'ไม่มีรูปย่อต้องตกไปใช้แผ่นเต็ม ไม่ใช่รูปแตก');
  assert.equal(response.headers.get('content-type'), 'image/jpeg');
});

test('the thumbnail never sneaks into anyone download', async () => {
  // รูปย่อเป็นของหน้าเว็บ ไม่ใช่ของแขก · ติดไปใน ZIP แล้วแขกงงว่าไฟล์ไหนคือของจริง
  const body = Buffer.from(await (await fetch(`${app.baseUrl}/p/BBB222/zip`)).arrayBuffer());
  assert.ok(!body.toString('latin1').includes('thumb'), 'ZIP ของรอบต้องไม่มีรูปย่อ');

  const album = Buffer.from(await (await fetch(`${app.baseUrl}/b/${ALBUM}/zip`)).arrayBuffer());
  assert.ok(!album.toString('latin1').includes('-thumb.jpg'), 'ZIP ของทั้งงานก็ต้องไม่มี');
});

test('storage stats count the animation, not just the sheet', async () => {
  // ไฟล์แถมที่ไม่ถูกนับ = ตัวเลขพื้นที่ใช้ไปในหน้าแอดมินต่ำกว่าความจริงเรื่อย ๆ
  // จนเจ้าภาพเชื่อว่ายังมีที่เหลือ ทั้งที่ดิสก์ใกล้เต็ม
  const row = getBoothSession('BBB222');
  const sheet = Number((await fetch(`${app.baseUrl}/p/BBB222/sheet`)).headers.get('content-length'));
  const gif = Number((await fetch(`${app.baseUrl}/p/BBB222/gif`)).headers.get('content-length'));
  assert.equal(row.bytes, sheet + gif, 'ไบต์ที่บันทึกต้องรวม GIF ด้วย');
});
