import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

/**
 * ไฟล์ชั่วคราวต้องไม่ค้างอยู่บนดิสก์
 *
 * ทุกไฟล์ที่แขกส่งมาลงที่ `tmp/` ก่อนเสมอ แล้วค่อยถูกย้ายหรือลบ · ทางไหนที่ลืมลบ
 * จะทิ้งรูปเต็มความละเอียด (ถึง 25 MB ต่อใบ) ไว้ถาวรโดยไม่มีใครเห็น — และ
 * `stats().bytes` นับเฉพาะแถวในฐานข้อมูล เพดาน MAX_TOTAL_STORAGE_GB จึงมองไม่เห็น
 * พื้นที่ส่วนนี้เลย ดิสก์เต็มได้ทั้งที่ตัวเลขในหน้าแอดมินยังดูปกติดี
 *
 * สองทางที่เคยรั่วจริง (ยืนยันด้วยการยิงจริงก่อนแก้) อยู่ในสมุดคำอวยพรทั้งคู่ —
 * เป็นเส้นทางเดียวที่รับไฟล์แนบแล้ว *อาจไม่เอาไปใช้*
 */

const dataDir = useTempDataDir('tmp-files');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const tmpDir = path.join(dataDir, 'tmp');
const tmpCount = async () => (await fs.readdir(tmpDir)).length;

let counter = 0;
async function attachment() {
  counter += 1;
  return fs.readFile(await makeJpeg(path.join(dataDir, `w-${counter}.jpg`), { width: 800, height: 600 }));
}

async function postWish({ body, withFile = true }) {
  const form = new FormData();
  form.append('body', body);
  form.append('author', 'ครูฟาฏิมะฮ์');
  if (withFile) form.append('attachment', new Blob([await attachment()]), 'w.jpg');
  const response = await fetch(`${app.baseUrl}/api/messages`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

const setUploads = (on) =>
  fetch(`${app.baseUrl}/admin/settings`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: on ? 'uploads_enabled=on' : '',
    redirect: 'manual',
  });

test('a wish that goes through leaves nothing behind', async () => {
  const result = await postWish({ body: 'ขอให้มีความสุขตลอดไป' });
  assert.equal(result.status, 201);
  assert.deepEqual(result.body.errors, []);
  assert.equal(await tmpCount(), 0);
});

test('an attachment sent with no message text is not left on disk', async () => {
  // แขกแตะปุ่มแนบรูปแล้วกดส่งก่อนพิมพ์ข้อความ — เกิดบ่อยกว่าที่คิด
  const result = await postWish({ body: '   ' });
  assert.equal(result.status, 400, 'ต้องปฏิเสธเพราะไม่มีข้อความ');
  assert.equal(await tmpCount(), 0, 'แต่ไฟล์แนบต้องไม่ค้างอยู่');
});

test('an attachment sent after the host closes uploads is not left on disk', async () => {
  // ท้ายงานเจ้าภาพปิดรับรูป แต่แขกยังเขียนคำอวยพรพร้อมแนบรูปต่อได้อีกนาน
  // สามคนก็สามไฟล์ค้าง งานพันคนคือหลายกิกะไบต์ที่ไม่มีใครรู้ว่ามีอยู่
  await setUploads(false);
  try {
    for (let i = 0; i < 3; i += 1) {
      const result = await postWish({ body: `ยินดีด้วยครับ ${i}` });
      assert.equal(result.status, 201, 'คำอวยพรยังต้องบันทึกได้ แค่ไม่รับรูป');
      assert.equal(result.body.errors.length, 1, 'และต้องบอกแขกว่ารูปไม่ได้ถูกส่ง');
    }
    assert.equal(await tmpCount(), 0, 'ไฟล์แนบทั้งสามใบต้องถูกลบทิ้ง');
  } finally {
    await setUploads(true);
  }
});

test('a photo that guests upload normally still lands where it should', async () => {
  // กันไม่ให้การไล่ลบไฟล์ชั่วคราวเผลอไปลบไฟล์ของเส้นทางที่ทำงานถูกอยู่แล้ว
  const file = await makeJpeg(path.join(dataDir, 'guest.jpg'), { width: 700, height: 500 });
  const { body } = await uploadFiles(app.baseUrl, [file]);
  assert.equal(body.created, 1);
  assert.equal(await tmpCount(), 0);

  const { getItem } = await import('../src/repo.js');
  await fs.access(path.join(dataDir, 'uploads', getItem(body.ids[0]).stored_name));
});

test('files stranded by an earlier crash are swept up at startup', async () => {
  const { sweepStaleTmp } = await import('../src/lib/media.js');

  const stale = path.join(tmpDir, 'stale-part');
  const fresh = path.join(tmpDir, 'fresh-part');
  await fs.writeFile(stale, 'ค้างมาจากคอนเทนเนอร์ที่ถูกฆ่ากลางคำขอ');
  await fs.writeFile(fresh, 'ของคำขอที่กำลังวิ่งอยู่ตอนนี้');

  const old = Date.now() - 12 * 60 * 60 * 1000;
  await fs.utimes(stale, new Date(old), new Date(old));

  assert.equal(await sweepStaleTmp(), 1, 'ต้องกวาดเฉพาะไฟล์ที่ค้างมานาน');
  await assert.rejects(fs.access(stale), 'ไฟล์เก่าต้องถูกลบ');
  await fs.access(fresh); // ห้ามแตะไฟล์ของคำขอที่ยังวิ่งอยู่

  await fs.rm(fresh, { force: true });
});
