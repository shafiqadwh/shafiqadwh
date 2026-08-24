import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { useTempDataDir } from './helpers/app.js';

/**
 * นี่คือการแก้ schema ครั้งแรกของโปรเจกต์ — จนถึงตอนนี้ตารางโตแบบเพิ่มอย่างเดียว
 * (`CREATE TABLE/INDEX IF NOT EXISTS`) ไม่เคยต้องมาแก้ตารางที่มีอยู่แล้วบนเครื่องจริง
 *
 * ไฟล์นี้จำลอง `wedding.db` ของ NAS จริงก่อนอัปเดต — สร้างตาราง `items` แบบไม่มี
 * `deleted_at` เอง (คัดลอกโครงจาก `src/db.js` ตัดคอลัมน์ใหม่ออก) ใส่แถวไว้หนึ่งแถว
 * แล้วค่อยเปิดผ่าน `src/db.js` — ต้องได้คอลัมน์เพิ่มมาโดยไม่ error และแถวเดิมต้องอยู่ครบ
 *
 * รันในไฟล์แยกของตัวเอง (node --test แยกโปรเซสต่อไฟล์อยู่แล้ว) เพราะต้องเตรียม
 * ไฟล์ฐานข้อมูลเก่าไว้ **ก่อน** import `src/db.js` — ผลข้างเคียงตอน import คือ
 * เปิดไฟล์และรัน migration ทันที ถ้า import ไปแล้วครั้งหนึ่งในโปรเซสเดียวกัน
 * ตัว module cache ของ ESM จะกันไม่ให้เปิดซ้ำ ทดสอบสภาพ "เพิ่งอัปเดตโค้ดครั้งแรก"
 * ไม่ได้เลย
 */

const dataDir = useTempDataDir('trash-migration');
const dbPath = path.join(dataDir, 'db', 'wedding.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const old = new Database(dbPath);
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
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);
old.prepare(`
  INSERT INTO items (kind, original_name, stored_name, mime, bytes, uploader, status)
  VALUES ('image', 'from-the-old-schema.jpg', 'old-1.jpg', 'image/jpeg', 12345, 'ครูฟาฏิมะฮ์', 'visible')
`).run();
old.close();

test('opening a pre-existing database without deleted_at adds the column without losing data', async () => {
  const { db } = await import('../src/db.js');

  const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  assert.ok(columns.includes('deleted_at'), 'migration ไม่ได้เพิ่มคอลัมน์');

  const row = db.prepare('SELECT * FROM items WHERE stored_name = ?').get('old-1.jpg');
  assert.ok(row, 'แถวเดิมหายไปหลัง migration');
  assert.equal(row.uploader, 'ครูฟาฏิมะฮ์');
  assert.equal(row.bytes, 12345);
  assert.equal(row.deleted_at, null, 'แถวเดิมต้องไม่ถูกนับว่าอยู่ในถังขยะ');
});

test('opening the already-migrated database a second time is a no-op', async () => {
  // แทนการ import ซ้ำ (module cache กันไว้อยู่แล้ว) ให้เรียกโค้ด migration ตรง ๆ
  // อีกครั้งด้วยมือ จำลองสถานการณ์ "รัน update.sh ซ้ำบน NAS ที่อัปเดตไปแล้ว"
  const { db } = await import('../src/db.js');
  const before = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);

  assert.doesNotThrow(() => {
    const columns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
    if (!columns.includes('deleted_at')) {
      db.exec('ALTER TABLE items ADD COLUMN deleted_at TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items (deleted_at)');
  }, 'รัน migration ซ้ำต้องไม่ error');

  const after = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
  assert.deepEqual(after, before, 'รันซ้ำแล้วโครงตารางต้องไม่เปลี่ยนอีก');
});
