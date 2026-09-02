import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionForKey, createRemote, keyName } from '../src/core/keys.js';
import { registerGlobalKeys } from '../src/main/remote.js';
import { planScreens } from '../src/main/windows.js';
import { normaliseSettings } from '../src/main/settings.js';

/**
 * สองจอ กับรีโมทกดถ่าย
 *
 * ทั้งสองเรื่องตัดสินกันที่ "ของจริงมีจออยู่กี่ตัว" กับ "รีโมทตัวนั้นส่งปุ่มอะไร"
 * ซึ่งเป็นสองอย่างที่เครื่องที่รันเทสต์ตอบแทนไม่ได้ · ตรรกะทั้งหมดจึงถูกดึงออกมา
 * เป็นฟังก์ชันคำนวณล้วนที่ป้อนอะไรเข้าไปก็ได้ แล้วเทสต์ตรงนั้นแทน
 */

const display = (id, x, width = 1920) =>
  ({ id, bounds: { x, y: 0, width, height: 1080 } });

test('two screens: the guest gets the primary, the photographer gets the other', () => {
  const front = display(1, 0);
  const back = display(2, 1920);

  const plan = planScreens([front, back], 1, { operator: 'auto' });
  assert.deepEqual(plan.guest, front.bounds);
  assert.deepEqual(plan.operator, back.bounds);

  // เสียบสลับข้าง (จอหลักเป็นตัวที่สองในรายการ) ต้องยังแจกถูก ไม่ใช่ยึดลำดับ
  const swapped = planScreens([back, front], 1, { operator: 'auto' });
  assert.deepEqual(swapped.guest, front.bounds);
  assert.deepEqual(swapped.operator, back.bounds);
});

test('one screen means one window, never two stacked on the same glass', () => {
  // จอช่างภาพที่ไปทับจอแขก = บูธที่ใช้งานไม่ได้เลย ไม่ใช่บูธที่ขาดของเสริม
  const plan = planScreens([display(1, 0)], 1, { operator: 'auto' });
  assert.deepEqual(plan.guest, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(plan.operator, null);
});

test('the photographer screen can be turned off even when a second screen is plugged in', () => {
  const plan = planScreens([display(1, 0), display(2, 1920)], 1, { operator: 'off' });
  assert.equal(plan.operator, null, 'ตั้ง off ไว้แล้วต้องไม่เปิดจอที่สอง');
});

test('a third screen does not become a third window', () => {
  const plan = planScreens([display(1, 0), display(2, 1920), display(3, 3840)], 1, {});
  assert.deepEqual(plan.operator, { x: 1920, y: 0, width: 1920, height: 1080 });
});

test('no usable display at all is reported, not guessed at', () => {
  assert.deepEqual(planScreens([], 1, {}), { guest: null, operator: null });
  assert.deepEqual(planScreens(undefined, 1, {}), { guest: null, operator: null });
});

test('the keys real shutter remotes send all reach the booth', () => {
  // สาย USB ส่วนใหญ่ส่ง Enter/Space/PageDown · บลูทูธสลับโหมดแล้วส่งปุ่มเสียง
  assert.equal(actionForKey({ key: 'Enter' }), 'shutter');
  assert.equal(actionForKey({ key: ' ' }), 'shutter', 'เว้นวรรคมาเป็น " " ไม่ใช่ "Space"');
  assert.equal(actionForKey({ key: 'PageDown' }), 'shutter');
  assert.equal(actionForKey({ key: 'AudioVolumeUp' }), 'shutter');
  assert.equal(actionForKey({ key: '0', code: 'Numpad0' }), 'shutter');
  assert.equal(actionForKey({ key: 'Enter', code: 'NumpadEnter' }), 'shutter');

  assert.equal(actionForKey({ key: 'PageUp' }), 'back');
  assert.equal(actionForKey({ key: 'AudioVolumeDown' }), 'back');

  assert.equal(actionForKey({ key: 'q' }), null);
  assert.equal(actionForKey({}), null);
  assert.equal(keyName({ key: ' ' }), 'Space');
});

test('a bouncing remote button does not print twice', () => {
  // รีโมทถูก ๆ เด้งสัญญาณ และคนก็กดซ้ำตอนไม่แน่ใจว่าติดไหม
  // ปล่อยผ่านทั้งคู่ = สั่งพิมพ์สองใบ ซึ่งย้อนไม่ได้
  let clock = 1000;
  const seen = [];
  const press = createRemote((action) => seen.push(action), { now: () => clock });

  assert.equal(press({ key: 'Enter' }), 'shutter');
  clock += 80;
  assert.equal(press({ key: 'Enter' }), null, 'ปุ่มเดิมในเสี้ยววินาทีคือสัญญาณเด้ง');

  // แต่ปุ่มอีกตัวทันทีคือเจตนาจริง — กดถ่ายแล้วรีบกดยกเลิก ต้องได้ยิน
  assert.equal(press({ key: 'PageUp' }), 'back');

  clock += 500;
  assert.equal(press({ key: 'Enter' }), 'shutter', 'พ้นระยะแล้วต้องรับอีกครั้ง');
  assert.deepEqual(seen, ['shutter', 'back', 'shutter']);

  // ค้างนิ้วบนปุ่มไม่ใช่การกดใหม่ — คีย์บอร์ดยิงซ้ำให้เองเป็นสิบครั้งต่อวินาที
  clock += 5000;
  assert.equal(press({ key: 'Enter', repeat: true }), null);
});

test('a key nothing else on the machine can spare is never taken silently', () => {
  const asked = [];
  const globalShortcut = {
    register(key) {
      asked.push(key);
      return key !== 'VolumeUp';   // จำลองว่าเดสก์ท็อปยึดปุ่มเสียงไว้ก่อนแล้ว
    },
  };

  const fired = [];
  const taken = registerGlobalKeys(globalShortcut, ['VolumeUp', 'F5', 'ปุ่มที่ไม่มีจริง'],
    createRemote((action) => fired.push(action)));

  assert.deepEqual(asked, ['VolumeUp', 'F5'], 'ปุ่มที่บูธไม่รู้จักต้องไม่ไปยึดไว้เปล่า ๆ');
  assert.deepEqual(taken, ['F5'], 'จดไม่สำเร็จต้องไม่นับว่าจดได้');
});

test('settings keep only keys the booth actually does something with', () => {
  const settings = normaliseSettings({
    remote: { globalKeys: ['VolumeUp', 'VolumeUp', 'Ctrl+Q', 42] },
    operatorScreen: 'off',
  });
  assert.deepEqual(settings.remote.globalKeys, ['VolumeUp']);
  assert.equal(settings.remote.enabled, true, 'ไม่ได้สั่งปิด = เปิด');
  assert.equal(settings.operatorScreen, 'off');

  // ค่าเริ่มต้นต้องไม่ยึดปุ่มอะไรทั้งเครื่อง — ยึด Enter ไว้แปลว่าโปรแกรมอื่น
  // บนเครื่องนั้นใช้ปุ่มนั้นไม่ได้จนกว่าจะปิดบูธ
  const fresh = normaliseSettings({});
  assert.deepEqual(fresh.remote.globalKeys, []);
  assert.equal(fresh.operatorScreen, 'auto');
  assert.equal(normaliseSettings({ operatorScreen: 'ทั้งสองจอ' }).operatorScreen, 'auto');
  assert.equal(normaliseSettings({ remote: { enabled: false } }).remote.enabled, false);
});
