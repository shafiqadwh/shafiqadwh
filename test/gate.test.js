import assert from 'node:assert/strict';
import test from 'node:test';
import { createGate } from '../src/lib/gate.js';

const defer = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('never runs more than the limit at once', async () => {
  const gate = createGate(2);
  const blockers = [defer(), defer(), defer(), defer()];

  let active = 0;
  let peak = 0;

  const jobs = blockers.map((blocker) =>
    gate.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await blocker.promise;
      active -= 1;
    }));

  // ให้ Node ปล่อยงานที่รอคิวเข้าไปเท่าที่ประตูยอม
  await new Promise((r) => setImmediate(r));
  assert.equal(peak, 2, 'only two jobs may be inside the gate');

  blockers.forEach((blocker) => blocker.resolve());
  await Promise.all(jobs);
  assert.equal(peak, 2, 'the limit must hold for the whole run, not just the start');
});

test('a job that throws still frees its slot', async () => {
  // ถ้า ffmpeg ล้ม แล้วประตูไม่คืนช่อง คิวจะค้างถาวร — แขกที่เหลือส่งไฟล์ไม่ได้
  // ตลอดงาน โดยไม่มี error ให้เห็นด้วย
  const gate = createGate(1);

  await assert.rejects(() => gate.run(async () => { throw new Error('ffmpeg died'); }));

  const result = await gate.run(async () => 'still working');
  assert.equal(result, 'still working');
  assert.equal(gate.depth, 0, 'nothing should be left holding the gate');
});

test('waiting jobs run in the order they arrived', async () => {
  const gate = createGate(1);
  const order = [];
  const blocker = defer();

  const first = gate.run(async () => { order.push(1); await blocker.promise; });
  const rest = [2, 3, 4].map((n) => gate.run(async () => { order.push(n); }));

  blocker.resolve();
  await Promise.all([first, ...rest]);

  assert.deepEqual(order, [1, 2, 3, 4]);
});

test('depth reports what is running plus what is waiting', async () => {
  const gate = createGate(1);
  const blocker = defer();

  const running = gate.run(async () => { await blocker.promise; });
  const queued = gate.run(async () => {});
  await new Promise((r) => setImmediate(r));

  assert.equal(gate.depth, 2, 'one running, one waiting');

  blocker.resolve();
  await Promise.all([running, queued]);
  assert.equal(gate.depth, 0);
});
