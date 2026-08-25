import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * GPU ต้องเป็นของที่ "เปิดให้เมื่อใช้ได้" ไม่ใช่ "ขาดไม่ได้"
 *
 * `deploy.resources.reservations.devices` ของ Compose เป็นคำขอแบบบังคับ —
 * Docker หา GPU ไม่เจอเมื่อไร คอนเทนเนอร์ไม่ขึ้นเลย เว็บล่มทั้งเว็บ ซึ่งเกิดได้จริง
 * เมื่อ NAS รีบูตแล้ว nvidia.ko ไม่โหลด (Xpenology ไม่ใช่ฮาร์ดแวร์แท้) แล้วเจ้าภาพ
 * กำลังอยู่ในงานแต่ง ไม่ได้นั่งอยู่หน้าเทอร์มินัล
 *
 * เทสต์ชุดนี้เฝ้าโครงที่แยกไว้: ไฟล์หลักต้องขึ้นได้เสมอ ส่วน GPU อยู่ในไฟล์ที่ต้อง
 * สั่ง -f เอง และมีเส้นทางถอยกลับ CPU จริง ๆ ในตัวเฝ้า
 */

const read = (name) => fs.readFile(path.join(ROOT, name), 'utf8');

test('the file that always has to come up asks for no GPU at all', async () => {
  const base = await read('docker-compose.yml');

  // ถ้าบล็อกนี้กลับเข้ามาอยู่ในไฟล์หลักอีกครั้ง แปลว่า `docker compose up -d`
  // เปล่า ๆ (ซึ่งเอกสารกับสคริปต์อื่นบอกให้พิมพ์อยู่หลายที่) กลายเป็นคำขอบังคับ
  assert.ok(!base.includes('driver: nvidia'), 'ไฟล์หลักกลับไปขอ GPU แบบบังคับอีกแล้ว');
  assert.ok(!base.includes('capabilities: [gpu]'), 'ไฟล์หลักกลับไปขอ GPU แบบบังคับอีกแล้ว');
});

test('the GPU add-on exists and targets the very same service', async () => {
  const gpu = await read('docker-compose.gpu.yml');
  assert.match(gpu, /driver: nvidia/);
  assert.match(gpu, /capabilities: \[gpu\]/);

  // ชื่อ service ที่พิมพ์ผิดใน override จะไม่ error — Compose สร้าง service ที่สอง
  // เงียบ ๆ แล้ว GPU ไม่เคยไปถึงคอนเทนเนอร์จริงโดยไม่มีอะไรบอก
  const base = await read('docker-compose.yml');
  const serviceOf = (text) => text.match(/^ {2}([a-z0-9-]+):$/m)?.[1];
  assert.equal(serviceOf(gpu), serviceOf(base), 'ชื่อ service ในไฟล์เสริมไม่ตรงกับไฟล์หลัก');
});

test('the add-on is not named something Compose would load on its own', async () => {
  // docker-compose.override.yml ถูกโหลดอัตโนมัติทุกครั้ง ซึ่งกลับหัวกลับหางกับ
  // เหตุผลที่แยกไฟล์นี้ออกมาพอดี
  const entries = await fs.readdir(ROOT);
  assert.ok(!entries.includes('docker-compose.override.yml'),
    'ชื่อนี้ถูกโหลดเอง GPU จะกลายเป็นคำขอบังคับอีกครั้ง');
  assert.ok(entries.includes('docker-compose.gpu.yml'));
});

test('both compose files are still valid YAML that docker could read', async () => {
  // พัง YAML แล้วจะรู้ตอนรัน update.sh บน NAS ซึ่งสายเกินไปถ้าเป็นคืนก่อนงาน
  for (const name of ['docker-compose.yml', 'docker-compose.gpu.yml']) {
    const text = await read(name);
    assert.doesNotThrow(() => {
      // ไม่มี yaml parser ใน dependencies — ตรวจเท่าที่ตรวจได้: ต้องมี services
      // และการเยื้องต้องเป็นสเปซล้วน (แท็บทำให้ YAML พังทันที)
      assert.match(text, /^services:$/m, `${name} ไม่มีบล็อก services`);
      assert.ok(!/^\t/m.test(text), `${name} มีแท็บในการเยื้อง`);
    });
  }
});

test('picking the compose files falls back to CPU whenever the GPU probe fails', async () => {
  // รันฟังก์ชันจริงจาก lib-compose.sh โดยวาง docker ปลอมที่ล้มเสมอไว้ใน PATH
  // — เลียนแบบ NAS ที่รีบูตแล้วไดรเวอร์ไม่ขึ้น
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-lib-'));
  const bin = path.join(work, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 1\n');
  await fs.chmod(path.join(bin, 'docker'), 0o755);

  const { stdout } = await run('sh', ['-c',
    '. ./scripts/lib-compose.sh && compose_files'],
  { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  assert.equal(stdout.trim(), '-f docker-compose.yml',
    'GPU ตรวจไม่ผ่านแต่ยังใส่ไฟล์ GPU เข้าไป — คอนเทนเนอร์จะไม่ขึ้น');

  await fs.rm(work, { recursive: true, force: true });
});

test('picking the compose files adds the GPU add-on when the probe really passes', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'compose-lib-'));
  const bin = path.join(work, 'bin');
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, 'docker'), '#!/bin/sh\nexit 0\n');
  await fs.chmod(path.join(bin, 'docker'), 0o755);

  const { stdout } = await run('sh', ['-c',
    '. ./scripts/lib-compose.sh && compose_files'],
  { cwd: ROOT, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

  assert.equal(stdout.trim(), '-f docker-compose.yml -f docker-compose.gpu.yml');

  await fs.rm(work, { recursive: true, force: true });
});

test('the watchdog leaves a healthy site completely alone', async () => {
  const script = await read('scripts/ensure-up.sh');

  // รันทุก 5 นาทีระหว่างงาน — ถ้ามันไป up -d ทับคอนเทนเนอร์ที่ทำงานดีอยู่
  // ทุกรอบ เว็บจะสะดุดเป็นระยะตลอดงานเพราะตัวที่ควรจะมาช่วย
  const beforeFirstCompose = script.slice(0, script.indexOf('docker compose'));
  assert.match(beforeFirstCompose, /if healthy; then\s*\n\s*exit 0/,
    'ต้องออกก่อนแตะ compose เมื่อเว็บยังตอบอยู่');
});

test('the watchdog really has a CPU-only last resort', async () => {
  const script = await read('scripts/ensure-up.sh');
  assert.match(script, /compose_files_cpu/, 'ไม่มีเส้นทางถอยเป็น CPU');

  // เส้นทางถอยต้องอยู่ "หลัง" ความพยายามแบบปกติ ไม่ใช่แทนที่มัน
  assert.ok(script.indexOf('compose_files)') < script.indexOf('compose_files_cpu'),
    'ถอยเป็น CPU ก่อนจะได้ลอง GPU เลย — GPU จะไม่มีวันถูกใช้');
});
