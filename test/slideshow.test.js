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

test('the slideshow gets a screen-sized copy, not the full-resolution original', async () => {
  // กล่อง Google TV ถอดรหัสรูป 12 ล้านพิกเซลทุกสไลด์ไม่ไหว จอกระตุกและบางครั้งขึ้นดำ
  const big = path.join(dataDir, 'huge.jpg');
  await makeJpeg(big, { width: 4032, height: 3024 });

  const form = new FormData();
  form.append('files', new Blob([await fs.readFile(big)], { type: 'image/jpeg' }), 'huge.jpg');
  const upload = await fetch(`${app.baseUrl}/api/upload`, { method: 'POST', body: form });
  const { ids } = JSON.parse(await upload.text());
  const id = ids[0];

  const listed = await (await fetch(`${app.baseUrl}/api/items`)).json();
  const item = listed.items.find((entry) => entry.id === id);
  assert.equal(item.displayUrl, `/display/${id}`, 'the slideshow needs its own URL for the smaller copy');

  const response = await fetch(`${app.baseUrl}${item.displayUrl}`);
  assert.equal(response.status, 200);

  const sharp = (await import('sharp')).default;
  const meta = await sharp(Buffer.from(await response.arrayBuffer())).metadata();

  assert.ok(meta.width <= 1920 && meta.height <= 1920,
    `display copy should fit inside 1920px, got ${meta.width}x${meta.height}`);
  assert.ok(meta.width > 1000, 'but still big enough to look sharp on a 1080p screen');

  // ต้นฉบับต้องยังอยู่ครบ ไม่ถูกแทนที่ — ZIP ตอนท้ายงานต้องได้ของเต็ม
  const original = await fetch(`${app.baseUrl}/media/${id}`);
  const originalMeta = await sharp(Buffer.from(await original.arrayBuffer())).metadata();
  assert.equal(originalMeta.width, 4032, 'the original must be untouched');
});

test('slideshow media can never be sized by its own pixel count', async () => {
  // พังมาแล้วสองรอบด้วยเหตุคนละอย่าง ทั้งสองรอบจบเหมือนกันคือรูปกางตามขนาด
  // พิกเซลจริงแล้วล้นจอ
  //   รอบแรก  max-height: 100% ถูกทิ้งเพราะกล่องแม่สูงแบบ auto
  //   รอบสอง  width/height: 100% พังบน WebView ของทีวีที่ไม่รู้จัก inset
  // ทั้งคู่คือการพึ่ง "เปอร์เซ็นต์" ซึ่งต้องอาศัยว่ากล่องแม่มีขนาดแน่นอน
  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const rule = css.match(/\.slide__media img,\s*\n\.slide__media video \{([^}]*)\}/);

  assert.ok(rule, 'the slideshow media rule should still exist');
  const body = rule[1];

  assert.match(body, /max-width:\s*[\d.]+vw/, 'width must be capped against the screen, not the parent');
  assert.match(body, /max-height:\s*[\d.]+vh/, 'height must be capped against the screen, not the parent');
  assert.doesNotMatch(body, /(max-)?(width|height):\s*\d+%/,
    'percentages here depend on the parent having a definite size, which has failed twice');

  // inset เป็นชอร์ตแฮนด์ที่เพิ่งมีใน Chrome 87 — WebView ของกล่องทีวีหลายรุ่นเก่ากว่านั้น
  // แล้วทิ้งทั้งบรรทัด กล่องเลยไม่มีขนาด
  const slideshowBlock = css.slice(css.indexOf('/* ---------- slideshow'), css.indexOf('/* ---------- printable'));
  assert.doesNotMatch(slideshowBlock, /^\s*inset:/m,
    'the slideshow must not rely on the inset shorthand; old TV WebViews drop it');
});

test('the slideshow clamps media in JavaScript too, in case the CSS never applies', async () => {
  // ตาข่ายกันตกชั้นสุดท้าย พิสูจน์แล้วว่ารูปไม่ล้นจอแม้ปิด stylesheet ทั้งไฟล์
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');

  assert.match(js, /function clampToScreen/, 'the runtime safety net must stay');
  assert.match(js, /naturalWidth/, 'it measures the real pixel size of what loaded');
  assert.match(js, /window\.innerWidth/, 'and compares it against the screen, not against any box');
  assert.match(js, /addEventListener\('load'/, 'images are measured once they have loaded');
  assert.match(js, /addEventListener\('loadedmetadata'/, 'videos too — they report size later than images');

  // เปิดทิ้งไว้ทั้งงานแล้วจอดำ เพราะบัฟเฟอร์ภาพที่ถอดรหัสไว้ไม่ถูกคืน
  assert.match(js, /function releaseMedia/, 'decoded frames must be released when a slide is dropped');
});

test('the wall mode is available and ships everything it needs', async () => {
  const html = await (await fetch(`${app.baseUrl}/slideshow?lang=th`)).text();
  assert.match(html, /"mode":\s*"(cinema|wall)"/, 'the page must tell the client which mode to render');

  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');
  assert.match(js, /function startWall/, 'the wall renderer must stay');
  assert.match(js, /mode.*wall|wall.*mode/s, 'and be reachable by ?mode=wall');

  // การ์ดบนกำแพงต้องใช้รูปย่อ ไม่ใช่รูปเต็ม — มีรูปบนจอพร้อมกันสิบกว่าใบ
  // ถ้าใช้รูปเต็มทุกใบ กล่องทีวีถอดรหัสไม่ไหวแน่
  const wallBlock = js.slice(js.indexOf('function buildCard'), js.indexOf('function playBadge'));
  assert.match(wallBlock, /entry\.thumbUrl/, 'wall cards must load the small thumbnail first');

  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.wall__card\.is-hot/, 'the highlighted card needs its own styling');
});

test('the wall never stacks several cards into one slot', async () => {
  // บั๊กจริงที่เจอหน้างาน: การสลับรูปถูกหน่วง 900ms ก่อนทำจริง แต่ลูปที่เลือก
  // "ใบเก่าที่สุด" ทำงานทันที รูปใหม่ทุกใบในรอบเดียวกันจึงเลือกใบเดียวกันหมด
  // แล้วสร้างการ์ดทับกันที่ช่องเดียว เห็นเป็นกองซ้อนค้างอยู่มุมจอทั้งงาน
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');

  assert.match(js, /const reserved = new Set\(\)/,
    'cards already queued for replacement must be reserved so they cannot be picked twice');
  assert.match(js, /reserved\.has\(card\)/, 'and the picker must honour that reservation');

  assert.match(js, /cards\.indexOf\(card\)/, 'replacement writes back to a known slot');
  assert.match(js, /index === -1/, 'and gives up safely if the card already left the wall');

  assert.match(js, /function sweepOrphans/,
    'any card node left behind without an owner must be swept, or it blocks a slot all night');

  // จอนี้ไม่มีใครดูแลทั้งงาน error หลุดมาครั้งเดียวแล้วลูปตายคือรูปแรกค้างจนจบงาน
  const cycleBlock = js.slice(js.indexOf('function highlightNext'), js.indexOf('function cycle'));
  assert.match(cycleBlock, /try \{/, 'the highlight loop must survive one bad slide');
  assert.match(cycleBlock, /catch/, 'and schedule the next one anyway');
});
