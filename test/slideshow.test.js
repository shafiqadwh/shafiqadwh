import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

const dataDir = useTempDataDir('slideshow');

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

async function postMessage({ author, body, attach = null }) {
  const form = new FormData();
  form.append('author', author);
  form.append('body', body);
  if (attach) {
    const bytes = await fs.readFile(attach);
    form.append('attachment', new Blob([bytes], { type: 'image/jpeg' }), path.basename(attach));
  }
  const response = await fetch(`${app.baseUrl}/api/messages`, { method: 'POST', body: form });
  // อ่าน body ครั้งเดียว — ถ้าใส่ await response.text() ไว้ในข้อความของ assert
  // มันจะถูกเรียกทุกครั้งแม้ assert ผ่าน แล้ว .json() ตามหลังจะพัง
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text);
}

const deck = async () => (await fetch(`${app.baseUrl}/api/slideshow`)).json();
const findMessage = (payload, author) => payload.messages.find((m) => m.author === author);

test('a wish with an attachment carries its media to the screen', async () => {
  // เดิม /api/slideshow ส่งกลับแค่ author กับ body ทำให้สไลด์โชว์เอารูปที่แขก
  // แนบมากับคำอวยพรมาแสดงคู่กันไม่ได้
  const file = await makeJpeg(path.join(dataDir, 'wish.jpg'));
  await postMessage({ author: 'Kak Aminah', body: 'Selamat pengantin baru!', attach: file });

  const message = findMessage(await deck(), 'Kak Aminah');
  assert.ok(message, 'the wish should reach the slideshow deck');
  assert.ok(message.media, 'the attachment should travel with the wish');
  assert.equal(message.media.kind, 'image');
  assert.match(message.media.mediaUrl, /^\/media\/\d+$/);
});

test('a wish with no attachment still reaches the screen', async () => {
  await postMessage({ author: 'ป้าซาลมา', body: 'ขอให้มีความสุขตลอดไป' });

  const message = findMessage(await deck(), 'ป้าซาลมา');
  assert.ok(message, 'a text-only wish must still be shown, not skipped');
  assert.equal(message.media, null, 'no attachment means no media, and the card renders text only');
});

test('hiding a photo hides it from the wish slide but keeps the words', async () => {
  // เจ้าภาพซ่อนรูปที่ไม่เหมาะ แต่คำอวยพรของแขกไม่ควรหายไปจากจอด้วย
  const file = await makeJpeg(path.join(dataDir, 'hidden.jpg'));
  await postMessage({ author: 'James', body: 'Congratulations you two!', attach: file });

  const before = findMessage(await deck(), 'James');
  assert.ok(before.media, 'precondition: the wish starts out with its photo');

  const response = await fetch(`${app.baseUrl}/admin/items/${before.media.id}/hide`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json' },
  });
  assert.equal(response.status, 200, await response.text());

  const after = findMessage(await deck(), 'James');
  assert.ok(after, 'the words stay on screen');
  assert.equal(after.media, null, 'the hidden photo must not come back through the wish slide');
});

test('the slideshow page ships the settings and artwork the deck needs', async () => {
  const html = await (await fetch(`${app.baseUrl}/slideshow?lang=th`)).text();

  assert.match(html, /id="flourish"/, 'the gold ornament is drawn inline so no asset fetch can fail');
  assert.match(html, /"messageEvery":\s*\d+/);
  assert.match(html, /"titleEvery":\s*\d+/);
  assert.match(html, /"kenBurns":\s*(true|false)/);
  assert.match(html, /"event":\s*\{/, 'the title card needs the couple names and date');
});
