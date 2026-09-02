import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

/**
 * รอบถ่ายจาก photo booth ที่ส่งขึ้นเว็บ กับหน้า /p/<โทเคน> ที่ QR ชี้ไปหา
 *
 * ข้อที่สำคัญที่สุดในไฟล์นี้คือข้อแรก เหมือนกับรูปของเจ้าภาพ:
 * **รูปจากบูธต้องไม่หลุดเข้าไปในเส้นทางของรูปแขกแม้แต่เส้นเดียว**
 * มันเป็นของคนละงานกัน — แขกในงานแต่งไม่ควรเห็นรูปของคนที่ไปถ่ายบูธในงานอื่น
 * และไฟล์ ZIP ที่บ่าวสาวเก็บไว้ตลอดชีวิตไม่ควรมีของพวกนี้ปนอยู่
 */

// กุญแจเดินทางเป็น HTTP header จึงต้องเป็น ASCII เท่านั้น (ดู config.js)
const KEY = 'booth-key-for-tests-9f3a2c';
process.env.BOOTH_KEY = KEY;

const dataDir = useTempDataDir('booth-upload');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

const { stats, listGuests, countBoothSessions, getBoothSession } = await import('../src/repo.js');
const { readDeck } = await import('../src/lib/film-plan.js');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;
async function jpeg(size = { width: 600, height: 400 }) {
  counter += 1;
  return fs.readFile(await makeJpeg(path.join(dataDir, `b-${counter}.jpg`), size));
}

async function send({ token = 'K7QX2M', key = KEY, shots = 1, manifest, sheet } = {}) {
  const form = new FormData();
  form.append('manifest', JSON.stringify(manifest ?? {
    token,
    createdAt: '2026-09-02T10:00:00.000Z',
    event: { title: 'งานแต่ง A' },
    template: 'strip',
    effect: 'soft',
    shots: [],
  }));
  form.append('sheet', new Blob([sheet ?? await jpeg({ width: 1200, height: 1800 })]), 'sheet.jpg');
  for (let i = 0; i < shots; i += 1) {
    form.append('shots', new Blob([await jpeg()]), `shot-${i + 1}.jpg`);
  }

  const response = await fetch(`${app.baseUrl}/api/booth/upload`, {
    method: 'POST',
    headers: key === null ? {} : { 'x-booth-key': key },
    body: form,
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test('a booth session never reaches any path that carries guest photos', async () => {
  // รูปของแขกหนึ่งใบไว้เทียบ — ตัวเลขทุกตัวต้องนับเฉพาะใบนี้
  const guestFile = await makeJpeg(path.join(dataDir, 'guest.jpg'), { colour: '#c8a27a' });
  await uploadFiles(app.baseUrl, [guestFile], { uploader: 'ครูฟาฏิมะฮ์' });

  const before = stats();
  const deckBefore = readDeck().items.length;

  const result = await send({ token: 'K7QX2M', shots: 3 });
  assert.equal(result.status, 201);
  assert.equal(countBoothSessions(), 1);

  const after_ = stats();
  assert.equal(after_.photos, before.photos, 'ต้องไม่ถูกนับเป็นรูปของแขก');
  assert.equal(after_.videos, before.videos);
  assert.equal(after_.pending, before.pending);
  assert.equal(readDeck().items.length, deckBefore, 'ต้องไม่เข้าไปอยู่ในหนัง');

  const api = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.equal(api.total, 1, '/api/items ต้องเห็นแค่รูปของแขก');

  const guests = listGuests({ includeHidden: true });
  assert.equal(guests.length, 1, 'ต้องไม่โผล่ในรายชื่อแขก');

  const zip = await fetch(`${app.baseUrl}/admin/zip`, { headers: { cookie } });
  const bytes = Buffer.from(await zip.arrayBuffer());
  assert.ok(!bytes.includes(Buffer.from('K7QX2M')), 'ต้องไม่อยู่ในไฟล์ ZIP ของบ่าวสาว');

  // แต่พื้นที่ดิสก์ต้องนับรวม — ไฟล์พวกนี้กินที่จริง
  assert.ok(after_.bytes > before.bytes, 'สถิติพื้นที่ต้องรวมรูปจากบูธด้วย');
});

test('the page the QR points at shows the sheet and every shot', async () => {
  const page = await fetch(`${app.baseUrl}/p/K7QX2M`);
  assert.equal(page.status, 200);
  const html = await page.text();

  assert.ok(html.includes('งานแต่ง A'), 'ต้องขึ้นชื่องานที่บูธส่งมา');
  assert.ok(html.includes('/p/K7QX2M/sheet'), 'ต้องมีลิงก์แผ่นเต็ม');
  for (const n of [1, 2, 3]) {
    assert.ok(html.includes(`/p/K7QX2M/shot/${n}`), `ต้องมีรูปใบที่ ${n}`);
  }

  const sheet = await fetch(`${app.baseUrl}/p/K7QX2M/sheet`);
  assert.equal(sheet.status, 200);
  assert.equal(sheet.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(sheet.headers.get('content-length')) > 1000);

  assert.equal((await fetch(`${app.baseUrl}/p/K7QX2M/shot/3`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/p/K7QX2M/shot/9`)).status, 404, 'ใบที่ไม่มีต้อง 404');
});

test('a guest who scans before we upload gets an explanation, not a dead end', async () => {
  // โทเคนถูกจองตั้งแต่ตอนพิมพ์ · ลิงก์บนกระดาษถูกต้องแล้วตั้งแต่แรก
  // แขกที่สแกนก่อนเราอัปโหลดไม่ได้พิมพ์ผิด และจะกลับมาก็ต่อเมื่อรู้ว่าต้องกลับมา
  const response = await fetch(`${app.baseUrl}/p/ZZZZZZ`);
  assert.equal(response.status, 404, 'ยังไม่มีของ จึงเป็น 404 ตามความจริง');

  const html = await response.text();
  assert.ok(html.includes('ZZZZZZ'), 'ต้องบอกรหัสกลับไปให้เขาเก็บไว้');
  assert.ok(html.includes('อัปโหลดหลังจบงาน'), 'และต้องอธิบายว่าทำไมยังไม่มี');
});

test('a token that is not a token is refused before it touches anything', async () => {
  for (const bad of ['../../etc/passwd', 'ABCDEI', 'abc', 'K7QX2M2', '%2e%2e%2f']) {
    const response = await fetch(`${app.baseUrl}/p/${encodeURIComponent(bad)}`);
    assert.equal(response.status, 404, `${bad} ต้องไม่ผ่าน`);
    assert.equal((await fetch(`${app.baseUrl}/p/${encodeURIComponent(bad)}/sheet`)).status, 404);
  }
});

test('the lowercase code a guest types by hand still works', async () => {
  // สแกน QR ไม่ติด (กระดาษยับ แสงสะท้อน) แขกจะพิมพ์รหัสเอง และคนพิมพ์ตัวเล็ก
  assert.equal((await fetch(`${app.baseUrl}/p/k7qx2m`)).status, 200);
  assert.equal((await fetch(`${app.baseUrl}/p/k7qx2m/sheet`)).status, 200);
});

test('uploading without the right key gets nowhere', async () => {
  const before = countBoothSessions();

  for (const key of [null, '', 'wrong-key-entirely-xx', `${KEY}x`]) {
    const result = await send({ token: 'AAAAAA', key });
    assert.equal(result.status, 401, `กุญแจ "${key}" ไม่ควรผ่าน`);
  }
  assert.equal(countBoothSessions(), before, 'ต้องไม่มีอะไรถูกบันทึก');
  assert.equal(getBoothSession('AAAAAA'), undefined);
});

test('sending the same session twice is safe, because the network drops', async () => {
  /*
   * เน็ตหลุดหลังเซิร์ฟเวอร์บันทึกเสร็จแต่ก่อนตอบกลับ = บูธคิดว่ายังไม่สำเร็จ
   * แล้วส่งใหม่ · ถ้าตอบว่าผิดพลาด ตัวอัปโหลดจะติดวนพยายามส่งรอบเดิมไม่มีวันจบ
   */
  const again = await send({ token: 'K7QX2M', shots: 3 });
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(countBoothSessions(), 1, 'ต้องไม่เกิดรอบซ้ำ');
});

test('a manifest that is not a manifest is refused', async () => {
  const before = countBoothSessions();
  for (const manifest of [{ token: 'ไม่ใช่โทเคน' }, { token: '../x' }, {}, { token: 'K7QX2M2' }]) {
    assert.equal((await send({ manifest })).status, 400);
  }
  assert.equal(countBoothSessions(), before);
});

test('a file that is not an image is refused, whatever it claims to be', async () => {
  // ชนิดไฟล์ตัดสินจากไบต์จริง ไม่ใช่จากนามสกุลหรือ content-type ที่ผู้ส่งบอกมา
  const before = countBoothSessions();
  const result = await send({
    token: 'BBBBBB',
    sheet: Buffer.from('%PDF-1.7\nไม่ใช่รูปเลย'),
  });
  assert.equal(result.status, 415);
  assert.equal(countBoothSessions(), before);
});

test('nothing is left behind on disk when an upload is refused', async () => {
  const boothDir = path.join(dataDir, 'booth');
  const tmpDir = path.join(dataDir, 'tmp');
  const before = (await fs.readdir(boothDir)).length;

  await send({ token: 'CCCCCC', key: 'a-wrong-key-that-is-ascii' });
  await send({ manifest: { token: 'ไม่ใช่' } });
  await send({ token: 'DDDDDD', sheet: Buffer.from('ขยะ') });

  assert.equal((await fs.readdir(boothDir)).length, before, 'ไม่ควรมีไฟล์ใหม่ในโฟลเดอร์บูธ');
  assert.equal((await fs.readdir(tmpDir)).length, 0, 'ไฟล์ชั่วคราวต้องไม่ค้าง');
});

// ── ตัวส่งฝั่งบูธ ยิงเข้าเซิร์ฟเวอร์จริง ────────────────────────────────────

test('the booth uploader pushes real sessions end to end', async () => {
  const { composeSheet } = await import('../photobooth/src/core/sheet.js');
  const { reserveSession, saveSession, listSessions } = await import('../photobooth/src/main/session.js');
  const { normaliseSettings } = await import('../photobooth/src/main/settings.js');
  const { uploadPending } = await import('../photobooth/src/main/upload.js');

  const root = path.join(dataDir, 'booth-side');
  const photo = await jpeg({ width: 900, height: 675 });
  const settings = normaliseSettings({ eventTitle: 'งานหมั้น B', template: 'classic' });

  const tokens = [];
  for (let i = 0; i < 2; i += 1) {
    const { token } = await reserveSession(root);
    await saveSession(root, {
      token,
      photos: [photo],
      sheet: await composeSheet({ photos: [photo], template: 'classic', title: 'งานหมั้น B' }),
      settings,
      effect: 'soft',
      template: 'classic',
    });
    tokens.push(token);
  }

  const result = await uploadPending(root, { baseUrl: app.baseUrl, key: KEY });
  assert.equal(result.total, 2);
  assert.deepEqual(result.failed, [], 'ต้องไม่มีรอบไหนล้ม');

  for (const token of tokens) {
    assert.ok(getBoothSession(token), `${token} ต้องอยู่บนเว็บแล้ว`);
    const page = await fetch(`${app.baseUrl}/p/${token}`);
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('งานหมั้น B'));
  }

  // จดว่าส่งแล้ว — ไม่งั้นสั่งซ้ำจะส่งซ้ำทั้งกองทุกครั้ง
  assert.equal((await listSessions(root)).filter((one) => !one.uploaded).length, 0);

  // สั่งซ้ำต้องไม่มีอะไรให้ส่ง และต้องไม่ error
  assert.equal((await uploadPending(root, { baseUrl: app.baseUrl, key: KEY })).total, 0);
});

test('the uploader only marks a session sent after the server confirms it', async () => {
  /*
   * จดว่าส่งแล้วก่อนเซิร์ฟเวอร์ยืนยัน = รอบนั้นหายไปตลอดกาลเมื่อเน็ตหลุด
   * และไม่มีใครรู้ เพราะมันจะไม่ถูกหยิบมาส่งอีกแล้ว
   */
  const { composeSheet } = await import('../photobooth/src/core/sheet.js');
  const { reserveSession, saveSession, readSession } = await import('../photobooth/src/main/session.js');
  const { normaliseSettings } = await import('../photobooth/src/main/settings.js');
  const { uploadPending } = await import('../photobooth/src/main/upload.js');

  const root = path.join(dataDir, 'booth-fail');
  const photo = await jpeg({ width: 400, height: 300 });
  const { token } = await reserveSession(root);
  await saveSession(root, {
    token,
    photos: [photo],
    sheet: await composeSheet({ photos: [photo], template: 'classic', title: 'x' }),
    settings: normaliseSettings({}),
    effect: 'clean',
    template: 'classic',
  });

  const result = await uploadPending(root, {
    baseUrl: app.baseUrl,
    key: KEY,
    fetchImpl: () => Promise.reject(new Error('เน็ตหลุด')),
  });

  assert.equal(result.sent.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].reason, /เน็ตหลุด/);
  assert.equal((await readSession(root, token)).uploaded, false,
    'ยังต้องเป็น false เพื่อให้ครั้งหน้าหยิบมาส่งใหม่');

  // ลองใหม่ตอนเน็ตกลับมาแล้วต้องผ่าน
  assert.equal((await uploadPending(root, { baseUrl: app.baseUrl, key: KEY })).sent.length, 1);
  assert.equal((await readSession(root, token)).uploaded, true);
});

test('a booth key that could never work as a header is refused at startup', async () => {
  /*
   * กุญแจเดินทางเป็น HTTP header ซึ่งรับได้แค่ ASCII · ตั้งเป็นภาษาไทยแล้ว
   * `fetch` ฝั่งบูธจะโยน error ตั้งแต่ยังไม่ได้ส่ง อาการที่เจ้าของเห็นคือ
   * "อัปโหลดไม่ได้เลย" โดยไม่มีอะไรชี้ว่าเป็นเพราะกุญแจ — เจอตอนเขียนเทสต์นี้เอง
   */
  const { execFileSync } = await import('node:child_process');
  const probe = (key) => execFileSync(process.execPath, ['--input-type=module', '-e', `
    const { config } = await import('${path.resolve('src/config.js')}');
    console.log(JSON.stringify({ key: config.boothKey }));
  `], {
    encoding: 'utf8',
    env: { ...process.env, BOOTH_KEY: key, ADMIN_PASSWORD: 'x'.repeat(10), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.equal(JSON.parse(probe('a-perfectly-good-key-123')).key, 'a-perfectly-good-key-123');
  assert.equal(JSON.parse(probe('กุญแจภาษาไทยยาวมากพอเลยนะ')).key, '',
    'กุญแจที่ไม่ใช่ ASCII ต้องถือว่ายังไม่ได้ตั้ง');
  assert.equal(JSON.parse(probe('sh0rt')).key, '', 'กุญแจสั้นเกินไปต้องถือว่ายังไม่ได้ตั้ง');
  assert.equal(JSON.parse(probe('')).key, '');
});
