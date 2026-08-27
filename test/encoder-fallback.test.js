import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { useTempDataDir } from './helpers/app.js';

/**
 * ตัวเข้ารหัสที่ตั้งไว้ใช้ไม่ได้ = ต้องถอย ไม่ใช่ล้ม
 *
 * เกิดขึ้นจริงบน NAS: `.env` สั่ง `h264_nvenc` ไว้ถาวร แต่คอนเทนเนอร์ถูกยกขึ้น
 * โดยไม่มี GPU ต่ออยู่ (ซึ่งเป็นเรื่องปกติหลังย้าย GPU ไปไฟล์ override) ffmpeg จึงล้ม
 * ด้วย "Cannot load libnvidia-encode.so.1" ทุกครั้งที่ต้องเข้ารหัส
 *
 * อาการที่เจ้าของเห็นคือ **เว็บปกติดีทุกอย่าง** แขกอัพรูปได้ ดูรูปได้ แต่คลิปที่ส่งมา
 * แปลงไม่ผ่านสักไฟล์ และไม่มีอะไรบอกจนกว่าจะมีคนเปิดวิดีโอบน Android แล้วเล่นไม่ได้
 * — ในงานที่มีแขกพันคนถ่ายวิดีโอ นี่คือความเสียหายที่ไม่มีวันกู้คืนได้
 *
 * ตั้งค่า **ก่อน** import config เพราะ config อ่าน env ตอนโหลดโมดูลครั้งเดียว
 */
useTempDataDir('encoder-fallback');
process.env.VIDEO_ENCODER = 'h264_nvenc';
process.env.VIDEO_ENCODER_ARGS = '-preset p4 -cq 24';
process.env.FILM_ENCODER_ARGS = '-preset p4 -cq 20';
process.env.VIDEO_DECODER_ARGS = '-hwaccel cuda';

const { config } = await import('../src/config.js');
const media = await import('../src/lib/media.js');
const { encoderSignature } = await import('../src/lib/film-encode.js');
const { makeMovHevc } = await import('./helpers/fixtures.js');

await media.ensureDirs();

test('the configured encoder is what .env says, so the test is testing something', () => {
  assert.equal(config.media.videoEncoder, 'h264_nvenc');
  assert.deepEqual(config.media.decoderArgs, ['-hwaccel', 'cuda']);
});

test('an encoder that cannot actually run is replaced by one that can', async () => {
  // เครื่องที่รันเทสต์ไม่มี GPU — nvenc จึงล้มจริง ไม่ได้จำลอง
  const encoder = await media.activeEncoder();

  assert.equal(encoder.videoEncoder, 'libx264', 'ไม่ได้ถอยไปตัวที่ใช้ได้');
  // -hwaccel cuda ล้มด้วยเหตุผลเดียวกัน ต้องถูกทิ้งไปพร้อมกัน ไม่ใช่ทิ้งแค่ฝั่งเข้ารหัส
  assert.deepEqual(encoder.decoderArgs, [], 'ยังถืออาร์กิวเมนต์ถอดรหัสของ GPU ไว้');
  assert.ok(encoder.encoderArgs.includes('-crf'), 'อาร์กิวเมนต์ต้องเป็นชุดของ CPU');
  assert.ok(!encoder.encoderArgs.includes('-cq'), '-cq เป็นของ nvenc เท่านั้น libx264 ไม่รู้จัก');
});

test('the answer is worked out once and remembered', async () => {
  // ตรวจด้วยการเข้ารหัสจริงหนึ่งเฟรม ถ้าทำใหม่ทุกครั้งที่แปลงคลิป งานคิวจะช้าลงเปล่า ๆ
  const first = await media.activeEncoder();
  const second = await media.activeEncoder();
  assert.equal(first, second, 'ตรวจซ้ำทุกครั้งแทนที่จะจำผลไว้');
});

test('the film signature names the encoder that will really be used', async () => {
  // ลายเซ็นนี้เป็นตัวตัดสินว่าคลิปเก่าใน export/parts/ ยังเอามาต่อกันได้ไหม
  // ถ้ามันบอกว่า nvenc ทั้งที่ของจริงเป็น libx264 คลิปสองชนิดจะถูกนับว่าชนิดเดียวกัน
  // แล้ว concat แบบ -c copy จะได้หนังที่ภาพค้างกลางเรื่องโดยไม่มี error สักบรรทัด
  const signature = await encoderSignature();
  assert.match(signature, /^libx264 /);
  assert.ok(!signature.includes('nvenc'));
  assert.ok(!signature.includes('cuda'));
});

test('a real iPhone clip still converts, which is the whole point', async () => {
  // ข้อตัดสินของไฟล์นี้ — ไม่ใช่ว่า activeEncoder() คืนค่าถูก แต่คือคลิปจริงที่แขก
  // ส่งมาแปลงผ่านจริงทั้งที่ .env สั่งตัวเข้ารหัสที่ใช้ไม่ได้ไว้
  const source = path.join(config.paths.uploads, 'guest-clip.mov');
  await makeMovHevc(source, { seconds: 1, ffmpeg: media.FFMPEG });

  const playbackName = await media.transcodeVideo('guest-clip.mov');
  const output = path.join(config.paths.derived, playbackName);

  const probed = await media.probeVideo(output);
  assert.equal(probed.codec, 'h264', 'ไฟล์ที่ได้ต้องเป็น H.264 ที่ Android เปิดได้');
  assert.ok((await fs.stat(output)).size > 1024, 'ได้ไฟล์เปล่า');
});
