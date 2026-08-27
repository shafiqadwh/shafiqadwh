import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

const dataDir = useTempDataDir('slideshow');
// การ์ด QR พิมพ์บรรทัดสถานที่เฉพาะเมื่อมีค่านี้ ต้องตั้งก่อนบูตเซิร์ฟเวอร์
// ไม่งั้นการ์ดทั้งสองแบบจะเหมือนกันหมด แล้วเทสต์ผ่านโดยไม่ได้ทดสอบอะไรเลย
process.env.EVENT_VENUE = 'Hasanah Restaurant, Yala';
process.env.EVENT_TIME = '11.00 - 16.00';

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

test('on the wall a video actually plays instead of sitting there as a still', async () => {
  // บั๊กจริงหน้างาน: playIfVideo() ใส่ <video> เข้าไปใน .card__media ได้จริง
  // แต่ภาพปกยังอยู่ และทั้งคู่เป็น display:block สูง 100% เท่ากันใน flow ปกติ
  // วิดีโอจึงไปต่อคิว "ใต้" ภาพปก แล้วโดน overflow:hidden ตัดหายทั้งตัว
  // วิดีโอเล่นอยู่จริงแต่เล่นนอกกรอบที่ตาเห็น การ์ดเลยเป็นภาพนิ่งตลอดงาน
  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');

  // ".card__media video" โผล่ในหลาย rule (มีอันที่ใช้ร่วมกับ img ด้วย)
  // ที่ต้องมีคือ "อย่างน้อยหนึ่งอัน" ที่ยกวิดีโอขึ้นมาทับ
  const rules = [...css.matchAll(/\.card__media video \{([^}]*)\}/g)].map((match) => match[1]);
  const lifted = rules.find((body) => /position:\s*absolute/.test(body));
  assert.ok(lifted, 'the wall video must be lifted out of the flow, on top of the poster');
  assert.match(lifted, /top:\s*0/, 'anchored with explicit offsets');
  assert.match(lifted, /left:\s*0/, 'both of them');

  // WebView ของกล่องทีวีรุ่นเก่าไม่รู้จัก inset แล้วทิ้งทั้ง declaration
  // ซึ่งเคยทำให้รูปล้นจอมาแล้วรอบหนึ่ง — ห้ามใช้ย่อในบล็อกกำแพง
  assert.doesNotMatch(lifted, /\binset\b/, 'old TV WebViews drop inset entirely');

  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');
  const play = js.slice(js.indexOf('function playIfVideo'), js.indexOf('function stopVideo'));

  assert.match(play, /video\.play\(\)/,
    'the autoplay attribute is ignored by TV WebViews when the element is inserted later');
  assert.match(play, /\.catch\(/, 'and a rejected play() must not spam the console all night');
  assert.match(play, /setAttribute\('playsinline'/,
    'old WebViews read the attribute, not the property — without it the video goes fullscreen');
  assert.match(play, /addEventListener\('error'/,
    'a video that cannot be decoded must fall back to its poster, not to a black frame');

  // ป้ายสามเหลี่ยม "นี่คือวิดีโอ" ต้องหายตอนมันเล่นอยู่จริง
  assert.match(play, /classList\.add\('is-playing'\)/, 'a playing card marks itself');
  const stop = js.slice(js.indexOf('function stopVideo'), js.indexOf('// ── เริ่มทำงาน'));
  assert.match(stop, /classList\.remove\('is-playing'\)/, 'and clears the mark when it stops');
  assert.match(css, /\.wall__card\.is-playing \.card__play\s*\{[^}]*display:\s*none/,
    'the play badge must not sit on top of moving video');
});

test('the wall always keeps room for guest wishes', async () => {
  // บั๊กจริง: entries() คืนรูปมาก่อนคำอวยพรทั้งหมด แล้ว sync() เติมช่องตามลำดับนั้น
  // กำแพงมี 15 ช่อง งานไหนมีรูปเกิน 15 ใบ (คือทุกงาน) การ์ดคำอวยพรจึงไม่เคยได้ช่อง
  // และคิวรูปของงานพันคนก็ไม่มีวันหมด — คนที่เขียนคำอวยพรมาไม่ได้ขึ้นจอเลยทั้งงาน
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');
  const sync = js.slice(js.indexOf('function noteQuota'), js.indexOf('function pickOldest'));

  assert.match(sync, /function noteQuota/, 'the wall must reserve a share of its slots for wishes');
  assert.match(sync, /waitingNotes/, 'wishes queue separately from photos');
  assert.match(sync, /waitingMedia/, 'so a long photo backlog cannot bury them');
  assert.match(sync, /swapped === 0/,
    'and every refresh must spend its first swap on a waiting wish, however long the photo queue is');

  // เลือกใบที่จะถูกเบียดออกตามชนิด ไม่งั้นรูปจะค่อย ๆ กินโควตาคำอวยพรจนหมด
  assert.match(sync, /pickOldest\(/, 'the eviction must be able to say what kind it wants to drop');
  const pick = js.slice(js.indexOf('function pickOldest'), js.indexOf('function replace'));
  assert.match(pick, /function pickOldest\(prefer\)/, 'the picker takes that preference');
  assert.match(pick, /fallback/, 'and still evicts something when that kind is not on the wall');
  assert.match(pick, /fixed\.includes\(card\)/, 'the pinned cards are still never evicted');
  assert.match(pick, /reserved\.has\(card\)/, 'and reservations still hold — that fixed the stacking bug');
});

test('a wish that came with a photo still shows its words', async () => {
  // โหมดโรงหนังเอาข้อความทาบบนรูปให้อยู่แล้ว แต่บนกำแพงของเดิม `continue` ทิ้ง
  // ข้อความไปเฉย ๆ รูปขึ้นจอแต่คำอวยพรหายไปทั้งงาน
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');
  const entries = js.slice(js.indexOf('function entries'), js.indexOf('function sweepOrphans'));

  assert.match(entries, /wishFor/, 'wishes must be joined onto the photo they were attached to');
  assert.match(entries, /wishFor\.set\(message\.media\.id/, 'keyed by the item the guest attached');
  assert.match(entries, /body: wish \? wish\.body : null/, 'the words ride along with the photo entry');

  const build = js.slice(js.indexOf('function buildCard'), js.indexOf('function playBadge'));
  assert.match(build, /card__wish/, 'and the card renders them');

  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const wish = css.match(/\.card__wish \{([^}]*)\}/);
  assert.ok(wish, 'the caption needs styling of its own');
  assert.match(wish[1], /position:\s*absolute/,
    'it is laid over the photo so the card height never changes — a taller card would overflow its slot');
  assert.match(wish[1], /opacity:\s*0/, 'hidden while the card is dimmed, where nobody could read it anyway');
  assert.match(css, /\.wall__card\.is-hot \.card__wish\s*\{[^}]*opacity:\s*1/,
    'and revealed exactly when the card is lifted up as the highlight');
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

test('the chooser offers both styles and carries the settings through', async () => {
  const response = await fetch(`${app.baseUrl}/slideshow/menu?lang=th&lite=1&tv=1`);
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.match(html, /href="\/slideshow\?mode=cinema[^"]*"/);
  assert.match(html, /href="\/slideshow\?mode=wall[^"]*"/);

  // ทีวีตั้งโหมดเบาไว้ ถ้าลิงก์ในเมนูไม่พา lite ไปด้วย จอจะกลับไปกระตุกทันที
  // ที่เลือกจากเมนู ซึ่งเป็นจังหวะที่หาสาเหตุยากที่สุด
  const links = [...html.matchAll(/href="(\/slideshow\?mode=[^"]+)"/g)].map((m) => m[1]);
  assert.equal(links.length, 2);
  for (const link of links) {
    assert.match(link, /lite=1/, 'lite mode must survive the jump from the menu');
    assert.match(link, /lang=th/, 'so must the language');
  }

  // รีโมตทีวีไม่มีเมาส์ ต้องมีตัวที่โฟกัสอยู่ตั้งแต่เปิดหน้า ไม่งั้นกดลูกศรแล้วไม่มีอะไรเกิด
  assert.match(html, /autofocus/, 'the first choice must be focused when the page opens');
});

test('the admin page links to the slideshow chooser', async () => {
  const html = await (await fetch(`${app.baseUrl}/admin`, { headers: { Cookie: cookie } })).text();
  assert.match(html, /href="\/slideshow\/menu"/, 'one button on the admin page, not one per mode');
});

test('on the wall the QR is a card of its own, never the highlight', async () => {
  // ป้าย QR มุมจอทับการ์ดที่อยู่ใต้มันจนอ่านไม่ออก บนกำแพงจึงต้องเป็นการ์ด
  // ที่มีช่องของตัวเอง ย้ายที่ไปเรื่อย ๆ และห้ามถูกยกขึ้นมาเป็นไฮไลท์
  // เพราะถ้าขยาย มันจะไปบังรูปแขกรอบ ๆ ซึ่งคือปัญหาเดิมในรูปแบบใหม่
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');

  assert.match(js, /qrBadge\.remove\(\)/, 'the corner badge must go away in wall mode');
  assert.match(js, /qr: true/, 'the wall builds a QR card instead');
  assert.match(js, /fixed\.includes\(card\)/, 'new photos must never push the QR off the wall');
  assert.match(js, /fixed\.some\(\(card\) => card\.slotIndex === hotIndex\)/,
    'the highlight must step over every pinned slot');
  assert.match(js, /function moveFixedSomewhereElse/, 'and the QR must not sit in one corner all night');
  assert.match(js, /slotDistance\(qrCard\.slotIndex, hotIndex\)/,
    'it also has to dodge whichever card is about to grow next to it');

  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');
  const rule = css.match(/\.wall__card--fixed \{([^}]*)\}/);
  assert.ok(rule, 'the QR card needs its own styling');
  assert.match(rule[1], /opacity:\s*0\.9[0-9]?/,
    'it must stay bright enough to scan, not dim like the other cards');
});

test('the wall carries a card naming the couple, since it has no title slide', async () => {
  // โหมดกำแพงถอดเวทีหลักทิ้ง (stage.remove()) การ์ดชื่องานเต็มจอของโหมดโรงหนัง
  // จึงไม่มีทางขึ้นเลย คนที่เพิ่งเดินเข้างานมาเห็นแต่กองรูป ไม่รู้ว่างานของใคร
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');

  assert.match(js, /key: 'title', title: true/, 'the wall builds a title card of its own');
  assert.match(js, /event\.coupleNames \|\| event\.title/, 'carrying the names from the event config');

  // ของประจำสองใบต้องไม่ไปกองมุมเดียวกัน ทั้งตอนวางครั้งแรกและตอนย้าย
  assert.match(js, /function spacedSlot/, 'the pinned cards must start at least two steps apart');
  assert.match(js, /!fixed\.includes\(card\)/,
    'and a pinned card may only swap places with a photo, never with the other pinned card');

  // ตัวอักษรคิดจากความกว้างการ์ด และต้องคิดใหม่ตอนย้ายช่อง ไม่งั้นล้นกรอบ
  assert.match(js, /function scaleTitle/, 'its text is sized from the card width');
  const resize = js.slice(js.indexOf('function resize(card)'), js.indexOf('function addCard'));
  assert.match(resize, /scaleTitle/, 'and resized again whenever the card changes slot');

  const css = await fs.readFile(new URL('../public/css/app.css', import.meta.url), 'utf8');
  assert.match(css, /\.card--title \.card__media/, 'the title card needs its own look');
});

test('static files carry a version so a fixed browser cannot keep serving the old one', async () => {
  // เจอจริงบนทีวี: /static ตั้งแคชไว้ 7 วัน ทีวีจึงใช้ CSS กับ JS เวอร์ชันเก่าต่อไป
  // แม้ deploy โค้ดใหม่แล้ว ผลคือหน้าเมนูขึ้นมาไม่มีสไตล์เลย และเลือกโหมดไหน
  // ก็ได้สไลด์โชว์แบบเดิม เพราะ JS ที่แคชไว้ยังไม่รู้จักโหมดใหม่
  const pages = await Promise.all([
    (await fetch(`${app.baseUrl}/slideshow/menu?lang=th`)).text(),
    (await fetch(`${app.baseUrl}/slideshow?mode=wall`)).text(),
    (await fetch(`${app.baseUrl}/?lang=th`)).text(),
  ]);

  const versions = new Set();
  for (const html of pages) {
    const refs = [...html.matchAll(/\/static\/(?:css|js)\/[\w.-]+\?v=([a-f0-9]+)/g)];
    assert.ok(refs.length > 0, 'every page must version the assets it loads');
    for (const [, version] of refs) versions.add(version);

    // ต้องไม่มีที่อยู่ไฟล์ที่ลืมใส่เวอร์ชันหลงเหลืออยู่
    //
    // ห้ามใช้ negative lookahead กับ [\w.-]+ ตรงนี้ — regex จะถอยหลังไปจับ
    // ชื่อไฟล์สั้นลงจนพอดีเงื่อนไข (app.css กลายเป็น app.cs) แล้วรายงานผิด
    // ให้จับชื่อไฟล์เต็ม ๆ ก่อน แล้วค่อยดูตัวอักษรถัดไปว่าเป็น ? หรือเปล่า
    for (const match of html.matchAll(/\/static\/(?:css|js)\/[\w.-]+/g)) {
      const nextChar = html[match.index + match[0].length];
      assert.equal(nextChar, '?', `unversioned asset URL found: ${match[0]}`);
    }
  }

  assert.equal(versions.size, 1, 'all pages should agree on one version per build');

  // ไฟล์ที่ขอมาพร้อมเวอร์ชันต้องเสิร์ฟได้จริง ไม่ใช่ 404
  const version = [...versions][0];
  const css = await fetch(`${app.baseUrl}/static/css/app.css?v=${version}`);
  assert.equal(css.status, 200);
});

test('the printed QR card can leave the venue off for the days held elsewhere', async () => {
  // งานนี้จัดสามวันคนละที่ การ์ดชุดเดียวที่พิมพ์ชื่อร้านกับเวลาไว้ตายตัว
  // จะบอกข้อมูลผิดให้แขกในวันที่จัดที่บ้าน
  const withVenue = await (await fetch(`${app.baseUrl}/admin/qr`, { headers: { Cookie: cookie } })).text();
  const without = await (await fetch(`${app.baseUrl}/admin/qr?venue=0`, { headers: { Cookie: cookie } })).text();

  assert.match(withVenue, /qr-card__url/, 'both variants still carry the web address');
  assert.match(without, /qr-card__url/);

  // ทั้งสองแบบต้องมี QR และคำอธิบายครบสามภาษาเหมือนกัน ต่างกันแค่บรรทัดสถานที่
  for (const html of [withVenue, without]) {
    assert.match(html, /flag-th/);
    assert.match(html, /flag-ms/);
    assert.match(html, /flag-en/);
  }

  const venueLines = (html) => (html.match(/qr-card__venue/g) || []).length;
  assert.ok(venueLines(withVenue) > 0, 'the reception card names the restaurant');
  assert.equal(venueLines(without), 0, 'the everyday card must not name a place it is not held at');
});

test('the wall rotates fairly, so an old photo is not starved by newer ones', async () => {
  const js = await fs.readFile(new URL('../public/js/slideshow.js', import.meta.url), 'utf8');

  // คิวรอขึ้นกำแพงเรียงตาม deck ซึ่งเป็น id DESC = ใหม่สุดก่อน หยิบจากหัวคิวเสมอ
  // ใบที่เพิ่งถูกไล่ออกจึงกลับไปอยู่หัวคิวแล้วถูกหยิบซ้ำทันที วนอยู่กับรูปใหม่ไม่กี่ใบ
  // จำลองแล้ว: รูป 100 ใบ เปิดจอ 50 นาที ขึ้นจอจริง 16 ใบ อีก 84 ใบไม่เคยขึ้นเลย
  assert.match(js, /const lastShown = new Map\(\)/,
    'ต้องจำว่าแต่ละใบเคยขึ้นกำแพงครั้งล่าสุดเมื่อไร');
  assert.match(js, /lastShown\.set\(entry\.key, card\.serial\)/,
    'ต้องบันทึกตอนการ์ดขึ้นกำแพงจริง');
  assert.match(js, /waitingMedia\.sort\(\(a, b\) => shownAt\(a\) - shownAt\(b\)\)/,
    'คิวรูปต้องเรียงให้ใบที่ไม่ได้ขึ้นนานที่สุดมาก่อน');
  assert.match(js, /waitingNotes\.sort\(\(a, b\) => shownAt\(a\) - shownAt\(b\)\)/,
    'คิวคำอวยพรต้องเป็นธรรมด้วยเหตุผลเดียวกัน');

  // ใบที่ยังไม่เคยขึ้นได้ค่า 0 เท่ากันหมด และ sort ของ JS เสถียร ลำดับใหม่สุดก่อน
  // จึงคงอยู่ — รูปที่แขกเพิ่งส่งต้องยังขึ้นจอไวเหมือนเดิม ไม่ใช่ไปต่อท้ายแถว
  assert.match(js, /lastShown\.get\(entry\.key\) \?\? 0/,
    'ใบที่ยังไม่เคยขึ้นต้องมาก่อนใบที่เคยขึ้นแล้ว');
});
