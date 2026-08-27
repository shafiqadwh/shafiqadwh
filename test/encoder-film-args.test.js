import assert from 'node:assert/strict';
import test from 'node:test';
import { useTempDataDir } from './helpers/app.js';

/**
 * อาร์กิวเมนต์ของ "หนัง" ต้องถูกตรวจด้วย ไม่ใช่ตรวจแต่ของคิวแปลงวิดีโอ
 *
 * ระบบมีอาร์กิวเมนต์สองชุดที่ใช้คนละที่ — `VIDEO_ENCODER_ARGS` สำหรับคิวแปลงคลิป
 * ที่แขกส่งมา และ `FILM_ENCODER_ARGS` สำหรับหนังงานแต่ง (คุณภาพสูงกว่า)
 *
 * ตอนแรกตัวตรวจดูแค่ชุดแรก ซึ่งเป็นช่องโหว่จริง: เอกสารเองเตือนไว้ว่า "เปลี่ยน
 * ตัวเข้ารหัสต้องเปลี่ยนอาร์กิวเมนต์คู่กันเสมอ" เพราะ libx264 ใช้ `-crf` ส่วน nvenc
 * ใช้ `-cq` — สลับกลับไป libx264 แต่ลืมล้าง `-cq` ที่ค้างอยู่ใน FILM_ENCODER_ARGS
 * จะผ่านการตรวจไปเฉย ๆ แล้วหนังจะล้มทุกคลิปด้วย "Unrecognized option 'cq'"
 * ซึ่งคือความล้มเหลวแบบเดียวกับที่เพิ่งเจอบน NAS จริง แค่คนละหน้ากาก
 *
 * ตั้งค่า **ก่อน** import config เพราะ config อ่าน env ตอนโหลดโมดูลครั้งเดียว
 */
useTempDataDir('encoder-film-args');
process.env.VIDEO_ENCODER = 'libx264';
process.env.VIDEO_ENCODER_ARGS = '-preset veryfast -crf 24 -profile:v high';
// ตัวร้ายอยู่บรรทัดนี้บรรทัดเดียว — ชุดของคิวแปลงวิดีโอข้างบนถูกต้องสมบูรณ์
process.env.FILM_ENCODER_ARGS = '-preset p4 -cq 20';
process.env.VIDEO_DECODER_ARGS = '';

const media = await import('../src/lib/media.js');
const { encoderSignature } = await import('../src/lib/film-encode.js');

test('film arguments that the encoder cannot understand are caught, not waved through', async () => {
  const encoder = await media.activeEncoder();

  // -cq เป็นของ nvenc เท่านั้น libx264 ตอบว่า "Unrecognized option 'cq'" แล้วล้มทันที
  assert.ok(!encoder.filmEncoderArgs.includes('-cq'),
    'อาร์กิวเมนต์ของหนังที่ใช้ไม่ได้หลุดผ่านการตรวจมา — หนังจะล้มทุกคลิป');
  assert.ok(encoder.filmEncoderArgs.includes('-crf'), 'ต้องถอยไปชุดของ libx264 ที่ใช้ได้จริง');
});

test('falling back swaps the whole set, never a half-CPU half-GPU mixture', async () => {
  const encoder = await media.activeEncoder();

  // ตัวเข้ารหัสกับอาร์กิวเมนต์ต้องมาจากชุดเดียวกันเสมอ ผสมกันเมื่อไรก็ล้มเมื่อนั้น
  assert.equal(encoder.videoEncoder, 'libx264');
  assert.ok(!encoder.encoderArgs.includes('-cq'));
  assert.deepEqual(encoder.decoderArgs, []);

  const signature = await encoderSignature();
  assert.ok(!signature.includes('-cq'), `ลายเซ็นยังมีอาร์กิวเมนต์ที่ใช้ไม่ได้: ${signature}`);
});
