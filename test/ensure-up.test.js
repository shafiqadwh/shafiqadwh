import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * ตัวเฝ้าที่กู้เว็บคืนเองระหว่างงาน
 *
 * สถานการณ์ที่สคริปต์นี้มีไว้รับ: คืนวันงาน NAS รีบูต (ไฟตก/DSM อัปเดต) แล้ว
 * `nvidia.ko` ไม่โหลด คอนเทนเนอร์ที่ถูกสร้างมาพร้อมคำขอ GPU จึงสตาร์ทไม่ขึ้น
 * เว็บล่มทั้งงาน โดยที่เจ้าภาพอยู่ในงานแต่ง ไม่ได้นั่งอยู่หน้าเทอร์มินัล
 *
 * เทสต์ชุดนี้ยกเซิร์ฟเวอร์จริงกับ docker ปลอมขึ้นมาแล้ว **รันสคริปต์ตัวจริง**
 * ไล่ทั้งสามเส้นทาง ไม่ใช่อ่านซอร์สแล้วเดาว่ามันน่าจะทำงาน
 */

const WORK = await fs.mkdtemp(path.join(os.tmpdir(), 'ensure-up-'));
after(() => fs.rm(WORK, { recursive: true, force: true }));

/**
 * เว็บปลอม — ตอบ 200 ก็ต่อเมื่อมีไฟล์ธง ซึ่ง docker ปลอมเป็นคนสร้าง
 * (เลียนแบบ "คอนเทนเนอร์ขึ้นแล้วเว็บถึงจะตอบ")
 */
function serveHealth(flagPath) {
  const server = http.createServer((req, res) => {
    if (req.url !== '/healthz') {
      res.writeHead(404).end();
      return;
    }
    fs.access(flagPath).then(
      () => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'),
      () => res.writeHead(503).end(),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

/**
 * โปรเจกต์ปลอมหนึ่งชุด: สคริปต์ตัวจริง + docker ปลอมที่คุมพฤติกรรมได้
 *
 * gpuProbe   — `docker run --gpus` สำเร็จไหม (ไดรเวอร์ยังดีอยู่หรือเปล่า)
 * gpuStarts  — `compose ... -f docker-compose.gpu.yml up` ทำให้เว็บขึ้นได้ไหม
 */
async function project({ label, gpuProbe, gpuStarts }) {
  const dir = path.join(WORK, label);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });

  for (const name of ['ensure-up.sh', 'lib-compose.sh']) {
    await fs.copyFile(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
  }
  await fs.chmod(path.join(dir, 'scripts', 'ensure-up.sh'), 0o755);
  await fs.copyFile(path.join(ROOT, 'docker-compose.yml'), path.join(dir, 'docker-compose.yml'));
  await fs.copyFile(path.join(ROOT, 'docker-compose.gpu.yml'), path.join(dir, 'docker-compose.gpu.yml'));

  const flag = path.join(dir, 'up.flag');
  const calls = path.join(dir, 'docker-calls.log');
  const { server, port } = await serveHealth(flag);

  await fs.writeFile(path.join(dir, '.env'), `HTTP_PORT=${port}\nDATA_DIR=${dir}\n`);

  // docker ปลอม: จดทุกคำสั่งที่ถูกเรียก แล้วทำตามสถานการณ์ที่ตั้งไว้
  await fs.writeFile(path.join(dir, 'bin', 'docker'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
case "$1 $2" in
  "image inspect") exit 0 ;;
  "run --rm")      exit ${gpuProbe ? 0 : 1} ;;   # ตัวตรวจ GPU
esac
if [ "$1" = "compose" ]; then
  case "$*" in
    *docker-compose.gpu.yml*) ${gpuStarts ? `touch ${JSON.stringify(flag)}` : 'true'} ;;
    *)                        touch ${JSON.stringify(flag)} ;;
  esac
fi
exit 0
`);
  await fs.chmod(path.join(dir, 'bin', 'docker'), 0o755);

  return {
    dir,
    flag,
    close: () => new Promise((resolve) => server.close(resolve)),
    calls: async () => {
      try {
        return await fs.readFile(calls, 'utf8');
      } catch {
        return '';
      }
    },
    run: () => run('sh', [path.join(dir, 'scripts', 'ensure-up.sh')], {
      cwd: dir,
      env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, ENSURE_UP_WAIT: '4' },
    }),
    log: async () => {
      try {
        return await fs.readFile(path.join(dir, 'ensure-up.log'), 'utf8');
      } catch {
        return '';
      }
    },
  };
}

test('a site that is already answering is left completely untouched', async () => {
  const p = await project({ label: 'healthy', gpuProbe: true, gpuStarts: true });
  await fs.writeFile(p.flag, ''); // เว็บขึ้นอยู่แล้วตั้งแต่ต้น

  await p.run();

  // รันทุก 5 นาทีระหว่างงาน — แตะคอนเทนเนอร์ที่ทำงานดีอยู่ทุกรอบคือทำให้เว็บ
  // สะดุดเป็นระยะตลอดงาน เพราะตัวที่ควรจะมาช่วย
  assert.equal(await p.calls(), '', 'เว็บปกติดีอยู่ แต่ยังไปเรียก docker');
  assert.equal(await p.log(), '', 'ปกติดีอยู่แต่ยังเขียนล็อก — รันทุก 5 นาทีล็อกจะโตเปล่า ๆ');

  await p.close();
});

test('a site that is down comes back, with the GPU when the GPU still works', async () => {
  const p = await project({ label: 'gpu-ok', gpuProbe: true, gpuStarts: true });

  await p.run();

  const calls = await p.calls();
  assert.match(calls, /compose .*docker-compose\.gpu\.yml.*up -d/, 'ไม่ได้ลองเปิด GPU เลย');
  assert.match(await p.log(), /กู้สำเร็จ/);

  await p.close();
});

test('a GPU that no longer works is skipped instead of taking the site down with it', async () => {
  // ไดรเวอร์หายหลังรีบูต — ตัวตรวจ GPU ล้ม ต้องยกขึ้นด้วย CPU ตั้งแต่แรก
  const p = await project({ label: 'gpu-gone', gpuProbe: false, gpuStarts: false });

  await p.run();

  const calls = await p.calls();
  assert.ok(!calls.includes('docker-compose.gpu.yml'), 'GPU ใช้ไม่ได้แล้วแต่ยังใส่ไฟล์ GPU เข้าไป');
  assert.match(calls, /compose -f docker-compose\.yml up -d/);
  assert.match(await p.log(), /กู้สำเร็จ/);

  await p.close();
});

test('a GPU that probes fine but will not start still ends with the site up', async () => {
  // เคสที่แย่ที่สุดและเป็นเหตุผลทั้งหมดที่สคริปต์นี้มีอยู่: ตัวตรวจผ่าน แต่พอยก
  // คอนเทนเนอร์จริงกลับไม่ขึ้น — ต้องถอยเป็น CPU เองโดยไม่มีใครมาสั่ง
  const p = await project({ label: 'gpu-lies', gpuProbe: true, gpuStarts: false });

  await p.run();

  const calls = await p.calls();
  const gpuAttempt = calls.indexOf('docker-compose.gpu.yml up -d');
  const cpuAttempt = calls.lastIndexOf('compose -f docker-compose.yml up -d');
  assert.ok(gpuAttempt >= 0, 'ไม่ได้ลอง GPU ก่อน');
  assert.ok(cpuAttempt > gpuAttempt, 'ลอง GPU ไม่สำเร็จแล้วไม่ได้ถอยเป็น CPU');

  assert.equal(await fs.access(p.flag).then(() => true, () => false), true, 'สุดท้ายเว็บยังไม่ขึ้น');
  assert.match(await p.log(), /ถอยเป็น CPU/);

  await p.close();
});
