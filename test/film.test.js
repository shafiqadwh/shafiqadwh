import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, test } from 'node:test';
import sharp from 'sharp';
import { useTempDataDir } from './helpers/app.js';
import { makeJpeg, makeMp4 } from './helpers/fixtures.js';

const dataDir = useTempDataDir('film');
process.env.COUPLE_NAMES = "Sofwan & 'Aishah Nadhirah";
process.env.EVENT_MONOGRAM = 'S & N';
process.env.EVENT_DATE = '29.08.2026';
process.env.EVENT_VENUE = 'Hasanah Restaurant (ร้านอาหารฮาซานะห์) Sateng, Yala';

const {
  FRAME_WIDTH, FRAME_HEIGHT, trim, fontFor, ink: renderText,
  photoFrame, textCard, openingCard, wishCard, captionLayer,
} = await import('../src/lib/film.js');
const { buildTimeline, dedupe } = await import('../src/lib/film-plan.js');
const { wallFrame, SLOTS } = await import('../src/lib/film-wall.js');
const { stillClip, concatClips, alreadyDone } = await import('../src/lib/film-encode.js');
const { FFMPEG, FFPROBE } = await import('../src/lib/media.js');

const work = path.join(dataDir, 'work');
before(() => fs.mkdir(work, { recursive: true }));
after(() => fs.rm(work, { recursive: true, force: true }));

async function duration(filePath) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(FFPROBE, [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath,
  ]);
  return Number(stdout.trim());
}

/**
 * สัดส่วนพิกเซลที่เป็น "หมึก" คือจุดสว่างที่ทึบพอมองเห็น
 *
 * ต้องวัดจากความสว่าง ไม่ใช่จากค่า alpha — ลองมาแล้วสองแบบและผิดทั้งคู่:
 * การ์ดข้อความทึบทั้งใบ วัด alpha ได้ 1.0 เท่ากันหมดไม่ว่าจะมีตัวหนังสือหรือไม่
 * ส่วนชั้นคำบรรยายมีแถบไล่เฉดคลุมอยู่ วัด alpha ได้ 0.18 แม้จะไม่มีตัวอักษรเลย
 * เทสต์ที่ดูเหมือนตรวจตัวหนังสือจึงผ่านทั้งที่ไม่ได้ตรวจอะไร
 *
 * ตัวหนังสือในหนังเป็นสีครีมกับสีทองบนพื้นมืดเสมอ การนับจุดสว่างจึงตรงกับสิ่งที่
 * ตาคนเห็นจริง ๆ
 */
async function inkCoverage(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let ink = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i + 3] < 128) continue;
    const luma = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
    if (luma > 140) ink += 1;
  }
  return ink / (info.width * info.height);
}

test('guest text can never break the renderer, however it is punctuated', async () => {
  // Pango อ่านข้อความเป็น markup — เจอจริงตอนพัฒนา: ชื่อ "Sofwan & 'Aishah"
  // ทำให้ sharp โยน invalid markup แล้วเฟรมนั้นหายไปทั้งใบ
  //
  // ตอนนี้ `ink()` escape ให้เองข้างใน ผู้เรียกยี่สิบกว่าจุดจึงไม่ต้องจำอีก
  // — เทสต์นี้จึงตรวจ "ผลลัพธ์ที่รับประกัน" แทนที่จะตรวจฟังก์ชันช่วยที่ซ่อนไปแล้ว
  for (const text of [
    "Sofwan & 'Aishah",
    '<span foreground="red">แดง</span>',
    'a > b < c',
    'บรรทัดเดียว',
  ]) {
    const out = await renderText(text, { size: 24, width: 900 });
    assert.ok(out.info.width > 0 && out.info.height > 0, `เรนเดอร์ "${text}" ไม่ออก`);
  }

  // และต้อง escape "ครั้งเดียว" ไม่ใช่สองครั้ง — escape ซ้ำจะได้ข้อความ "&amp;"
  // โผล่บนจอให้แขกอ่าน ซึ่งไม่ throw จึงไม่มีอะไรจับได้นอกจากตรวจความกว้าง
  const amp = await renderText('&', { size: 40, width: 2000 });
  const one = await renderText('x', { size: 40, width: 2000 });
  assert.ok(amp.info.width < one.info.width * 2.5,
    `"&" กว้าง ${amp.info.width} เทียบกับ "x" ${one.info.width} — น่าจะถูก escape ซ้ำเป็น "&amp;"`);
});

test('a very long wish is cut, a short one is left alone', () => {
  assert.equal(trim('สั้น', 100), 'สั้น');
  assert.equal(trim('  เว้น   วรรค   เยอะ  ', 100), 'เว้น วรรค เยอะ');
  assert.match(trim('ก'.repeat(300), 50), /…$/);
  assert.equal(trim('ก'.repeat(300), 50).length, 51);
});

test('Thai really renders — the reason the whole film is drawn with Pango', async () => {
  // ffmpeg ของ Debian ที่อยู่ในอิมเมจไม่มี harfbuzz drawtext จึงวางวรรณยุกต์ไทยผิด
  // เทสต์นี้กันไม่ให้ใครย้ายกลับไปใช้ drawtext แล้วได้หนังที่ตัวหนังสือเพี้ยนทั้งเรื่อง
  const thai = await captionLayer({ name: 'ปี่ ญี่ปุ่น เกี๊ยะ ผู้ใหญ่ น้ำ' });
  const blank = await captionLayer({ name: '' });

  assert.ok(thai, 'a caption with a name must produce a layer');
  assert.equal(blank, null, 'nothing to say means no layer at all');

  // ข้อความยาวต้องมีหมึกมากกว่าข้อความสั้นอย่างชัดเจน ถ้าฟอนต์หายหรือเรนเดอร์ล้ม
  // เงียบ ๆ สองค่านี้จะเท่ากัน (หรือเป็นศูนย์ทั้งคู่) เทสต์จึงจับได้
  const long = await inkCoverage(thai);
  const short = await inkCoverage(await captionLayer({ name: 'ป' }));
  assert.ok(long > short * 3, `Thai must render glyph by glyph (${long} vs ${short})`);
  assert.ok(short > 0, 'even one Thai character must leave ink');

  // ชื่อที่แขกพิมพ์เป็นเคาะวรรคล้วน ต้องไม่ทำให้เฟรมพัง
  assert.equal(await captionLayer({ name: '   ' }), null);

  const meta = await sharp(thai).metadata();
  assert.equal(meta.width, FRAME_WIDTH);
  assert.equal(meta.height, FRAME_HEIGHT);
});

test('an Arabic wish is drawn with an Arabic font that travels with the project', async () => {
  // ครูสอนภาษาอาหรับที่โรงเรียนมาร่วมงาน และเขียนคำอวยพรเป็นภาษาอาหรับได้
  // ถ้าปล่อยให้ fontconfig หา fallback เอง เครื่องพัฒนาจะเรนเดอร์ได้แต่คอนเทนเนอร์
  // บน NAS อาจไม่มีฟอนต์อาหรับเลย แล้วคำอวยพรจะกลายเป็นกล่องว่างโดยไม่มี error
  assert.equal(fontFor('ขอให้มีความสุข').family, 'Noto Serif Thai');
  assert.equal(fontFor('Sofwan').family, 'Noto Serif Thai');
  assert.equal(fontFor('بارك الله لكما').family, 'Noto Naskh Arabic');
  assert.equal(fontFor('Ahmad أحمد').family, 'Noto Naskh Arabic', 'mixed text follows the Arabic');

  for (const face of [fontFor('ก'), fontFor('ب')]) {
    for (const file of [face.regular, face.bold]) {
      await fs.access(file); // ฟอนต์ต้องอยู่ในโปรเจกต์จริง ไม่ใช่หวังว่าเครื่องจะมี
    }
  }

  const card = await wishCard({ body: 'بارك الله لكما وجمع بينكما في خير', author: 'أستاذ العربية' });
  assert.ok(await inkCoverage(card) > 0.002, 'the Arabic wish must actually appear on the card');
});

test('every frame comes out at exactly one size, whatever the source photo is', async () => {
  const portrait = path.join(dataDir, 'portrait.jpg');
  const landscape = path.join(dataDir, 'landscape.jpg');
  await makeJpeg(portrait, { width: 900, height: 1600 });
  await makeJpeg(landscape, { width: 2400, height: 1000 });

  for (const source of [portrait, landscape]) {
    const meta = await sharp(await photoFrame(source, { name: 'พี่หนึ่ง' })).metadata();
    assert.equal(meta.width, FRAME_WIDTH, 'concat -c copy only works if every clip matches');
    assert.equal(meta.height, FRAME_HEIGHT);
  }

  const card = await sharp(await openingCard()).metadata();
  assert.equal(card.width, FRAME_WIDTH);
  assert.equal(card.height, FRAME_HEIGHT);
});

test('the opening card carries the couple, and a wish card carries the wish', async () => {
  const opening = await inkCoverage(await textCard({ eyebrow: 'S & N', headline: "Sofwan & 'Aishah" }));
  const empty = await inkCoverage(await textCard({}));
  assert.ok(opening > empty, 'a card with words must have more ink than an empty one');

  assert.equal(empty, 0, 'a card with nothing on it has no ink at all');

  const wish = await inkCoverage(await wishCard({
    body: 'ขอให้บ่าวสาวมีความสุขตลอดไป', author: 'ผู้ใหญ่บ้าน',
  }));
  assert.ok(wish > 0.002, `the wish must be legible on the card (${wish})`);
});

test('duplicate uploads are dropped by what is inside the file, not by its size', async () => {
  // เดิมเทียบด้วยขนาดไบต์บวกมิติ แล้วเทสต์จับได้ว่ารูปสีพื้นคนละสีถูกตัดทิ้ง
  // เพราะบีบอัดออกมาได้ขนาดเท่ากันพอดี — รูปของแขกหายโดยไม่มีใครรู้
  const uploads = path.join(dataDir, 'uploads');
  await fs.mkdir(uploads, { recursive: true });

  const one = path.join(uploads, 'one.jpg');
  const two = path.join(uploads, 'two.jpg');
  await makeJpeg(one, { width: 400, height: 400, colour: '#112233' });
  await makeJpeg(two, { width: 400, height: 400, colour: '#332211' });
  await fs.copyFile(one, path.join(uploads, 'copy.jpg'));

  const items = [
    { id: 1, kind: 'image', stored_name: 'one.jpg', playback_name: null },
    { id: 2, kind: 'image', stored_name: 'two.jpg', playback_name: null },
    { id: 3, kind: 'image', stored_name: 'copy.jpg', playback_name: null },
  ];

  const kept = await dedupe(items);
  assert.deepEqual(kept.map((item) => item.id), [1, 2],
    'the exact copy goes, the different picture stays');

  const sizes = await Promise.all([one, two].map(async (file) => (await fs.stat(file)).size));
  assert.equal(sizes[0], sizes[1],
    'these two differ only in content — a size check would have thrown one away');
});

test('the story runs in upload order, with wishes spread through it', () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, kind: 'image', uploader: 'แขก' }));
  const messages = [
    { id: 1, author: 'ก', body: 'ยินดีด้วย', item_id: null },
    { id: 2, author: 'ข', body: 'มีความสุขนะ', item_id: null },
    { id: 3, author: 'ค', body: 'บนรูป', item_id: 5 },
  ];

  const timeline = buildTimeline({ items, messages }, { limit: 0 });

  assert.equal(timeline.at(0).kind, 'opening');
  assert.equal(timeline.at(-1).kind, 'closing');

  const ids = timeline.filter((entry) => entry.item).map((entry) => entry.item.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'upload order is the story of the day');

  const attached = timeline.find((entry) => entry.item?.id === 5);
  assert.equal(attached.wish, 'บนรูป', 'a wish with a photo rides on that photo');
  assert.equal(attached.name, 'ค', 'and is credited to whoever wrote it');

  const wishCards = timeline.filter((entry) => entry.kind === 'wish');
  assert.equal(wishCards.length, 2, 'wishes without a photo become cards of their own');
  const positions = wishCards.map((card) => timeline.indexOf(card));
  assert.ok(positions[1] - positions[0] > 2, 'and they are spread out, not stacked together');
});

test('every wish reaches the film even when there are more wishes than photos', () => {
  const items = [{ id: 1, kind: 'image' }, { id: 2, kind: 'image' }];
  const messages = Array.from({ length: 5 }, (_, i) => ({ id: i + 1, body: `อวยพร ${i}`, item_id: null }));

  const timeline = buildTimeline({ items, messages }, { limit: 0 });
  assert.equal(timeline.filter((entry) => entry.kind === 'wish').length, 5);
});

test('clips are built to one shared recipe, so joining them needs no re-encode', async (t) => {
  const frame = path.join(work, 'frame.png');
  await fs.writeFile(frame, await openingCard());

  const first = path.join(work, 'a.mp4');
  const second = path.join(work, 'b.mp4');
  await stillClip(frame, first, { seconds: 2 });
  await stillClip(frame, second, { seconds: 3 });

  assert.ok(Math.abs(await duration(first) - 2) < 0.2);
  assert.ok(await alreadyDone(first), 'a finished clip reports itself done so a re-run skips it');

  const joined = path.join(work, 'joined.mp4');
  await concatClips([first, second], joined, work);

  // ต่อกันแล้วต้องได้ความยาวรวม ถ้าพารามิเตอร์ของสองคลิปไม่ตรงกัน
  // concat แบบ copy จะได้ไฟล์ที่ความยาวเพี้ยนหรือภาพค้าง
  assert.ok(Math.abs(await duration(joined) - 5) < 0.3, 'the joined film is as long as its parts');

  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { stdout } = await promisify(execFile)(FFPROBE, [
    '-v', 'error', '-show_entries', 'stream=codec_name,width,height,channels',
    '-of', 'csv=p=0', joined,
  ]);
  assert.match(stdout, /h264,1920,1080/, 'video stays 1080p H.264');
  assert.match(stdout, /aac,2/, 'and every clip carries stereo audio, silent or not');
});

test('a clip half-written by an interrupted run is never mistaken for a finished one', async () => {
  const stub = path.join(work, 'truncated.mp4');
  await fs.writeFile(stub, Buffer.alloc(10));
  assert.equal(await alreadyDone(stub), false);
  assert.equal(await alreadyDone(path.join(work, 'missing.mp4')), false);
});

test('the wall style lays a photo wall out at exactly one frame size', async () => {
  const one = path.join(dataDir, 'wall-a.jpg');
  const two = path.join(dataDir, 'wall-b.jpg');
  await makeJpeg(one, { width: 900, height: 1200, colour: '#3d6b8a' });
  await makeJpeg(two, { width: 1200, height: 900, colour: '#8a5f3b' });

  const neighbours = Array.from({ length: SLOTS }, () => ({ photoPath: one, name: 'พี่หนึ่ง' }));
  const built = await wallFrame({ neighbours, hot: { photoPath: two, name: 'أحمد' } });

  const meta = await sharp(built.png).metadata();
  assert.equal(meta.width, FRAME_WIDTH, 'wall frames join with cinema clips, so sizes must match');
  assert.equal(meta.height, FRAME_HEIGHT);
});

test('a video in the wall style gets a real hole to play through', async () => {
  // เจอจริงตอนพัฒนา: เจาะรูด้วยสี่เหลี่ยมโปร่งใส ซึ่ง dest-out ไม่ลบอะไรเลย
  // แล้วรูที่เจาะในตัวการ์ดก็ยังถูกถมกลับด้วยพื้นกำแพงตอนประกอบชั้นสุดท้าย
  // ผลคือได้การ์ดขาวเปล่า วิดีโอเล่นอยู่ข้างหลังแต่ไม่มีทางทะลุขึ้นมาให้เห็น
  const photo = path.join(dataDir, 'wall-hole.jpg');
  await makeJpeg(photo, { width: 900, height: 1200, colour: '#4a7a5f' });

  const neighbours = Array.from({ length: 6 }, () => ({ photoPath: photo, name: 'แขก' }));
  const built = await wallFrame({
    neighbours,
    hot: { photoPath: photo, name: 'คนถ่ายวิดีโอ' },
    hotIsVideo: true,
  });

  const { data, info } = await sharp(built.png).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true });
  const alphaAt = (x, y) => data[(y * info.width + x) * info.channels + 3];

  const { left, top, width, height } = built.window;
  assert.ok(width > 100 && height > 100, 'the window must be big enough to see the video in');
  assert.equal(alphaAt(left + Math.round(width / 2), top + Math.round(height / 2)), 0,
    'the middle of the window must be see-through');
  assert.equal(alphaAt(20, 20), 255, 'and the wall around it must stay solid');
  assert.equal(alphaAt(left - 12, top + Math.round(height / 2)), 255,
    'the polaroid border beside the window stays solid too');

  // ภาพนิ่งต้องไม่มีรู ไม่งั้นจะเห็นพื้นดำทะลุตรงกลางการ์ด
  const still = await wallFrame({ neighbours, hot: { photoPath: photo, name: 'แขก' } });
  const solid = await sharp(still.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const middle = ((top + Math.round(height / 2)) * solid.info.width + left + Math.round(width / 2))
    * solid.info.channels;
  assert.equal(solid.data[middle + 3], 255, 'a photo card must have no hole punched in it');
});

test('the film never contains the QR code', async () => {
  // ข้อกำหนดจากเจ้าของ: หนังที่ export หลังงานต้องไม่มี QR
  // กันด้วยการออกแบบ — โมดูลที่ประกอบเฟรมไม่รู้จัก QR เลย ไม่มีทางหลุดเข้ามาได้
  const film = await fs.readFile(new URL('../src/lib/film.js', import.meta.url), 'utf8');
  const plan = await fs.readFile(new URL('../src/lib/film-plan.js', import.meta.url), 'utf8');
  const script = await fs.readFile(new URL('../scripts/export-film.js', import.meta.url), 'utf8');

  for (const [name, source] of [['film', film], ['plan', plan], ['script', script]]) {
    assert.doesNotMatch(source, /qrDataUrl|qrImage|shareUrl/,
      `${name} must not be able to draw the QR into the keepsake film`);
  }
});
