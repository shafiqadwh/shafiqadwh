import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

const run = promisify(execFile);
const ROOT = new URL('..', import.meta.url).pathname;

/**
 * เทถังขยะทิ้งถาวรก่อนวันงาน
 *
 * ของทดสอบที่ลบไปแล้วยังกินพื้นที่และยังกู้คืนได้อีก 7 วัน ซึ่งช้าเกินไปเมื่ออยาก
 * เริ่มงานจริงด้วยระบบที่สะอาด — แต่เพราะเป็นการลบที่กู้คืนไม่ได้ ตัวสคริปต์จึงต้อง
 * ไม่ลงมือจนกว่าจะสั่ง --yes ชัดเจน
 */

const dataDir = useTempDataDir('empty-trash');
const app = await startTestServer();
const { softDeleteItems } = await import('../src/repo.js');
const { db } = await import('../src/db.js');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const tool = (...args) => run('node', [path.join(ROOT, 'src/tools/empty-trash.js'), ...args],
  { env: { ...process.env, DATA_DIR: dataDir } });

const countRows = () => db.prepare('SELECT COUNT(*) AS n FROM items').get().n;

async function upload(name) {
  const file = await makeJpeg(path.join(dataDir, name));
  const { body } = await uploadFiles(app.baseUrl, [file], { uploader: 'ทดสอบ' });
  return body.ids[0];
}

const keep = await upload('keep.jpg');
const drop = await upload('drop.jpg');
const storedOf = (id) => db.prepare('SELECT stored_name FROM items WHERE id = ?').get(id).stored_name;
const dropFile = path.join(dataDir, 'uploads', storedOf(drop));

test('without --yes it only reports, and touches nothing', async () => {
  softDeleteItems([drop]);

  const { stdout } = await tool();
  assert.match(stdout, /รูป 1 ใบ/);
  assert.match(stdout, /--yes/, 'ต้องบอกวิธีสั่งจริง');

  assert.equal(countRows(), 2, 'ยังไม่ได้สั่งจริง แต่แถวหายไปแล้ว');
  await fs.access(dropFile); // ไฟล์ต้องยังอยู่
});

test('with --yes the trashed file and row are gone for good', async () => {
  await tool('--yes');

  assert.equal(countRows(), 1, 'ลบแล้วต้องเหลือเฉพาะของที่ไม่ได้อยู่ในถังขยะ');
  await assert.rejects(() => fs.access(dropFile), 'ไฟล์บนดิสก์ต้องถูกลบจริง ไม่ใช่แค่แถวใน DB');

  // ของที่ไม่ได้อยู่ในถังขยะต้องไม่โดนลูกหลง
  const survivor = db.prepare('SELECT id FROM items').get();
  assert.equal(survivor.id, keep);
  await fs.access(path.join(dataDir, 'uploads', storedOf(keep)));
});

test('running it on an empty bin is safe and says so', async () => {
  const { stdout } = await tool('--yes');
  assert.match(stdout, /ว่างอยู่แล้ว/);
  assert.equal(countRows(), 1);
});
