import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

/**
 * ของที่ลบแล้วต้องไม่กลับมาใน "ของที่เก็บไว้ตลอดไป"
 *
 * ตอนทำถังขยะ ไล่เติม `deleted_at IS NULL` ให้ทุกคิวรีใน `src/repo.js` ครบแล้ว
 * แต่ **สองเส้นทางที่เขียน SQL เองโดยไม่ผ่าน repo.js ถูกมองข้ามไป** —
 * `readDeck()` ใน `src/lib/film-plan.js` (หนังงานแต่ง) กับ `selectAll` ใน
 * `src/lib/zip.js` (ดาวน์โหลดทั้งงาน)
 *
 * ทั้งคู่กรองด้วย `status` อย่างเดียว ซึ่งไม่พอ เพราะ **การลบรูปไม่ได้แตะ status เลย**
 * (`deleted_at` เป็นคนละแกนกับ `status` โดยตั้งใจ ตั้งแต่ออกแบบถังขยะ) รูปในถังขยะ
 * จึงยังเป็น 'visible' อยู่ทุกใบและหลุดเข้าไปทั้งในหนังและใน ZIP
 *
 * เจ้าภาพเจอกับตัวเอง: กดลบรูปที่ไม่เหมาะสมทิ้งแล้ว แต่หนังที่สร้างออกมายังมีรูปนั้นอยู่
 * — ทั้งสองอย่างนี้คือของที่คู่บ่าวสาวเก็บไว้ตลอดชีวิต ไม่ใช่หน้าเว็บที่รีเฟรชแล้วหาย
 */

const dataDir = useTempDataDir('trash-exports');
const app = await startTestServer();

const { softDeleteItems, restoreItems } = await import('../src/repo.js');
const { readDeck } = await import('../src/lib/film-plan.js');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const deckIds = () => readDeck().items.map((row) => row.id);

async function upload(name) {
  const file = await makeJpeg(path.join(dataDir, name));
  const { body } = await uploadFiles(app.baseUrl, [file], { uploader: 'ครูฟาฏิมะฮ์' });
  assert.equal(body.created, 1);
  return body.ids[0];
}

/** ชื่อไฟล์ทุกไฟล์ใน ZIP ที่สตรีมออกมา — อ่านจาก local file header ตรง ๆ */
async function zipNames(query = '') {
  const response = await fetch(`${app.baseUrl}/admin/zip${query}`, {
    headers: { cookie },
  });
  assert.equal(response.status, 200);
  const buffer = Buffer.from(await response.arrayBuffer());

  const names = [];
  for (let i = 0; i + 30 < buffer.length; i += 1) {
    if (buffer.readUInt32LE(i) !== 0x04034b50) continue; // local file header
    const nameLength = buffer.readUInt16LE(i + 26);
    names.push(buffer.subarray(i + 30, i + 30 + nameLength).toString('utf8'));
  }
  return names;
}

const { login } = await import('./helpers/app.js');
const cookie = await login(app.baseUrl);

const keep = await upload('keep.jpg');
const drop = await upload('drop.jpg');

test('both photos start out in the film and in the ZIP', async () => {
  assert.deepEqual(deckIds().sort(), [keep, drop].sort());
  const names = await zipNames();
  assert.equal(names.filter((name) => name.endsWith('.jpg')).length, 2, names.join(', '));
});

test('a photo in the trash is left out of the film', () => {
  softDeleteItems([drop]);

  const ids = deckIds();
  assert.ok(!ids.includes(drop), 'หนังหยิบรูปที่ลบทิ้งไปแล้วกลับมาใส่ให้');
  assert.deepEqual(ids, [keep]);
});

test('a photo in the trash is left out of the ZIP kept after the wedding', async () => {
  const names = (await zipNames()).filter((name) => name.endsWith('.jpg'));
  assert.equal(names.length, 1, `รูปที่ลบแล้วยังอยู่ใน ZIP: ${names.join(', ')}`);
});

test('restoring puts it back into both, exactly as it was', async () => {
  // ถังขยะจะมีความหมายก็ต่อเมื่อกู้คืนแล้วได้ของเดิมกลับมาครบทุกที่
  restoreItems([drop]);

  assert.deepEqual(deckIds().sort(), [keep, drop].sort());
  const names = (await zipNames()).filter((name) => name.endsWith('.jpg'));
  assert.equal(names.length, 2);
});
