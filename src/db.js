import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });

export const db = new Database(config.paths.db);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
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

  CREATE INDEX IF NOT EXISTS idx_items_status_created ON items (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_convert_state  ON items (convert_state);
  -- ค้นหาและจัดกลุ่มตามชื่อผู้ส่ง (หน้าแกลลอรี่ + รายชื่อแขก + PDF)
  CREATE INDEX IF NOT EXISTS idx_items_uploader       ON items (uploader);

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT,
    body       TEXT    NOT NULL,
    item_id    INTEGER REFERENCES items (id) ON DELETE SET NULL,
    status     TEXT    NOT NULL DEFAULT 'visible'
               CHECK (status IN ('visible', 'pending', 'hidden')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_messages_author         ON messages (author);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  /*
   * รูปที่ "เจ้าภาพ" อัพเอง — ภาพปก การ์ดเชิญ รูปงาน สำหรับโชว์บนหน้าแรก
   *
   * แยกตารางจาก items โดยตั้งใจ ไม่ใช่เพิ่มคอลัมน์บอกชนิดลงใน items
   * เพราะทุกเส้นทางที่อ่าน items — แกลลอรี่ สไลด์โชว์ หนัง ZIP รายชื่อแขก สถิติ —
   * จะต้องเติมเงื่อนไขกรองออกให้ครบทุกที่ และลืมที่เดียวก็แปลว่าการ์ดเชิญ
   * ของเจ้าภาพไปโผล่กลางหนังงานแต่ง · โปรเจกต์นี้เคยลืมเงื่อนไข deleted_at
   * มาแล้วสองจุดทั้งที่ตอนนั้นมีให้จำแค่ข้อเดียว — คนละตารางกันจึงกันได้ตั้งแต่ต้น
   */
  CREATE TABLE IF NOT EXISTS host_media (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    slot         TEXT    NOT NULL CHECK (slot IN ('cover', 'invitation', 'photo')),
    stored_name  TEXT    NOT NULL UNIQUE,
    display_name TEXT,
    thumb_name   TEXT,
    mime         TEXT    NOT NULL,
    bytes        INTEGER NOT NULL,
    width        INTEGER,
    height       INTEGER,
    caption      TEXT,
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_host_media_slot ON host_media (slot, sort_order, id);

  /*
   * รอบถ่ายจาก photo booth ที่อัปโหลดขึ้นมาหลังงาน
   *
   * แยกตารางด้วยเหตุผลเดียวกับ host_media และหนักกว่าเดิม: รูปจากบูธไม่ใช่ของที่
   * แขกส่งเข้ามาในงาน มันจึงต้องไม่ไปโผล่ในแกลลอรี่ สไลด์โชว์ หนัง ZIP หรือ
   * รายชื่อแขก · เข้าถึงได้ทางเดียวคือ /p/<โทเคน> ที่พิมพ์อยู่บนกระดาษของเจ้าตัว
   *
   * โทเคนเป็น PRIMARY KEY เอง ไม่ใช่ id ที่นับขึ้นเรื่อย ๆ — อัปโหลดซ้ำโทเคนเดิม
   * (เน็ตหลุดกลางทางแล้วสั่งใหม่) จึงชนกันเองแล้วเรารู้ทันที ไม่เกิดของซ้ำเงียบ ๆ
   */
  CREATE TABLE IF NOT EXISTS booth_sessions (
    token       TEXT    PRIMARY KEY,
    taken_at    TEXT    NOT NULL,
    event_title TEXT,
    template    TEXT,
    effect      TEXT,
    sheet_name  TEXT    NOT NULL UNIQUE,
    bytes       INTEGER NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS booth_shots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    token       TEXT    NOT NULL REFERENCES booth_sessions (token) ON DELETE CASCADE,
    stored_name TEXT    NOT NULL UNIQUE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_booth_shots_token ON booth_shots (token, sort_order);
  CREATE INDEX IF NOT EXISTS idx_booth_sessions_created ON booth_sessions (created_at DESC);
`);

/**
 * การแก้ schema ครั้งแรกของโปรเจกต์ — จนถึงตอนนี้ตารางโตแบบเพิ่มอย่างเดียว
 * (`CREATE TABLE/INDEX IF NOT EXISTS`) ไม่เคยต้องมาแก้ตารางที่มีอยู่แล้วบนเครื่องจริง
 *
 * `ALTER TABLE ... ADD COLUMN` ปลอดภัย (คอลัมน์ nullable ไม่มี default ไม่ต้อง
 * เขียนตารางใหม่ทั้งก้อนแบบที่แก้ CHECK constraint ต้องทำ) แต่ไม่ idempotent เอง
 * แบบ `IF NOT EXISTS` — รันซ้ำจะ error "duplicate column name" จึงต้องเช็คก่อนด้วย
 * PRAGMA table_info() แล้วค่อย ALTER เฉพาะตอนยังไม่มีคอลัมน์นี้จริง ๆ
 *
 * `deleted_at` คือเวลาที่กดลบ — ว่าง = ไม่ได้อยู่ในถังขยะ ไม่แตะ `status` เดิมเลย
 * เพราะ status บอกว่า "แขกเห็นไหม" ส่วน deleted_at บอกว่า "อยู่ในถังขยะไหม"
 * เป็นคนละมิติกัน แถวหนึ่งจึงเป็น hidden+deleted พร้อมกันได้ (กู้คืนมาแล้วยังซ่อนอยู่)
 */
const itemColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
if (!itemColumns.includes('deleted_at')) {
  db.exec('ALTER TABLE items ADD COLUMN deleted_at TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items (deleted_at)');

/*
 * `album` = รหัสอัลบั้มของงานที่รอบถ่ายนี้สังกัด (โหมด "สแกนแล้วดูได้ทั้งงาน")
 *
 * ว่างได้เสมอ: บูธที่ตั้งเป็นโหมด "เห็นเฉพาะรูปตัวเอง" ไม่ส่งค่านี้ขึ้นมา และรอบ
 * ที่อัปโหลดไว้ก่อนมีฟีเจอร์นี้ก็ไม่มี — ทั้งสองกรณีต้องเปิดหน้า /p/<รหัส> ได้เหมือนเดิม
 * ALTER แบบเดียวกับ deleted_at ข้างบน (เช็ค PRAGMA ก่อน เพราะ ADD COLUMN ไม่ idempotent)
 */
const boothColumns = db.prepare('PRAGMA table_info(booth_sessions)').all().map((c) => c.name);
if (!boothColumns.includes('album')) {
  db.exec('ALTER TABLE booth_sessions ADD COLUMN album TEXT');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_booth_sessions_album ON booth_sessions (album, created_at DESC)');

const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const writeSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

export function getSetting(key, fallback = null) {
  const row = readSetting.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  writeSetting.run(key, String(value));
}

export function getFlag(key, fallback) {
  const value = getSetting(key);
  if (value === null) return fallback;
  return value === 'true';
}

export function setFlag(key, value) {
  setSetting(key, value ? 'true' : 'false');
}

// Seed the runtime switches from the environment on first boot only; after that
// the admin panel owns them.
if (getSetting('uploads_enabled') === null) {
  setFlag('uploads_enabled', config.uploads.defaultEnabled);
}
if (getSetting('require_review') === null) {
  setFlag('require_review', config.uploads.defaultRequireReview);
}

export function pruneExpiredSessions() {
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
}
