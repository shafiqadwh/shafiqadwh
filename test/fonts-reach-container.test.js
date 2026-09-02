import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

/**
 * ฟอนต์ต้องเดินทางไปถึงคอนเทนเนอร์ที่เรนเดอร์จริง
 *
 * `sharp` ส่ง `fontfile` ที่ไม่มีอยู่จริงให้ Pango แล้ว Pango **ไม่ error** —
 * มันตกไปใช้ฟอนต์ระบบตัวใดก็ได้ ซึ่งบนอิมเมจ node:slim ไม่มีอักษรไทยเลย
 * ข้อความไทยทั้งหมดจึงกลายเป็น □□□ โดยไม่มีอะไรเตือน
 *
 * เกิดขึ้นจริง: `assets/` ไม่ได้ถูกใส่ทั้งใน Dockerfile และ docker-compose.yml
 * หนังที่สร้างจากหน้าแอดมินจึงมีชื่อร้านเป็นกล่องสี่เหลี่ยม ส่วน PDF สมุดคำอวยพร
 * (ซึ่งใช้ตัวเรนเดอร์เดียวกัน) ก็จะเป็นกล่องทั้งเล่ม — เป็นของที่พิมพ์เก็บไว้ตลอด
 *
 * `scripts/export-film.sh` ไม่เป็นเพราะมัน mount assets เอง ซึ่งเป็นเหตุผลที่
 * บั๊กนี้รอดสายตามาได้นาน
 */

const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('the fonts the renderer points at actually exist in the repo', async () => {
  const { fontFor } = await import('../src/lib/film.js');
  for (const text of ['ภาษาไทย', 'العربية', 'Latin']) {
    const face = fontFor(text);
    for (const file of [face.regular, face.bold]) {
      await fs.access(file); // โยน error ถ้าไม่มี — นั่นคือสิ่งที่ต้องจับ
    }
  }
});

test('a missing font is refused outright instead of quietly drawing boxes', async () => {
  // ตัวเรนเดอร์ตัวหนังสือย้ายไปอยู่ที่ shared/text.js แล้ว (ใช้ร่วมกับ photo booth)
  // — ที่นั่นคือที่เดียวที่ยังต้องมีด่านตรวจฟอนต์ ไม่ใช่สองที่
  const source = await read('shared/text.js');
  // Pango ไม่บ่นเรื่องฟอนต์หาย จึงต้องเช็คเองก่อนเรนเดอร์
  assert.match(source, /existsSync/, 'ต้องตรวจว่าไฟล์ฟอนต์มีอยู่จริงก่อนใช้');
  assert.match(source, /กล่องสี่เหลี่ยม/, 'ข้อความ error ต้องบอกอาการที่คนเห็นจริง');
});

test('assets travels into the image and into the running container', async () => {
  // ต้องมีทั้งสองที่: COPY ไว้ให้อิมเมจครบในตัวเอง และ mount ไว้ให้แก้ฟอนต์
  // แล้วมีผลโดยไม่ต้อง rebuild (เหมือน src/views/public/locales ที่ทำแบบเดียวกัน)
  assert.match(await read('Dockerfile'), /^COPY assets \.\/assets$/m,
    'Dockerfile ไม่ได้คัดลอก assets เข้าอิมเมจ');
  assert.match(await read('docker-compose.yml'), /^\s*- \.\/assets:\/app\/assets:ro$/m,
    'docker-compose.yml ไม่ได้ mount assets ให้คอนเทนเนอร์ที่แขกใช้');
});
