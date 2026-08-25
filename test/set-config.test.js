import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = path.join(HERE, '..', 'scripts', 'set-config.sh');

/**
 * เกิดจากของจริง: `sudo ./scripts/set-config.sh --show` ถูกก็อปวางไปถามใน
 * แชท แล้ว CLOUDFLARE_API_TOKEN โผล่เต็มค่าติดไปด้วย เพราะ --show เดิม
 * ซ่อนแค่ ADMIN_PASSWORD ตัวเดียว
 *
 * สคริปต์ตัวจริง cd ไปที่โฟลเดอร์โปรเจกต์ตามตำแหน่งของตัวเอง (`dirname "$0"/..`)
 * เทสต์นี้จึงคัดลอกสคริปต์ไปไว้ในโฟลเดอร์ปลอมที่มีโครง scripts/ + .env(.example)
 * ของตัวเอง แทนที่จะไปแตะ .env จริงของ repo (ซึ่งไม่มีอยู่แล้วในเครื่องที่รันเทสต์)
 */
function setupProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-config-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  const script = path.join(dir, 'scripts', 'set-config.sh');
  fs.copyFileSync(REAL_SCRIPT, script);
  fs.chmodSync(script, 0o755);

  const envExample = [
    'ADMIN_PASSWORD=',
    'CLOUDFLARE_API_TOKEN=',
    'MAX_VIDEO_SECONDS=180',
    'VIDEO_ENCODER_ARGS=',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.env.example'), envExample);

  const env = [
    'ADMIN_PASSWORD=sup3rsecret',
    'CLOUDFLARE_API_TOKEN=cfut_realtokenvalue123',
    'MAX_VIDEO_SECONDS=180',
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, '.env'), env);

  return { dir, script };
}

test('--show redacts the Cloudflare token, not just the admin password', async () => {
  const { script } = setupProject();
  const { stdout } = await run('sh', [script, '--show']);

  assert.ok(!stdout.includes('sup3rsecret'), 'รหัสผ่านแอดมินหลุดออกมาเต็มค่า');
  assert.ok(!stdout.includes('cfut_realtokenvalue123'), 'โทเคน Cloudflare หลุดออกมาเต็มค่า');
  assert.match(stdout, /ADMIN_PASSWORD=\*+/);
  assert.match(stdout, /CLOUDFLARE_API_TOKEN=\*+/);
  // ค่าที่ไม่ใช่ความลับต้องยังอ่านได้ปกติ ไม่ใช่ถูกเซ็นเซอร์ไปด้วย
  assert.match(stdout, /MAX_VIDEO_SECONDS=180/);
});

test('a value containing spaces round-trips through .env unquoted and unsplit', async () => {
  // เจอจริงบน NAS: พิมพ์ NAME=value ลงเชลล์ตรง ๆ ("-preset p4 -cq 24") ทำให้
  // เชลล์แยกเป็นหลายคำสั่งแล้วพัง — set-config.sh ต้องรับค่านี้เป็นก้อนเดียว
  // ตราบใดที่ผู้ใช้ quote อาร์กิวเมนต์ทั้งก้อนตอนเรียกสคริปต์
  const { script } = setupProject();
  await run('sh', [script, 'VIDEO_ENCODER_ARGS=-preset p4 -cq 24']);

  const { stdout } = await run('sh', [script, '--show']);
  assert.match(stdout, /VIDEO_ENCODER_ARGS=-preset p4 -cq 24/);
});

test('an unknown key is rejected instead of being written silently', async () => {
  const { script } = setupProject();
  await assert.rejects(() => run('sh', [script, 'NOT_A_REAL_KEY=1']));
});
