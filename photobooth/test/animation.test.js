import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { bounceOrder, makeGif } from '../src/core/animation.js';

/**
 * ภาพเคลื่อนไหวจากรูปชุดเดียวกับที่พิมพ์
 *
 * เป็นของที่แขกได้กลับไปใช้จริงมากที่สุด — แผ่นอยู่ในกระเป๋า แต่ GIF ถูกส่งต่อ
 * ในไลน์กลุ่มครอบครัวคืนนั้นเลย · จึงต้อง **เล่นจริง** ไม่ใช่แค่เป็นไฟล์ที่เปิดได้
 * เทสต์ชุดนี้อ่านไฟล์ที่ได้กลับมาเป็นเฟรม ๆ ไม่ใช่ดูแค่ว่ามีไบต์ออกมา
 */

const swatch = (r, g, b) => sharp({
  create: { width: 640, height: 480, channels: 3, background: { r, g, b } },
}).jpeg().toBuffer();

const photos = async () => Promise.all([
  swatch(210, 60, 60), swatch(60, 210, 60), swatch(60, 60, 210),
]);

test('three shots become an animation that really has three frames', async () => {
  const gif = await makeGif(await photos(), { effect: 'clean' });
  const meta = await sharp(gif, { animated: true }).metadata();

  assert.equal(meta.format, 'gif');
  assert.equal(meta.pages, 4, 'สามรูปแบบไป-กลับ = 4 เฟรม');
  assert.equal(meta.width, 540);
  assert.equal(meta.loop, 0, 'ต้องวนไม่รู้จบ ไม่ใช่เล่นรอบเดียวแล้วค้าง');
});

test('every frame gets its own delay, not just the first one', async () => {
  // libvips ใส่ค่าให้เฟรมแรกเฟรมเดียวถ้าส่ง delay เป็นเลขตัวเดียว (วัดแล้วได้
  // [400, 0, 0]) แล้วเฟรมที่เหลือจะกระพริบผ่านไปเร็วจนดูไม่ทัน
  const gif = await makeGif(await photos(), { effect: 'clean', delayMs: 380 });
  const { delay } = await sharp(gif, { animated: true }).metadata();

  assert.equal(delay.length, 4);
  assert.deepEqual(delay, [380, 380, 380, 380], `เฟรมกระพริบ: ${delay.join(',')}`);
});

test('the frames are the guest three poses, in bounce order', async () => {
  const gif = await makeGif(await photos(), { effect: 'clean' });

  // อ่านสีเด่นของแต่ละเฟรมกลับมา — พิสูจน์ว่าเรียงถูกและไม่ใช่รูปเดียวซ้ำสี่รอบ
  const dominant = [];
  for (let page = 0; page < 4; page += 1) {
    const { channels } = await sharp(gif, { page }).stats();
    // GIF มีช่องอัลฟาติดมาด้วย ซึ่งค่าเต็ม 255 เสมอ — ดูแค่ RGB ไม่งั้นได้ช่องอัลฟา
    // เป็นช่องที่สว่างที่สุดของทุกเฟรม แล้วเทียบอะไรไม่ได้เลย
    dominant.push(channels.slice(0, 3).map((one) => Math.round(one.mean)));
  }

  const brightest = (rgb) => rgb.indexOf(Math.max(...rgb));
  assert.deepEqual(dominant.map(brightest), [0, 1, 2, 1],
    'ต้องเป็น แดง → เขียว → น้ำเงิน → เขียว (ไป-กลับ)');
});

test('the effect the guest picked is on the animation too', async () => {
  // แผ่นโทนขาวดำแต่ GIF สีสด = ของสองชิ้นที่ดูเหมือนมาจากคนละงาน
  const mono = await makeGif(await photos(), { effect: 'mono' });
  const { channels } = await sharp(mono, { page: 0 }).stats();
  const [r, g, b] = channels.slice(0, 3).map((one) => one.mean);

  assert.ok(Math.abs(r - g) < 12 && Math.abs(g - b) < 12,
    `เอฟเฟคขาวดำไม่ถูกใส่ลง GIF: ได้ ${[r, g, b].map(Math.round).join(',')}`);
});

test('one shot means no animation, and that is not an error', async () => {
  // แบบเต็มใบถ่ายใบเดียว — ไม่มีอะไรให้เคลื่อนไหว · ต้องคืน null ไม่ใช่โยน error
  // เพราะการถ่ายทั้งรอบต้องไม่ล้มเพราะของแถมชิ้นนี้
  assert.equal(await makeGif([await swatch(200, 200, 200)]), null);
  assert.equal(await makeGif([]), null);
  assert.equal(await makeGif(null), null);
});

test('the file stays small enough to send in a chat app', async () => {
  const gif = await makeGif(await photos(), { effect: 'film' });
  // ส่งในไลน์/วอทส์แอปได้โดยไม่โดนบีบจนพัง · GIF เก็บทุกเฟรมเต็มใบ ไฟล์จึงโต
  // เร็วมากตามความกว้าง — ถ้าเกินนี้แปลว่ามีคนขยับ GIF_WIDTH ขึ้นโดยไม่ได้วัดผล
  assert.ok(gif.length < 4 * 1024 * 1024, `GIF ใหญ่เกินไป: ${Math.round(gif.length / 1024)} KB`);
});

test('the bounce never repeats a frame back to back', () => {
  // 1→2→3→2 แล้ววนกลับไป 1 · เฟรมซ้ำติดกันคือภาพที่ดูเหมือนค้างไปหนึ่งจังหวะ
  for (const count of [2, 3, 4, 5]) {
    const order = bounceOrder(count);
    assert.equal(new Set(order).size, count, 'ต้องใช้ทุกรูปที่ถ่ายมา');
    for (let i = 1; i < order.length; i += 1) {
      assert.notEqual(order[i], order[i - 1], `เฟรมซ้ำติดกันที่ ${count} รูป`);
    }
    assert.notEqual(order.at(-1), order[0], 'รอยต่อตอนวนซ้ำก็ต้องไม่ซ้ำ');
  }
});
