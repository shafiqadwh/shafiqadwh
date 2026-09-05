import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

/**
 * หนึ่งงาน = หนึ่งไฟล์ฐานข้อมูล
 *
 * `db` ที่ export ออกไปไม่ใช่ตัวฐานข้อมูลอีกต่อไป แต่เป็น **หน้าตาเดียวกันเป๊ะ**
 * ที่ไปหยิบฐานข้อมูลของงานที่กำลังเปิดอยู่ตอนถูกเรียกจริง · `db.prepare(...)`
 * ห้าสิบกว่าคำสั่งที่ประกาศไว้ระดับโมดูลใน `src/repo.js` จึงไม่ต้องแก้เลยสักบรรทัด
 * ทั้งที่ตอนนี้มันทำงานกับคนละไฟล์กันตามคำขอที่เข้ามา
 *
 * เหตุผลที่แยกไฟล์แทนที่จะใส่คอลัมน์ `event_id` อยู่หัวไฟล์ `src/lib/tenancy.js`
 */
const SCHEMA = `
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

  /*
   * จอทีวีเคยอยู่ตรงนี้ ตอนนี้ย้ายไปอยู่ในทะเบียน (src/lib/tenancy.js) แล้ว
   * — ห้ามใส่ backtick ในคอมเมนต์นี้ มันปิด template literal ของ JS ทั้งก้อน
   *
   * เหตุผล: APK บนทีวีเปิดที่อยู่เดิมเสมอ แต่ต้องให้เจ้าภาพของงานไหนก็ได้ในเครื่องนี้
   * จับคู่มันไปเป็นของงานตัวเองได้ · ตารางที่อยู่ในฐานข้อมูลของงานทำแบบนั้นไม่ได้
   * ฐานข้อมูลเก่าที่ยังมีตารางนี้ค้างอยู่ไม่เป็นไร ไม่มีใครอ่านมันแล้ว และแถวที่
   * จับคู่ไว้ถูกย้ายเข้าทะเบียนให้ครั้งเดียวตอนบูตแรกหลังอัปเดต
   */

  CREATE INDEX IF NOT EXISTS idx_booth_shots_token ON booth_shots (token, sort_order);
  CREATE INDEX IF NOT EXISTS idx_booth_sessions_created ON booth_sessions (created_at DESC);
`;

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
function migrate(database) {
const itemColumns = database.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
if (!itemColumns.includes('deleted_at')) {
  database.exec('ALTER TABLE items ADD COLUMN deleted_at TEXT');
}
database.exec('CREATE INDEX IF NOT EXISTS idx_items_deleted_at ON items (deleted_at)');

/*
 * `album` = รหัสอัลบั้มของงานที่รอบถ่ายนี้สังกัด (โหมด "สแกนแล้วดูได้ทั้งงาน")
 *
 * ว่างได้เสมอ: บูธที่ตั้งเป็นโหมด "เห็นเฉพาะรูปตัวเอง" ไม่ส่งค่านี้ขึ้นมา และรอบ
 * ที่อัปโหลดไว้ก่อนมีฟีเจอร์นี้ก็ไม่มี — ทั้งสองกรณีต้องเปิดหน้า /p/<รหัส> ได้เหมือนเดิม
 * ALTER แบบเดียวกับ deleted_at ข้างบน (เช็ค PRAGMA ก่อน เพราะ ADD COLUMN ไม่ idempotent)
 */
const boothColumns = database.prepare('PRAGMA table_info(booth_sessions)').all().map((c) => c.name);
if (!boothColumns.includes('album')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN album TEXT');
}
/*
 * `expired_at` = วันที่ไฟล์ของรอบนี้ถูกลบทิ้งตามกำหนดเก็บ
 *
 * **แถวไม่ถูกลบตาม** และนั่นคือทั้งหมดที่ทำให้ QR บนกระดาษยังทำงานอยู่: สแกนแล้ว
 * ได้หน้าที่บอกว่ารูปหมดอายุไปแล้วเมื่อไร ไม่ใช่หน้าที่บอกว่า "ยังไม่ขึ้นระบบ
 * กลับมาใหม่" (ซึ่งเป็นคำตอบของอีกสถานะหนึ่งคนละเรื่องกัน) และไม่ใช่หน้าหาย
 * แถวที่เหลือไว้เป็นแค่ทะเบียน ไม่มีรูปอยู่ในนั้นแล้ว
 */
if (!boothColumns.includes('expired_at')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN expired_at TEXT');
}
// ภาพเคลื่อนไหวจากรูปชุดเดียวกับที่พิมพ์ · ว่างได้ (ถ่ายใบเดียว หรือรอบเก่าก่อนมีฟีเจอร์นี้)
if (!boothColumns.includes('gif_name')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN gif_name TEXT');
}
/*
 * รูปย่อของแผ่น — สำหรับกริดในหน้าอัลบั้มเท่านั้น
 *
 * วัดแล้ว: อัลบั้ม 30 รอบที่ใช้แผ่นเต็มความละเอียดกินเน็ตมือถือ **17.7 MB**
 * (และนั่นคือเท่าที่ lazy-load โหลดมาแล้ว เลื่อนดูครบจะมากกว่านั้นอีกเท่าตัว)
 * แขกยืนอยู่ในงานใช้ 4G และแบนด์วิดท์ขาออกของบ้านเจ้าภาพต้องแบ่งให้การอัปโหลดด้วย
 */
if (!boothColumns.includes('thumb_name')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN thumb_name TEXT');
}
/*
 * ขนาดของแผ่น — สำหรับให้สไลด์โชว์วางกรอบได้ถูกสัดส่วนตั้งแต่ก่อนโหลดรูป
 *
 * ไม่มีค่านี้จอจะเดาเป็น 1.2 แล้วกรอบกระพริบเปลี่ยนขนาดตอนรูปโหลดเสร็จ ซึ่งบนกำแพง
 * ที่มีสิบห้าใบพร้อมกันคือการกระตุกทั้งจอ · รอบเก่าที่อัปโหลดไว้ก่อนมีคอลัมน์นี้
 * ปล่อยว่างได้ ตัวอ่านตกกลับไปสัดส่วนกระดาษ 4×6 ซึ่งถูกกับแผ่นเกือบทุกใบอยู่แล้ว
 */
// เช็กทีละคอลัมน์ตามแบบข้างบน — เผื่อฐานข้อมูลที่ถูกอัปเดตค้างกลางทางมาก่อน
if (!boothColumns.includes('width')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN width INTEGER');
}
if (!boothColumns.includes('height')) {
  database.exec('ALTER TABLE booth_sessions ADD COLUMN height INTEGER');
}
database.exec('CREATE INDEX IF NOT EXISTS idx_booth_sessions_album ON booth_sessions (album, created_at DESC)');
}

/**
 * เปิดไฟล์ฐานข้อมูลของงานหนึ่งงาน แล้วทำให้พร้อมใช้ทันที
 *
 * งานใหม่ไม่ต้องมีขั้นตอน "สร้างฐานข้อมูล" แยกต่างหาก — เปิดครั้งแรกได้ตารางครบ
 * และค่าเริ่มต้นครบเลย เพราะทุกคำสั่งเป็น `IF NOT EXISTS` หรือเช็คก่อน ALTER อยู่แล้ว
 * (กฎ idempotency ข้อ 2 ของโปรเจกต์) · เปิดฐานข้อมูลเก่าที่ใช้งานอยู่ก็ได้ผลเหมือนเดิม
 */
function connect(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new Database(file);
  database.pragma('journal_mode = WAL');
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(SCHEMA);
  migrate(database);

  // สวิตช์ตอนเริ่มต้นของงานใหม่มาจาก .env ครั้งเดียว หลังจากนั้นหน้าแอดมินเป็นเจ้าของ
  const read = database.prepare('SELECT value FROM settings WHERE key = ?');
  const write = database.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT (key) DO UPDATE SET value = excluded.value
  `);
  if (!read.get('uploads_enabled')) write.run('uploads_enabled', String(config.uploads.defaultEnabled));
  if (!read.get('require_review')) write.run('require_review', String(config.uploads.defaultRequireReview));

  return { database, statements: new Map(), transactions: new WeakMap() };
}

/*
 * ฐานข้อมูลที่เปิดค้างไว้ · คีย์คือพาธของไฟล์ ไม่ใช่ชื่อย่อของงาน
 *
 * ตั้งใจให้เปิดค้าง: SQLite เปิดไฟล์ถูกมากแต่ไม่ฟรี และงานที่กำลังจัดอยู่มีคำขอ
 * เข้ามาทุกวินาที · เครื่องหนึ่งเครื่องรับงานพร้อมกันไม่กี่งาน ไม่ใช่หลักพัน
 * จึงไม่ต้องมีกลไกปิดไฟล์ที่ไม่ได้ใช้มาเพิ่มความซับซ้อนโดยไม่มีใครได้ประโยชน์
 */
const pool = new Map();

function open() {
  const file = config.paths.db;
  let entry = pool.get(file);
  if (!entry) {
    entry = connect(file);
    pool.set(file, entry);
  }
  return entry;
}

/**
 * คำสั่ง SQL ที่ยังไม่ผูกกับฐานข้อมูลไหน
 *
 * `db.prepare(...)` ทั้งหมดใน repo.js ถูกเรียกตอนโหลดโมดูล ซึ่งเป็นตอนที่ยังไม่รู้
 * เลยว่าคำขอถัดไปจะเป็นของงานไหน · จึงคืนของที่หน้าตาเหมือน statement ของ
 * better-sqlite3 แต่ไปเตรียมคำสั่งจริงกับไฟล์ของงานปัจจุบัน ณ ตอนที่ถูกเรียกใช้
 * แล้วจำไว้ต่อ (ฐานข้อมูล, SQL) — ค่าใช้จ่ายจึงเท่าเดิมหลังคำขอแรกของแต่ละงาน
 */
function statement(sql) {
  const resolve = () => {
    const entry = open();
    let prepared = entry.statements.get(sql);
    if (!prepared) {
      prepared = entry.database.prepare(sql);
      entry.statements.set(sql, prepared);
    }
    return prepared;
  };
  return {
    get: (...args) => resolve().get(...args),
    all: (...args) => resolve().all(...args),
    run: (...args) => resolve().run(...args),
    iterate: (...args) => resolve().iterate(...args),
  };
}

export const db = {
  prepare: statement,
  exec: (sql) => open().database.exec(sql),
  pragma: (sql, options) => open().database.pragma(sql, options),
  /*
   * ธุรกรรมก็ต้องผูกกับฐานข้อมูลตอนถูกเรียก ไม่ใช่ตอนประกาศ — `insertBoothSession`
   * กับ `expireBoothSession` ใน repo.js ประกาศไว้ระดับโมดูลเหมือนกัน
   */
  transaction: (fn) => (...args) => {
    const entry = open();
    // WeakMap ไม่ใช่ Map — `moveHostMedia` เรียก `db.transaction(() => …)()` โดยสร้าง
    // ฟังก์ชันใหม่ทุกครั้ง · แคชแบบธรรมดาจึงโตขึ้นเรื่อย ๆ ตลอดอายุโปรเซส
    // (วัดแล้ว: เรียกห้าพันครั้ง heap โตขึ้น 6.4 MB และไม่มีอะไรคืนเลย)
    let wrapped = entry.transactions.get(fn);
    if (!wrapped) {
      wrapped = entry.database.transaction(fn);
      entry.transactions.set(fn, wrapped);
    }
    return wrapped(...args);
  },
};

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

export function pruneExpiredSessions() {
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
}
