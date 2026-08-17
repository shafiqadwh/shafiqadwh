import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeMovHevc, makeMp4, uploadFiles } from './helpers/fixtures.js';

const dataDir = useTempDataDir('video');
process.env.MAX_VIDEO_SECONDS = '4';
process.env.FFMPEG_THREADS = '1';

const { FFMPEG } = await import('../src/lib/media.js');
const { whenIdle } = await import('../src/lib/queue.js');

let app;
let cookie;

before(async () => {
  app = await startTestServer();
  cookie = await login(app.baseUrl);
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('an MP4 arrives with a poster frame and its duration', async () => {
  const clip = path.join(dataDir, 'dance.mp4');
  await makeMp4(clip, { seconds: 2, ffmpeg: FFMPEG });

  const upload = await uploadFiles(app.baseUrl, [clip], { uploader: 'Ali' });
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  assert.equal(upload.body.created, 1);

  const listed = await (await fetch(`${app.baseUrl}/api/items?filter=videos`)).json();
  const item = listed.items.find((entry) => entry.id === upload.body.ids[0]);

  assert.equal(item.kind, 'video');
  assert.ok(Math.abs(item.duration - 2) < 0.5, `duration should be about 2s, got ${item.duration}`);
  assert.equal(item.width, 320);
  assert.equal(item.height, 240);

  const poster = await fetch(`${app.baseUrl}${item.thumbUrl}`);
  assert.equal(poster.status, 200);
  assert.equal(poster.headers.get('content-type'), 'image/jpeg');

  const playback = await fetch(`${app.baseUrl}${item.mediaUrl}`);
  assert.equal(playback.status, 200);
});

test('an iPhone HEVC .mov is converted so Android can play it', async () => {
  const clip = path.join(dataDir, 'IMG_0042.mov');
  await makeMovHevc(clip, { seconds: 2, ffmpeg: FFMPEG });

  const upload = await uploadFiles(app.baseUrl, [clip]);
  assert.equal(upload.status, 201, JSON.stringify(upload.body));
  const id = upload.body.ids[0];

  const duringConversion = await (await fetch(`${app.baseUrl}/api/items?filter=videos`)).json();
  const queued = duringConversion.items.find((entry) => entry.id === id);
  assert.equal(queued.converting, true, 'the guest should not have waited for the transcode');

  await whenIdle();

  const { db } = await import('../src/db.js');
  const row = db.prepare('SELECT convert_state, playback_name, stored_name FROM items WHERE id = ?').get(id);
  assert.equal(row.convert_state, 'done', 'the background queue should have finished the job');
  assert.match(row.playback_name, /-web\.mp4$/);

  // The original is kept untouched for the download-everything ZIP.
  await fs.access(path.join(dataDir, 'uploads', row.stored_name));

  const served = await fetch(`${app.baseUrl}/media/${id}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'video/mp4');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ffprobe = (await import('../src/lib/media.js')).FFPROBE;
  const { stdout } = await promisify(execFile)(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0',
    path.join(dataDir, 'derived', row.playback_name),
  ]);
  assert.equal(stdout.trim(), 'h264', 'the web copy must be H.264, not HEVC');
});

test('a clip longer than the limit is refused, in the guest\'s language', async () => {
  const clip = path.join(dataDir, 'speech.mp4');
  await makeMp4(clip, { seconds: 8, ffmpeg: FFMPEG });

  const malay = await uploadFiles(app.baseUrl, [clip], { lang: 'ms' });
  assert.equal(malay.status, 400);
  assert.equal(malay.body.created, 0);
  assert.match(malay.body.errors[0], /melebihi 4 saat/);

  const thai = await uploadFiles(app.baseUrl, [clip], { lang: 'th' });
  assert.match(thai.body.errors[0], /ยาวเกิน 4 วินาที/);

  const english = await uploadFiles(app.baseUrl, [clip], { lang: 'en' });
  assert.match(english.body.errors[0], /longer than 4 seconds/);
});

test('a file that only pretends to be an MP4 is refused without a crash', async () => {
  const fake = path.join(dataDir, 'fake.mp4');
  const buffer = Buffer.alloc(64);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write('isom', 8, 'ascii');
  await fs.writeFile(fake, buffer);

  const upload = await uploadFiles(app.baseUrl, [fake], { lang: 'en' });
  assert.equal(upload.body.created, 0);
  assert.equal(upload.body.errors.length, 1);

  const health = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(health.status, 200, 'the server stays up after a malformed upload');
});

test('one bad file in a batch does not lose the good ones', async () => {
  const good = path.join(dataDir, 'good.mp4');
  const bad = path.join(dataDir, 'bad.mp4');
  await makeMp4(good, { seconds: 1, ffmpeg: FFMPEG });
  await fs.writeFile(bad, 'this is not a video at all');

  const upload = await uploadFiles(app.baseUrl, [good, bad], { lang: 'en' });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.created, 1);
  assert.equal(upload.body.errors.length, 1);
});

test('the slideshow skips clips that are still converting', async () => {
  const clip = path.join(dataDir, 'IMG_0043.mov');
  await makeMovHevc(clip, { seconds: 2, ffmpeg: FFMPEG });
  const upload = await uploadFiles(app.baseUrl, [clip]);
  const id = upload.body.ids[0];

  const deck = await (await fetch(`${app.baseUrl}/api/slideshow`)).json();
  assert.ok(
    !deck.items.some((item) => item.id === id),
    'a half-converted clip would show as a black rectangle on the projector',
  );

  await whenIdle();

  const afterDeck = await (await fetch(`${app.baseUrl}/api/slideshow`)).json();
  assert.ok(afterDeck.items.some((item) => item.id === id), 'once converted it joins the rotation');
});

test('the ZIP keeps photos and videos in separate folders', async () => {
  const response = await fetch(`${app.baseUrl}/admin/zip`, { headers: { cookie } });
  const asText = Buffer.from(await response.arrayBuffer()).toString('latin1');
  assert.ok(asText.includes('videos/'), 'videos should be filed under videos/');
});

test('asking for photos only leaves the videos behind', async () => {
  const response = await fetch(`${app.baseUrl}/admin/zip?videos=0`, { headers: { cookie } });
  const asText = Buffer.from(await response.arrayBuffer()).toString('latin1');
  assert.ok(!asText.includes('videos/'), 'the photos-only archive must skip the heavy files');
});
