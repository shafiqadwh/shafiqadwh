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
 * ตัวลงโปรแกรมบนเครื่อง Ubuntu ที่เพิ่งลงระบบเสร็จ
 *
 * **สคริปต์นี้จะถูกรันบนเครื่องที่ผมไม่มีวันได้เห็น** — เครื่องของเจ้าของที่บ้าน
 * ผิดพลาดตรงไหนจึงไม่มีใครมาช่วยดู และค่าเสียหายคือคนที่เพิ่งลง Ubuntu เสร็จ
 * ต้องมานั่งแก้เองโดยไม่รู้ว่าอะไรพัง · เทสต์นี้จึง **รันสคริปต์ตัวจริง** กับ
 * apt/npm/node ปลอมที่วางไว้ใน PATH แล้วดูว่ามันตัดสินใจถูกไหม
 * (แพทเทิร์นเดียวกับ test/update-recreate.test.js ที่รัน update.sh กับ docker ปลอม)
 *
 * สิ่งที่เทสต์นี้ตรวจไม่ได้และต้องยอมรับตรง ๆ: apt ลงของได้จริงไหม NodeSource
 * ตอบอะไรกลับมา และ Electron โหลดครบไหม — สามข้อนั้นต้องรันบนเครื่องจริง
 */

const WORK = await fs.mkdtemp(path.join(os.tmpdir(), 'install-ubuntu-'));
after(() => fs.rm(WORK, { recursive: true, force: true }));

let counter = 0;

/**
 * โปรเจกต์ปลอมหนึ่งชุด พร้อมคำสั่งปลอมที่จดไว้ว่าถูกเรียกด้วยอะไรบ้าง
 *
 * `nodeVersion` คือสิ่งที่ `node --version` ปลอมจะตอบ — ตัวแปรที่ตัดสินว่า
 * สคริปต์จะไปโหลด NodeSource มาลงทับหรือข้ามไป
 */
async function makeProject({ nodeVersion = 'v22.11.0', withEnv = false, withModules = false } = {}) {
  const dir = path.join(WORK, `p${counter += 1}`);
  const bin = path.join(dir, 'fakebin');
  const log = path.join(dir, 'calls.log');
  await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(dir, 'photobooth'), { recursive: true });
  await fs.mkdir(bin, { recursive: true });

  await fs.copyFile(path.join(ROOT, 'scripts', 'install-ubuntu.sh'),
    path.join(dir, 'scripts', 'install-ubuntu.sh'));
  await fs.chmod(path.join(dir, 'scripts', 'install-ubuntu.sh'), 0o755);

  // .env.example ของจริง — สคริปต์คัดลอกไฟล์นี้แล้วแทนที่สามบรรทัด
  await fs.copyFile(path.join(ROOT, '.env.example'), path.join(dir, '.env.example'));
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');
  await fs.writeFile(path.join(dir, 'photobooth', 'package-lock.json'), '{}');

  if (withEnv) {
    await fs.writeFile(path.join(dir, '.env'),
      'BASE_URL=http://อย่าทับฉัน:3000\nBOOTH_KEY=an-existing-key-1234\nADMIN_PASSWORD=existing\n');
  }
  if (withModules) {
    // node_modules ที่ใหม่กว่า lockfile = ของที่ลงไว้ยังตรงอยู่
    for (const where of [dir, path.join(dir, 'photobooth')]) {
      await fs.mkdir(path.join(where, 'node_modules'), { recursive: true });
    }
    await new Promise((done) => { setTimeout(done, 20); });
    const now = new Date();
    for (const where of [dir, path.join(dir, 'photobooth')]) {
      await fs.utimes(path.join(where, 'node_modules'), now, now);
    }
  }

  const fake = async (name, body) => {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`);
    await fs.chmod(path.join(bin, name), 0o755);
  };

  // sudo ปลอม: ข้ามแฟล็ก (-E ฯลฯ) แล้วรันคำสั่งที่เหลือ เหมือน sudo จริง
  await fake('sudo', 'while [ "${1#-}" != "$1" ]; do shift; done\nexec "$@"');
  // apt-get ปลอม: ลง nodejs แล้วต้องทำให้ `node --version` ตอบใหม่จริง ๆ
  // ไม่งั้นเทสต์จะไม่ได้เดินเส้นทางหลังอัปเกรดเลย และด่านกันของสคริปต์จะฟ้องถูกต้อง
  await fake('apt-get', `case "$*" in *nodejs*) cp "${bin}/node22" "${bin}/node" ;; esac
exit 0`);
  await fake('dpkg', 'exit 1');             // ยังไม่มีแพ็กเกจไหนลงไว้
  await fake('curl', 'echo "#!/bin/sh"');   // สคริปต์ของ NodeSource ปลอม
  // npm ปลอมต้องทิ้งร่องรอยเหมือนของจริง ไม่งั้นขั้นตรวจผลท้ายสคริปต์จะไม่ผ่าน
  // แล้วเทสต์จะไม่ได้เดินเส้นทางสำเร็จเลยสักข้อ
  await fake('npm', `case "$1" in
  ci) mkdir -p node_modules ;;
  run) mkdir -p node_modules/electron/dist
       echo electron > node_modules/electron/path.txt
       printf '#!/bin/sh\\n' > node_modules/electron/dist/electron
       chmod +x node_modules/electron/dist/electron ;;
esac
exit 0`);
  await fake('node', `[ "$1" = "--version" ] && echo "${nodeVersion}"; exit 0`);
  await fake('node22', '[ "$1" = "--version" ] && echo v22.11.0; exit 0');
  await fake('ip', 'echo "1.1.1.1 via 10.0.0.1 dev eth0 src 192.168.2.10 uid 1000"');
  await fake('id', 'echo 1000');            // ไม่ใช่ root

  return { dir, log, bin };
}

const calls = async (log) => fs.readFile(log, 'utf8').catch(() => '');

async function install(project, args = []) {
  return run('./scripts/install-ubuntu.sh', args, {
    cwd: project.dir,
    env: { ...process.env, PATH: `${project.bin}:${process.env.PATH}` },
  });
}

test('an up-to-date Node is left alone instead of being reinstalled over', async () => {
  const project = await makeProject({ nodeVersion: 'v22.11.0' });
  await install(project);

  const log = await calls(project.log);
  assert.ok(!log.includes('deb.nodesource.com'), 'ไม่ควรไปโหลด NodeSource เมื่อ Node ใหม่พออยู่แล้ว');
});

test('a Node too old for the project is replaced', async () => {
  const project = await makeProject({ nodeVersion: 'v18.20.4' });
  await install(project);

  const log = await calls(project.log);
  assert.match(log, /deb\.nodesource\.com\/setup_22\.x/);
});

test('an upgrade that silently did not happen stops the run instead of carrying on', async () => {
  const project = await makeProject({ nodeVersion: 'v18.20.4' });
  // apt ที่รายงานสำเร็จแต่ไม่ได้อัปเกรดจริง เกิดขึ้นได้จากซอร์สที่ตั้งไว้ผิด
  await fs.writeFile(path.join(project.bin, 'apt-get'), '#!/bin/sh\nexit 0\n');
  await fs.chmod(path.join(project.bin, 'apt-get'), 0o755);

  await assert.rejects(() => install(project), (error) => {
    assert.match(String(error.stdout), /ลง Node 22 ไม่สำเร็จ/);
    return true;
  });
});

test('a fresh machine gets an .env with a usable key and its own address', async () => {
  const project = await makeProject();
  await install(project);

  const env = await fs.readFile(path.join(project.dir, '.env'), 'utf8');

  // ไอพีต้องมาจากเส้นทางจริงของเครื่อง ไม่ใช่ localhost ที่มือถือแขกเข้าไม่ได้
  assert.match(env, /^BASE_URL=http:\/\/192\.168\.2\.10:3000$/m);

  // กุญแจต้องผ่านกติกาของ boothKey() ใน src/config.js: ASCII พิมพ์ได้ อย่างน้อย 16 ตัว
  const key = env.match(/^BOOTH_KEY=(.*)$/m)?.[1] ?? '';
  assert.ok(key.length >= 16, `กุญแจสั้นไป: ${key.length} ตัว`);
  assert.match(key, /^[\x20-\x7e]+$/);

  // รหัสแอดมินต้องถูกตั้งจริง ไม่ใช่ปล่อยข้อความไทยตัวอย่างไว้ให้กลายเป็นรหัสจริง
  const pass = env.match(/^ADMIN_PASSWORD=(.*)$/m)?.[1] ?? '';
  assert.ok(pass.length >= 8);
  assert.match(pass, /^[\x20-\x7e]+$/);

  // แทนที่ทั้งบรรทัด ไม่ใช่ต่อท้าย — คีย์ซ้ำสองบรรทัดอ่านแล้วงงว่าตัวไหนมีผล
  assert.equal(env.match(/^BOOTH_KEY=/gm).length, 1);
  assert.equal(env.match(/^BASE_URL=/gm).length, 1);
});

test('a real generated key is accepted, whatever the machine locale says', async () => {
  // กุญแจตัวจริงที่สคริปต์สุ่มให้บนเครื่อง Ubuntu 26.04 แล้ว **ถูกตัดสินว่าใช้ไม่ได้**
  // ทั้งที่เป็นตัวอักษรอังกฤษกับตัวเลขล้วน 32 ตัว · สาเหตุคือตัวตรวจเดิมใช้ช่วง
  // อักขระ `[ -~]` ซึ่ง grep ตีความตามลำดับการเรียงของ locale ไม่ใช่ตามรหัสอักขระ
  const real = 'jhdTuxAUqWIzhnCjwOGyhit9B7tccLiY';

  for (const locale of ['C', 'en_US.UTF-8', 'th_TH.UTF-8']) {
    const project = await makeProject();
    await fs.writeFile(path.join(project.dir, '.env'),
      `BASE_URL=http://192.168.2.10:3000\nBOOTH_KEY=${real}\n`);

    const { stdout } = await run('./scripts/install-ubuntu.sh', [], {
      cwd: project.dir,
      env: { ...process.env, PATH: `${project.bin}:${process.env.PATH}`, LC_ALL: locale },
    });
    assert.match(stdout, /BOOTH_KEY ใช้ได้/, `locale ${locale} ตัดสินกุญแจที่ถูกต้องว่าใช้ไม่ได้`);
  }
});

test('a key that really is unusable is still caught, and says what it saw', async () => {
  const project = await makeProject();
  // ยาวพอแต่มีอักขระไทยปน — ส่งเป็น HTTP header ไม่ได้ config จะเมินมันเงียบ ๆ
  await fs.writeFile(path.join(project.dir, '.env'),
    'BASE_URL=http://192.168.2.10:3000\nBOOTH_KEY=abcdefghijklmnopกขค\n');

  await assert.rejects(() => install(project), (error) => {
    assert.match(String(error.stdout), /BOOTH_KEY ใช้ไม่ได้: ยาว \d+ ตัว/);
    return true;
  });
});

test('an .env that already exists is never overwritten', async () => {
  const project = await makeProject({ withEnv: true });
  await install(project);

  const env = await fs.readFile(path.join(project.dir, '.env'), 'utf8');
  assert.match(env, /อย่าทับฉัน/, 'ทับ .env ของเครื่องที่ตั้งค่าไว้แล้ว');
});

test('a second run does not sit there reinstalling what is already correct', async () => {
  const project = await makeProject({ withModules: true });
  await install(project);

  const log = await calls(project.log);
  assert.ok(!log.includes('npm ci'), 'ลงใหม่ทั้งที่ของเดิมยังตรงกับ lockfile');
});

test('dependencies are installed when the lockfile is newer than what is on disk', async () => {
  const project = await makeProject({ withModules: true });
  // git pull แล้ว lockfile ใหม่กว่าของที่ลงไว้ — ต้องลงใหม่ ไม่ใช่ข้าม
  const later = new Date(Date.now() + 10_000);
  await fs.utimes(path.join(project.dir, 'package-lock.json'), later, later);
  await install(project);

  const log = await calls(project.log);
  assert.match(log, /npm ci/);
});

test('the Electron runtime is fetched, because npm ci no longer brings it', async () => {
  const project = await makeProject();
  await install(project);

  const log = await calls(project.log);
  assert.match(log, /npm run --silent install:electron/);
});

test('running the whole thing as root is refused, not quietly allowed', async () => {
  const project = await makeProject();
  await fs.writeFile(path.join(project.bin, 'id'), '#!/bin/sh\necho 0\n');
  await fs.chmod(path.join(project.bin, 'id'), 0o755);

  // node_modules เป็นของ root แล้วผู้ใช้ปกติเขียนไม่ได้ — ต้องหยุดก่อนแตะอะไร
  await assert.rejects(() => install(project), (error) => {
    assert.match(String(error.stdout), /ห้ามรันด้วย sudo/);
    return true;
  });
});

test('the camera and printer packages are opt-in, not forced on every machine', async () => {
  const plain = await makeProject();
  await install(plain);
  assert.ok(!(await calls(plain.log)).includes('gphoto2'));

  const full = await makeProject();
  await install(full, ['--camera', '--printer']);
  const log = await calls(full.log);
  assert.match(log, /gphoto2/);
  assert.match(log, /printer-driver-escpr/);
});

test('an unknown option stops instead of installing something unintended', async () => {
  const project = await makeProject();
  await assert.rejects(() => install(project, ['--wipe-everything']));
});
