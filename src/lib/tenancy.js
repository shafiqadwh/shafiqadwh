import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config, initialsFrom, useEventPaths } from '../config.js';

/**
 * หลายงานในระบบเดียว — แต่แยกกัน "ด้วยโครงสร้าง" ไม่ใช่ด้วยวินัย
 *
 * เจ้าของขายบริการนี้ให้ลูกค้าหลายราย วันเดียวอาจมีสองงาน และงานหนึ่งกินเวลาสามวัน
 * ทางเลือกมีสองทาง: ยกคอนเทนเนอร์ใหม่ต่อหนึ่งงาน หรือรวมไว้ระบบเดียว
 * เจ้าของเลือกทางหลัง เพราะต้องดูแลเครื่องเดียว อัปเดตครั้งเดียว และรายงานข้ามงานได้
 *
 * **แต่ "ระบบเดียว" ไม่ได้แปลว่า "ฐานข้อมูลเดียว"** — ตรงนี้คือหัวใจของไฟล์นี้
 * ถ้าทุกงานอยู่ในตารางเดียวกันแล้วกรองด้วยคอลัมน์ `event_id` แปลว่าทุกคิวรีในระบบ
 * (มีอยู่ห้าสิบกว่าคำสั่งใน repo.js) ต้องจำเงื่อนไขนั้นให้ครบ **และลืมที่เดียว
 * = รูปงานของลูกค้า ก. ไปโผล่ในแกลลอรี่ของลูกค้า ข.** ซึ่งเป็นความผิดพลาดที่
 * ขอโทษไม่ได้และกู้ไม่ได้ · โปรเจกต์นี้เคยลืมเงื่อนไข `deleted_at` มาแล้วสองจุด
 * ทั้งที่ตอนนั้นมีให้จำแค่ข้อเดียว
 *
 * จึงเลือก **หนึ่งงาน = หนึ่งไฟล์ฐานข้อมูล + หนึ่งโฟลเดอร์ไฟล์** คิวรีของงาน ก.
 * ไม่ได้ "ถูกกรอง" ออกจากข้อมูลงาน ข. — มันไปไม่ถึงตั้งแต่แรกเพราะคนละไฟล์กัน
 * ราคาที่จ่ายคือรายงานข้ามงานต้องอ่านหลายไฟล์ ซึ่งเป็นงานอ่านล้วนที่ทำทีหลังได้
 *
 * ทะเบียนงาน (ไฟล์นี้) เป็นฐานข้อมูลอีกไฟล์แยกต่างหาก เก็บแค่ว่ามีงานอะไรบ้าง
 * โดเมนไหนคืองานไหน และรหัสผ่านของแอดมินลูกค้าแต่ละราย — ไม่มีรูปหรือคำอวยพร
 * อยู่ในนี้เลยแม้แต่แถวเดียว
 */

/** งานเริ่มต้น — งานที่ติดตั้งอยู่บนเครื่องจริงวันนี้ ก่อนที่จะมีคำว่า "หลายงาน" */
export const DEFAULT_SLUG = (process.env.DEFAULT_EVENT_SLUG || 'main').toLowerCase();

/*
 * ชื่อย่อของงาน ใช้เป็นทั้งชื่อโฟลเดอร์และค่าใน URL จึงต้องแคบไว้ก่อน
 * ห้ามมี `.` `/` หรือช่องว่าง — ค่านี้ไปต่อเป็นพาธจริงบนดิสก์
 */
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

export const isSlug = (value) => SLUG.test(String(value ?? ''));

const store = new AsyncLocalStorage();

let control = null;

function controlDb() {
  if (control) return control;
  const file = path.join(config.paths.data, 'db', 'control.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  control = new Database(file);
  control.pragma('journal_mode = WAL');
  control.pragma('busy_timeout = 5000');
  control.exec(`
    CREATE TABLE IF NOT EXISTS events (
      slug        TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      -- โดเมนของงานนี้ · ว่างได้ (งานที่ยังไม่ได้ตั้งโดเมน เข้าถึงด้วย ?event= ได้)
      host        TEXT,
      -- รหัสผ่านแอดมินของลูกค้ารายนี้ (แฮชแล้ว) · ว่าง = ใช้ ADMIN_PASSWORD จาก .env
      password    TEXT,
      -- ป้ายบนหน้าเว็บของงานนี้ · ว่าง = ใช้ค่าจาก .env เหมือนเดิมทุกช่อง
      kind        TEXT,
      names       TEXT,
      venue       TEXT,
      time        TEXT,
      monogram    TEXT,
      starts_on   TEXT,
      ends_on     TEXT,
      -- งานที่จบแล้วและปิดรับทุกอย่าง · แถวยังอยู่เพื่อให้รายงานย้อนหลังได้
      archived_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_host
      ON events (host) WHERE host IS NOT NULL AND host != '';
  `);
  return control;
}

/** ปิดทะเบียน (เทสต์ที่สลับ DATA_DIR ระหว่างทางเท่านั้น — โปรดักชันเปิดค้างไว้) */
export function closeRegistry() {
  control?.close();
  control = null;
}

/**
 * โฟลเดอร์ของงานหนึ่งงาน
 *
 * **งานเริ่มต้นใช้พาธเดิมทุกอันแบบไม่ขยับสักไบต์** — เครื่องจริงที่รันอยู่วันนี้มี
 * รูปอยู่ใน `data/uploads` และฐานข้อมูลอยู่ที่ `data/db/wedding.db` การอัปเดตขึ้น
 * เวอร์ชันนี้จึงไม่ต้องย้ายไฟล์ ไม่ต้อง migrate อะไรเลย · งานที่สร้างใหม่หลังจากนี้
 * ถึงจะไปอยู่ใน `data/events/<ชื่อย่อ>/`
 */
export function pathsFor(slug) {
  const base = config.paths.data;
  if (slug === DEFAULT_SLUG) {
    return {
      uploads: path.join(base, 'uploads'),
      derived: path.join(base, 'derived'),
      booth: path.join(base, 'booth'),
      db: path.join(base, 'db', 'wedding.db'),
      tmp: path.join(base, 'tmp'),
      export: path.join(base, 'export'),
      films: path.join(base, 'export', 'films'),
      papers: path.join(base, 'export', 'papers'),
    };
  }
  const home = path.join(base, 'events', slug);
  return {
    uploads: path.join(home, 'uploads'),
    derived: path.join(home, 'derived'),
    booth: path.join(home, 'booth'),
    db: path.join(home, 'db', 'wedding.db'),
    tmp: path.join(home, 'tmp'),
    export: path.join(home, 'export'),
    films: path.join(home, 'export', 'films'),
    papers: path.join(home, 'export', 'papers'),
  };
}

/**
 * ป้ายที่จะขึ้นบนหน้าเว็บของงานนี้
 *
 * ช่องไหนไม่ได้ตั้งในทะเบียนก็ตกกลับไปใช้ค่าจาก `.env` — งานเริ่มต้นจึงได้หน้าตา
 * เดิมทุกตัวอักษรโดยไม่ต้องกรอกอะไรใหม่ และงานที่สร้างเพิ่มก็เขียนทับได้ทีละช่อง
 */
function branding(row) {
  return {
    kind: row.kind || config.event.kind,
    title: row.title || config.event.title,
    names: row.names || config.event.names,
    date: row.starts_on || config.event.date,
    venue: row.venue || config.event.venue,
    time: row.time || config.event.time,
    // งานที่ตั้งชื่อคู่ของตัวเองต้องได้โมโนแกรมของตัวเองด้วย ไม่ใช่ตัวย่อของงานใน .env
    monogram: row.monogram
      || (row.names ? initialsFrom(row.names) : '')
      || config.event.monogram,
  };
}

const decorate = (row) => (row
  ? { ...row, paths: pathsFor(row.slug), branding: branding(row) }
  : null);

/**
 * โฟลเดอร์ของงานใหม่ต้องมีตั้งแต่ก่อนคำขอแรก
 *
 * ที่เก็บไฟล์ชั่วคราวของ multer ถูกเลือกตอนรับคำขอ ถ้าโฟลเดอร์ยังไม่มี แขกคนแรก
 * ของงานใหม่จะได้ "เกิดข้อผิดพลาดที่เซิร์ฟเวอร์" ทั้งที่ไฟล์ไม่มีอะไรผิดเลย
 * (เจอจริงตอนเขียนเทสต์ข้อแรกของ `test/multi-event.test.js`)
 */
export function prepareStorage(slug) {
  const paths = pathsFor(slug);
  for (const dir of [
    paths.uploads, paths.derived, paths.booth, paths.tmp,
    paths.export, paths.films, paths.papers, path.dirname(paths.db),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

/** งานเริ่มต้นต้องมีอยู่เสมอ — เครื่องที่เพิ่งอัปเดตขึ้นมาต้องใช้งานได้ทันทีโดยไม่ต้องตั้งอะไร */
function ensureDefault() {
  const found = controlDb().prepare('SELECT * FROM events WHERE slug = ?').get(DEFAULT_SLUG);
  if (found) return found;

  // โดเมนมาจาก BASE_URL ที่ตั้งไว้อยู่แล้ว — ไม่ต้องให้เจ้าของพิมพ์ซ้ำ
  let host = '';
  try {
    host = config.baseUrl ? new URL(config.baseUrl).hostname.toLowerCase() : '';
  } catch { host = ''; }

  controlDb().prepare(
    'INSERT INTO events (slug, title, host, starts_on) VALUES (?, ?, ?, ?)',
  ).run(DEFAULT_SLUG, config.event.title, host, config.event.date || null);
  return controlDb().prepare('SELECT * FROM events WHERE slug = ?').get(DEFAULT_SLUG);
}

export function defaultEvent() {
  return decorate(ensureDefault());
}

export function findEvent(slug) {
  if (!isSlug(slug)) return null;
  ensureDefault();
  return decorate(controlDb().prepare('SELECT * FROM events WHERE slug = ?').get(String(slug)));
}

export function listEvents({ includeArchived = true } = {}) {
  ensureDefault();
  const rows = controlDb().prepare(`
    SELECT * FROM events
    ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
    ORDER BY COALESCE(starts_on, created_at) DESC, slug
  `).all();
  return rows.map(decorate);
}

/** โฮสต์ที่มากับคำขอ → งาน · ตัดพอร์ตออกและเทียบตัวพิมพ์เล็กเสมอ */
export function eventForHost(host) {
  const name = String(host ?? '').toLowerCase().split(':')[0].trim();
  if (!name) return null;
  ensureDefault();
  return decorate(controlDb().prepare('SELECT * FROM events WHERE host = ?').get(name));
}

/** ช่องที่ super admin แก้ได้ → ชื่อคอลัมน์ในทะเบียน */
const FIELDS = {
  title: 'title',
  host: 'host',
  kind: 'kind',
  names: 'names',
  venue: 'venue',
  time: 'time',
  monogram: 'monogram',
  startsOn: 'starts_on',
  endsOn: 'ends_on',
};

export function createEvent({ slug, title, ...rest }) {
  if (!isSlug(slug)) throw new Error(`ชื่อย่อของงานใช้ไม่ได้: "${slug}"`);
  ensureDefault();
  controlDb().prepare('INSERT INTO events (slug, title) VALUES (?, ?)')
    .run(slug, String(title || slug));
  prepareStorage(slug);
  return updateEvent(slug, rest);
}

export function updateEvent(slug, fields = {}) {
  const event = findEvent(slug);
  if (!event) return null;
  const columns = FIELDS;
  for (const [key, column] of Object.entries(columns)) {
    if (fields[key] === undefined) continue;
    const value = key === 'host'
      ? String(fields[key] || '').toLowerCase().trim()
      : (fields[key] || null);
    controlDb().prepare(`UPDATE events SET ${column} = ? WHERE slug = ?`).run(value, slug);
  }
  if (fields.archived !== undefined) {
    controlDb().prepare(
      `UPDATE events SET archived_at = ${fields.archived ? "datetime('now')" : 'NULL'} WHERE slug = ?`,
    ).run(slug);
  }
  return findEvent(slug);
}

/*
 * รหัสผ่านของแอดมินลูกค้า — เก็บเป็นแฮช ไม่ใช่ค่าจริง
 *
 * ต่างจาก ADMIN_PASSWORD ใน .env ตรงที่ค่านี้ตั้งผ่านหน้าเว็บได้ จึงต้องถือว่ามัน
 * รั่วได้ (สำรองฐานข้อมูล, ใครเปิดไฟล์ดู) · scrypt มากับ Node อยู่แล้ว ไม่ต้องเพิ่ม
 * แพ็กเกจใหม่ซึ่งเป็นกฎข้อหนึ่งของโปรเจกต์นี้
 */
export function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(plain), salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function passwordMatches(stored, candidate) {
  const [scheme, saltHex, hashHex] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const given = crypto.scryptSync(String(candidate ?? ''), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, given);
}

export function setEventPassword(slug, plain) {
  const value = plain ? hashPassword(plain) : null;
  controlDb().prepare('UPDATE events SET password = ? WHERE slug = ?').run(value, slug);
  return findEvent(slug);
}

/**
 * งานของคำขอที่กำลังทำอยู่
 *
 * นอกเส้นทางคำขอ (งานเบื้องหลังตอนบูต, สคริปต์, เทสต์ที่เรียกโค้ดตรง ๆ) คืนงาน
 * เริ่มต้น — พฤติกรรมเดิมของระบบเป๊ะ ๆ ก่อนที่จะมีหลายงาน
 */
export function currentEvent() {
  return store.getStore() ?? defaultEvent();
}

export const runInEvent = (event, fn) => store.run(event, fn);

/**
 * ผูกงานเข้ากับคำขอที่กำลังเข้ามา — **ต้องเป็น `enterWith` ไม่ใช่ `run`**
 *
 * เบราว์เซอร์ใช้การเชื่อมต่อเดิมซ้ำ (keep-alive) และเนื้อคำขอ (multipart ของรูป
 * และคำอวยพร) ถูกอ่านออกมาจาก **ซ็อกเก็ต** ไม่ใช่จากสายที่ handler วิ่งอยู่
 * `store.run(event, next)` จึงครอบได้แค่ช่วงที่ยังไม่แตะเนื้อคำขอ พอ multer
 * เริ่มอ่าน body ของคำขอที่ **สอง** บนการเชื่อมต่อเดิม callback จะกลับไปอยู่ใน
 * บริบทของคำขอ **ก่อนหน้า** — วัดแล้วเห็นกับตา:
 *
 *     DBG ก่อนเข้า multer: rina      ← ถูก
 *     DBG ใน callback:     main      ← ผิด · คำอวยพรของรินาถูกเขียนลงงานอื่น
 *
 * นี่คือความผิดพลาดที่เงียบที่สุดเท่าที่ระบบนี้จะมีได้: ไม่มี error ไม่มีใครรู้
 * จนกว่าลูกค้าจะเห็นรูปของคนอื่นในงานตัวเอง · `enterWith` เขียนบริบทลงไปที่
 * ทรัพยากรของซ็อกเก็ตเองจึงติดไปกับการอ่าน body ทุกก้อนของคำขอนั้น และคำขอถัดไป
 * บนซ็อกเก็ตเดียวกันก็เขียนทับใหม่ (HTTP/1.1 ทำทีละคำขอต่อการเชื่อมต่อเสมอ)
 */
export const enterEvent = (event) => store.enterWith(event);

/** ทำงานเดียวกันให้ครบทุกงาน — ใช้กับงานเบื้องหลังที่เดิมทำให้งานเดียว */
export async function forEachEvent(fn) {
  const results = [];
  for (const event of listEvents()) {
    results.push(await runInEvent(event, () => fn(event)));
  }
  return results;
}

// พาธทุกอันที่ขึ้นกับงาน อ่านค่าจาก ALS ตอนถูกเรียก ไม่ใช่ตอนโหลดโมดูล —
// จุดเรียกใช้ห้าสิบกว่าแห่งใน src/ จึงไม่ต้องแก้แม้แต่บรรทัดเดียว
useEventPaths(() => store.getStore()?.paths ?? null);
