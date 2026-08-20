import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg, uploadFiles } from './helpers/fixtures.js';

const dataDir = useTempDataDir('api');

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

test('the gallery page renders in each language', async () => {
  const expectations = [
    ['th', 'ยินดีต้อนรับ'],
    ['ms', 'Selamat datang'],
    ['en', 'Welcome to our wedding'],
  ];

  for (const [lang, phrase] of expectations) {
    const response = await fetch(`${app.baseUrl}/?lang=${lang}`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.ok(html.includes(phrase), `${lang} page should contain "${phrase}"`);
    assert.ok(html.includes(`<html lang="${lang}"`), `${lang} page should set the html lang attribute`);
  }
});

test('the camera buttons can actually open a camera', async () => {
  // Regression: `capture` is ignored when accept lists more than one media
  // type, so the button fell back to the plain file picker on every phone.
  const html = await (await fetch(`${app.baseUrl}/?lang=en`)).text();

  const captureInputs = [...html.matchAll(/<input[^>]*\bcapture=[^>]*>/g)].map((m) => m[0]);
  assert.equal(captureInputs.length, 2, 'one camera input for photos, one for videos');

  for (const input of captureInputs) {
    const accept = input.match(/accept="([^"]+)"/)[1];
    assert.ok(
      accept === 'image/*' || accept === 'video/*',
      `capture needs a single media type, got accept="${accept}"`,
    );
  }

  // The plain picker stays multi-type and multi-file, and must not capture.
  const picker = html.match(/<input[^>]*id="file-input"[^>]*>/)[0];
  assert.ok(picker.includes('accept="image/*,video/*"'));
  assert.ok(picker.includes('multiple'));
  assert.ok(!picker.includes('capture'));
});

test('a phone with a Malaysian locale gets Malay without asking', async () => {
  const response = await fetch(app.baseUrl, { headers: { 'Accept-Language': 'ms-MY,ms;q=0.9,en;q=0.6' } });
  const html = await response.text();
  assert.ok(html.includes('Selamat datang'));
});

test('an unknown locale falls back to Thai', async () => {
  const response = await fetch(app.baseUrl, { headers: { 'Accept-Language': 'fi-FI,fi;q=0.9' } });
  assert.ok((await response.text()).includes('ยินดีต้อนรับ'));
});

test('a guest uploads a photo and everyone can see it', async () => {
  const photo = path.join(dataDir, 'sample.jpg');
  await makeJpeg(photo);

  const upload = await uploadFiles(app.baseUrl, [photo], { uploader: 'พี่หนึ่ง' });
  assert.equal(upload.status, 201);
  assert.equal(upload.body.created, 1);
  assert.deepEqual(upload.body.errors, []);

  const listed = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.equal(listed.items.length, 1);

  const item = listed.items[0];
  assert.equal(item.kind, 'image');
  assert.equal(item.uploader, 'พี่หนึ่ง');
  assert.equal(item.width, 1200);
  assert.equal(item.height, 800);

  const thumb = await fetch(`${app.baseUrl}${item.thumbUrl}`);
  assert.equal(thumb.status, 200);
  assert.equal(thumb.headers.get('content-type'), 'image/jpeg');
  assert.ok(Number(thumb.headers.get('content-length')) > 0);

  const media = await fetch(`${app.baseUrl}${item.mediaUrl}`);
  assert.equal(media.status, 200);

  const download = await fetch(`${app.baseUrl}${item.downloadUrl}`);
  assert.match(download.headers.get('content-disposition'), /attachment/);
});

test('a disguised script is rejected in the guest\'s own language', async () => {
  const fake = path.join(dataDir, 'evil.jpg');
  await fs.writeFile(fake, '<?php system($_GET["cmd"]); ?>');

  const malay = await uploadFiles(app.baseUrl, [fake], { lang: 'ms' });
  assert.equal(malay.status, 400);
  assert.equal(malay.body.created, 0);
  assert.match(malay.body.errors[0], /tidak disokong/);

  const thai = await uploadFiles(app.baseUrl, [fake], { lang: 'th' });
  assert.match(thai.body.errors[0], /ไม่รองรับ/);

  const stillOne = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.equal(stillOne.items.length, 1, 'the rejected file must not reach the gallery');
});

test('the guest book stores a message with its photo', async () => {
  const photo = path.join(dataDir, 'wish.jpg');
  await makeJpeg(photo, { width: 600, height: 600, colour: '#8a5f3b' });

  const form = new FormData();
  form.append('author', 'Aisyah');
  form.append('body', 'Selamat pengantin baru!');
  form.append('attachment', new Blob([await fs.readFile(photo)]), 'wish.jpg');

  const response = await fetch(`${app.baseUrl}/api/messages`, { method: 'POST', body: form });
  assert.equal(response.status, 201);

  const listed = await (await fetch(`${app.baseUrl}/api/messages`)).json();
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0].author, 'Aisyah');
  assert.equal(listed.messages[0].body, 'Selamat pengantin baru!');
  assert.ok(listed.messages[0].item?.thumbUrl, 'the attached photo should be linked to the message');
});

test('an empty message is refused', async () => {
  const form = new FormData();
  form.append('body', '   ');
  const response = await fetch(`${app.baseUrl}/api/messages?lang=en`, { method: 'POST', body: form });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /write a message/i);
});

test('the admin area is closed to guests', async () => {
  const page = await fetch(`${app.baseUrl}/admin`);
  assert.ok((await page.text()).includes('name="password"'), 'guests see the login form, not the panel');

  const zip = await fetch(`${app.baseUrl}/admin/zip`, { redirect: 'manual' });
  assert.equal(zip.status, 302, 'the archive must not be downloadable without logging in');
});

test('a wrong admin password does not open the panel', async () => {
  const response = await fetch(`${app.baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'not-the-password' }),
    redirect: 'manual',
  });
  assert.equal(response.status, 401);

  // เดิมตรวจว่า "ไม่มี cookie ใด ๆ เลย" ซึ่งกว้างเกินสิ่งที่ต้องการรับประกันจริง
  // ตอนนี้ทุก request ได้ cookie รหัสประจำเครื่องไปด้วย (ใช้นับโควตารายเครื่อง
  // แทนการนับตามไอพี) สิ่งที่ต้องไม่เกิดคือ "ได้ session ของแอดมิน" ต่างหาก
  const issued = response.headers.getSetCookie();
  assert.ok(
    issued.every((value) => !value.startsWith('admin_session=')),
    `a failed login must not hand out an admin session, got: ${issued.join(' | ')}`,
  );
});

test('the hosts can download everything as one ZIP', async () => {
  const response = await fetch(`${app.baseUrl}/admin/zip`, { headers: { cookie } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/zip');

  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(archive.subarray(0, 2).toString('ascii'), 'PK', 'that should be a real ZIP file');

  // Read the central directory the cheap way: file names appear as plain text.
  const asText = archive.toString('latin1');
  assert.ok(asText.includes('photos/'), 'photos should be filed in their own folder');
  assert.ok(asText.includes('guestbook.txt'), 'the written wishes should travel with the photos');
});

test('the printable QR card carries every language at once', async () => {
  const response = await fetch(`${app.baseUrl}/admin/qr`, { headers: { cookie } });
  const html = await response.text();

  assert.ok(html.includes('สแกนเพื่อแชร์รูปในงาน'), 'Thai heading');
  assert.ok(html.includes('Imbas untuk kongsi gambar majlis'), 'Malay heading');
  assert.ok(html.includes('Scan to share your photos'), 'English heading');
  assert.ok(html.includes('امسحوا الرمز لمشاركة صوركم'), 'Arabic heading');
  assert.ok(html.includes('data:image/png;base64'), 'the QR image is embedded, not fetched');

  // บล็อกอาหรับต้องเรียงขวาไปซ้ายของตัวเอง แม้หน้าที่ครอบอยู่จะเป็นภาษาไทย
  assert.match(html, /lang="ar" dir="rtl"/, 'the Arabic block runs right to left on paper');

  // ธงที่อ้างถึงแต่ไม่มี symbol รองรับ จะพิมพ์ออกมาเป็นกล่องสี่เหลี่ยมว่าง ๆ บนกระดาษ
  // ตรวจทุกธงที่การ์ดอ้างถึง ไม่ใช่เฉพาะภาษาที่นึกออกตอนเขียนเทสต์
  const referenced = [...html.matchAll(/href="#flag-([a-z]{2})"/g)].map((m) => m[1]);
  assert.ok(referenced.includes('ar'), 'Arabic now prints the Saudi flag like the others');
  for (const code of new Set(referenced)) {
    assert.ok(html.includes(`id="flag-${code}"`), `the card asks for #flag-${code} but never draws it`);
  }
});

test('a guest page tells the browser which way its language runs', async () => {
  const thai = await (await fetch(`${app.baseUrl}/?lang=th`)).text();
  const arabic = await (await fetch(`${app.baseUrl}/?lang=ar`)).text();

  assert.match(thai, /<html lang="th" dir="ltr">/);
  assert.match(arabic, /<html lang="ar" dir="rtl">/);

  // หน้าที่มี <html> ของตัวเอง ไม่ได้ผ่าน partial เดียวกัน จึงเคยหลุดไม่มี dir
  for (const path of ['/slideshow?lang=ar', '/slideshow/menu?lang=ar']) {
    const html = await (await fetch(`${app.baseUrl}${path}`)).text();
    assert.match(html, /dir="rtl"/, `${path} must carry the direction too`);
  }
});

test('hosts can hide a photo and guests stop seeing it', async () => {
  const before = await (await fetch(`${app.baseUrl}/api/items`)).json();
  const target = before.items[0];

  const hide = await fetch(`${app.baseUrl}/admin/items/${target.id}/hide`, {
    method: 'POST',
    headers: { cookie, accept: 'application/json' },
  });
  assert.equal(hide.status, 200);

  const after = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.ok(!after.items.some((item) => item.id === target.id));

  const media = await fetch(`${app.baseUrl}/media/${target.id}`);
  assert.equal(media.status, 404, 'a hidden file must not stay reachable by direct link');
});

test('unknown pages answer in the language that was asked for', async () => {
  const response = await fetch(`${app.baseUrl}/no-such-page?lang=ms`);
  assert.equal(response.status, 404);
  assert.ok((await response.text()).includes('Halaman tidak dijumpai'));
});

test('the health endpoint answers for the container healthcheck', async () => {
  const response = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
