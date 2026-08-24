import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { useTempDataDir, startTestServer, login } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * เลือกลบหลายรูปพร้อมกัน + ถังขยะ/เลิกทำ
 *
 * กติกาของฟีเจอร์นี้: ลบ = เข้าถังขยะ ไม่ใช่ลบไฟล์จริงทันที — ไฟล์ยังอยู่บนดิสก์
 * จนกว่าจะพ้นระยะเก็บ (`TRASH_RETENTION_DAYS`) ของในถังขยะต้องหายไปจากทุกจุดที่แขก
 * มองเห็น (แกลลอรี่ สไลด์โชว์ สมุดคำอวยพร สถิติ) ทันทีที่ลบ แต่แอดมินยังต้องเห็น
 * รูปย่อได้เพื่อกู้คืน และกู้คืนแล้วทุกอย่างต้องกลับมาเป๊ะเหมือนเดิม
 */

const dataDir = useTempDataDir('trash');
const app = await startTestServer();
const cookie = await login(app.baseUrl);
const { db } = await import('../src/db.js');
const { config } = await import('../src/config.js');

after(() => app.close());

async function uploadOne(uploader = 'ทดสอบ') {
  const filePath = path.join(dataDir, `${Math.random().toString(36).slice(2)}.jpg`);
  await makeJpeg(filePath);
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(filePath)], { type: 'image/jpeg' }), 'photo.jpg');
  form.append('uploader', uploader);
  const response = await fetch(`${app.baseUrl}/api/upload`, { method: 'POST', body: form });
  const body = await response.json();
  return body.ids[0];
}

function asAdmin(pathname, options = {}) {
  return fetch(`${app.baseUrl}${pathname}`, {
    ...options,
    redirect: 'manual',
    headers: { cookie, ...(options.headers ?? {}) },
  });
}

async function apiIds() {
  const { items } = await (await fetch(`${app.baseUrl}/api/items`)).json();
  return items.map((i) => i.id);
}

/* ---------- ยืนยันตัวตน ---------- */

test('a stranger cannot bulk-delete or restore', async () => {
  const id = await uploadOne();
  for (const [route, body] of [
    ['/admin/items/bulk-delete', `ids=${id}`],
    ['/admin/items/restore', `ids=${id}`],
  ]) {
    const response = await fetch(`${app.baseUrl}${route}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    assert.ok(response.status === 401 || response.status === 302, `${route} → ${response.status}`);
  }
});

/* ---------- ลบทีละใบ = เข้าถังขยะ ไม่ใช่ลบไฟล์จริงทันที ---------- */

test('deleting one photo hides it everywhere but keeps the file on disk', async () => {
  const id = await uploadOne('ครูฟาฏิมะฮ์');
  const row = db.prepare('SELECT stored_name FROM items WHERE id = ?').get(id);
  const filePath = path.join(config.paths.uploads, row.stored_name);
  await fs.access(filePath); // ยังไม่ลบ ต้องเจอไฟล์อยู่

  const response = await asAdmin(`/admin/items/${id}/delete`, { method: 'POST' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/admin?undo=${id}`);

  assert.ok(!(await apiIds()).includes(id), 'ยังโผล่ใน /api/items หลังลบ');
  await fs.access(filePath); // "ลบ" แล้วแต่ไฟล์ต้องยังอยู่ — นี่คือใจกลางของถังขยะ

  const { count } = db.prepare('SELECT COUNT(*) AS count FROM items WHERE id = ? AND deleted_at IS NOT NULL')
    .get(id);
  assert.equal(count, 1);
});

test('the confirm text no longer claims the delete is permanent', async () => {
  // ข้อความเดิมเขียนว่า "ถาวร" มาตั้งแต่ก่อนมีถังขยะ — ถ้ายังพูดแบบนั้นอยู่ เจ้าภาพ
  // จะเข้าใจผิดว่ากดพลาดแล้วกู้คืนไม่ได้ ทั้งที่กู้คืนได้จริง
  for (const code of ['th', 'ms', 'en', 'ar']) {
    const locale = (await import(`../locales/${code}.json`, { with: { type: 'json' } })).default;
    assert.ok(!/permanent|ถาวร|kekal|نهائي/i.test(locale.admin.confirm_delete),
      `${code}: ${locale.admin.confirm_delete}`);
  }
});

/* ---------- กู้คืน ---------- */

test('restoring brings a photo back everywhere', async () => {
  const id = await uploadOne();
  await asAdmin(`/admin/items/${id}/delete`, { method: 'POST' });
  assert.ok(!(await apiIds()).includes(id));

  const response = await asAdmin('/admin/items/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${id}`,
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin');

  assert.ok((await apiIds()).includes(id), 'ไม่กลับมาหลังกู้คืน');
});

test('restoring an id that is not actually trashed is a quiet no-op', async () => {
  const id = await uploadOne();
  const response = await asAdmin('/admin/items/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${id}`,
  });
  assert.equal(response.status, 302, 'กู้คืนของที่ไม่ได้อยู่ในถังขยะต้องไม่ error');
  assert.ok((await apiIds()).includes(id));
});

/* ---------- ลบหลายรูปพร้อมกัน ---------- */

test('bulk-delete removes exactly the selected photos and carries them into ?undo=', async () => {
  const [a, b, c] = [await uploadOne(), await uploadOne(), await uploadOne()];

  const response = await asAdmin('/admin/items/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${a}&ids=${b}`,
  });
  assert.equal(response.status, 302);
  const location = response.headers.get('location');
  assert.match(location, /^\/admin\?undo=/);
  const undone = location.split('undo=')[1].split(',').map(Number);
  assert.deepEqual(undone.sort(), [a, b].sort());

  const ids = await apiIds();
  assert.ok(!ids.includes(a) && !ids.includes(b), 'a/b ยังโผล่อยู่');
  assert.ok(ids.includes(c), 'c ที่ไม่ได้เลือกหายไปด้วย');
});

test('bulk-deleting the same ids twice does not error and stays trashed exactly once', async () => {
  const id = await uploadOne();
  const post = () => asAdmin('/admin/items/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${id}`,
  });

  assert.equal((await post()).status, 302);
  assert.equal((await post()).status, 302, 'ยิงซ้ำต้องไม่ error');

  const row = db.prepare('SELECT deleted_at FROM items WHERE id = ?').get(id);
  assert.ok(row.deleted_at, 'ยังต้องอยู่ในถังขยะ');
});

test('an empty selection posts safely with nothing to undo', async () => {
  const response = await asAdmin('/admin/items/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: '',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/admin');
});

/* ---------- ใครดึงรูปในถังขยะได้บ้าง ---------- */

test('a trashed photo 404s for guests but still loads for the host', async () => {
  const id = await uploadOne();
  await asAdmin(`/admin/items/${id}/delete`, { method: 'POST' });

  for (const route of [`/media/${id}`, `/thumb/${id}`, `/download/${id}`]) {
    const guest = await fetch(`${app.baseUrl}${route}`);
    assert.equal(guest.status, 404, `${route} เปิดได้จากแขกทั้งที่อยู่ในถังขยะ`);

    const host = await fetch(`${app.baseUrl}${route}`, { headers: { cookie } });
    assert.equal(host.status, 200, `${route} แอดมินก็เปิดไม่ได้ — ถังขยะโชว์รูปย่อไม่ได้`);
  }
});

/* ---------- แบนเนอร์เลิกทำ ---------- */

test('the undo banner only lists ids that are still actually trashed', async () => {
  const [a, b] = [await uploadOne(), await uploadOne()];
  await asAdmin('/admin/items/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${a}&ids=${b}`,
  });
  // กู้คืน a ไปก่อนแล้ว แต่ยังตามลิงก์เดิมที่มีทั้ง a และ b อยู่
  await asAdmin('/admin/items/restore', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: `ids=${a}`,
  });

  const html = await (await asAdmin(`/admin?undo=${a},${b}`)).text();
  assert.ok(!html.includes(`value="${a}"`) || html.includes(`value="${b}"`),
    'ต้องมีแค่ b ในแบนเนอร์ ไม่ใช่ a ที่กู้คืนไปแล้ว');
  assert.match(html, new RegExp(`name="ids" value="${b}"`));
});

test('a stale or already-restored ?undo= shows no banner instead of erroring', async () => {
  const response = await asAdmin('/admin?undo=999999,not-a-number');
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes('class="admin-undo'), 'id ที่ไม่ได้อยู่ในถังขยะจริง ไม่ควรมีแบนเนอร์ขึ้นมา');
  // ยืนยันว่าเป็นเพราะ "ไม่มีอะไรให้เลิกทำ" ไม่ใช่เพราะฟีเจอร์นี้ยังไม่มีอยู่เลย
  assert.match(html, /id="admin-bulkbar"/);
});

/* ---------- คำอวยพรที่แนบรูปที่ถูกลบ ---------- */

test('a wish loses its attached photo the moment that photo is trashed', async () => {
  // guestbook แนบรูปด้วยการอัพไฟล์ใหม่ในคำขอเดียวกัน (field ชื่อ attachment) ไม่ใช่
  // ชี้ไปที่ item ที่มีอยู่แล้ว — สร้างไฟล์จริงเพื่อให้ id ที่ได้มาเป็น item จริงในระบบ
  const filePath = path.join(dataDir, `${Math.random().toString(36).slice(2)}.jpg`);
  await makeJpeg(filePath);

  const form = new FormData();
  form.append('author', 'Johan');
  form.append('body', 'Selamat pengantin baru');
  form.append('attachment', new Blob([await fs.readFile(filePath)], { type: 'image/jpeg' }), 'wish.jpg');
  const posted = await fetch(`${app.baseUrl}/api/messages`, { method: 'POST', body: form });
  assert.ok(posted.ok, `guestbook post failed: ${posted.status}`);
  const { id: messageId } = await posted.json();

  const id = db.prepare('SELECT item_id FROM messages WHERE id = ?').get(messageId).item_id;
  assert.ok(id, 'ไม่ได้สร้าง item ให้ไฟล์ที่แนบมา');

  const before = await (await fetch(`${app.baseUrl}/api/messages`)).json();
  const mine = before.messages.find((m) => m.id === messageId);
  assert.ok(mine.item, 'ยังไม่ได้ลบ แต่หารูปที่แนบไม่เจอตั้งแต่แรก');
  assert.ok(mine.item.thumbUrl, 'ยังไม่ได้ลบ แต่ thumbUrl หายไปแล้ว');

  await asAdmin(`/admin/items/${id}/delete`, { method: 'POST' });

  // ตัวชี้ขาดว่าเป็นถังขยะจริง ไม่ใช่ลบถาวรแบบเดิม — id ต้องยังอยู่ใน DB พร้อม deleted_at
  // (โค้ดเก่าลบแถวทิ้งไปเลย ก็ทำให้ /api/messages ไม่มีรูปแนบเหมือนกัน แต่คนละเหตุผล)
  const row = db.prepare('SELECT deleted_at FROM items WHERE id = ?').get(id);
  assert.ok(row && row.deleted_at, 'ลบแล้วแถวควรยังอยู่ในถังขยะ ไม่ใช่หายไปจาก DB เลย');

  const after = await (await fetch(`${app.baseUrl}/api/messages`)).json();
  const stillMine = after.messages.find((m) => m.id === messageId);
  assert.ok(stillMine, 'ข้อความทั้งอันหายไปด้วย — ควรเหลือแค่ข้อความ ไม่ใช่หายทั้งคู่');
  assert.equal(stillMine.item, null, 'รูปที่ถูกลบยังโผล่แนบอยู่กับคำอวยพร');
});

/* ---------- สถิติ ---------- */

test('trashed photos still count toward storage but not toward the headline counts', async () => {
  const before = db.prepare("SELECT COUNT(*) AS count FROM items WHERE status != 'hidden' AND deleted_at IS NULL")
    .get().count;
  const beforeBytes = db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM items').get().bytes;

  const id = await uploadOne();
  const bytes = db.prepare('SELECT bytes FROM items WHERE id = ?').get(id).bytes;
  await asAdmin(`/admin/items/${id}/delete`, { method: 'POST' });

  const { stats } = await import('../src/repo.js');
  const summary = stats();
  assert.equal(summary.photos + summary.videos, before, 'นับของในถังขยะเป็นรูปที่ยังอยู่');
  assert.equal(db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM items').get().bytes, beforeBytes + bytes,
    'ไฟล์ในถังขยะยังกินพื้นที่ดิสก์จริง ตัวเลขพื้นที่ใช้จึงต้องนับรวมด้วย');
});

/* ---------- กวาดถังขยะที่หมดอายุ + จำกัดความถี่ ---------- */

test('the purge sweep removes only what is past the retention window, and runs at most once per hour', async () => {
  // เทสต์ก่อนหน้านี้บางอันเรียก GET /admin ไปแล้ว (เช่นตอนเช็คแบนเนอร์เลิกทำ)
  // ซึ่งไปทริกเกอร์ purgeExpiredTrash() ให้บันทึกเวลาไว้แล้วจริง — บังคับให้ดูเหมือน
  // "ยังไม่เคยกวาดมานานเกินชั่วโมง" เพื่อให้เทสต์นี้ควบคุมจังหวะการกวาดได้เองแน่นอน
  // ไม่ขึ้นกับว่าเทสต์ก่อนหน้าเรียก /admin ไปกี่ครั้งแล้ว
  const { setSetting } = await import('../src/db.js');
  setSetting('trash_purged_at', new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString());

  const overdueId = await uploadOne();
  const overdueRow = db.prepare('SELECT stored_name FROM items WHERE id = ?').get(overdueId);
  const overduePath = path.join(config.paths.uploads, overdueRow.stored_name);
  db.prepare("UPDATE items SET deleted_at = datetime('now', ?) WHERE id = ?")
    .run(`-${config.admin.trashRetentionDays + 1} days`, overdueId);

  const freshId = await uploadOne();
  const freshRow = db.prepare('SELECT stored_name FROM items WHERE id = ?').get(freshId);
  const freshPath = path.join(config.paths.uploads, freshRow.stored_name);
  db.prepare("UPDATE items SET deleted_at = datetime('now') WHERE id = ?").run(freshId);

  await asAdmin('/admin'); // ทริกเกอร์ให้กวาดครั้งแรก

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(overdueId).n, 0,
    'เกินระยะเก็บแล้วต้องถูกลบถาวรจริง');
  await assert.rejects(fs.access(overduePath), 'ไฟล์ที่เกินระยะเก็บต้องถูกลบจากดิสก์จริง');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(freshId).n, 1,
    'ยังไม่เกินระยะเก็บ ไม่ควรถูกกวาดทิ้ง');
  await fs.access(freshPath);

  // แถวใหม่ที่เกินระยะเก็บเหมือนกัน แต่เพิ่งมาถึงหลังกวาดรอบแรกไปแล้ว
  const secondOverdueId = await uploadOne();
  db.prepare("UPDATE items SET deleted_at = datetime('now', ?) WHERE id = ?")
    .run(`-${config.admin.trashRetentionDays + 1} days`, secondOverdueId);

  await asAdmin('/admin'); // ภายในชั่วโมงเดียวกัน — ต้องไม่กวาดซ้ำ

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM items WHERE id = ?').get(secondOverdueId).n, 1,
    'กวาดซ้ำภายในชั่วโมงเดียวกัน ทั้งที่ควรรอ');
});
