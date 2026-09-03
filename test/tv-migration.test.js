import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import Database from 'better-sqlite3';
import { useTempDataDir } from './helpers/app.js';

/**
 * ทีวีที่จับคู่ไว้แล้วต้องไม่หลุดเพราะการอัปเดต
 *
 * รุ่นก่อนเก็บทะเบียนจอไว้ในฐานข้อมูลของงาน · รุ่นนี้ย้ายไปไว้ในทะเบียนกลาง
 * เพื่อให้ APK ตัวเดียวรับได้หลายงาน (เหตุผลอยู่ใน src/lib/tenancy.js)
 *
 * ถ้าไม่ย้ายแถวเก่าให้ ทีวีที่ตั้งไว้แล้วบนเครื่องจริงจะเด้งกลับไปหน้าจับคู่หลัง
 * อัปเดต ซึ่งแปลว่าเจ้าของต้องเดินไปยืนหน้าจอพร้อมมือถืออีกรอบโดยไม่มีเหตุผลเลย
 * — และถ้าอัปเดตตอนเช้าวันงาน ก็คือจอดำจนกว่าจะมีคนไปยืนหน้าทีวี
 */

const dataDir = useTempDataDir('tv-migration');

// สร้างฐานข้อมูลหน้าตาแบบรุ่นก่อน **ก่อน** ที่โค้ดรุ่นใหม่จะเปิดทะเบียนครั้งแรก
const legacy = path.join(dataDir, 'db', 'wedding.db');
fs.mkdirSync(path.dirname(legacy), { recursive: true });
const old = new Database(legacy);
old.exec(`
  CREATE TABLE tv_screens (
    device TEXT PRIMARY KEY, code TEXT, code_at TEXT, mode TEXT,
    label TEXT, paired_at TEXT, seen_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
old.prepare("INSERT INTO tv_screens (device, mode, label, paired_at) VALUES (?, 'wall', ?, ?)")
  .run('device-token-from-before-the-upgrade', 'โถงหน้า', '2026-09-01 18:00:00');
// จอที่ยังไม่ได้จับคู่ (โชว์รหัสค้างไว้เฉย ๆ) ไม่ต้องย้าย — รหัสหมดอายุไปแล้วอยู่ดี
old.prepare("INSERT INTO tv_screens (device, code, code_at) VALUES ('waiting', 'AB12CD', datetime('now'))")
  .run();
old.close();

const { findScreen, listScreens } = await import('../src/lib/tv.js');
const { DEFAULT_SLUG } = await import('../src/lib/tenancy.js');

after(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
});

test('a TV paired before the upgrade keeps playing without being re-paired', () => {
  const screen = findScreen('device-token-from-before-the-upgrade');
  assert.ok(screen, 'จอที่จับคู่ไว้แล้วต้องยังอยู่หลังอัปเดต');
  assert.equal(screen.mode, 'wall');
  assert.equal(screen.label, 'โถงหน้า');

  // และต้องกลายเป็นของ "งานเริ่มต้น" ซึ่งเป็นงานเดียวที่มีอยู่ก่อนอัปเดต
  assert.equal(screen.event, DEFAULT_SLUG);
  assert.deepEqual(listScreens(DEFAULT_SLUG).map((one) => one.label), ['โถงหน้า']);

  // จอที่ยังไม่ได้จับคู่ไม่ต้องย้ายมา — รหัสของมันหมดอายุไปตั้งแต่ก่อนอัปเดตแล้ว
  assert.equal(findScreen('waiting'), undefined);
});
