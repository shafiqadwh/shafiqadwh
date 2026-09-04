import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createCamera, explain, isJpeg, parseCameras } from '../src/main/camera.js';
import { normaliseSettings } from '../src/main/settings.js';

/**
 * กล้องใหญ่ต่อสาย — ไฟล์นี้ทดสอบ **เส้นทางที่กล้องพัง** เป็นหลัก
 *
 * เส้นทางที่กล้องทำงานปกติทดสอบง่ายและไม่ค่อยพัง · สิ่งที่จะเกิดจริงกลางงานคือ
 * สาย USB หลวม แบตกล้องหมด โปรแกรมอื่นจับกล้องไว้ กล้องโฟกัสไม่ได้แล้วไม่ยอมลั่น
 * ชัตเตอร์ — ทุกกรณีต้องจบลงที่ **แขกยังได้รูปและคิวยังเดิน** ไม่ใช่บูธค้าง
 *
 * ขับด้วยกล้องจำลองทั้งหมด เพราะเครื่องที่รันเทสต์ไม่มีกล้องเสียบอยู่ และเส้นทาง
 * ที่ต้องมั่นใจที่สุดคือเส้นทางที่จำลองได้เท่านั้น (กล้องจริงพังตามสั่งไม่ได้)
 */

const dirs = [];
const fresh = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cam-'));
  dirs.push(dir);
  return dir;
};

after(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/**
 * gphoto2 จำลอง — `plan` บอกว่าคำสั่งที่ n ควรตอบอะไร
 *
 * เขียนไฟล์ให้ตรงตำแหน่งที่ `--filename` ระบุ เหมือนของจริง จะได้ทดสอบได้ว่า
 * โค้ดอ่านไฟล์จากที่ถูกต้อง ไม่ใช่แค่ดูรหัสจบของกระบวนการ
 */
function fakeGphoto(plan) {
  const calls = [];
  const spawnImpl = (bin, args) => {
    calls.push(args);
    const step = plan[Math.min(calls.length - 1, plan.length - 1)];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };

    setImmediate(async () => {
      if (step.writes) {
        const at = args[args.indexOf('--filename') + 1];
        await fs.writeFile(at, step.writes);
      }
      if (step.stdout) child.stdout.emit('data', step.stdout);
      if (step.stderr) child.stderr.emit('data', step.stderr);
      if (step.throws) child.emit('error', new Error(step.throws));
      else if (!step.hangs) child.emit('close', step.code ?? 0);
    });
    return child;
  };
  return { spawnImpl, calls };
}

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);

const DETECTED = `Model                          Port
----------------------------------------------------------
Nikon DSC D7000 (PTP mode)     usb:001,011
`;

// ── ตัวอ่านผลลัพธ์ ──────────────────────────────────────────────────────────

test('the camera list ignores the table header, and reads the real rows', () => {
  const found = parseCameras(DETECTED);
  assert.deepEqual(found, [{ model: 'Nikon DSC D7000 (PTP mode)', port: 'usb:001,011' }]);

  // ชื่อรุ่นมีช่องว่างในตัวเอง — ห้ามตัดที่ช่องว่างแรก ต้องตัดที่คอลัมน์
  const two = parseCameras(`${DETECTED}Canon EOS 700D                 usb:001,012\n`);
  assert.deepEqual(two.map((one) => one.model),
    ['Nikon DSC D7000 (PTP mode)', 'Canon EOS 700D']);

  // ไม่มีกล้องเสียบอยู่ = ตารางเปล่า ไม่ใช่ error
  assert.deepEqual(parseCameras('Model   Port\n--------\n'), []);
});

test('a truncated download is caught before it reaches the sheet builder', () => {
  assert.equal(isJpeg(jpeg), true);
  assert.equal(isJpeg(Buffer.from('ไม่ใช่รูป')), false);
  assert.equal(isJpeg(Buffer.alloc(0)), false);
  assert.equal(isJpeg(null), false);
});

test('every error message tells the person at the booth what to do next', () => {
  // "PTP I/O Error" บนจอกลางงานมีค่าเท่ากับไม่มีข้อความเลย
  assert.match(explain('*** Error: Could not claim the USB device'), /pkill/);
  assert.match(explain('Could not capture image. Out of Focus'), /สวิตช์ที่เลนส์เป็น M/);
  assert.match(explain('spawn gphoto2 ENOENT'), /apt install gphoto2/);
  assert.match(explain('timed out — หมดเวลารอกล้องตอบ'), /ปิดเปิดกล้อง/);

  // ข้อความที่ไม่รู้จักต้องส่งของจริงออกไป ไม่ใช่กลืนแล้วบอกว่า "เกิดข้อผิดพลาด"
  assert.match(explain('PTP Device Busy 0x2019'), /PTP Device Busy 0x2019/);
});

// ── ตรวจกล้อง ──────────────────────────────────────────────────────────────

test('detecting reports the model, so you know you plugged in the right body', async () => {
  const { spawnImpl } = fakeGphoto([{ stdout: DETECTED }]);
  const camera = createCamera({ spawnImpl });

  assert.deepEqual(await camera.detect(),
    { ok: true, model: 'Nikon DSC D7000 (PTP mode)', port: 'usb:001,011' });
});

test('no camera and no gphoto2 are different problems, and get different answers', async () => {
  const missing = createCamera({ spawnImpl: fakeGphoto([{ throws: 'spawn gphoto2 ENOENT' }]).spawnImpl });
  assert.match((await missing.detect()).reason, /apt install gphoto2/);

  const empty = createCamera({ spawnImpl: fakeGphoto([{ stdout: 'Model  Port\n------\n' }]).spawnImpl });
  assert.match((await empty.detect()).reason, /เช็กว่าสาย USB เสียบแน่น/);
});

// ── ถ่ายจริง ───────────────────────────────────────────────────────────────

test('a good capture returns the bytes the camera wrote, not the exit code', async () => {
  const dir = await fresh();
  // ในโฟลเดอร์ที่ยังไม่มีอยู่ — เครื่องที่เพิ่งลงใหม่และตั้งโหมดกล้องใหญ่ไว้ตั้งแต่แรก
  // จะยังไม่มีโฟลเดอร์ข้อมูลเลยตอนที่แขกคนแรกกดถ่าย (gphoto2 ไม่สร้างให้เอง)
  const file = path.join(dir, 'ยังไม่มี', 'capture.jpg');
  const { spawnImpl, calls } = fakeGphoto([{ writes: jpeg }]);

  const shot = await createCamera({ spawnImpl }).capture(file);
  assert.equal(shot.ok, true);
  assert.ok(shot.data.equals(jpeg), 'ต้องเป็นไฟล์ที่กล้องเขียนมาจริง ๆ');

  // สั่งเก็บสำเนาลงการ์ดไปด้วย — D7000 มีสองช่อง ทุกรูปที่ขายไปจึงมีสำเนาในกล้อง
  assert.deepEqual(calls[0].slice(0, 2), ['--set-config', 'capturetarget=1']);

  // และไฟล์ชั่วคราวต้องไม่ค้าง งานสามวันจะได้ไม่มีไฟล์ 18MP กองอยู่
  await assert.rejects(fs.access(file));
});

test('a camera that refuses the card copy still takes the photo', async () => {
  /*
   * การเก็บสำเนาลงการ์ดเป็นของแถม ไม่ใช่ของหลัก · กล้องรุ่นที่ไม่รับคำสั่งนี้
   * ต้องยังถ่ายได้ตามปกติ ไม่ใช่ล้มทั้งรอบเพราะของแถมชิ้นเดียว
   */
  const dir = await fresh();
  const file = path.join(dir, 'capture.jpg');
  const { spawnImpl, calls } = fakeGphoto([
    { code: 1, stderr: 'Could not set config entry capturetarget' },
    { writes: jpeg },
  ]);

  const camera = createCamera({ spawnImpl });
  assert.equal((await camera.capture(file)).ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].includes('--set-config'), false, 'ครั้งที่สองต้องไม่สั่งเก็บลงการ์ดอีก');

  // และต้องจำไว้ — รูปถัดไปห้ามเสียเวลาลองทางที่รู้แล้วว่าไม่ได้
  assert.equal((await camera.capture(file)).ok, true);
  assert.equal(calls.length, 3, 'รูปที่สองต้องยิงคำสั่งเดียว ไม่ใช่สองคำสั่งซ้ำเดิม');
});

test('a capture that exits clean but writes rubbish is still a failure', async () => {
  // gphoto2 คืนรหัส 0 ได้ทั้งที่ไฟล์ถูกตัดกลางคัน (สายหลวม การ์ดเต็ม) — ถ้าปล่อยผ่าน
  // รอบนั้นจะไปล้มตอนประกอบแผ่นแทน ซึ่งไกลจากต้นเหตุจนหาสาเหตุไม่เจอ
  const dir = await fresh();
  const file = path.join(dir, 'capture.jpg');
  const { spawnImpl } = fakeGphoto([{ writes: Buffer.from('ไม่ใช่รูป') }]);

  const shot = await createCamera({ spawnImpl }).capture(file, { keepOnCard: false });
  assert.equal(shot.ok, false);
  assert.match(shot.reason, /ไม่ใช่รูป JPEG/);
});

test('a camera that stops answering is given up on, not waited for forever', async () => {
  const dir = await fresh();
  const { spawnImpl } = fakeGphoto([{ hangs: true }]);
  const camera = createCamera({ spawnImpl, captureTimeoutMs: 120 });

  const started = Date.now();
  const shot = await camera.capture(path.join(dir, 'capture.jpg'), { keepOnCard: false });

  assert.equal(shot.ok, false);
  assert.match(shot.reason, /ปิดเปิดกล้อง/);
  // แขกยืนอยู่ตรงหน้า — ยอมเสียความคมของรอบนั้น ดีกว่าให้ทั้งคิวรอกล้องที่ค้าง
  assert.ok(Date.now() - started < 3000, 'ต้องเลิกรอตามเวลาที่ตั้งไว้');
});

test('two rounds cannot talk to the camera at the same time', async () => {
  /*
   * กล้องหนึ่งตัวรับได้ทีละคำสั่ง · ยิงพร้อมกันจะได้ "Could not claim the USB device"
   * ซึ่งอ่านแล้วเหมือนสายหลวม ทั้งที่เป็นความผิดของเราเอง — ต่อคิวไว้ในตัวคุมกล้อง
   * ผู้เรียกจึงไม่ต้องรู้เรื่องนี้เลย
   */
  const dir = await fresh();
  let running = 0;
  let overlapped = false;

  const spawnImpl = () => {
    running += 1;
    if (running > 1) overlapped = true;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setTimeout(async () => {
      running -= 1;
      child.emit('close', 1);
    }, 30);
    return child;
  };

  const camera = createCamera({ spawnImpl });
  await Promise.all([
    camera.capture(path.join(dir, 'a.jpg'), { keepOnCard: false }),
    camera.capture(path.join(dir, 'b.jpg'), { keepOnCard: false }),
    camera.detect(),
  ]);
  assert.equal(overlapped, false);
});

test('one failed call does not jam the queue for every call after it', async () => {
  // คิวที่ค้างเพราะงานหนึ่งล้ม = บูธที่ถ่ายไม่ได้อีกเลยทั้งคืน หลังกล้องสะดุดครั้งเดียว
  const dir = await fresh();
  const file = path.join(dir, 'capture.jpg');
  const { spawnImpl } = fakeGphoto([
    { throws: 'boom' },
    { writes: jpeg },
  ]);

  const camera = createCamera({ spawnImpl });
  assert.equal((await camera.capture(file, { keepOnCard: false })).ok, false);
  assert.equal((await camera.capture(file, { keepOnCard: false })).ok, true);
});

// ── ค่าตั้ง ─────────────────────────────────────────────────────────────────

test('the booth stays on the webcam unless someone deliberately picks the DSLR', () => {
  // ค่าเริ่มต้นต้องเป็นทางที่ใช้ได้เสมอโดยไม่ต้องมีอุปกรณ์อะไรเพิ่ม
  assert.deepEqual(normaliseSettings({}).camera, { source: 'webcam', keepOnCard: true });
  assert.equal(normaliseSettings({ camera: { source: 'dslr' } }).camera.source, 'dslr');

  // ค่าที่พิมพ์ผิดต้องตกกลับไปทางที่ใช้ได้ ไม่ใช่ทำให้บูธเปิดไม่ขึ้น
  assert.equal(normaliseSettings({ camera: { source: 'nikon' } }).camera.source, 'webcam');
  assert.equal(normaliseSettings({ camera: 'dslr' }).camera.source, 'webcam');
  assert.equal(normaliseSettings({ camera: { keepOnCard: false } }).camera.keepOnCard, false);
});
