import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

const dataDir = useTempDataDir('hardening');

let app;
let photoBytes;

before(async () => {
  app = await startTestServer();
  photoBytes = await fs.readFile(await makeJpeg(path.join(dataDir, 'ok.jpg')));
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function upload(bytes, name = 'x.jpg') {
  const form = new FormData();
  form.append('files', new Blob([bytes], { type: 'image/jpeg' }), name);
  return fetch(`${app.baseUrl}/api/upload`, { method: 'POST', body: form });
}

const filesIn = async (sub) => (await fs.readdir(path.join(dataDir, sub))).length;

test('a corrupt upload leaves no orphan file behind', async () => {
  // บั๊กจริง: processImage ย้ายไฟล์เข้า uploads/ ก่อนแล้วค่อยประมวลผล พอ sharp
  // ล้ม (ไฟล์หัวถูกเนื้อพัง) ตัว catch ลบได้แต่ tmp ซึ่งย้ายไปแล้ว ไฟล์ที่ย้าย
  // จึงค้างเป็นไฟล์กำพร้า มองไม่เห็นจากที่ไหนเลย และโตขึ้นทุกครั้งที่มีไฟล์เสีย
  const before = await filesIn('uploads');

  const corrupt = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 0x41)]);
  const response = await upload(corrupt, 'broken.jpg');
  const body = await response.json();
  assert.equal(body.created, 0, 'the corrupt file must be refused');

  // การเก็บกวาดเกิดหลังตอบ ไม่ต้องรอ — แต่กันจังหวะไว้นิดเดียวพอ
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await filesIn('uploads'), before,
    'uploads/ must hold exactly the files the database knows about');
});

test('a forged JPEG claiming absurd dimensions is refused and cleaned up', async () => {
  // แก้ไบต์ขนาดใน SOF marker ให้อ้าง 30,000×30,000 — เกินลิมิตพิกเซลของ sharp
  // เส้นทางล้มเหลวคนละจุดกับไฟล์เนื้อพัง แต่ต้องจบแบบเดียวกัน: ปฏิเสธ + ไม่ทิ้งขยะ
  const before = await filesIn('uploads');

  const forged = Buffer.from(photoBytes);
  for (let i = 0; i < forged.length - 8; i += 1) {
    if (forged[i] === 0xff && (forged[i + 1] === 0xc0 || forged[i + 1] === 0xc2)) {
      forged.writeUInt16BE(30000, i + 5);
      forged.writeUInt16BE(30000, i + 7);
      break;
    }
  }

  const body = await (await upload(forged, 'forged.jpg')).json();
  assert.equal(body.created, 0);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(await filesIn('uploads'), before);
});

test('the slideshow poll window keeps up with a thousand-guest burst', async () => {
  // จอ poll ทุก 15 วินาที ช่วงพีคหลังพิธีแขกพันคนอัพเกิน 60 รูปในรอบเดียวได้จริง
  // เดิมหน้าต่าง poll กว้างแค่ 60 แถว รูปที่เกินมาไม่ขึ้นจอเลยตลอดงาน
  const first = await (await fetch(`${app.baseUrl}/api/slideshow`)).json();
  const since = first.maxId;

  const { db } = await import('../src/db.js');
  const insert = db.prepare(`INSERT INTO items
    (kind, original_name, stored_name, thumb_name, mime, bytes, status)
    VALUES ('image', 'burst.jpg', @stored, 'burst-thumb.jpg', 'image/jpeg', 1000, 'visible')`);
  for (let i = 0; i < 70; i += 1) insert.run({ stored: `burst-${since}-${i}.jpg` });

  const poll = await (await fetch(`${app.baseUrl}/api/slideshow?since=${since}`)).json();
  assert.ok(poll.items.length >= 70,
    `every photo from the burst must reach the screen, got ${poll.items.length}/70`);
});

test('ten simultaneous first requests for a display copy all succeed', async () => {
  // จอสไลด์โชว์กับมือถือแขกขอรูปเดียวกันวินาทีเดียวกันได้ เดิมใช้ไฟล์ .part
  // ชื่อเดียวกัน คนแรก rename สำเร็จแล้วไฟล์หาย คนถัดไปเจอ ENOENT ทั้งที่งานดี
  const big = await makeJpeg(path.join(dataDir, 'big.jpg'), { width: 3000, height: 2200 });
  const { ids } = await (await upload(await fs.readFile(big), 'big.jpg')).json();

  const responses = await Promise.all(
    Array.from({ length: 10 }, () => fetch(`${app.baseUrl}/display/${ids[0]}`)),
  );
  const codes = responses.map((r) => r.status);
  assert.ok(codes.every((c) => c === 200), `all must be 200, got ${codes.join(',')}`);
});
