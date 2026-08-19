import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { useTempDataDir, startTestServer, login } from './helpers/app.js';

const dataDir = useTempDataDir('filmweb');
const app = await startTestServer();
const cookie = await login(app.baseUrl);

const { config } = await import('../src/config.js');
const { acquireLock, lockOwner } = await import('../src/lib/film-lock.js');
const { jobStatus, existingFilm } = await import('../src/lib/film-job.js');

after(() => app.close());
before(() => fs.mkdir(config.paths.export, { recursive: true }));

function asAdmin(path, options = {}) {
  return fetch(`${app.baseUrl}${path}`, {
    ...options,
    headers: { cookie, accept: 'application/json', ...(options.headers ?? {}) },
  });
}

test('every film route is closed to anyone who is not the host', async () => {
  // ปุ่มนี้กินซีพียูทั้งเครื่องเป็นสิบ ๆ นาที และไฟล์ผลลัพธ์คือรูปทุกใบของงาน
  // รวมของที่แอดมินซ่อนไว้ — ห้ามให้คนนอกแตะได้ทั้งการสั่งและการดาวน์โหลด
  for (const [method, route] of [
    ['GET', '/admin/film/status'],
    ['POST', '/admin/film/start'],
    ['POST', '/admin/film/music'],
    ['POST', '/admin/film/music/delete'],
    ['GET', '/admin/film/video'],
    ['GET', '/admin/film/download'],
  ]) {
    const response = await fetch(`${app.baseUrl}${route}`, {
      method,
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    assert.ok(response.status === 401 || response.status === 302,
      `${method} ${route} must not answer a stranger (got ${response.status})`);
  }
});

test('with no film made yet the page says so instead of serving a broken file', async () => {
  assert.equal(await existingFilm(), null);

  const status = await (await asAdmin('/admin/film/status')).json();
  assert.equal(status.film, null);
  assert.equal(status.state, 'idle');

  // ไม่มีไฟล์ = 404 ไม่ใช่ไฟล์ว่างเปล่าที่เบราว์เซอร์พยายามเล่นแล้วขึ้น error
  assert.equal((await asAdmin('/admin/film/video')).status, 404);
  assert.equal((await asAdmin('/admin/film/download')).status, 404);
});

test('a film that is there is served with seeking and without stale caching', async () => {
  const filmPath = path.join(config.paths.export, 'wedding-film.mp4');
  await fs.writeFile(filmPath, Buffer.alloc(4096, 7));

  const ranged = await asAdmin('/admin/film/video', { headers: { range: 'bytes=10-19' } });
  assert.equal(ranged.status, 206, 'seeking inside an hour-long film needs range support');
  assert.equal(ranged.headers.get('content-range'), 'bytes 10-19/4096');

  // หนังถูกสร้างทับที่เดิมได้ ถ้าเบราว์เซอร์แคชไว้ยาวจะเล่นของเก่าหลังสร้างใหม่
  assert.match(ranged.headers.get('cache-control') ?? '', /no-cache/);

  const download = await asAdmin('/admin/film/download');
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);

  await fs.rm(filmPath, { force: true });
});

test('two exports can never run at once, even from different containers', async () => {
  // ปุ่มในเว็บรันในคอนเทนเนอร์ของเว็บ ส่วน scripts/export-film.sh รันในคอนเทนเนอร์
  // ชั่วคราวคนละตัว เช็ก PID ข้ามกันไม่ได้ ล็อกจึงต้องอยู่บนดิสก์ที่ทั้งคู่เห็น
  const held = await acquireLock('cli');
  try {
    const owner = await lockOwner();
    assert.equal(owner.source, 'cli');

    await assert.rejects(() => acquireLock('web'), (error) => error.code === 'LOCKED');

    const status = await (await asAdmin('/admin/film/status')).json();
    assert.equal(status.busyElsewhere, true, 'the web button must know an SSH run is in progress');

    const start = await asAdmin('/admin/film/start', { method: 'POST' });
    assert.equal(start.status, 409, 'and must refuse to start a second one');
  } finally {
    await held.release();
  }

  assert.equal(await lockOwner(), null, 'releasing frees it for the next run');
});

test('a job killed by a restart is reported as stopped, not stuck at 40%', async () => {
  // เจอได้จริง: คอนเทนเนอร์ถูกรีสตาร์ทตอนกำลังเรนเดอร์ ไฟล์สถานะยังบอกว่า running
  // อยู่ ถ้าไม่ตรวจว่ายังมีใครถือล็อกอยู่จริง หน้าเว็บจะหมุนรอตลอดกาล
  await fs.writeFile(
    path.join(config.paths.export, 'status.json'),
    JSON.stringify({ state: 'running', phase: 'building', done: 12, total: 40 }),
  );

  const status = await jobStatus();
  assert.equal(status.state, 'stopped');
  assert.match(status.error, /หยุดกลางทาง/);
});

test('numbers typed into the form are clamped before they reach ffmpeg', async () => {
  // ค่าติดลบหรือค่าที่ไม่ใช่ตัวเลขทำให้ตัวกรองของ ffmpeg พังกลางทางแบบอ่าน error
  // ไม่รู้เรื่อง — หนีบให้อยู่ในช่วงที่ปลอดภัยตั้งแต่ก่อนเริ่มงาน
  const source = await fs.readFile(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf("adminRouter.post('/admin/film/start'"));

  assert.match(block, /Number\.isFinite/, 'a non-number must fall back, not reach ffmpeg');
  assert.match(block, /Math\.min\(Math\.max/, 'and out-of-range values must be clamped');
  assert.match(block, /clamp\(req\.body\.seconds/);
  assert.match(block, /clamp\(req\.body\.maxVideoSeconds/);
});

test('the music upload only accepts audio, and keeps one file at a time', async () => {
  const notAudio = new FormData();
  notAudio.append('music', new Blob([Buffer.alloc(64)]), 'song.exe');
  const refused = await asAdmin('/admin/film/music', { method: 'POST', body: notAudio });
  assert.equal(refused.status, 400, 'an executable must never land in the music folder');

  const first = new FormData();
  first.append('music', new Blob([Buffer.alloc(2048, 1)]), 'first.mp3');
  assert.equal((await asAdmin('/admin/film/music', { method: 'POST', body: first })).status, 200);

  const second = new FormData();
  second.append('music', new Blob([Buffer.alloc(2048, 2)]), 'second.m4a');
  assert.equal((await asAdmin('/admin/film/music', { method: 'POST', body: second })).status, 200);

  // อัพเพลงใหม่ต้องทับของเดิม ไม่ใช่กองสะสมจนไม่รู้ว่าเพลงไหนถูกใช้
  const names = await fs.readdir(config.paths.music);
  assert.equal(names.length, 1, `only one song may be kept, found ${names.join(', ')}`);
  assert.equal(names[0], 'song.m4a');

  await asAdmin('/admin/film/music/delete', { method: 'POST' });
  assert.deepEqual(await fs.readdir(config.paths.music), []);
});

test('the admin page ships the film panel and its script', async () => {
  const html = await (await fetch(`${app.baseUrl}/admin?lang=th`, { headers: { cookie } })).text();

  assert.match(html, /id="film"/, 'the panel is rendered by the server, not only by JavaScript');
  assert.match(html, /id="film-start"/);
  assert.match(html, /admin-film\.js\?v=/, 'the script carries the cache-busting version');
  // หนังไฟล์ใหญ่หลาย GB ห้ามให้มือถือเริ่มโหลดทันทีที่เปิดหน้าแอดมิน
  assert.match(html, /preload="none"/);
});
