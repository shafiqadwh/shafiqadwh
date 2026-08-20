import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

import { useTempDataDir, startTestServer, login } from './helpers/app.js';

useTempDataDir('paper');
process.env.COUPLE_NAMES = "Sofwan & 'Aishah";
process.env.EVENT_DATE = '29 สิงหาคม 2026';

const { config } = await import('../src/config.js');
const { db } = await import('../src/db.js');
const { ensureDirs } = await import('../src/lib/media.js');
const { groupGuests, normaliseName, pickDisplayName } = await import('../src/lib/guests.js');
const { buildPdf, pdfString } = await import('../src/lib/pdf.js');
const { listGuests, listItems, countItems } = await import('../src/repo.js');
const { paperPath } = await import('../src/lib/paper-job.js');

await ensureDirs();

/* ---------- ข้อมูลตัวอย่างที่กินกรณีจริงให้ครบ ---------- */

let counter = 0;
async function seedItem(uploader, kind = 'image') {
  counter += 1;
  const stored = `seed-${counter}.jpg`;
  const thumb = `seed-${counter}-thumb.jpg`;
  const jpeg = await sharp({
    create: { width: 400, height: 300, channels: 3, background: `hsl(${counter * 37 % 360}, 50%, 40%)` },
  }).jpeg().toBuffer();
  fs.writeFileSync(path.join(config.paths.uploads, stored), jpeg);
  fs.writeFileSync(path.join(config.paths.derived, thumb), jpeg);
  return db.prepare(`
    INSERT INTO items (kind, original_name, stored_name, thumb_name, mime, bytes, width, height, uploader, status)
    VALUES (?, ?, ?, ?, 'image/jpeg', ?, 400, 300, ?, 'visible')
  `).run(kind, stored, stored, thumb, jpeg.length, uploader).lastInsertRowid;
}

const THAI = 'ครูฟาฏิมะฮ์ บินอับดุลลอฮ์';
const ARABIC = 'أحمد بن سالم';

// ชื่อเดียวกันที่พิมพ์ต่างกัน · ชื่อไทย · ชื่ออาหรับ · ไม่ระบุชื่อสองครั้ง
for (const who of [THAI, `  ${THAI}  `, ARABIC, 'Nurul Ain', 'nurul ain', null, null]) {
  await seedItem(who);
}
await seedItem(THAI, 'video');

const WISHES = [
  [THAI, 'ขอให้มีความสุขนะคะ ปี่ ญี่ปุ่น เกี๊ยะ เกี่ยว เปี๊ยะ'],
  [`${THAI} `, 'ขออวยพรอีกครั้งค่ะ'],
  [ARABIC, 'بارك الله لكما وبارك عليكما وجمع بينكما في خير'],
  [null, 'ยินดีด้วยครับ'],
  [null, 'Congratulations!'],
];
for (const [author, body] of WISHES) {
  // แนบรูปกับคำอวยพรของคนไทยทั้งสองอัน แม้ชื่อจะพิมพ์มาไม่เหมือนกันเป๊ะ
  const itemId = normaliseName(author) === normaliseName(THAI) ? await seedItem(author) : null;
  db.prepare("INSERT INTO messages (author, body, item_id, status) VALUES (?, ?, ?, 'visible')")
    .run(author, body, itemId);
}

const app = await startTestServer();
const cookie = await login(app.baseUrl);
test.after(() => app.close());

/* ---------- การจับคู่ชื่อ ---------- */

test('names that differ only by spacing or case are the same guest', () => {
  assert.equal(normaliseName('  สม   ชาย  '), normaliseName('สม ชาย'));
  assert.equal(normaliseName('Nurul Ain'), normaliseName('nurul  ain'));
  // สระลอยแบบแยกตัวกับแบบรวมร่างหน้าตาเหมือนกันบนจอ แต่ไบต์ไม่ตรงกัน
  assert.equal(normaliseName('é'), normaliseName('é'));
});

test('a blank or missing name is the one shared anonymous bucket', () => {
  assert.equal(normaliseName(null), '');
  assert.equal(normaliseName('   '), '');
  assert.equal(normaliseName('​'), '', 'อักขระกว้างศูนย์ไม่ใช่ชื่อ');
});

test('the displayed name keeps the spelling the guest typed most often', () => {
  assert.equal(pickDisplayName(['Fatimah', 'Fatimah', 'fatimah']), 'Fatimah');
  assert.equal(pickDisplayName(['  สมชาย  ']), 'สมชาย');
  assert.equal(pickDisplayName([null, '']), '');
});

test('guests are grouped across uploads and wishes, anonymous last', () => {
  const guests = listGuests();
  const names = guests.map((guest) => guest.name);

  assert.equal(guests.at(-1).anonymous, true, 'ก้อนไม่ระบุชื่อต้องอยู่ท้ายสุดเสมอ');
  assert.equal(guests.filter((guest) => guest.anonymous).length, 1, 'ไม่ระบุชื่อต้องรวมเป็นก้อนเดียว');
  assert.equal(new Set(names).size, names.length, 'ชื่อซ้ำแปลว่าจับกลุ่มพลาด');

  const thai = guests.find((guest) => guest.name === THAI);
  assert.ok(thai, 'ชื่อไทยที่พิมพ์มาสองแบบต้องรวมเป็นคนเดียว');
  // 2 รูปจากชื่อสองแบบ + 2 รูปที่แนบมากับคำอวยพรสองอัน
  assert.equal(thai.photos, 4);
  assert.equal(thai.videos, 1);
  assert.equal(thai.messages, 2);

  const anonymous = guests.at(-1);
  assert.equal(anonymous.photos, 2);
  assert.equal(anonymous.messages, 2);
});

test('grouping counts every row exactly once', () => {
  const guests = listGuests({ includeHidden: true });
  const items = db.prepare('SELECT COUNT(*) AS n FROM items').get().n;
  const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;

  assert.equal(guests.reduce((sum, g) => sum + g.photos + g.videos, 0), items);
  assert.equal(guests.reduce((sum, g) => sum + g.messages, 0), messages);
});

test('an empty wedding produces an empty guest list, not a crash', () => {
  assert.deepEqual(groupGuests(), []);
  assert.deepEqual(groupGuests({ items: [], messages: [] }), []);
});

/* ---------- ตัวเขียน PDF ---------- */

async function samplePages(count) {
  const pages = [];
  for (let i = 0; i < count; i += 1) {
    pages.push({
      jpeg: await sharp({ create: { width: 310, height: 438, channels: 3, background: `hsl(${i * 90}, 60%, 45%)` } })
        .jpeg().toBuffer(),
      width: 310,
      height: 438,
    });
  }
  return pages;
}

test('every xref offset points at the object it claims', async () => {
  const pages = await samplePages(3);
  const text = buildPdf(pages, { title: 'ทดสอบ' }).toString('latin1');

  const startxref = Number(text.slice(text.lastIndexOf('startxref') + 9).trim().split('\n')[0]);
  const size = Number(/\/Size (\d+)/.exec(text)[1]);
  const rows = text.slice(startxref).split('\n').slice(3, 3 + size - 1);

  assert.equal(rows.length, size - 1);
  rows.forEach((row, index) => {
    const offset = Number(row.slice(0, 10));
    const expected = `${index + 1} 0 obj`;
    assert.equal(text.slice(offset, offset + expected.length), expected,
      `ออฟเซ็ตของวัตถุที่ ${index + 1} ชี้ผิดที่ — โปรแกรมอ่าน PDF จะเปิดไฟล์ไม่ขึ้น`);
  });
});

test('the page count in the file matches the pages handed in', async () => {
  for (const count of [1, 2, 7]) {
    const text = buildPdf(await samplePages(count)).toString('latin1');
    assert.equal(Number(/\/Count (\d+)/.exec(text)[1]), count);
    assert.equal((text.match(/\/Type \/Page\b/g) ?? []).length, count);
  }
});

test('the embedded images come back out byte for byte', async () => {
  const pages = await samplePages(3);
  const buffer = buildPdf(pages);
  const text = buffer.toString('latin1');

  let cursor = 0;
  for (const page of pages) {
    const marker = `/Length ${page.jpeg.length}>>\nstream\n`;
    const at = text.indexOf(marker, cursor);
    assert.ok(at > 0, 'หาสตรีมของภาพไม่เจอ');

    const start = at + marker.length;
    const embedded = buffer.subarray(start, start + page.jpeg.length);
    assert.ok(embedded.equals(page.jpeg), 'ไบต์ของ JPEG เพี้ยนระหว่างทาง');

    // ถอดกลับได้จริง ไม่ใช่แค่ไบต์เท่ากัน
    const meta = await sharp(embedded).metadata();
    assert.equal(meta.format, 'jpeg');
    assert.equal(meta.width, page.width);
    assert.equal(meta.height, page.height);
    cursor = start + page.jpeg.length;
  }
});

test('a PDF with no pages is refused instead of written broken', async () => {
  assert.throws(() => buildPdf([]), /อย่างน้อยหนึ่งหน้า/);
  assert.throws(() => buildPdf([{ jpeg: Buffer.alloc(0), width: 1, height: 1 }]), /ไม่มีข้อมูลภาพ/);
});

test('a file name from the browser cannot walk out of the papers folder', () => {
  assert.equal(paperPath('../../.env'), null);
  assert.equal(paperPath('/etc/passwd'), null);
  assert.equal(paperPath('note.txt'), null);
  assert.equal(paperPath('sub/dir.pdf'), null);
  assert.ok(paperPath('wedding-wishes-2026-08-29-10-00.pdf')?.startsWith(config.paths.papers));
});

/* ---------- เอกสารทั้งเล่ม ---------- */

test('the guest book carries every wish and every guest', async () => {
  const { wishesPages } = await import('../src/lib/paper.js');
  const { translator } = await import('../src/i18n.js');

  const seen = [];
  const { pages, counts } = await wishesPages(translator('th'), 'th', (p) => seen.push(p.done));

  assert.equal(counts.wishes, WISHES.length, 'คำอวยพรหายไประหว่างทาง');
  assert.equal(counts.guests, new Set(WISHES.map(([a]) => normaliseName(a))).size);
  assert.ok(pages.length >= 2, 'อย่างน้อยต้องมีหน้าปกกับหน้าเนื้อหา');
  assert.deepEqual(seen, WISHES.map((_, i) => i + 1), 'ความคืบหน้าต้องเดินทีละข้อความ');

  for (const page of pages) {
    assert.equal(page.width, 1240);
    assert.equal(page.height, 1754);
    const meta = await sharp(page.jpeg).metadata();
    assert.equal(meta.width, 1240, 'ภาพหน้ากระดาษต้องเป็นขนาด A4 จริง');
  }
});

test('the contributor list carries every upload', async () => {
  const { uploadersPages } = await import('../src/lib/paper.js');
  const { translator } = await import('../src/i18n.js');

  const { pages, counts } = await uploadersPages(translator('th'), 'th');
  const total = db.prepare("SELECT COUNT(*) AS n FROM items WHERE status = 'visible'").get().n;

  assert.equal(counts.items, total, 'รูปหายไปจากเล่ม');
  assert.ok(pages.length >= 2);
});

test('an Arabic guest book renders without falling back to blank pages', async () => {
  const { wishesPages } = await import('../src/lib/paper.js');
  const { translator } = await import('../src/i18n.js');

  const { pages } = await wishesPages(translator('ar'), 'ar');

  // นับพิกเซลที่เข้มกว่าพื้นกระดาษ — หน้าที่ฟอนต์หายจะว่างเปล่าโดยไม่มี error ให้เห็น
  const { data, info } = await sharp(pages[1].jpeg).greyscale().raw().toBuffer({ resolveWithObject: true });
  let dark = 0;
  for (let i = 0; i < data.length; i += 1) if (data[i] < 140) dark += 1;
  assert.ok(dark > info.width * info.height * 0.002,
    `หน้าเนื้อหาแทบไม่มีหมึกเลย (${dark} พิกเซล) — น่าจะเรนเดอร์ตัวอักษรไม่ออก`);
});

/* ---------- ค้นหาชื่อในหน้าแกลลอรี่ ---------- */

test('?who= returns only that guest, whatever spacing the link carries', async () => {
  const key = normaliseName(THAI);
  const mine = listItems({ who: key, limit: 200 });

  assert.ok(mine.length > 0);
  for (const row of mine) assert.equal(normaliseName(row.uploader), key);
  assert.equal(countItems({ who: key }), mine.length);

  const padded = await fetch(`${app.baseUrl}/api/items?who=${encodeURIComponent(`   ${THAI}   `)}`);
  const payload = await padded.json();
  assert.equal(payload.items.length, mine.length, 'ช่องว่างหัวท้ายไม่ควรทำให้ค้นไม่เจอ');
});

test('?who= with an empty key finds the guests who left no name', async () => {
  const anonymous = listItems({ who: '', limit: 200 });
  assert.ok(anonymous.length > 0);
  for (const row of anonymous) assert.equal(row.uploader, null);
});

test('a name nobody used returns nothing rather than everything', () => {
  assert.equal(listItems({ who: normaliseName('ไม่มีคนนี้'), limit: 200 }).length, 0);
  assert.equal(countItems({ who: normaliseName('ไม่มีคนนี้') }), 0);
});

test('filtering by name still pages without dropping items', () => {
  const key = normaliseName(THAI);
  const all = listItems({ who: key, limit: 200 });
  assert.ok(all.length >= 3, 'ต้องมีของพอให้แบ่งหน้าได้');

  const firstPage = listItems({ who: key, limit: 2 });
  assert.equal(firstPage.length, 2);
  const secondPage = listItems({ who: key, limit: 2, beforeId: firstPage.at(-1).id });

  const collected = [...firstPage, ...secondPage].map((row) => row.id);
  assert.deepEqual(collected, all.slice(0, collected.length).map((row) => row.id),
    'หน้าถัดไปข้ามของหายไป — เคอร์เซอร์เดินผิด');
});

/* ---------- เส้นทางในหน้าแอดมิน ---------- */

test('the admin page lists guests and the document panel', async () => {
  const html = await (await fetch(`${app.baseUrl}/admin`, { headers: { cookie } })).text();
  assert.match(html, /id="guests-list"/);
  assert.match(html, /id="paper-list"/);
  assert.match(html, /data-paper-kind="wishes"/);
  assert.match(html, /data-paper-kind="uploaders"/);
  assert.ok(html.includes(THAI), 'ชื่อแขกต้องเรนเดอร์มากับหน้า ไม่ใช่รอ JavaScript');
});

test('making a document end to end serves a real PDF that sharp-made pages went into', async () => {
  const start = await fetch(`${app.baseUrl}/admin/paper/start`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'wishes' }),
  });
  assert.equal(start.status, 200);

  let status;
  for (let i = 0; i < 120; i += 1) {
    status = await (await fetch(`${app.baseUrl}/admin/paper/status`, { headers: { cookie } })).json();
    if (status.state !== 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(status.state, 'done', status.error ?? '');
  assert.ok(status.papers.length > 0);

  const id = status.papers[0].id;
  const view = await fetch(`${app.baseUrl}/admin/paper/${encodeURIComponent(id)}/view`, { headers: { cookie } });
  assert.equal(view.status, 200);
  const body = Buffer.from(await view.arrayBuffer());
  assert.equal(body.subarray(0, 5).toString('latin1'), '%PDF-', 'สิ่งที่เสิร์ฟออกไปต้องเป็น PDF จริง');
  assert.ok(body.includes(Buffer.from('%%EOF')), 'ไฟล์ถูกตัดกลางทาง');

  const download = await fetch(`${app.baseUrl}/admin/paper/${encodeURIComponent(id)}/download`, { headers: { cookie } });
  assert.match(download.headers.get('content-disposition') ?? '', /attachment/);

  const gone = await fetch(`${app.baseUrl}/admin/paper/${encodeURIComponent(id)}/delete`, {
    method: 'POST', headers: { cookie },
  });
  assert.equal(gone.status, 200);
  const after = await (await fetch(`${app.baseUrl}/admin/paper/status`, { headers: { cookie } })).json();
  assert.ok(!after.papers.some((paper) => paper.id === id), 'ลบแล้วต้องหายจากรายการจริง');
});

test('an unknown document kind is refused, not guessed at', async () => {
  const response = await fetch(`${app.baseUrl}/admin/paper/start`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ kind: 'passwords' }),
  });
  assert.equal(response.status, 400);
});

test('the document routes are closed to anyone not logged in', async () => {
  for (const path of ['/admin/paper/status', '/admin/paper/x.pdf/view', '/admin/paper/x.pdf/download']) {
    const response = await fetch(`${app.baseUrl}${path}`, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
    });
    assert.ok([401, 302].includes(response.status), `${path} ตอบ ${response.status}`);
  }
});

/* ---------- ชื่อเรื่องใน PDF ---------- */

/** อ่านสตริงกลับตามกฎของสเปก PDF — ตัวถอดที่เขียนแยกจากตัวเข้ารหัส */
function readPdfString(raw) {
  const bytes = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw[i] === '\\') { i += 1; }
    bytes.push(raw.charCodeAt(i));
  }
  const buffer = Buffer.from(bytes);
  return buffer[0] === 0xfe && buffer[1] === 0xff
    ? buffer.subarray(2).swap16().toString('utf16le')
    : buffer.toString('latin1');
}

test('a title in any script survives the trip into the file', async () => {
  for (const title of ['Guest Book', 'สมุดคำอวยพร', 'سجل التهاني', 'ทดสอบ ษ ฬ ฦ', 'a(b)c\\d']) {
    const text = buildPdf(await samplePages(1), { title }).toString('latin1');
    const raw = /\/Title \((.*?)\) \/Producer/s.exec(text)[1];
    assert.equal(readPdfString(raw), title, `ชื่อเรื่อง ${JSON.stringify(title)} เพี้ยน`);
  }
});

test('a title can never unbalance the dictionary it sits in', async () => {
  // "ษ" คือ U+0E29 — ไบต์ล่างคือ 0x29 ซึ่งคือวงเล็บปิด การเข้ารหัสแบบเดิม
  // (ตัดเหลือไบต์เดียว) จึงแทรก ) เข้าไปเองหลังจาก escape ไปแล้ว แล้วไฟล์ก็พัง
  for (const title of ['ษ', 'ษษษ', '(((', ')))', '\\\\', 'สมุดคำอวยพร']) {
    const text = buildPdf(await samplePages(1), { title }).toString('latin1');
    const dict = /\/Title \((.*?)\) \/Producer/s.exec(text)[1];

    let depth = 0;
    for (let i = 0; i < dict.length; i += 1) {
      if (dict[i] === '\\') { i += 1; continue; }
      if (dict[i] === '(') depth += 1;
      if (dict[i] === ')') depth -= 1;
      assert.ok(depth >= 0, `${JSON.stringify(title)} ปิดวงเล็บเกิน — ไฟล์ผิดรูปแบบ`);
    }
    assert.equal(depth, 0, `${JSON.stringify(title)} วงเล็บไม่สมดุล`);
  }
});

test('control characters never reach the file', () => {
  assert.equal(pdfString('a\u0000b\u0007c'), 'abc');
});
