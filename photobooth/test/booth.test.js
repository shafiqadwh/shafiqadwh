import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import sharp from 'sharp';
import {
  DEFAULTS, loadSettings, normaliseSettings, photoUrl, saveSettings, sheetQrUrl,
} from '../src/main/settings.js';
import {
  discardSession, isToken, listSessions, newToken, readSession, reserveSession, saveSession,
} from '../src/main/session.js';
import { lpArgs, printSheet } from '../src/main/print.js';
import { composeSheet } from '../src/core/sheet.js';

/**
 * ฝั่งกระบวนการหลักของบูธ — ค่าตั้ง รอบถ่าย และการสั่งพิมพ์
 *
 * ทั้งหมดนี้ทำงานตอนมีแขกยืนรออยู่ และหลายอย่างย้อนกลับไม่ได้ (กระดาษที่พิมพ์ไปแล้ว)
 * กติกาที่ยึดตลอด: **ค่าที่ผิดต้องตกกลับไปค่าที่ใช้ได้ ไม่ใช่ทำให้บูธไม่ขึ้น**
 */

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-test-'));
after(() => fs.rm(work, { recursive: true, force: true }));

let counter = 0;
const scratch = async () => {
  counter += 1;
  const dir = path.join(work, `case-${counter}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
};

// ── ค่าตั้ง ────────────────────────────────────────────────────────────────

test('rubbish in the settings file never stops the booth from opening', async () => {
  // ลูกค้าเปลี่ยนชื่องานนาทีสุดท้ายแล้วพิมพ์ JSON พัง — บูธที่เปิดไม่ติดตอนแขก
  // ต่อแถวอยู่คือความเสียหายที่แก้ไม่ทัน · เสียค่าหนึ่งค่าดีกว่าเสียทั้งงาน
  const junk = normaliseSettings({
    lang: 'klingon',
    theme: 'ไม่มีธีมนี้',
    template: 42,
    paper: null,
    effects: ['ไม่มี', 'clean', 'clean', 'ไม่มีอีก'],
    countdownSeconds: 9999,
    copies: -5,
    qrMode: 'maybe',
    baseUrl: 'javascript:alert(1)',
    printer: 'ไม่ใช่ออบเจ็กต์',
  });

  assert.equal(junk.lang, DEFAULTS.lang);
  assert.equal(junk.theme, DEFAULTS.theme);
  assert.equal(junk.template, DEFAULTS.template);
  assert.equal(junk.paper, DEFAULTS.paper);
  assert.deepEqual(junk.effects, ['clean'], 'เก็บเฉพาะตัวที่มีจริง และไม่ซ้ำ');
  assert.equal(junk.countdownSeconds, 10, 'บีบเข้าช่วงที่ใช้ได้');
  assert.equal(junk.copies, 1);
  assert.equal(junk.qrMode, DEFAULTS.qrMode);
  assert.equal(junk.baseUrl, '', 'รับเฉพาะ http(s) — javascript: ต้องถูกทิ้ง');
  assert.deepEqual(junk.printer, DEFAULTS.printer);
});

test('an empty effect list falls back instead of leaving nothing to pick', () => {
  // ว่างเปล่าไม่ใช่การตั้งค่าที่ใครตั้งใจ เป็นผลของการพิมพ์ผิด — และผลของมันคือ
  // บูธที่แขกกดอะไรไม่ได้เลย
  assert.deepEqual(normaliseSettings({ effects: [] }).effects, DEFAULTS.effects);
  assert.deepEqual(normaliseSettings({ effects: ['ไม่มีสักตัว'] }).effects, DEFAULTS.effects);
  assert.ok(normaliseSettings({ effects: [...Array(20).keys()].map(() => 'clean') }).effects.length <= 4);
});

test('settings survive a power cut in the middle of saving', async () => {
  // บูธรันด้วยแบตเตอรี่ในเต็นท์ · JSON ครึ่งไฟล์ = บูธที่เปิดไม่ขึ้นในงานถัดไป
  const dir = await scratch();
  await saveSettings(dir, { eventTitle: 'งานแต่ง A' });

  const files = await fs.readdir(dir);
  assert.deepEqual(files, ['settings.json'], 'ต้องไม่มีไฟล์ .part ค้าง');
  assert.equal((await loadSettings(dir)).eventTitle, 'งานแต่ง A');

  // เขียนทับด้วยขยะแล้วต้องยังเปิดได้
  await fs.writeFile(path.join(dir, 'settings.json'), '{ ไม่ใช่ JSON');
  assert.equal((await loadSettings(dir)).eventTitle, '', 'ตกกลับไปค่าเริ่มต้น ไม่ใช่โยน');
});

test('a QR is only printed when it can actually lead somewhere', () => {
  // QR ที่สแกนแล้วพาไปหน้าว่าง แย่กว่าไม่มี QR เลย — และตั้ง qrMode ไว้แต่ลืมใส่
  // baseUrl เป็นความผิดพลาดที่เกิดง่ายที่สุดของทั้งหน้าตั้งค่า
  const on = normaliseSettings({ qrMode: 'later', baseUrl: 'https://booth.example.com/' });
  assert.equal(sheetQrUrl(on, 'K7QX2M'), 'https://booth.example.com/p/K7QX2M');

  assert.equal(sheetQrUrl(normaliseSettings({ qrMode: 'off', baseUrl: 'https://a.bc' }), 'K7QX2M'), null);
  assert.equal(sheetQrUrl(normaliseSettings({ qrMode: 'later', baseUrl: '' }), 'K7QX2M'), null);
  assert.equal(sheetQrUrl(on, null), null);
});

test('where the photos live is a different question from what to print', () => {
  /*
   * เคยเป็นฟังก์ชันเดียวกัน แล้วโหมดจอที่ตั้ง qrMode: 'off' (ซึ่งสมเหตุสมผลมาก
   * เพราะโหมดจอไม่ได้พิมพ์อะไรเลย) ได้ที่อยู่เป็น null แล้วพังตอนสร้าง QR ขึ้นจอ
   */
  const screen = normaliseSettings({
    deliver: 'screen', qrMode: 'off', baseUrl: 'https://a.bc', uploadKey: 'k'.repeat(20),
  });
  assert.equal(sheetQrUrl(screen, 'K7QX2M'), null, 'ไม่พิมพ์ QR ลงแผ่น');
  assert.equal(photoUrl(screen, 'K7QX2M'), 'https://a.bc/p/K7QX2M', 'แต่รูปยังอยู่ที่เดิม');

  assert.equal(photoUrl(normaliseSettings({}), 'K7QX2M'), null, 'ไม่มี baseUrl ก็ไม่มีที่อยู่');
  assert.equal(photoUrl(screen, null), null);
});

// ── รอบถ่าย ────────────────────────────────────────────────────────────────

test('a token is short, unambiguous, and never repeats itself', () => {
  // โทเคนไปอยู่บนกระดาษที่แขกถือกลับบ้าน · สแกนไม่ติดเมื่อไรแขกจะพิมพ์เอง
  const seen = new Set();
  for (let i = 0; i < 4000; i += 1) {
    const token = newToken();
    assert.ok(isToken(token), `โทเคนผิดรูปแบบ: ${token}`);
    assert.ok(!/[ILOU]/.test(token), `มีตัวอักษรที่คนอ่านสลับกันได้: ${token}`);
    seen.add(token);
  }
  assert.ok(seen.size > 3990, `ซ้ำกันมากผิดปกติ: ได้ ${seen.size} จาก 4000`);

  for (const bad of ['', 'ABC', 'abcdef', 'ABCDEI', '../../x', null, 'ABCDEFG']) {
    assert.equal(isToken(bad), false, `ต้องปฏิเสธ: ${bad}`);
  }
});

test('two sessions started at the same moment never collide', async () => {
  // บูธสองตัวเขียนลงโฟลเดอร์แชร์เดียวกันได้ · ใช้ระบบไฟล์เป็นตัวตัดสินว่าใครได้
  // โทเคนนั้น แทน "เช็คก่อนแล้วค่อยสร้าง" ซึ่งมีช่องว่างระหว่างสองขั้น
  const root = path.join(await scratch(), 'sessions');
  const claimed = await Promise.all([...Array(30)].map(() => reserveSession(root)));
  const tokens = claimed.map((one) => one.token);
  assert.equal(new Set(tokens).size, tokens.length, 'โทเคนซ้ำกัน');

  for (const { dir } of claimed) await fs.access(dir);
});

async function fakeSheet() {
  const photo = await sharp({
    create: { width: 600, height: 450, channels: 3, background: { r: 130, g: 160, b: 200 } },
  }).jpeg().toBuffer();
  return {
    photo,
    sheet: await composeSheet({ photos: [photo], template: 'classic', title: 'งานแต่ง' }),
  };
}

test('a saved session keeps both the sheet and the originals', async () => {
  const root = path.join(await scratch(), 'sessions');
  const { photo, sheet } = await fakeSheet();
  const { token } = await reserveSession(root);

  const saved = await saveSession(root, {
    token,
    photos: [photo, photo],
    sheet,
    settings: normaliseSettings({ eventTitle: 'งานแต่ง', theme: 'wedding' }),
    effect: 'soft',
    template: 'classic',
  });

  assert.equal(saved.token, token);
  await fs.access(saved.sheetPath);
  await fs.access(path.join(saved.dir, 'shots', 'shot-1.jpg'));
  await fs.access(path.join(saved.dir, 'shots', 'shot-2.jpg'));

  const manifest = await readSession(root, token);
  assert.equal(manifest.effect, 'soft');
  assert.deepEqual(manifest.shots, ['shot-1.jpg', 'shot-2.jpg']);
  assert.equal(manifest.sheet.dpi, 300);
  assert.equal(manifest.uploaded, false);
});

test('a half-written session is cleaned up, not left as a mystery folder', async () => {
  const root = path.join(await scratch(), 'sessions');
  const { sheet } = await fakeSheet();
  const { token, dir } = await reserveSession(root);

  await assert.rejects(() => saveSession(root, {
    token,
    photos: [null], // เขียนไม่ได้ → ต้องล้มแล้วเก็บกวาด
    sheet,
    settings: normaliseSettings({}),
    effect: 'clean',
    template: 'classic',
  }));

  await assert.rejects(fs.access(dir), 'โฟลเดอร์ที่ไม่ครบต้องถูกลบทิ้ง');
});

test('only finished sessions are listed, newest first', async () => {
  const root = path.join(await scratch(), 'sessions');
  const { photo, sheet } = await fakeSheet();
  const common = { photos: [photo], sheet, settings: normaliseSettings({}), effect: 'clean', template: 'classic' };

  const first = await reserveSession(root);
  await saveSession(root, { token: first.token, ...common });
  await new Promise((done) => setTimeout(done, 1100)); // เวลาใน manifest ละเอียดระดับวินาที
  const second = await reserveSession(root);
  await saveSession(root, { token: second.token, ...common });

  // โฟลเดอร์ที่ไฟดับกลางทาง: มีโฟลเดอร์แต่ไม่มี session.json
  const stranded = await reserveSession(root);

  const listed = await listSessions(root);
  assert.deepEqual(listed.map((one) => one.token), [second.token, first.token],
    'ต้องเรียงใหม่สุดก่อน และไม่นับรอบที่ยังไม่ครบ');
  assert.ok(!listed.some((one) => one.token === stranded.token));

  assert.deepEqual(await listSessions(path.join(root, 'ไม่มีโฟลเดอร์นี้')), []);
});

test('saving refuses a token that did not come from a reservation', async () => {
  // กันพาธหลุด: โทเคนถูกเอาไปต่อเป็นชื่อโฟลเดอร์ตรง ๆ
  const root = path.join(await scratch(), 'sessions');
  const { photo, sheet } = await fakeSheet();
  for (const token of ['../escape', 'x', '']) {
    await assert.rejects(() => saveSession(root, {
      token, photos: [photo], sheet, settings: normaliseSettings({}), effect: 'clean', template: 'classic',
    }), /โทเคนไม่ถูกต้อง/);
  }
});

test('discarding a session removes it completely, and refuses a bad token', async () => {
  const root = path.join(await scratch(), 'sessions');
  const { photo, sheet } = await fakeSheet();
  const { token, dir } = await reserveSession(root);
  await saveSession(root, {
    token, photos: [photo], sheet, settings: normaliseSettings({}), effect: 'clean', template: 'classic',
  });

  await discardSession(root, token);
  await assert.rejects(fs.access(dir), 'ต้องลบทั้งโฟลเดอร์ ไม่ใช่แค่ manifest');
  assert.equal(await readSession(root, token), null);

  // ลบซ้ำต้องไม่ error — ปุ่มที่กดสองครั้งไม่ควรทำให้บูธขึ้นข้อความผิดพลาด
  await discardSession(root, token);

  // และโทเคนที่ไม่ถูกรูปแบบต้องไม่ถูกเอาไปต่อเป็นพาธเด็ดขาด
  for (const bad of ['../..', 'x', '']) {
    await assert.rejects(() => discardSession(root, bad), /โทเคนไม่ถูกต้อง/);
  }
});

// ── สั่งพิมพ์ ──────────────────────────────────────────────────────────────

test('the lp command is built without going through a shell', () => {
  // ⚠️ ส่วนนี้ทดสอบได้แค่ "คำสั่งถูกไหม" — เครื่องที่พัฒนาไม่มี CUPS และไม่มี
  // เครื่องพิมพ์ dye-sub ต่ออยู่ · ตัวตัดสินจริงคือกระดาษที่ออกมาจากเครื่อง
  const args = lpArgs({ printerName: 'DS-RX1 ตัวที่ 2', paper: '4x6', copies: 2, file: '/tmp/a.jpg' });

  assert.deepEqual(args, [
    '-d', 'DS-RX1 ตัวที่ 2',
    '-n', '2',
    '-o', 'media=4x6',
    '-o', 'fit-to-page',
    '-o', 'StpBorderless=True',
    '/tmp/a.jpg',
  ]);
  // ชื่อเครื่องพิมพ์มีช่องว่าง แต่ต้องอยู่เป็นอาร์กิวเมนต์เดียว ไม่ถูกแยกเป็นสองคำ
  assert.equal(args[1], 'DS-RX1 ตัวที่ 2');

  // ไม่ระบุชื่อเครื่อง = ใช้เครื่องเริ่มต้นของระบบ ต้องไม่มี -d เปล่า ๆ ติดไป
  assert.ok(!lpArgs({ printerName: '', paper: '4x6', copies: 1, file: '/tmp/a.jpg' }).includes('-d'));

  // กระดาษที่ไม่รู้จักตกกลับไป 4x6 แทนที่จะส่งชื่อสื่อที่ CUPS ไม่รู้จักไป
  assert.ok(lpArgs({ paper: 'ไม่มีขนาดนี้', copies: 1, file: '/x' }).includes('media=4x6'));
});

test('the file driver writes one copy per requested print', async () => {
  const dir = await scratch();
  const sheetPath = path.join(dir, 'sheet.jpg');
  const { sheet } = await fakeSheet();
  await fs.writeFile(sheetPath, sheet.data);
  const outbox = path.join(dir, 'outbox');

  const result = await printSheet({
    sheetPath,
    settings: normaliseSettings({ copies: 3, printer: { driver: 'file' } }),
    token: 'K7QX2M',
    outbox,
  });

  assert.equal(result.ok, true);
  assert.equal(result.driver, 'file');
  const written = await fs.readdir(outbox);
  assert.equal(written.length, 3);
  assert.ok(written.every((name) => name.includes('K7QX2M')), 'ชื่อไฟล์ต้องย้อนกลับไปหารอบถ่ายได้');
  assert.ok(written.every((name) => name.endsWith('.jpg')));
});

test('a missing lp says what to do instead of dumping a stack trace', async () => {
  // เครื่องที่รันเทสต์ไม่มี lp — ซึ่งเป็นสภาพเดียวกับมินิพีซีที่ยังไม่ได้ตั้ง CUPS
  const dir = await scratch();
  const sheetPath = path.join(dir, 'sheet.jpg');
  const { sheet } = await fakeSheet();
  await fs.writeFile(sheetPath, sheet.data);

  await assert.rejects(
    () => printSheet({
      sheetPath,
      settings: normaliseSettings({ printer: { driver: 'cups', name: 'x' } }),
      token: 'K7QX2M',
      outbox: path.join(dir, 'outbox'),
    }),
    /ไม่พบคำสั่ง lp|สั่งพิมพ์ไม่ได้/,
  );
});
