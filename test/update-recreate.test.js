import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * อัปเดตโค้ดขึ้น NAS — **รีสตาร์ทกับสร้างคอนเทนเนอร์ใหม่ไม่ใช่เรื่องเดียวกัน**
 *
 * `docker compose restart` สตาร์ทคอนเทนเนอร์เดิมด้วยคอนฟิกเดิม มัน **ไม่อ่าน
 * docker-compose.yml ใหม่เลย** · ปกติไม่เป็นไร เพราะโค้ดถูก bind mount ไว้แล้ว
 * รีสตาร์ทก็พอ (และเร็วกว่ามาก) — แต่รอบที่ตัวไฟล์ compose เองเปลี่ยน มันกลายเป็น
 * การอัปเดตที่ขึ้น ✓ ทุกบรรทัดแล้วเว็บล่ม
 *
 * **เกิดขึ้นจริงแล้วหนึ่งครั้งบนเครื่องจริง**: เพิ่ม mount ของ `shared/` ลง compose
 * (เพราะ `src/lib/film.js` import ข้ามไปที่นั่น) แล้วรัน `update.sh` — ได้เส้นทาง
 * รีสตาร์ท คอนเทนเนอร์จึงยังไม่มี mount นั้น และอิมเมจก็ถูก build ไว้ก่อนมีโฟลเดอร์นี้
 * ผลคือ **เว็บทั้งเว็บไม่ขึ้น** ด้วย ERR_MODULE_NOT_FOUND
 *
 * เทสต์นี้ **รันสคริปต์ตัวจริง** กับ curl/docker ปลอม ไล่ทั้งสองเส้นทาง
 * ไม่ใช่อ่านซอร์สแล้วเดาว่ามันน่าจะตัดสินใจถูก
 */

const WORK = await fs.mkdtemp(path.join(os.tmpdir(), 'update-sh-'));
after(() => fs.rm(WORK, { recursive: true, force: true }));

const COMPOSE = ['docker-compose.yml', 'docker-compose.gpu.yml'];

/**
 * โปรเจกต์ปลอมหนึ่งชุด + tarball ที่ "GitHub" จะส่งมาให้
 *
 * `composeEdit` คือสิ่งที่ทำกับ docker-compose.yml ในตัว tarball — `null` แปลว่า
 * เหมือนเดิมเป๊ะ (รอบอัปเดตโค้ดธรรมดา) ส่วนสตริงคือบรรทัดที่ถูกเพิ่มเข้าไป
 */
async function project({ label, composeEdit }) {
  const dir = path.join(WORK, label);
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'bin'), { recursive: true });

  for (const name of ['update.sh', 'lib-compose.sh']) {
    await fs.copyFile(path.join(ROOT, 'scripts', name), path.join(dir, 'scripts', name));
    await fs.chmod(path.join(dir, 'scripts', name), 0o755);
  }
  for (const name of COMPOSE) {
    await fs.copyFile(path.join(ROOT, name), path.join(dir, name));
  }
  await fs.writeFile(path.join(dir, '.env'), 'HTTP_PORT=18090\n');

  // tarball ที่ curl ปลอมจะส่งมา — มีโฟลเดอร์ชั้นนอกหนึ่งชั้นเหมือนของ codeload
  const stage = path.join(WORK, `${label}-stage`, 'repo-branch');
  await fs.mkdir(path.join(stage, 'scripts'), { recursive: true });
  await fs.copyFile(
    path.join(ROOT, 'scripts', 'lib-compose.sh'), path.join(stage, 'scripts', 'lib-compose.sh'),
  );
  for (const name of COMPOSE) {
    await fs.copyFile(path.join(ROOT, name), path.join(stage, name));
  }
  if (composeEdit) {
    await fs.appendFile(path.join(stage, 'docker-compose.yml'), composeEdit);
  }
  const tarball = path.join(WORK, `${label}.tar.gz`);
  await run('tar', ['czf', tarball, '-C', path.dirname(stage), 'repo-branch']);

  const calls = path.join(dir, 'docker-calls.log');

  /*
   * curl ปลอมทำสองหน้าที่เหมือนของจริง: โหลด tarball (มี -o) กับเคาะ /healthz
   * ข้อหลังตอบ 0 ไปเลย — เทสต์นี้ถามว่า "ตัดสินใจถูกไหม" ไม่ได้ถามว่าเว็บขึ้นไหม
   */
  await fs.writeFile(path.join(dir, 'bin', 'curl'), `#!/bin/sh
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then cp ${JSON.stringify(tarball)} "$arg"; exit 0; fi
  prev="$arg"
done
exit 0
`, { mode: 0o755 });

  // docker ปลอม: จดทุกคำสั่ง · ตัวตรวจ GPU ตอบว่าใช้ไม่ได้ เพื่อให้ได้เส้นทาง CPU
  await fs.writeFile(path.join(dir, 'bin', 'docker'), `#!/bin/sh
echo "$@" >> ${JSON.stringify(calls)}
case "$1 $2" in
  "image inspect") exit 0 ;;
  "run --rm")      exit 1 ;;
esac
exit 0
`, { mode: 0o755 });

  return {
    dir,
    async update(args = []) {
      const { stdout } = await run('sh', [path.join(dir, 'scripts', 'update.sh'), ...args], {
        cwd: dir,
        env: { ...process.env, PATH: `${path.join(dir, 'bin')}:${process.env.PATH}` },
      });
      return stdout;
    },
    async dockerCalls() {
      return (await fs.readFile(calls, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    },
  };
}

test('a compose change makes the update recreate the container, not just restart it', async () => {
  const app = await project({
    label: 'changed',
    // บรรทัดเดียวกับที่ทำให้เว็บล่มจริง ๆ รอบนี้
    composeEdit: '      - ./shared:/app/shared:ro\n',
  });

  const output = await app.update();
  const calls = await app.dockerCalls();

  assert.ok(calls.some((line) => line.includes('up -d')),
    `ต้องสร้างคอนเทนเนอร์ใหม่ · ที่เรียกจริง: ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((line) => line.trim() === 'compose restart'),
    'ต้องไม่ใช่แค่รีสตาร์ท — รีสตาร์ทไม่อ่านไฟล์ compose ใหม่');

  // และต้องบอกคนที่รันด้วยว่าทำไมรอบนี้ช้ากว่าปกติ ไม่ใช่เปลี่ยนพฤติกรรมเงียบ ๆ
  assert.match(output, /docker-compose\.yml เปลี่ยน/);
});

test('an ordinary code update still takes the fast restart path', async () => {
  /*
   * ด้านกลับสำคัญเท่ากัน: ถ้าสร้างคอนเทนเนอร์ใหม่ทุกรอบ การอัปเดตกลางงานจะตัด
   * การเชื่อมต่อของแขกที่กำลังอัปโหลดอยู่ทุกคน ทั้งที่แค่รีสตาร์ทก็พอ
   * (โค้ด bind mount ไว้แล้ว — นั่นคือเหตุผลที่เส้นทางเร็วนี้มีอยู่แต่แรก)
   */
  const app = await project({ label: 'same', composeEdit: null });

  await app.update();
  const calls = await app.dockerCalls();

  assert.deepEqual(calls, ['compose restart'],
    'โค้ดเปลี่ยนเฉย ๆ ต้องรีสตาร์ทเท่านั้น ไม่ต้องแตะคอนเทนเนอร์');
});

test('--env still forces a recreate even when nothing about compose moved', async () => {
  // แก้ .env ต้องสร้างใหม่เสมอ เพราะตัวแปรสภาพแวดล้อมถูกอ่านตอนสร้างคอนเทนเนอร์
  const app = await project({ label: 'env', composeEdit: null });

  await app.update(['--env']);
  const calls = await app.dockerCalls();

  assert.ok(calls.some((line) => line.includes('up -d')), `ที่เรียกจริง: ${JSON.stringify(calls)}`);
});
