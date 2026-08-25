import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { useTempDataDir, startTestServer, login } from './helpers/app.js';

/**
 * เพลงคลอในหน้าแกลลอรี่
 *
 * **ปุ่มเปิด/ปิดถูกถอดออกจากหน้าแขกไปก่อนแล้ว** (บ่นว่าดูเกะกะ วางอยู่ระหว่าง
 * ข้อความต้อนรับกับปุ่มอัพโหลดพอดี) — แต่ backend ทั้งชุดยังอยู่ครบตั้งใจ:
 * ตัวเลือกเพลงในหน้าแอดมิน, การตั้งค่า `gallery_music` ใน DB, และเส้นทาง
 * `GET /music/track` ยังทำงานเหมือนเดิมทุกอย่าง เอาปุ่มกลับมาทีหลังได้ด้วยการ
 * revert คอมมิตเดียว โดยไม่ต้องเลือกเพลงใหม่หรือแตะ backend เลย
 *
 * กติกาของฟีเจอร์ backend ที่เทสต์ชุดนี้ยังเฝ้าอยู่:
 *
 * 1. **หน้าแขกไม่มีปุ่ม/เครื่องเล่นเลยไม่ว่าจะตั้งเพลงไว้หรือไม่** (ของใหม่)
 * 2. **ชื่อไฟล์ไม่เคยมาจาก URL** เส้นทางเพลงเป็นเส้นเดียวตายตัว ค่าที่ชี้ไฟล์มาจาก
 *    ค่าที่เจ้าภาพบันทึกไว้ แล้วยังต้องผ่าน trackPath() อีกชั้น
 * 3. **ไฟล์หาย = เส้นทางตาย** `/music/track` ต้องตอบ 404 ไม่ใช่ส่งไฟล์ที่ไม่มีอยู่จริง
 */

const dataDir = useTempDataDir('galmusic');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

const { setSetting, getSetting } = await import('../src/db.js');
const { FFMPEG } = await import('../src/lib/media.js');
const { galleryMusic } = await import('../src/routes/gallery.js');

after(() => app.close());

const LIBRARY = path.join(dataDir, 'music', 'library', 'wedding');

/**
 * ไฟล์เสียงจริงสั้น ๆ — คลังกรองไฟล์ที่ ffprobe อ่านความยาวไม่ได้ทิ้ง
 * ใช้ FFMPEG ตัวเดียวกับที่แอปใช้ (ffmpeg-static) ไม่ใช่ `ffmpeg` ใน PATH
 * ซึ่งบนอิมเมจนี้ไม่มี
 */
async function makeTrack(name, { hz = 440, seconds = 1 } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  await fs.mkdir(LIBRARY, { recursive: true });
  const file = path.join(LIBRARY, name);
  await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi',
    '-i', `sine=frequency=${hz}:duration=${seconds}`, '-c:a', 'aac', '-b:a', '64k', file]);
  return file;
}

const galleryHtml = async () => (await fetch(`${app.baseUrl}/`)).text();

test('with no track chosen the page has no player and the route is a dead end', async () => {
  assert.equal(getSetting('gallery_music', ''), '', 'ค่าเริ่มต้นต้องเป็นปิด');

  const html = await galleryHtml();
  assert.ok(!html.includes('music-player'), 'ไม่ได้เลือกเพลงแต่มีเครื่องเล่นอยู่ในหน้า');

  const response = await fetch(`${app.baseUrl}/music/track`);
  assert.equal(response.status, 404);
});

test('the gallery page never shows the music button, even with a track picked', async () => {
  // นี่คือของใหม่ทั้งหมด — เดิมเทสต์นี้เช็คว่า "ต้องมี" ปุ่ม ตอนนี้กลับด้าน
  await makeTrack('Nocturne.m4a');
  setSetting('gallery_music', 'wedding/Nocturne.m4a');

  const html = await galleryHtml();
  assert.ok(!html.includes('music-toggle'), 'ปุ่มเปิด/ปิดเพลงถูกถอดไปแล้ว แต่ยังโผล่ในหน้า');
  assert.ok(!html.includes('music-player'), 'เครื่องเล่นถูกถอดไปแล้ว แต่ยังโผล่ในหน้า');
});

test('the chosen track is still served whole through the route, even with no button pointing at it', async () => {
  const file = await makeTrack('Nocturne.m4a');
  setSetting('gallery_music', 'wedding/Nocturne.m4a');

  const response = await fetch(`${app.baseUrl}/music/track`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /audio/);

  const served = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(served, await fs.readFile(file), 'ไบต์ที่ส่งออกไปไม่ตรงกับไฟล์บนดิสก์');
});

test('the player can jump into the middle of a track', async () => {
  // มือถือที่หลุดแล้วต่อใหม่ขอเป็นช่วง ไม่ได้ขอทั้งไฟล์ซ้ำ — ไม่รองรับ Range
  // แปลว่าโหลดใหม่ทั้งเพลงทุกครั้งที่สะดุด
  const response = await fetch(`${app.baseUrl}/music/track`, { headers: { range: 'bytes=0-99' } });
  assert.equal(response.status, 206);
  assert.match(response.headers.get('content-range') ?? '', /^bytes 0-99\//);
  assert.equal((await response.arrayBuffer()).byteLength, 100);
});

test('changing the track changes its version, so a cached browser would not reuse the old one', async () => {
  // เดิมเทสต์นี้อ่านที่อยู่จาก <audio src> ในหน้า HTML — ตอนนี้ไม่มี element
  // ให้อ่านแล้ว จึงเรียก galleryMusic() ตรง ๆ (ตัวเดียวกับที่ route ใช้จริง)
  await makeTrack('Nocturne.m4a');
  setSetting('gallery_music', 'wedding/Nocturne.m4a');
  const first = (await galleryMusic()).version;

  // เพลงคนละเพลงย่อมคนละขนาด — เวอร์ชันจึงต่างกัน มือถือที่เคยเปิดจะไม่เล่นของเก่าจากแคช
  await makeTrack('Waltz.m4a', { hz: 660, seconds: 2 });
  setSetting('gallery_music', 'wedding/Waltz.m4a');
  const second = (await galleryMusic()).version;

  assert.notEqual(first, second);
});

test('a track that was deleted from disk becomes a dead route', async () => {
  await makeTrack('Waltz.m4a', { hz: 660, seconds: 2 });
  setSetting('gallery_music', 'wedding/Waltz.m4a');
  await fs.rm(path.join(LIBRARY, 'Waltz.m4a'));
  await fs.rm(path.join(LIBRARY, 'Waltz.m4a.json'), { force: true });

  assert.equal(await galleryMusic(), null, 'ไฟล์หายแล้วแต่ galleryMusic() ยังคืนค่าเดิม');
  assert.equal((await fetch(`${app.baseUrl}/music/track`)).status, 404);
});

test('only the host can change the track, and only to a real one', async () => {
  setSetting('gallery_music', 'wedding/Nocturne.m4a');

  const stranger = await fetch(`${app.baseUrl}/admin/music/gallery`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'track=wedding/Nocturne.m4a',
    redirect: 'manual',
  });
  assert.ok(stranger.status === 401 || stranger.status === 302);

  const save = (track) => fetch(`${app.baseUrl}/admin/music/gallery`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ track }),
    redirect: 'manual',
  });

  // ค่าที่มาจากฟอร์มในเบราว์เซอร์แก้ได้ตามใจ — เส้นทางที่เดินออกนอกคลังต้องกลายเป็น "ปิด"
  // ไม่ใช่ถูกเก็บไว้แล้วไปงัดไฟล์ตอนมีคนเปิดหน้าเว็บ
  for (const nasty of ['../../db/wedding.db', 'wedding/../../db/wedding.db', '/etc/passwd', 'wedding/Nope.m4a.txt']) {
    await save(nasty);
    assert.equal(getSetting('gallery_music', ''), '', `รับค่าที่ไม่ควรรับ: ${nasty}`);
  }

  await save('wedding/Nocturne.m4a');
  assert.equal(getSetting('gallery_music', ''), 'wedding/Nocturne.m4a');

  await save('');
  assert.equal(getSetting('gallery_music', ''), '', 'ปิดเพลงไม่ได้');
});

test('the picker in the admin panel lists what is actually in the library', async () => {
  setSetting('gallery_music', 'wedding/Nocturne.m4a');
  const html = await (await fetch(`${app.baseUrl}/admin`, { headers: { cookie } })).text();

  assert.match(html, /action="\/admin\/music\/gallery"/);
  assert.match(html, /value="wedding\/Nocturne\.m4a" selected/);
  // ต้องมีทางปิดเสมอ ไม่ใช่เลือกเพลงแล้วเอาออกไม่ได้อีกเลย
  assert.match(html, /<option value=""/);
});
