import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { useTempDataDir } from './helpers/app.js';

/**
 * เครื่องที่รันอยู่จริงวันนี้ อัปเดตขึ้นรุ่นนี้แล้วต้องรอด
 *
 * ตั้งแต่ deploy ครั้งสุดท้ายบน NAS มีการเปลี่ยนแปลงสะสมไว้สามสิบกว่าคอมมิต รวมถึง
 * **การรื้อเป็นระบบหลายงาน** ซึ่งเพิ่มไฟล์ฐานข้อมูลใหม่ (ทะเบียนงาน) และเปลี่ยนวิธี
 * ตัดสินว่าไฟล์ของงานอยู่ที่ไหน · ไฟล์อื่นในโฟลเดอร์นี้ตรวจการย้ายทีละชิ้น
 * (`trash-migration` ดูคอลัมน์เดียว · `tv-migration` ดูตารางเดียว) แต่ **ไม่มีไฟล์ไหน
 * ตรวจสิ่งที่จะเกิดขึ้นจริงตอนกด `sudo ./scripts/update.sh`: ของทั้งก้อนพร้อมกัน**
 *
 * ไฟล์นี้จำลองสภาพ `data/` ของ NAS ณ คอมมิตที่ deploy ไปล่าสุด (2f86261) —
 * มีรูปของแขกอยู่บนดิสก์ มีแถวในฐานข้อมูล มีคำอวยพร มีค่าตั้ง แต่ **ยังไม่มีทะเบียนงาน
 * ไม่มีตารางของบูธ ไม่มีทะเบียนทีวี** แล้วเปิดด้วยโค้ดรุ่นนี้
 *
 * สิ่งที่กลัวไม่ใช่ "อัปเดตแล้ว error" (เห็นทันทีและ rollback ได้) แต่คือ **รูปงานแต่ง
 * ของลูกค้าที่ส่งมอบไปแล้วหายไปเงียบ ๆ เพราะระบบใหม่ไปมองหาไฟล์ผิดที่**
 */

const dataDir = useTempDataDir('upgrade-live');

/* ── สร้าง data/ ให้เหมือนเครื่องจริงก่อนอัปเดต ─────────────────────────── */

const legacyDb = path.join(dataDir, 'db', 'wedding.db');
fs.mkdirSync(path.dirname(legacyDb), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'derived'), { recursive: true });

// ไฟล์จริงบนดิสก์ — ไบต์พวกนี้คือรูปงานแต่งของลูกค้าในสายตาของเทสต์นี้
const PHOTO = Buffer.from('รูปของแขกที่ส่งมอบไปแล้ว', 'utf8');
fs.writeFileSync(path.join(dataDir, 'uploads', 'guest-photo.jpg'), PHOTO);
fs.writeFileSync(path.join(dataDir, 'derived', 'guest-photo-thumb.jpg'), PHOTO);

const old = new Database(legacyDb);
old.exec(`
  CREATE TABLE items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
    original_name  TEXT    NOT NULL,
    stored_name    TEXT    NOT NULL UNIQUE,
    playback_name  TEXT,
    thumb_name     TEXT,
    mime           TEXT    NOT NULL,
    bytes          INTEGER NOT NULL,
    width          INTEGER,
    height         INTEGER,
    duration       REAL,
    uploader       TEXT,
    status         TEXT    NOT NULL DEFAULT 'visible'
                   CHECK (status IN ('visible', 'pending', 'hidden')),
    convert_state  TEXT    NOT NULL DEFAULT 'none'
                   CHECK (convert_state IN ('none', 'queued', 'running', 'done', 'failed')),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    deleted_at     TEXT
  );
  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT,
    body       TEXT    NOT NULL,
    item_id    INTEGER REFERENCES items (id) ON DELETE SET NULL,
    status     TEXT    NOT NULL DEFAULT 'visible'
               CHECK (status IN ('visible', 'pending', 'hidden')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);
old.prepare(`
  INSERT INTO items (kind, original_name, stored_name, thumb_name, mime, bytes,
                     width, height, uploader)
  VALUES ('image', 'IMG_4823.HEIC', 'guest-photo.jpg', 'guest-photo-thumb.jpg',
          'image/jpeg', ?, 1200, 1600, 'ป้าแดง')
`).run(PHOTO.length);
old.prepare("INSERT INTO messages (author, body) VALUES ('ครูฟาฏิมะฮ์', 'ขอให้มีความสุขมาก ๆ นะ')").run();
old.prepare("INSERT INTO settings (key, value) VALUES ('require_review', 'true')").run();
old.close();

/* ── แล้วเปิดด้วยโค้ดรุ่นนี้ ────────────────────────────────────────────── */

const { startTestServer } = await import('./helpers/app.js');
const app = await startTestServer();

after(async () => {
  await app.close();
  await fsp.rm(dataDir, { recursive: true, force: true });
});

test('the site comes up and still knows every photo and wish it had', async () => {
  const { items } = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.equal(items.length, 1, 'รูปที่มีอยู่ก่อนอัปเดตต้องยังอยู่ครบ');
  assert.equal(items[0].uploader, 'ป้าแดง');

  const { messages } = await (await fetch(`${app.baseUrl}/api/messages`)).json();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].author, 'ครูฟาฏิมะฮ์');

  // และไฟล์จริงต้องยังเสิร์ฟได้ ไม่ใช่แค่แถวยังอยู่แต่รูปเปิดไม่ขึ้น
  const media = await fetch(`${app.baseUrl}/media/${items[0].id}`);
  assert.equal(media.status, 200);
  assert.ok(Buffer.from(await media.arrayBuffer()).equals(PHOTO));
});

test('nothing on disk moves — the upgrade must not touch a single guest file', async () => {
  /*
   * ข้อนี้คือเหตุผลที่ไฟล์นี้มีอยู่
   *
   * ระบบหลายงานเก็บไฟล์ของงานใหม่ไว้ที่ `data/events/<ชื่อย่อ>/` · ถ้างานเดิม
   * ถูกนับเป็น "งานหนึ่ง" ตามกติกาใหม่ด้วย มันจะไปมองหารูปที่ `data/events/main/`
   * ซึ่งว่างเปล่า แล้ว **แกลลอรี่ของลูกค้าที่ส่งมอบไปแล้วจะกลายเป็นหน้าว่าง**
   * โดยไม่มี error ให้ใครเห็น เพราะโฟลเดอร์ว่างไม่ใช่ความผิดพลาด
   */
  assert.deepEqual(fs.readdirSync(path.join(dataDir, 'uploads')), ['guest-photo.jpg']);
  assert.ok(fs.existsSync(legacyDb), 'ฐานข้อมูลเดิมต้องยังเป็นฐานข้อมูลของงานเดิม');

  assert.equal(
    fs.existsSync(path.join(dataDir, 'events', 'main')),
    false,
    'งานเดิมต้องไม่ถูกย้ายไปโฟลเดอร์ของระบบใหม่',
  );

  const { pathsFor, DEFAULT_SLUG } = await import('../src/lib/tenancy.js');
  const paths = pathsFor(DEFAULT_SLUG);
  assert.equal(paths.uploads, path.join(dataDir, 'uploads'));
  assert.equal(paths.db, legacyDb);
});

test('the new machinery is there, without having asked anyone to run anything', async () => {
  // ทะเบียนงานถูกสร้างให้เอง พร้อมงานเดิมอยู่ในนั้นหนึ่งงาน
  assert.ok(fs.existsSync(path.join(dataDir, 'db', 'control.db')));

  const { listEvents, DEFAULT_SLUG } = await import('../src/lib/tenancy.js');
  const events = listEvents();
  assert.equal(events.length, 1);
  assert.equal(events[0].slug, DEFAULT_SLUG);
  // งานที่ไม่ได้ระบุภาษาต้องได้ครบทุกภาษาเหมือนเดิม ไม่ใช่เหลือภาษาเดียว
  assert.deepEqual(events[0].branding.languages.sort(), ['ar', 'en', 'ms', 'th']);

  // ตารางกับคอลัมน์ที่เพิ่มมาหลังจากนั้นต้องมีครบ โดยไม่ต้องมีใครสั่ง migrate
  const live = new Database(legacyDb, { readonly: true });
  try {
    const columns = (table) =>
      live.prepare(`PRAGMA table_info(${table})`).all().map((one) => one.name);
    assert.ok(columns('booth_sessions').includes('width'), 'คอลัมน์ที่เพิ่งเพิ่มต้องถูกสร้างให้');
    assert.ok(columns('booth_sessions').includes('album'));
    assert.ok(columns('items').includes('deleted_at'));
  } finally {
    live.close();
  }
});

test('the settings the host had chosen survive the upgrade', async () => {
  // "ตรวจก่อนโชว์" ที่เจ้าภาพเปิดไว้ ต้องไม่ถูกรีเซ็ตเป็นค่าเริ่มต้นตอนอัปเดต —
  // รีเซ็ตแล้วรูปที่ยังไม่ได้ตรวจจะขึ้นจอทันทีในงานถัดไป ซึ่งเป็นเหตุผลที่เขาเปิดมันไว้
  const { getFlag } = await import('../src/db.js');
  assert.equal(getFlag('require_review', false), true);
});

test('and the site still takes new photos after the upgrade', async () => {
  // อัปเดตแล้วอ่านของเก่าได้อย่างเดียวไม่พอ — งานถัดไปต้องรับของใหม่ได้ด้วย
  const { makeJpeg } = await import('./helpers/fixtures.js');
  const file = path.join(dataDir, 'fresh.jpg');
  await makeJpeg(file, { width: 640, height: 480, colour: '#c8a27a' });

  const form = new FormData();
  form.append('files', new Blob([await fsp.readFile(file)]), 'fresh.jpg');
  form.append('uploader', 'แขกคนใหม่');
  const sent = await fetch(`${app.baseUrl}/api/upload`, { method: 'POST', body: form });
  assert.equal(sent.status, 201, await sent.text());

  // ของใหม่ต้องไปอยู่ที่เดียวกับของเก่า ไม่ใช่แยกไปโฟลเดอร์ของระบบใหม่
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).length, 2);
});
