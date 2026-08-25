import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';

import { useTempDataDir } from './helpers/app.js';

useTempDataDir('film-music');

const { config } = await import('../src/config.js');
const { FFMPEG, FFPROBE, ensureDirs } = await import('../src/lib/media.js');
const { planLength, secondsForPhotos, SECONDS_FLOOR, SECONDS_CEILING } = await import('../src/lib/film-plan.js');
const { buildMusicBed, encoderSignature, BED_CROSSFADE } = await import('../src/lib/film-encode.js');
const music = await import('../src/lib/music.js');

const run = promisify(execFile);
await ensureDirs();

const WORK = path.join(config.paths.export, 'music-test');
await fs.mkdir(WORK, { recursive: true });

/** เสียงสั้น ๆ ที่สร้างเอง — เร็วกว่าเอาเพลงจริงมาใช้ในเทสต์เป็นสิบเท่า */
async function tone(seconds, hz, outPath) {
  await run(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${seconds}:sample_rate=48000`,
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k', outPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
  return outPath;
}

async function seconds(filePath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
  ]);
  return Number(stdout.trim());
}

/* ---------- โปรแกรมคิดความยาวเอง ---------- */

test('seconds per photo stays inside the band, whatever the wedding size', () => {
  for (const count of [0, 1, 12, 40, 41, 120, 300, 700, 2000, 99999]) {
    const value = secondsForPhotos(count);
    assert.ok(value >= SECONDS_FLOOR && value <= SECONDS_CEILING,
      `${count} รูป ได้ ${value} วินาที ซึ่งอยู่นอกช่วง`);
  }
});

test('more photos never means more seconds each', () => {
  let previous = Infinity;
  for (const count of [10, 40, 120, 300, 700, 1500, 5000]) {
    const value = secondsForPhotos(count);
    assert.ok(value <= previous, `${count} รูป ได้ ${value} ซึ่งมากกว่าครั้งก่อน (${previous})`);
    previous = value;
  }
});

test('the predicted length counts cards and capped videos, not just photos', () => {
  const timeline = [
    { kind: 'opening' },
    { kind: 'image' }, { kind: 'image' },
    { kind: 'video', item: { duration: 300 } },   // ยาวเกิน ต้องถูกตัดที่เพดาน
    { kind: 'video', item: { duration: 9 } },     // สั้นกว่าเพดาน ต้องนับตามจริง
    { kind: 'wish' },
    { kind: 'closing' },
  ];
  const plan = planLength(timeline, { maxVideoSeconds: 30 });

  // 2 รูป × 8 + 30 + 9 + การ์ดคำอวยพร 8 + เปิด 8 + ปิด 8
  assert.equal(plan.secondsPerPhoto, 8);
  assert.equal(plan.totalSeconds, 16 + 30 + 9 + 8 + 8 + 8);
  assert.equal(plan.photos, 2);
});

test('an explicit number overrides the automatic choice', () => {
  const timeline = [{ kind: 'image' }, { kind: 'image' }];
  assert.equal(planLength(timeline, { seconds: 3 }).totalSeconds, 6);
  // ค่าที่ไม่ใช่ตัวเลขต้องตกกลับไปใช้ค่าอัตโนมัติ ไม่ใช่กลายเป็น NaN ทั้งเรื่อง
  assert.equal(planLength(timeline, { seconds: 'nonsense' }).totalSeconds, 16);
});

/* ---------- คลังเพลง ---------- */

test('a track id cannot walk out of the music library', () => {
  for (const id of ['../../.env', '/etc/passwd', 'mine/../../.env', 'mine/x.txt', 'x.mp3', '', null]) {
    assert.equal(music.trackPath(id), null, String(id));
  }
  assert.ok(music.trackPath('wedding/song.mp3')?.startsWith(config.paths.music));
});

test('the library reads the folder, and picking the same track twice keeps both', async () => {
  const dir = path.join(config.paths.music, 'library', 'wedding');
  await fs.mkdir(dir, { recursive: true });
  await tone(3, 440, path.join(dir, 'one.m4a'));
  await tone(2, 660, path.join(dir, 'two.m4a'));
  // ไฟล์ที่ไม่ใช่เสียงต้องไม่โผล่ในรายการให้เลือก
  await fs.writeFile(path.join(dir, 'notes.txt'), 'ไม่ใช่เพลง');

  const groups = await music.listLibrary();
  const wedding = groups.find((group) => group.theme === 'wedding');
  assert.equal(wedding.tracks.length, 2);
  assert.deepEqual(wedding.tracks.map((track) => track.title).sort(), ['one', 'two']);
  assert.equal(wedding.seconds, 5);

  const twice = ['wedding/one.m4a', 'wedding/one.m4a'];
  assert.equal((await music.resolveTracks(twice)).length, 2, 'เลือกเพลงซ้ำต้องได้สองท่อน');
  assert.equal(await music.totalSeconds(twice), 6);

  // เพลงที่ไฟล์หายไปแล้วต้องถูกคัดออก ไม่ใช่ส่ง path ที่ไม่มีอยู่ให้ ffmpeg
  assert.equal((await music.resolveTracks(['wedding/gone.m4a'])).length, 0);
});

test('the duration is measured once and cached beside the file', async () => {
  const dir = path.join(config.paths.music, 'library', 'calm');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'quiet.m4a');
  await tone(4, 330, file);

  await music.listLibrary();
  const cached = JSON.parse(await fs.readFile(`${file}.json`, 'utf8'));
  assert.equal(cached.seconds, 4);

  // เขียนทับด้วยเพลงที่ยาวไม่เท่าเดิม ค่าที่จำไว้ต้องไม่ถูกใช้ต่อ
  await tone(7, 330, file);
  const groups = await music.listLibrary();
  assert.equal(groups.find((group) => group.theme === 'calm').tracks[0].seconds, 7);
});

test('only tracks the owner uploaded can be deleted from the web', async () => {
  const mine = path.join(config.paths.music, 'library', 'mine');
  await fs.mkdir(mine, { recursive: true });
  await tone(2, 550, path.join(mine, 'ours.m4a'));

  assert.equal(await music.deleteTrack('mine/ours.m4a'), true);
  // เพลงที่มากับโปรแกรม fetch-music.sh จะโหลดกลับมาอยู่ดี ลบจากเว็บจึงทำให้งง
  assert.equal(await music.deleteTrack('wedding/one.m4a'), false);
  assert.equal(await music.deleteTrack('../../.env'), false);
});

// เจอจริงบน NAS: fetch-music.sh รายงานว่าโหลดครบ 22 เพลง sudo ls เห็นไฟล์ครบ
// แต่ listLibrary() ในคอนเทนเนอร์ยังคืน [] เพราะไฟล์เป็นของ root ไม่ใช่ PUID:PGID
// ของคอนเทนเนอร์ — ก่อนแก้ไม่มี log อะไรเลยให้สืบต่อได้จาก docker compose logs
test('a permission error on the library is logged instead of vanishing silently', async () => {
  const libraryDir = path.join(config.paths.music, 'library');
  await fs.rm(libraryDir, { recursive: true, force: true });
  // บังคับ ENOTDIR แทนการพึ่งสิทธิ์จริง (เทสต์อาจรันเป็น root ซึ่งไม่มี EACCES ให้เห็น)
  // ENOTDIR ก็ไม่ใช่ ENOENT เหมือนกัน คือ "ผิดปกติจริง" ไม่ใช่ "ยังไม่เคยโหลดเพลง"
  await fs.writeFile(libraryDir, 'ไม่ใช่โฟลเดอร์');

  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    assert.deepEqual(await music.listLibrary(), []);
  } finally {
    console.error = original;
    await fs.rm(libraryDir, { force: true });
  }
  assert.ok(calls.length > 0, 'อ่านคลังเพลงไม่ได้ทั้งที่ไม่ใช่ ENOENT แต่ไม่ log อะไรเลย');
  assert.match(calls[0].join(' '), /อ่านคลังเพลงไม่ได้/);
});

test('a library folder that was never downloaded yet stays silent', async () => {
  const libraryDir = path.join(config.paths.music, 'library');
  await fs.rm(libraryDir, { recursive: true, force: true });

  const original = console.error;
  const calls = [];
  console.error = (...args) => calls.push(args);
  try {
    assert.deepEqual(await music.listLibrary(), []);
  } finally {
    console.error = original;
  }
  assert.equal(calls.length, 0, 'ENOENT คือสภาพปกติ ไม่ควร log ทุกครั้งที่หน้าแอดมิน poll');
});

/* ---------- เตียงเสียงจากหลายเพลง ---------- */

test('the bed comes out exactly as long as the film asked for', async () => {
  const tracks = [
    await tone(6, 440, path.join(WORK, 'a.m4a')),
    await tone(5, 550, path.join(WORK, 'b.m4a')),
  ];
  const out = path.join(WORK, 'bed.m4a');
  await buildMusicBed(tracks, 30, out, WORK);

  assert.ok(Math.abs(await seconds(out) - 30) < 0.3, 'ความยาวต้องตรงกับที่หนังต้องการ');

  const probe = await run(FFPROBE, [
    '-v', 'error', '-show_entries', 'stream=sample_rate,channels', '-of', 'default=nw=1', out,
  ]);
  assert.match(probe.stdout, /sample_rate=48000/);
  assert.match(probe.stdout, /channels=2/);
});

test('short tracks shrink the crossfade instead of yielding an empty bed', async () => {
  // acrossfade=d=4 บนเพลง 2 วินาที **ไม่ error แต่คืนไฟล์ยาว 0 วินาที** แล้วไปล้ม
  // ทีหลังตอน -stream_loop ด้วยข้อความที่อ่านไม่ออกว่าเกี่ยวกับเพลง — และล้มหลังจาก
  // เรนเดอร์หนังครบทุกคลิปไปแล้ว
  const tiny = [
    await tone(2, 440, path.join(WORK, 's1.m4a')),
    await tone(2, 550, path.join(WORK, 's2.m4a')),
    await tone(2, 660, path.join(WORK, 's3.m4a')),
  ];
  const out = path.join(WORK, 'bed-short.m4a');
  await buildMusicBed(tiny, 25, out, WORK);
  assert.ok(Math.abs(await seconds(out) - 25) < 0.3, 'เพลงสั้นก็ต้องได้เตียงเสียงยาวตามสั่ง');
});

test('tracks too short to fade at all are refused by name, not silently dropped', async () => {
  const blink = await tone(1, 440, path.join(WORK, 'blink.m4a'));
  await assert.rejects(
    () => buildMusicBed([blink], 25, path.join(WORK, 'bed-blink.m4a'), WORK),
    /สั้นเกินไป/,
  );
});

test('no music picked means no bed, not a crash', async () => {
  assert.equal(await buildMusicBed([], 30, path.join(WORK, 'none.m4a'), WORK), null);
  assert.equal(await buildMusicBed(null, 30, path.join(WORK, 'none.m4a'), WORK), null);
});

test('the joins are crossfaded, so a run of tracks has no dead air', async () => {
  // เพลงที่จบด้วยความเงียบ — เหมือนเพลงเปียโนจริงที่เสียงค่อย ๆ หายไปตอนจบ
  const quietEnd = path.join(WORK, 'tail.m4a');
  await run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8:sample_rate=48000',
    '-af', 'volume=enable=\'gte(t,4)\':volume=0',
    '-ac', '2', '-c:a', 'aac', '-b:a', '96k', quietEnd,
  ], { maxBuffer: 4 * 1024 * 1024 });

  const out = path.join(WORK, 'bed-joins.m4a');
  await buildMusicBed([quietEnd, quietEnd, quietEnd], 40, out, WORK);

  // วัดจากไฟล์จริง ไม่ใช่เชื่อว่าตัวกรองทำงาน — เคยวัดแล้วพบช่วงเงียบ 3.5–5.3 วินาที
  // ที่ทุกรอยต่อ ตอนที่ยังใช้ concat ธรรมดา ก่อนจะเปลี่ยนมาไล่เฟดทับกัน
  const { stderr } = await run(FFMPEG, [
    '-hide_banner', '-nostats', '-i', out,
    '-af', 'silencedetect=n=-45dB:d=3', '-f', 'null', '-',
  ], { maxBuffer: 8 * 1024 * 1024 }).catch((error) => error);

  const gaps = (String(stderr).match(/silence_start/g) ?? []).length;
  assert.equal(gaps, 0, `ยังมีช่วงเงียบยาว ${gaps} ช่วง — รอยต่อไม่ได้ถูกเฟดทับ`);
  assert.ok(BED_CROSSFADE > 0);
});

/* ---------- ตัวเข้ารหัสกับ GPU ---------- */

test('the film encoder comes from config, and defaults to what it always was', async () => {
  const source = await fs.readFile(new URL('../src/lib/film-encode.js', import.meta.url), 'utf8');
  assert.ok(!/'-c:v', 'libx264'/.test(source), 'ตัวเข้ารหัสต้องไม่ถูกฮาร์ดโค้ดอีก');
  assert.match(source, /config\.media\.videoEncoder/);

  // ค่าเริ่มต้นต้องเท่ากับพฤติกรรมเดิมเป๊ะ ไม่งั้นหนังที่ทำหลังอัปเดตจะคุณภาพเปลี่ยน
  // โดยไม่มีใครสั่ง — เป็นการเปลี่ยนที่มองไม่เห็นจนกว่าจะเอาสองไฟล์มาเทียบกัน
  assert.equal(encoderSignature(), 'libx264 -preset veryfast -crf 20 -profile:v high -level 4.1');
});

test('the decoder arguments sit before the input they decode', async () => {
  const source = await fs.readFile(new URL('../src/lib/film-encode.js', import.meta.url), 'utf8');
  // -hwaccel ที่วางหลัง -i จะถูก ffmpeg เมินเงียบ ๆ GPU จะไม่ถูกใช้โดยไม่มีใครรู้
  for (const match of source.matchAll(/const inputs = \[([^\]]*)\]/g)) {
    assert.match(match[1], /^\.\.\.config\.media\.decoderArgs, '-i'/,
      'อาร์กิวเมนต์ถอดรหัสต้องมาก่อน -i');
  }
});

test('old clips are thrown away when the encoder changes under them', async () => {
  const source = await fs.readFile(new URL('../src/lib/film-run.js', import.meta.url), 'utf8');
  assert.match(source, /dropStaleParts/);
  // concat แบบ -c copy ต้องการคลิปที่พารามิเตอร์เหมือนกันทุกใบ คลิปคนละตัวเข้ารหัส
  // มาต่อกันจะได้หนังที่ภาพค้างกลางเรื่องโดยไม่มี error ให้เห็นสักบรรทัด
  assert.match(source, /encoderSignature\(\)/);
  assert.match(source, /rm\(workDir, \{ recursive: true/);
});

// GPU (GTX 1050 Ti) ใช้งานได้จริงแล้ว ยืนยันถึงระดับคอนเทนเนอร์ (nvidia-container-toolkit
// ลงทะเบียน driver กับ Docker daemon แล้ว, ffmpeg มี nvenc มาให้อยู่แล้วจริง) — โค้ดที่เลือก
// encoder รองรับสลับผ่าน .env มาตั้งแต่ก่อนหน้านี้แล้ว ที่ขาดจริง ๆ มีจุดเดียว: ไม่มีที่ไหน
// ขอสิทธิ์อุปกรณ์ GPU จาก Docker daemon เข้าไปให้คอนเทนเนอร์เลย ทดสอบจริงกับ GPU จริง
// ในเทสต์อัตโนมัติทำไม่ได้ (เครื่องที่รันเทสต์ไม่มี GPU) จึงตรวจแค่ว่า "ขอสิทธิ์" ไว้แล้ว
test('the live container asks Docker for the GPU device', async () => {
  const compose = await fs.readFile(new URL('../docker-compose.yml', import.meta.url), 'utf8');
  assert.match(compose, /driver:\s*nvidia/);
  assert.match(compose, /capabilities:\s*\[gpu\]/);
});

test('the standalone film-export container asks for the GPU too, without touching the live one', async () => {
  const script = await fs.readFile(new URL('../scripts/export-film.sh', import.meta.url), 'utf8');
  assert.match(script, /--gpus/);
  // ต้องยังเป็นคอนเทนเนอร์ชั่วคราวแยกจาก wedding-share เหมือนเดิม — ถ้า GPU พังตอน
  // export ต้องไม่มีทางกระทบเว็บที่แขกกำลังใช้งานอยู่ (คนละคอนเทนเนอร์ คนละชื่อ)
  assert.match(script, /--name wedding-film/);
  assert.ok(!script.includes('--name wedding-share'), 'ต้องไม่แตะคอนเทนเนอร์เว็บจริง');
  assert.match(script, /docker run --rm/, 'ต้องยังเป็นคอนเทนเนอร์ชั่วคราวที่ลบตัวเองทิ้ง');
});

test('picking GPU in .env is documented exactly once, not two conflicting copies', async () => {
  const example = await fs.readFile(new URL('../.env.example', import.meta.url), 'utf8');
  // เคยมีคอมเมนต์อธิบายชุดเดียวกันซ้ำสองที่ในไฟล์นี้ ตกค้างจากคนละรอบแก้ — คนละคำ
  // แต่บอกเรื่องเดียวกัน ทำให้ไม่รู้ว่าอันไหนคือของจริง
  const count = (example.match(/h264_nvenc/g) ?? []).length;
  assert.equal(count, 1, `บล็อกอธิบาย GPU ซ้ำกัน ${count} ที่ในไฟล์ ควรมีที่เดียว`);
});

/* ---------- แคตตาล็อกเพลงที่มากับโปรแกรม ---------- */

test('every catalogued track names its licence, its source and its hash', async () => {
  const raw = await fs.readFile(new URL('../assets/music-catalogue.json', import.meta.url), 'utf8');
  const catalogue = JSON.parse(raw);

  const themes = Object.entries(catalogue.themes);
  assert.ok(themes.length >= 3, 'ต้องมีหลายกลุ่มให้เลือก');

  for (const [theme, tracks] of themes) {
    assert.ok(tracks.length > 0, `กลุ่ม ${theme} ว่างเปล่า`);
    for (const track of tracks) {
      for (const field of ['id', 'title', 'artist', 'file', 'url', 'source', 'licence', 'licenceUrl']) {
        assert.ok(typeof track[field] === 'string' && track[field].length > 0,
          `${theme}/${track.id ?? '?'} ขาดช่อง ${field}`);
      }
      // แฮชคือสิ่งเดียวที่บอกได้ว่าไฟล์ที่โหลดมาคือไฟล์ที่ตั้งใจ ไม่ใช่หน้า error
      assert.match(track.sha256, /^[0-9a-f]{64}$/, `${track.id} แฮชไม่ถูกรูปแบบ`);
      assert.ok(Number.isInteger(track.seconds) && track.seconds > 30, `${track.id} ความยาวผิด`);
      // สัญญาอนุญาตต้องเป็นแบบที่ใช้ได้โดยไม่ต้องให้เครดิต — วิดีโองานแต่งไม่มีที่ใส่เครดิต
      assert.match(track.licenceUrl, /publicdomain/, `${track.id} ไม่ใช่สาธารณสมบัติ`);
    }
  }
});

test('the fetch script verifies hashes instead of trusting the download', async () => {
  const script = await fs.readFile(new URL('../scripts/fetch-music.sh', import.meta.url), 'utf8');
  assert.match(script, /sha256sum/);
  // ไฟล์ที่โหลดมาไม่ครบต้องถูกทิ้ง ไม่ใช่เตือนแล้วเก็บไว้ให้ ffmpeg ไปล้มทีหลัง
  assert.match(script, /rm -f "\$DEST\.part"/);
  assert.match(script, /\.part/, 'ต้องโหลดลงชื่อชั่วคราวก่อนแล้วค่อยเปลี่ยนชื่อ');
});

test('the fetch script retries the transient failures archive.org actually returns', async () => {
  const script = await fs.readFile(new URL('../scripts/fetch-music.sh', import.meta.url), 'utf8');

  // ตรวจที่บรรทัดคำสั่งจริง ไม่ใช่ทั้งไฟล์ — ในไฟล์มีคำอธิบายว่าทำไมถึงไม่ใช้
  // --retry-all-errors อยู่ด้วย การค้นทั้งไฟล์จะไปเจอคำอธิบายนั้นแทนของจริง
  const line = script.split('\n').find((row) => row.includes('curl -fsSL'));
  assert.ok(line, 'ไม่เจอบรรทัดที่เรียก curl');

  // เจอจริงบน NAS: 7 ใน 22 เพลงล้มด้วย 500/502 ทั้งที่ยิงซ้ำแล้วไฟล์ยังอยู่ดี
  // curl ลองใหม่เองได้ ไม่ต้องโยนภาระให้คนไปรันสคริปต์ซ้ำ
  assert.match(line, /--retry \d/);
  assert.match(line, /--retry-delay \d/);

  // --retry-all-errors จะลองใหม่กับ 404 ด้วย ซึ่งลองกี่ครั้งก็ไม่หาย
  // รอเปล่า ๆ แล้วยังกลบสาเหตุที่แท้จริง
  assert.ok(!line.includes('--retry-all-errors'), 'ห้ามลองใหม่กับความผิดพลาดที่ลองแล้วไม่หาย');

  // -m เป็นเพดานต่อการลองหนึ่งครั้ง ต้องคงไว้ ไม่งั้นโหนดที่ค้างจะแขวนสคริปต์ทิ้งไว้
  assert.match(line, /-m 300/);
});

test('the fetch script sets file ownership to match the container, without letting a chown failure fail the run', async () => {
  const script = await fs.readFile(new URL('../scripts/fetch-music.sh', import.meta.url), 'utf8');

  // ไฟล์ที่โหลดมาด้วย sudo เป็นของ root:root เสมอ ต่างจากคอนเทนเนอร์ที่รันเป็น
  // PUID:PGID (docker-compose.yml) — ไม่ chown ให้ตรงกัน fs.readdir() ในคอนเทนเนอร์
  // จะเจอ EACCES แล้วคลังเพลงว่างเปล่าในหน้าเว็บทั้งที่ไฟล์อยู่ครบ — เจอเคสนี้มาแล้วจริง
  assert.match(script, /PUID="\$\(grep '\^PUID=' \.env/);
  assert.match(script, /PGID="\$\(grep '\^PGID=' \.env/);
  assert.match(script, /chown -R "\$\{PUID:-1026\}:\$\{PGID:-100\}" "\$LIBRARY"/);

  // เพลงที่โหลดสำเร็จแล้วต้องยังนับว่าสำเร็จ แม้ chown จะทำไม่ได้ (เช่น รันไม่ครบสิทธิ์)
  const chownIndex = script.indexOf('chown -R');
  const nextFewLines = script.slice(chownIndex, chownIndex + 400).split('\n').slice(0, 4).join('\n');
  assert.ok(!/exit 1/.test(nextFewLines),
    'chown ล้มแล้วต้องแค่เตือน ไม่ใช่ทำให้สคริปต์ทั้งตัวออกด้วย error');
});

test.after(() => fs.rm(WORK, { recursive: true, force: true }));

/* ---------- สคริปต์โหลดเพลงต้องชี้ไปโฟลเดอร์ที่แอปอ่านจริง ---------- */

test('the fetch script never defaults to a folder the app does not read', async () => {
  const script = await fs.readFile(new URL('../scripts/fetch-music.sh', import.meta.url), 'utf8');

  // `$PROJECT_DIR/data` คือโฟลเดอร์ในโค้ด ส่วนแอปอ่านจากโฟลเดอร์ที่ bind mount
  // เข้าไปเป็น /app/data (บนเครื่องจริงคือ /volume1/wedding) — โหลดผิดที่แปลว่า
  // สคริปต์รายงานว่าสำเร็จครบทุกเพลง แต่คลังในหน้าเว็บว่างเปล่า
  assert.ok(!/DATA_DIR="\$\{DATA_DIR:-\$PROJECT_DIR\/data\}"/.test(script),
    'ห้ามใช้โฟลเดอร์ในโค้ดเป็นค่าเริ่มต้น');
  assert.match(script, /\/volume1\/wedding/);
  assert.match(script, /docker inspect/, 'ควรถามคอนเทนเนอร์ที่รันอยู่ก่อน');
  // ปลายทางที่ไม่มีอยู่ต้องหยุด ไม่ใช่สร้างใหม่แล้วโหลดลงไป
  assert.match(script, /ไม่พบโฟลเดอร์ข้อมูล/);
  assert.match(script, /--data-dir/);
});

/* ---------- ตัวเลขที่โชว์ต้องเป็นตัวเลขที่ใช้จริง ---------- */

test('the estimate removes duplicates exactly like the renderer does', async () => {
  const routes = await fs.readFile(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const block = routes.slice(routes.indexOf("adminRouter.get('/admin/film/plan'"));
  assert.match(block.slice(0, block.indexOf('res.json')), /dedupe\(deck\.items\)/,
    'ไม่ตัดไฟล์ซ้ำ ตัวเลขจะสูงเกินจริงในงานที่แขกอัพรูปซ้ำ');
  assert.match(block.slice(0, block.indexOf('res.json')), /maxVideoSeconds/,
    'เพดานวิดีโอต้องมีผลกับตัวเลขที่โชว์');
});

/* ---------- เก็บกวาดหลังทำหนังเสร็จ ---------- */

test('the clip folders are cleared on success and kept on failure', async () => {
  const job = await fs.readFile(new URL('../src/lib/film-job.js', import.meta.url), 'utf8');
  const done = job.indexOf("state: 'done'");
  const failed = job.indexOf("state: 'failed'");

  const cleanup = job.indexOf('rm(result.work');
  assert.ok(cleanup > 0, 'ต้องมีการเก็บกวาดโฟลเดอร์งาน');
  assert.ok(cleanup < done, 'ต้องเก็บกวาดก่อนรายงานว่าเสร็จ');
  // ตอนล้มต้องเก็บคลิปไว้ ไม่งั้นกดใหม่ก็ต้องเรนเดอร์ใหม่ทั้งเรื่อง
  assert.ok(cleanup < failed, 'การเก็บกวาดต้องอยู่ในเส้นทางสำเร็จเท่านั้น');
});

/* ---------- ของที่ถอดออกไปแล้ว ต้องไม่หลงเหลือ ---------- */

test('the music folder is never mistaken for a single song file', async () => {
  const routes = await fs.readFile(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  // currentMusic() หยิบ "รายการแรกในโฟลเดอร์" ซึ่งตอนนี้คือโฟลเดอร์ library
  // ไม่ใช่ไฟล์เพลง — ffmpeg ที่ได้ path ของโฟลเดอร์จะล้มแบบอ่านไม่รู้เรื่อง
  assert.ok(!routes.includes('currentMusic'), 'ถอด currentMusic ออกแล้ว');
  assert.ok(!routes.includes('film/music/delete'), 'route ที่ไม่มีใครเรียกต้องถูกถอดด้วย');
});

test('the admin page can delete an uploaded track and shows which film is rendering', async () => {
  const js = await fs.readFile(new URL('../public/js/admin-film.js', import.meta.url), 'utf8');

  // เอกสารบอกว่า "ลบรายเพลงได้" — ต้องมีปุ่มจริง ไม่ใช่มีแค่ route กับเทสต์
  assert.match(js, /film\/track\/delete/);
  assert.match(js, /group\.theme === 'mine'/, 'ปุ่มลบต้องมีเฉพาะกลุ่มเพลงของตัวเอง');

  // ทำหนังสองเรื่องแล้วแถบเดินเต็มจนย้อนกลับไป 0 โดยไม่บอกอะไร คนกดจะคิดว่างานล้ม
  assert.match(js, /style_of/);
  assert.match(js, /styleTotal/);
});
