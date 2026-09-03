import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import {
  ensureAlbumCode, isAlbumCode, loadSettings, newAlbumCode, normaliseSettings,
  photoUrl, saveSettings, sheetQrUrl,
} from '../src/main/settings.js';
import { reserveSession, saveSession } from '../src/main/session.js';

/**
 * สองแบบของ QR ที่เจ้าของงานต้องเลือกก่อนตั้งบูธ
 *
 * session = แขกเห็นเฉพาะรอบของตัวเอง · album = เห็นรูปทั้งงานและโหลดทั้งหมดได้
 *
 * เรื่องที่พลาดแล้วตามแก้ไม่ได้คือ **รหัสอัลบั้มเปลี่ยนกลางงาน** — แผ่นที่พิมพ์ไป
 * แล้วอยู่ในมือแขกที่กลับบ้านไปแล้ว เราตามไปแก้ QR บนกระดาษไม่ได้
 */

let dir;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-album-'));
});

after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

test('the two modes are the only two, and a typo falls back to the private one', () => {
  assert.equal(normaliseSettings({}).qrTarget, 'session', 'ค่าเริ่มต้นต้องเป็นแบบเห็นเฉพาะของตัวเอง');
  assert.equal(normaliseSettings({ qrTarget: 'album' }).qrTarget, 'album');
  // พิมพ์ผิดต้องตกไปทางที่เปิดเผยน้อยกว่าเสมอ ไม่ใช่ทางที่เปิดรูปทั้งงานให้คนแปลกหน้า
  assert.equal(normaliseSettings({ qrTarget: 'ทั้งงาน' }).qrTarget, 'session');
});

test('an album code is eight characters a guest can read off paper', () => {
  const code = newAlbumCode();
  assert.equal(code.length, 8);
  assert.ok(isAlbumCode(code));
  // ตัดตัวที่คนอ่านสลับกัน (I L O U) เหมือนโทเคนรอบถ่าย เพราะแขกอาจพิมพ์เอง
  assert.ok(!/[ILOU]/.test(code), `รหัส ${code} มีตัวที่อ่านสลับกันได้`);

  assert.equal(isAlbumCode('AB12CD3'), false, 'สั้นไป');
  assert.equal(isAlbumCode('AB12CD34X'), false, 'ยาวไป');
  assert.equal(isAlbumCode('AB12CD3I'), false, 'มีตัวที่ไม่อยู่ในชุด');
  assert.equal(normaliseSettings({ albumCode: 'อัลบั้ม!' }).albumCode, '');
});

test('the QR carries the album and the guest own code together', () => {
  const album = normaliseSettings({
    qrTarget: 'album', albumCode: 'AB12CD34', baseUrl: 'https://w.example',
  });
  // รหัสรอบต้องติดไปด้วย ไม่งั้นแขกที่ถือกระดาษใบเดียวต้องไล่หารูปตัวเองในกองเป็นร้อย
  assert.equal(photoUrl(album, 'KWJ1D0'), 'https://w.example/b/AB12CD34/KWJ1D0');
  assert.equal(sheetQrUrl(album, 'KWJ1D0'), 'https://w.example/b/AB12CD34/KWJ1D0');

  const own = normaliseSettings({ qrTarget: 'session', baseUrl: 'https://w.example' });
  assert.equal(photoUrl(own, 'KWJ1D0'), 'https://w.example/p/KWJ1D0',
    'โหมดเห็นเฉพาะของตัวเองต้องไม่มีทางพาไปที่อัลบั้ม');

  // ตั้งโหมดอัลบั้มไว้แต่รหัสหาย — ลิงก์รอบเดี่ยวยังถูกต้องเสมอ ดีกว่าพาไปหน้าที่ไม่มีอยู่
  const broken = normaliseSettings({ qrTarget: 'album', baseUrl: 'https://w.example' });
  assert.equal(photoUrl(broken, 'KWJ1D0'), 'https://w.example/p/KWJ1D0');

  // ปิด QR บนกระดาษไว้ ต้องไม่มี QR ไม่ว่าโหมดไหน
  assert.equal(sheetQrUrl({ ...album, qrMode: 'off' }, 'KWJ1D0'), null);
});

test('the album code is made once and never changes underneath a printed sheet', async () => {
  await saveSettings(dir, { qrTarget: 'album', baseUrl: 'https://w.example' });

  const first = await ensureAlbumCode(dir, await loadSettings(dir));
  assert.ok(isAlbumCode(first.albumCode), 'เปิดบูธในโหมดอัลบั้มต้องได้รหัสทันที');

  // เปิดบูธใหม่ทุกเช้าของงานสามวัน — ต้องได้รหัสเดิมทุกครั้ง
  for (let day = 0; day < 3; day += 1) {
    const again = await ensureAlbumCode(dir, await loadSettings(dir));
    assert.equal(again.albumCode, first.albumCode, 'รหัสอัลบั้มห้ามเปลี่ยนระหว่างงาน');
  }
  assert.equal((await loadSettings(dir)).albumCode, first.albumCode, 'และต้องอยู่ในไฟล์จริง');
});

test('a booth in private mode never gets an album code at all', async () => {
  const own = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-own-'));
  try {
    await saveSettings(own, { qrTarget: 'session' });
    const settings = await ensureAlbumCode(own, await loadSettings(own));
    assert.equal(settings.albumCode, '');
  } finally {
    await fs.rm(own, { recursive: true, force: true });
  }
});

test('each take records which album it belongs to, so the web side can keep events apart', async () => {
  const sessions = path.join(dir, 'sessions');
  const settings = await loadSettings(dir);
  const sheet = { data: Buffer.from('sheet'), width: 1200, height: 1800, dpi: 300 };

  const { token } = await reserveSession(sessions);
  await saveSession(sessions, {
    token, photos: [Buffer.from('a')], sheet, settings, effect: 'clean', template: 'classic',
  });
  const manifest = JSON.parse(await fs.readFile(path.join(sessions, token, 'session.json'), 'utf8'));
  assert.equal(manifest.album, settings.albumCode);

  // โหมดเห็นเฉพาะของตัวเองต้องเขียน null ไม่ใช่รหัสว่าง — ไม่งั้นทุกรอบของทุกงาน
  // จะไปกองรวมกันอยู่ในอัลบั้มชื่อ "" เดียวกันบนเว็บ
  const own = await reserveSession(sessions);
  await saveSession(sessions, {
    token: own.token,
    photos: [Buffer.from('a')],
    sheet,
    settings: { ...settings, qrTarget: 'session' },
    effect: 'clean',
    template: 'classic',
  });
  const second = JSON.parse(
    await fs.readFile(path.join(sessions, own.token, 'session.json'), 'utf8'));
  assert.equal(second.album, null);
});
