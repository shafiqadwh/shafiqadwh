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

test.after(() => fs.rm(WORK, { recursive: true, force: true }));
