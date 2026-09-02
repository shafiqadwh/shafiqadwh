import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

/**
 * รูปที่เจ้าภาพอัพเองสำหรับหน้าแรก — ภาพปก การ์ดเชิญ รูปงาน
 *
 * ข้อที่สำคัญที่สุดในไฟล์นี้คือข้อแรก: **รูปพวกนี้ต้องไม่หลุดเข้าไปในเส้นทางของรูปแขก
 * แม้แต่เส้นเดียว** — ไม่ใช่แค่ไม่โผล่ในแกลลอรี่ แต่ต้องไม่อยู่ในหนังงานแต่ง
 * ไม่อยู่ในไฟล์ ZIP ที่คู่บ่าวสาวเก็บไว้ตลอดชีวิต และไม่ทำให้ตัวเลข "แขกส่งรูปมากี่ใบ" เพี้ยน
 *
 * เหตุผลที่เก็บคนละตารางตั้งแต่แรกก็เพราะข้อนี้ — ถ้าใส่คอลัมน์บอกชนิดลงใน items
 * แล้วกรองออกตอนอ่าน จะต้องไล่เติมเงื่อนไขให้ครบสิบกว่าจุด และโปรเจกต์นี้เคยลืม
 * เงื่อนไข `deleted_at IS NULL` มาแล้วสองจุดทั้งที่ตอนนั้นมีให้จำแค่ข้อเดียว
 */

const dataDir = useTempDataDir('home-media');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

const { stats, listGuests, listHostMedia } = await import('../src/repo.js');
const { readDeck } = await import('../src/lib/film-plan.js');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

let counter = 0;

async function addHostImage(slot, { colour = '#7aa2c8', width = 1400, height = 900 } = {}) {
  counter += 1;
  const file = await makeJpeg(path.join(dataDir, `host-${counter}.jpg`), { width, height, colour });
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(file)]), path.basename(file));

  const response = await fetch(`${app.baseUrl}/admin/home/${slot}`, {
    method: 'POST',
    headers: { cookie },
    body: form,
    redirect: 'manual',
  });
  return response;
}

const home = (path_) => fetch(`${app.baseUrl}${path_}`).then(async (r) => ({ status: r.status, text: await r.text() }));

test('a host image never reaches any path that carries guest photos', async () => {
  // รูปของแขกหนึ่งใบไว้เทียบ — ตัวเลขทุกตัวต้องนับเฉพาะใบนี้เท่านั้น
  const guestFile = await makeJpeg(path.join(dataDir, 'guest.jpg'), { colour: '#c8a27a' });
  const uploaded = await uploadFiles(app.baseUrl, [guestFile], { uploader: 'ครูฟาฏิมะฮ์' });
  assert.equal(uploaded.body.created, 1);

  const before = stats();
  const deckBefore = readDeck().items.length;

  await addHostImage('cover');
  await addHostImage('invitation');
  await addHostImage('photo');
  assert.equal(listHostMedia('cover').length + listHostMedia('invitation').length
    + listHostMedia('photo').length, 3, 'ต้องเก็บครบสามใบจริง');

  const after_ = stats();

  // ── ตัวตัดสินทั้งห้า ──
  const items = await fetch(`${app.baseUrl}/api/items`).then((r) => r.json());
  assert.equal(items.items.length, 1, 'แกลลอรี่ต้องเห็นเฉพาะรูปของแขก');
  assert.equal(items.total, 1);

  assert.equal(readDeck().items.length, deckBefore, 'หนังงานแต่งต้องไม่หยิบรูปเจ้าภาพไป');
  assert.equal(after_.photos, before.photos, 'จำนวนรูปในสถิติต้องไม่ขยับ');
  assert.equal(after_.pending, before.pending);

  const guests = listGuests({ includeHidden: true });
  assert.equal(guests.reduce((sum, one) => sum + one.photos, 0), 1,
    'รายชื่อผู้ส่งรูปต้องนับเฉพาะรูปของแขก');

  // แต่พื้นที่ดิสก์ต้องนับรวม เพราะไฟล์กินที่จริง — ไม่งั้นเพดานพื้นที่กันไม่ทัน
  assert.ok(after_.bytes > before.bytes, 'พื้นที่ที่ใช้ไปต้องรวมรูปเจ้าภาพด้วย');
});

test('the ZIP that the couple keeps forever holds no host images', async () => {
  const response = await fetch(`${app.baseUrl}/admin/zip`, { headers: { cookie } });
  assert.equal(response.status, 200);

  const buffer = Buffer.from(await response.arrayBuffer());
  const names = [];
  for (let at = 0; at < buffer.length - 4; at += 1) {
    if (buffer.readUInt32LE(at) !== 0x04034b50) continue;
    const length = buffer.readUInt16LE(at + 26);
    names.push(buffer.subarray(at + 30, at + 30 + length).toString('utf8'));
  }

  assert.ok(names.length > 0, 'ต้องมีไฟล์ในซิปจริง ไม่งั้นเทสต์นี้ผ่านฟรี');
  const hostNames = listHostMedia('photo').concat(listHostMedia('cover'))
    .map((one) => one.stored_name);
  for (const stored of hostNames) {
    assert.ok(!names.some((name) => name.includes(path.parse(stored).name)),
      `ไฟล์ของเจ้าภาพ ${stored} ไม่ควรอยู่ในซิป`);
  }
});

test('the front page shows the cover with the event name over it', async () => {
  const page = await home('/');
  assert.equal(page.status, 200);

  const cover = listHostMedia('cover')[0];
  assert.match(page.text, new RegExp(`/host/${cover.id}`), 'ต้องมีภาพปกในหน้า');
  assert.match(page.text, /hero--cover/, 'ต้องใช้โครงที่ชื่องานทาบบนภาพ');
  // ชื่องานยังอยู่ในหน้าเหมือนเดิม ไม่ได้ถูกภาพแทนที่
  assert.match(page.text, /hero__title/);
});

test('serves a resized copy by default and a thumbnail on request', async () => {
  const cover = listHostMedia('cover')[0];

  const full = await fetch(`${app.baseUrl}/host/${cover.id}`);
  const thumb = await fetch(`${app.baseUrl}/host/${cover.id}?size=thumb`);
  assert.equal(full.status, 200);
  assert.equal(thumb.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/jpeg');

  const fullBytes = (await full.arrayBuffer()).byteLength;
  const thumbBytes = (await thumb.arrayBuffer()).byteLength;
  assert.ok(thumbBytes < fullBytes, 'รูปย่อต้องเล็กกว่าสำเนาเต็ม');

  // สำเนาที่เสิร์ฟต้องเป็นตัวที่ย่อแล้ว ไม่ใช่ไฟล์ต้นฉบับ — แขกทุกคนโหลดไฟล์นี้
  const original = (await fs.stat(path.join(dataDir, 'uploads', cover.stored_name))).size;
  assert.ok(fullBytes <= original, 'ต้องไม่ส่งไฟล์ที่ใหญ่กว่าต้นฉบับให้แขก');
});

test('a slot that is full says so instead of dropping images quietly', async () => {
  // การ์ดเชิญรับได้ 3 ใบ ใส่ไปแล้วหนึ่ง เติมอีกสามให้ล้น
  await addHostImage('invitation');
  await addHostImage('invitation');
  const overflow = await addHostImage('invitation');

  assert.equal(listHostMedia('invitation').length, 3, 'ต้องไม่เกินเพดานของช่อง');
  assert.match(overflow.headers.get('location') ?? '', /home=full/,
    'ต้องบอกว่าเต็ม ไม่ใช่ตัดทิ้งเงียบ ๆ');
});

/*
 * ─── ไฟล์ที่ไม่ใช่รูป ────────────────────────────────────────────────────────
 *
 * การ์ดเชิญที่ลูกค้าส่งมาให้เจ้าภาพมักเป็น PDF · เดิมเส้นทางนี้ทิ้งไฟล์ที่ไม่ใช่รูป
 * **เงียบสนิท** ไม่มีข้อความ ไม่มีแถวเพิ่ม เจ้าภาพเห็นแค่ช่องว่างเปล่าโดยไม่รู้สาเหตุ
 * — ต่างจากเส้นทางของแขกที่บอกชื่อไฟล์และเหตุผลกลับไปตั้งแต่แรก
 */
async function postHost(slot, parts) {
  const form = new FormData();
  for (const [name, bytes] of parts) form.append('files', new Blob([bytes]), name);
  return fetch(`${app.baseUrl}/admin/home/${slot}`, {
    method: 'POST', headers: { cookie }, body: form, redirect: 'manual',
  });
}

const PDF = Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n1 0 obj<<>>endobj\n', 'latin1');

async function jpegBytes() {
  counter += 1;
  return fs.readFile(await makeJpeg(path.join(dataDir, `bytes-${counter}.jpg`), { width: 600, height: 400 }));
}

test('a file that is not an image is refused out loud, not dropped in silence', async () => {
  const before = listHostMedia('invitation').length;
  const response = await postHost('invitation', [['card.pdf', PDF]]);

  assert.match(response.headers.get('location') ?? '', /home=badtype/,
    'ต้องบอกว่ารับเฉพาะไฟล์รูป');
  assert.equal(listHostMedia('invitation').length, before, 'ต้องไม่มีแถวเพิ่ม');
});

test('one bad file in a batch does not hide itself behind the good ones', async () => {
  // เจ้าภาพเลือกสองไฟล์ รูปหนึ่ง PDF หนึ่ง · เดิมรูปเข้าเงียบ ๆ แล้ว redirect ไป
  // /admin เฉย ๆ เจ้าภาพจึงเชื่อว่าเข้าไปทั้งคู่
  const slot = 'photo';
  const before = listHostMedia(slot).length;
  const response = await postHost(slot, [['ok.jpg', await jpegBytes()], ['card.pdf', PDF]]);

  assert.equal(listHostMedia(slot).length, before + 1, 'รูปที่ใช้ได้ต้องเข้าไปตามปกติ');
  assert.match(response.headers.get('location') ?? '', /home=badtype/,
    'และต้องบอกด้วยว่ามีไฟล์ที่เข้าไม่ได้');
});

test('too many files is not reported as a file being too big', async () => {
  // ภาพปกรับใบเดียว · เลือกมาสามใบเดิมได้ข้อความ "ไฟล์ใหญ่เกินไป" ซึ่งพาให้เจ้าภาพ
  // ไปย่อรูปแล้วลองใหม่ไปเรื่อย ๆ ทั้งที่ขนาดไฟล์ไม่ใช่ปัญหาเลย
  const bytes = await jpegBytes();
  const response = await postHost('cover', [['a.jpg', bytes], ['b.jpg', bytes], ['c.jpg', bytes]]);

  const location = response.headers.get('location') ?? '';
  assert.match(location, /home=toomany/);
  assert.ok(!location.includes('toobig'), 'ห้ามบอกว่าไฟล์ใหญ่เกินไป');
});

test('a cover survives an upload that turns out to be unusable', async () => {
  // ข้อที่ร้ายแรงที่สุดของแผงนี้: เดิมลบภาพปกเดิมทิ้ง *ก่อน* ตรวจไฟล์ใหม่
  // อัพ PDF ทับหนึ่งครั้ง = ภาพปกหายถาวร (รูปเจ้าภาพไม่มีถังขยะให้กู้) และไม่มีข้อความบอก
  await postHost('cover', [['good.jpg', await jpegBytes()]]);
  const before = listHostMedia('cover')[0];
  assert.ok(before, 'ต้องมีภาพปกอยู่ก่อนถึงจะทดสอบข้อนี้ได้');
  const beforePath = path.join(dataDir, 'uploads', before.stored_name);

  const response = await postHost('cover', [['card.pdf', PDF]]);

  const after_ = listHostMedia('cover');
  assert.equal(after_.length, 1, 'ภาพปกเดิมต้องยังอยู่');
  assert.equal(after_[0].id, before.id, 'และต้องเป็นใบเดิม ไม่ใช่ใบที่ถูกสร้างใหม่');
  await fs.access(beforePath); // ไฟล์บนดิสก์ต้องไม่ถูกลบไปด้วย
  assert.match(response.headers.get('location') ?? '', /home=badtype/);
});

test('uploading a new cover replaces the old one, files and all', async () => {
  const before = listHostMedia('cover')[0];
  const beforePath = path.join(dataDir, 'uploads', before.stored_name);
  await fs.access(beforePath);

  await addHostImage('cover', { colour: '#3c6e52' });

  const after_ = listHostMedia('cover');
  assert.equal(after_.length, 1, 'ภาพปกมีได้ใบเดียวเสมอ');
  assert.notEqual(after_[0].id, before.id);

  // ไฟล์เก่าต้องหายจากดิสก์จริง ไม่ใช่แค่หายจากฐานข้อมูล — ไม่งั้นเป็นไฟล์กำพร้ากินดิสก์
  await assert.rejects(fs.access(beforePath), 'ไฟล์ของภาพปกเดิมต้องถูกลบไปด้วย');
});

test('removing an image deletes every file it made', async () => {
  const target = listHostMedia('photo')[0];
  const files = [
    path.join(dataDir, 'uploads', target.stored_name),
    path.join(dataDir, 'derived', target.display_name),
    path.join(dataDir, 'derived', target.thumb_name),
  ];
  for (const file of files) await fs.access(file);

  const response = await fetch(`${app.baseUrl}/admin/home/item/${target.id}/delete`, {
    method: 'POST',
    headers: { cookie },
    redirect: 'manual',
  });
  assert.equal(response.status, 302);

  for (const file of files) {
    await assert.rejects(fs.access(file), `${file} ต้องถูกลบไปด้วย`);
  }
  assert.ok(!listHostMedia('photo').some((one) => one.id === target.id));
});

test('the arrows reorder images, and cannot walk off either end', async () => {
  await addHostImage('photo', { colour: '#8f5f8f' });
  await addHostImage('photo', { colour: '#5f8f6f' });
  const start = listHostMedia('photo').map((one) => one.id);
  assert.ok(start.length >= 2, 'ต้องมีอย่างน้อยสองใบถึงจะสลับได้');

  const move = (id, direction) => fetch(`${app.baseUrl}/admin/home/item/${id}/move`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ direction }),
    redirect: 'manual',
  });

  await move(start[1], 'up');
  const swapped = listHostMedia('photo').map((one) => one.id);
  assert.deepEqual(swapped.slice(0, 2), [start[1], start[0]], 'สองใบแรกต้องสลับที่กัน');

  // ใบบนสุดเลื่อนขึ้นอีกไม่ได้ และต้องไม่ทำให้ลำดับเพี้ยน
  await move(swapped[0], 'up');
  assert.deepEqual(listHostMedia('photo').map((one) => one.id), swapped,
    'เลื่อนเลยขอบแล้วลำดับต้องไม่ขยับ');
});

test('guests cannot add or remove anything on the front page', async () => {
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(path.join(dataDir, 'guest.jpg'))]), 'x.jpg');

  // คนไม่ล็อกอินถูกส่งกลับไปหน้าล็อกอิน — ตัวตัดสินคือ "ข้อมูลต้องไม่ขยับ"
  // ไม่ใช่รหัสตอบกลับ เพราะเส้นทางที่คืนหน้า HTML ก็ตอบ 302 เหมือนกันตอนสำเร็จ
  const before = listHostMedia('photo').map((one) => one.id);

  const upload = await fetch(`${app.baseUrl}/admin/home/photo`, {
    method: 'POST', body: form, redirect: 'manual',
  });
  assert.equal(upload.headers.get('location'), '/admin', 'ต้องถูกส่งไปหน้าล็อกอิน');
  assert.deepEqual(listHostMedia('photo').map((one) => one.id), before, 'ต้องไม่มีรูปเพิ่ม');

  const remove = await fetch(`${app.baseUrl}/admin/home/item/${before[0]}/delete`, {
    method: 'POST', redirect: 'manual',
  });
  assert.equal(remove.headers.get('location'), '/admin');
  assert.deepEqual(listHostMedia('photo').map((one) => one.id), before, 'รูปต้องยังอยู่ครบ');
});

test('the front page still works with nothing on it at all', async () => {
  for (const slot of ['cover', 'invitation', 'photo']) {
    for (const one of listHostMedia(slot)) {
      await fetch(`${app.baseUrl}/admin/home/item/${one.id}/delete`, {
        method: 'POST', headers: { cookie }, redirect: 'manual',
      });
    }
  }

  // สภาพเริ่มต้นของทุกงานใหม่ — ต้องได้หน้าเดิมเป๊ะเหมือนก่อนมีฟีเจอร์นี้
  const page = await home('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /hero__title/);
  assert.ok(!page.text.includes('hero--cover'), 'ไม่มีภาพปกก็ต้องไม่มีโครงภาพปก');
  assert.ok(!page.text.includes('/host/'), 'ต้องไม่มีลิงก์รูปเจ้าภาพค้างอยู่');
});
