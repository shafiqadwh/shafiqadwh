import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { CRITICAL_BYTES, ROUND_BYTES, diskWarning, freeBytes } from '../src/main/disk.js';

/**
 * เตือนก่อนดิสก์เต็ม
 *
 * บูธเก็บรูปดิบทุกใบของทุกรอบไว้ถาวรและไม่มีอะไรลบให้ · วัดจากภาพที่รายละเอียด
 * เต็มเฟรมแบบภาพถ่ายจริงแล้วได้ ~3.8 MB ต่อรอบด้วยเว็บแคม และ ~20.6 MB ด้วย DSLR
 * — งาน 200 รอบด้วยกล้องใหญ่คือ 4 GB ที่ไม่มีวันหายไปเอง
 *
 * **จังหวะที่ดิสก์เต็มคือจังหวะที่แย่ที่สุด**: โหมดจ่ายก่อนถ่ายรับเงินไปแล้ว
 * แล้วการเขียนไฟล์ล้ม · รอบนั้นกู้ได้ แต่รอบถัดไปล้มเหมือนกันทุกรอบจนกว่าจะมีคน
 * ไปลบไฟล์ ซึ่งไม่มีทางเกิดกลางงานที่คนต่อแถวอยู่
 *
 * สองกติกาที่ไฟล์นี้ตรึงไว้ และสำคัญกว่าตัวเลขทุกตัว
 *   1. **วัดไม่ได้ = เงียบ ไม่ใช่ล้ม** ตัวเตือนที่ทำให้รอบของแขกพังแย่กว่าไม่มีเลย
 *   2. **บอกให้รู้ ไม่ห้าม** ห้ามถ่ายเพราะที่ใกล้หมดคือปิดบูธด้วยมือตัวเอง
 */

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

const dirs = [];
after(() => Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

/** statfs ปลอมที่บอกได้ว่าเหลือกี่ไบต์ — ดิสก์จริงของเครื่องเทสต์ว่างเกินกว่าจะจำลองได้ */
const withFree = (bytes) => async () => ({ bsize: 4096, bavail: bytes / 4096 });

test('plenty of room means the photographer is never bothered', async () => {
  const quiet = await diskWarning('.', { statfs: withFree(50 * GB) });
  assert.equal(quiet, null, 'ที่ยังเหลือเยอะแต่ยังเตือน — จอที่เตือนตลอดคือจอที่ไม่มีใครอ่าน');
});

test('a disk we cannot measure is a silent disk, not a broken round', async () => {
  /*
   * ข้อนี้สำคัญกว่าตัวเลขทุกตัวในไฟล์: `statfs` โยนได้จริง (โฟลเดอร์ยังไม่ถูกสร้าง
   * ตอนเปิดบูธครั้งแรก, ไดรฟ์เครือข่ายหลุด) · ตัวเตือนที่ทำให้รอบของแขกล้ม
   * แย่กว่าการไม่มีตัวเตือนเลย
   */
  const thrown = await diskWarning('.', {
    statfs: async () => { throw new Error('statfs ล้ม'); },
  });
  assert.equal(thrown, null);

  // และค่าที่อ่านมาเพี้ยนก็ต้องเงียบเหมือนกัน ไม่ใช่คำนวณต่อจนได้ข้อความไร้สาระ
  assert.equal(await freeBytes('.', async () => ({ bsize: NaN, bavail: 10 })), null);
  assert.equal(await diskWarning('.', { statfs: async () => ({ bsize: 4096 }) }), null);

  // โฟลเดอร์ที่ไม่มีอยู่จริงก็ต้องไม่โยนออกมา (ใช้ statfs จริง ไม่ใช่ตัวปลอม)
  assert.equal(await freeBytes(path.join(os.tmpdir(), 'ไม่มีโฟลเดอร์นี้-9f3a2c')), null);
});

test('the warning counts rounds, not gigabytes', async () => {
  /*
   * "เหลือ 1.4 GB" ไม่ได้บอกคนหน้าบูธว่าควรทำอะไร · "พอสำหรับอีกราว 70 รอบ"
   * ตัดสินใจได้ทันทีว่าจะขายต่อหรือหยุดย้ายไฟล์ก่อน — ซึ่งคือทั้งหมดที่การเตือนมีไว้ทำ
   */
  const low = await diskWarning('.', { statfs: withFree(1.4 * GB), perRound: ROUND_BYTES.dslr });

  assert.ok(low, 'เหลือ 1.4 GB ต้องเตือน');
  assert.match(low.text, /1\.4 GB/);
  assert.match(low.text, /อีกราว \d+ รอบ/);
  assert.equal(low.rounds, Math.floor(1.4 * GB / ROUND_BYTES.dslr));
  assert.equal(low.critical, false, 'ยังพอถ่ายได้อีกเป็นสิบรอบ ไม่ใช่ขั้นวิกฤต');
});

test('the same free space means very different things on the two cameras', async () => {
  // กล้องใหญ่กินที่ต่อรอบมากกว่าเว็บแคมห้าเท่า — ตัวเลข "อีกกี่รอบ" จึงต้องถามว่า
  // บูธนี้ถ่ายด้วยอะไร ไม่ใช่บอกเลขเดียวกันให้ทั้งสองโหมด
  const free = 1.5 * GB;
  const webcam = await diskWarning('.', { statfs: withFree(free), perRound: ROUND_BYTES.webcam });
  const dslr = await diskWarning('.', { statfs: withFree(free), perRound: ROUND_BYTES.dslr });

  assert.ok(webcam.rounds > dslr.rounds * 4, `เว็บแคม ${webcam.rounds} · DSLR ${dslr.rounds}`);
});

test('nearly full says so in different words, because it needs a different answer', async () => {
  /*
   * "ย้ายก่อนงานหน้า" กับ "ย้ายเดี๋ยวนี้" เป็นคนละคำสั่ง · ข้อความเดียวกันทั้งสอง
   * ระดับแปลว่าคนอ่านต้องไปคำนวณเองว่าด่วนแค่ไหน ตอนที่กำลังยุ่งที่สุด
   */
  const soon = await diskWarning('.', { statfs: withFree(1.5 * GB) });
  const now = await diskWarning('.', { statfs: withFree(CRITICAL_BYTES - MB) });

  assert.equal(soon.critical, false);
  assert.match(soon.text, /ก่อนงานหน้า/);

  assert.equal(now.critical, true);
  assert.match(now.text, /เดี๋ยวนี้/);
  assert.match(now.text, /MB/, 'ต่ำกว่า 1 GB ต้องบอกเป็น MB ไม่ใช่ 0.4 GB ที่อ่านยากกว่า');
});

test('the real filesystem answers, so the check works on the machine it ships to', async () => {
  // ตัวปลอมพิสูจน์ตรรกะ แต่ไม่พิสูจน์ว่า statfs ใช้ได้จริงกับพาธจริง
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-disk-'));
  dirs.push(dir);

  const free = await freeBytes(dir);
  assert.ok(Number.isFinite(free) && free > 0, `อ่านพื้นที่ว่างจริงไม่ได้: ${free}`);

  // เพดานสูงจนดิสก์ไหนก็นับว่าใกล้เต็ม — พิสูจน์ว่าเส้นทางเตือนเดินได้จริงกับของจริง
  const forced = await diskWarning(dir, { warnBytes: Number.MAX_SAFE_INTEGER });
  assert.ok(forced, 'บังคับให้เตือนแล้วยังเงียบ');
  assert.match(forced.text, /รอบ/);
});
