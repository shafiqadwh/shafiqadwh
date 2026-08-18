import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

const dataDir = useTempDataDir('scale');
// โควตาต่อเครื่องตั้งต่ำไว้ให้ทดสอบได้เร็ว เพดานต่อไอพีปล่อยตามค่าจริง
process.env.UPLOADS_PER_HOUR_PER_DEVICE = '4';
process.env.MESSAGES_PER_HOUR_PER_DEVICE = '3';

let app;
let cookie;
let photo;

before(async () => {
  app = await startTestServer();
  cookie = await login(app.baseUrl);
  photo = await makeJpeg(path.join(dataDir, 'g.jpg'), { width: 600, height: 400 });
});

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function upload(cookieHeader) {
  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(photo)], { type: 'image/jpeg' }), 'g.jpg');
  return fetch(`${app.baseUrl}/api/upload`, {
    method: 'POST',
    body: form,
    headers: cookieHeader ? { Cookie: cookieHeader } : {},
  });
}

function deviceCookie(response) {
  const set = response.headers.getSetCookie().find((value) => value.startsWith('guest_device='));
  return set ? set.split(';')[0] : null;
}

test('one guest hammering the button is limited, everyone else is not', async () => {
  // เดิมนับตามไอพี ซึ่งพังในงานจริง: แขกที่ต่อ WiFi ของสถานที่ หรือใช้ 4G ผ่าน
  // CGNAT ของค่าย ออกเน็ตด้วยไอพีเดียวกันเป็นร้อยเครื่อง พอคนแรก ๆ อัพครบโควตา
  // แขกที่เหลือทั้งงานถูกปฏิเสธตามไปด้วย
  const first = await upload(null);
  assert.equal(first.status, 201);
  const jar = deviceCookie(first);
  assert.ok(jar, 'the server must hand out a device id so quotas can follow the phone');

  let accepted = 1;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await upload(jar);
    if (response.status === 429) break;
    accepted += 1;
  }
  assert.equal(accepted, 4, 'the same phone stops at its own quota');

  // แขกคนอื่นที่มาจากไอพีเดียวกันต้องยังส่งได้ตามปกติ
  for (let guest = 0; guest < 6; guest += 1) {
    const response = await upload(null);
    assert.equal(response.status, 201, 'a different guest behind the same IP must not be blocked');
  }
});

test('guest-book quota follows the phone too', async () => {
  const send = (jar) => {
    const form = new FormData();
    form.append('author', 'guest');
    form.append('body', 'ขอให้มีความสุข');
    return fetch(`${app.baseUrl}/api/messages`, {
      method: 'POST', body: form, headers: jar ? { Cookie: jar } : {},
    });
  };

  const first = await send(null);
  assert.equal(first.status, 201);
  const jar = deviceCookie(first);

  let accepted = 1;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await send(jar);
    if (response.status === 429) break;
    accepted += 1;
  }
  assert.equal(accepted, 3);

  assert.equal((await send(null)).status, 201, 'another guest on the same IP can still write');
});

test('a photo awaiting review is not downloadable by guessing its number', async () => {
  // เลข id เรียงกัน เดาต่อไปทีละหมายเลขได้ไม่ยาก ของที่เจ้าภาพยังไม่อนุมัติ
  // (และอาจกำลังจะปฏิเสธ) จึงต้องไม่หลุดออกไปก่อน
  await fetch(`${app.baseUrl}/admin/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
    body: new URLSearchParams({ uploads_enabled: 'on', require_review: 'on' }),
    redirect: 'manual',
  });

  const response = await upload(null);
  assert.equal(response.status, 201);
  const { ids } = JSON.parse(await response.text());
  const id = ids[0];

  for (const route of ['media', 'thumb', 'download']) {
    const guest = await fetch(`${app.baseUrl}/${route}/${id}`);
    assert.equal(guest.status, 404, `/${route} must not serve an unapproved item to a guest`);

    const host = await fetch(`${app.baseUrl}/${route}/${id}`, { headers: { Cookie: cookie } });
    assert.equal(host.status, 200, `/${route} must still work for the host reviewing it`);
  }

  const listed = await (await fetch(`${app.baseUrl}/api/items`)).json();
  assert.ok(!listed.items.some((item) => item.id === id), 'and it must stay out of the public list');
});
