import assert from 'node:assert/strict';
import test from 'node:test';
import { electronBinary, skipOrFail } from './helpers/electron.js';

/**
 * ตัวช่วยที่ตัดสินว่า "เปิด Electron ไม่ได้" เป็นการข้ามหรือการล้ม
 *
 * เหตุผลที่ต้องมีเทสต์กำกับของเล็ก ๆ ชิ้นนี้: มันคือสิ่งเดียวที่กันไม่ให้ CI
 * ขึ้นเขียวทั้งที่เทสต์ห้าสิบข้อไม่ได้รัน (เกิดขึ้นจริงในรอบแรกของ workflow)
 * ถ้ามันเงียบผิดด้าน จะไม่มีอะไรมาจับมันอีกชั้น
 */

test('without the CI flag, a booth that will not open is skipped with a reason', (t) => {
  const skipped = [];
  const fake = { skip: (why) => skipped.push(why) };

  delete process.env.BOOTH_REQUIRE_ELECTRON;
  const answer = skipOrFail(fake, new Error('ไม่มีจอ'), 'เปิดสองหน้าต่างไม่ได้');

  assert.equal(answer, true, 'ต้องคืน true ให้ผู้เรียก return ออกไปได้');
  assert.deepEqual(skipped, ['เปิดสองหน้าต่างไม่ได้ — ไม่มีจอ']);
  t.diagnostic('ข้ามพร้อมเหตุผล ไม่ใช่ผ่านเงียบ ๆ');
});

test('with the CI flag set, the same case is a failure', () => {
  const fake = { skip: () => assert.fail('ห้ามข้ามเมื่อตั้ง BOOTH_REQUIRE_ELECTRON') };

  process.env.BOOTH_REQUIRE_ELECTRON = '1';
  try {
    assert.throws(
      () => skipOrFail(fake, new Error('ไม่มีไบนารี'), 'เปิด Electron ไม่ได้'),
      /เปิด Electron ไม่ได้ — ไม่มีไบนารี/);
  } finally {
    delete process.env.BOOTH_REQUIRE_ELECTRON;
  }
});

test('a missing reason still says something, rather than printing undefined', () => {
  const skipped = [];
  delete process.env.BOOTH_REQUIRE_ELECTRON;
  skipOrFail({ skip: (why) => skipped.push(why) }, null, 'ยกบูธหรือเว็บไม่ขึ้น');
  assert.deepEqual(skipped, ['ยกบูธหรือเว็บไม่ขึ้น — ไม่ทราบสาเหตุ']);
});

test('the binary is found by the name the installer recorded, not a guessed one', async (t) => {
  // เครื่องที่ยังไม่ได้ลงไบนารีต้องได้ข้อความที่บอกวิธีแก้ ไม่ใช่ ENOENT ดิบ ๆ
  let binary;
  try {
    binary = await electronBinary();
  } catch (error) {
    assert.match(error.message, /npm run install:electron/);
    return t.skip('ยังไม่ได้ลงตัวโปรแกรม Electron บนเครื่องนี้ — ข้อความบอกวิธีแก้ถูกแล้ว');
  }

  // เส้นทางต้องลงท้ายด้วยชื่อที่ระบบนี้ใช้จริง ไม่ใช่ 'electron' ตายตัว
  const expected = { win32: 'electron.exe', darwin: 'Electron' }[process.platform] ?? 'electron';
  assert.ok(binary.endsWith(expected), `${binary} ไม่ได้ลงท้ายด้วย ${expected}`);
  return undefined;
});
