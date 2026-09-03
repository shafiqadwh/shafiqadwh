import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * สองงานในระบบเดียว ต้องมองไม่เห็นกันเลย
 *
 * นี่คือเทสต์ที่ต้องผ่านก่อนจะกล้ารับลูกค้ารายที่สอง · ความผิดพลาดที่กลัวไม่ใช่
 * "ระบบล่ม" (ซึ่งเห็นทันทีและแก้ได้) แต่คือ **รูปงานแต่งของลูกค้า ก. ไปโผล่ใน
 * แกลลอรี่ของลูกค้า ข.** ซึ่งเงียบสนิท ไม่มี error ไม่มีใครรู้ และขอโทษไม่ได้
 *
 * ทุกข้อในไฟล์นี้จึงเป็นข้อเดียวกันในมุมต่าง ๆ: ของของงานหนึ่ง **ต้องไปไม่ถึง**
 * อีกงานหนึ่ง — ไม่ใช่ "ถูกกรองออก" แต่คนละไฟล์ฐานข้อมูลและคนละโฟลเดอร์กันตั้งแต่ต้น
 */

// กุญแจเดินทางเป็น HTTP header จึงต้องเป็น ASCII เท่านั้น (ดู config.js)
const KEY = 'booth-key-multi-event-7a1c';
process.env.BOOTH_KEY = KEY;

const dataDir = useTempDataDir('multi-event');
const app = await startTestServer();

const { createEvent, listEvents, setEventPassword } = await import('../src/lib/tenancy.js');

// งานที่สอง — ลูกค้าอีกรายในวันเดียวกัน · ยังไม่ได้ตั้งโดเมน จึงเข้าถึงด้วย ?event=
createEvent({ slug: 'rina', title: 'งานของรินา', names: 'Rina & Adam' });
setEventPassword('rina', 'rina-only-password');

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

/** เติม ?event= ให้ทุกเส้นทาง — ทดสอบเจาะจงงานทีละคำขอ ไม่พึ่งคุกกี้ */
const url = (slug, route) => `${app.baseUrl}${route}${route.includes('?') ? '&' : '?'}event=${slug}`;

let counter = 0;
async function jpeg(colour) {
  counter += 1;
  const file = path.join(dataDir, `m-${counter}.jpg`);
  await makeJpeg(file, { width: 600, height: 400, colour });
  return fs.readFile(file);
}

async function upload(slug, uploader, colour) {
  const form = new FormData();
  form.append('files', new Blob([await jpeg(colour)]), `${uploader}.jpg`);
  form.append('uploader', uploader);
  const response = await fetch(url(slug, '/api/upload?lang=th'), { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}

const login = async (slug, password) => {
  const response = await fetch(url(slug, '/admin/login'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }),
    redirect: 'manual',
  });
  const jar = response.headers.getSetCookie().find((one) => one.startsWith('admin_session='));
  return { status: response.status, cookie: jar ? jar.split(';')[0] : null };
};

const items = async (slug) => (await (await fetch(url(slug, '/api/items'))).json()).items;

test('a photo sent to one event never appears in the other', async () => {
  const first = await upload('main', 'แขกของงานแรก', '#c8a27a');
  const second = await upload('rina', 'แขกของรินา', '#7aa2c8');
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const mine = await items('main');
  const theirs = await items('rina');
  assert.equal(mine.length, 1, 'งานแรกต้องเห็นรูปของตัวเองใบเดียว');
  assert.equal(theirs.length, 1, 'งานที่สองต้องเห็นรูปของตัวเองใบเดียว');
  assert.equal(mine[0].uploader, 'แขกของงานแรก');
  assert.equal(theirs[0].uploader, 'แขกของรินา');

  // เลข id ของทั้งสองงานเริ่มนับที่ 1 ใหม่ทั้งคู่ — หลักฐานว่าเป็นคนละฐานข้อมูลจริง
  // ไม่ใช่ตารางเดียวกันที่ถูกกรองด้วยคอลัมน์
  assert.equal(mine[0].id, 1);
  assert.equal(theirs[0].id, 1);

  // และรูปของอีกงานต้องดึงตรง ๆ ไม่ได้ด้วย ไม่ใช่แค่ไม่โผล่ในรายการ · เทียบเนื้อไฟล์
  // ไม่ใช่ขนาด — รูปทดสอบสองใบคนละสีแต่ขนาดเท่ากันเป๊ะ (1693 ไบต์ทั้งคู่)
  const fetchBytes = async (slug, id) => Buffer.from(
    await (await fetch(url(slug, `/media/${id}`))).arrayBuffer(),
  );
  const fromMain = await fetchBytes('main', mine[0].id);
  const fromRina = await fetchBytes('rina', theirs[0].id);
  assert.ok(fromMain.length > 0 && fromRina.length > 0);
  assert.ok(!fromMain.equals(fromRina), 'id เดียวกันในสองงานต้องได้คนละไฟล์');
});

test('events stay apart even when they share one browser connection', async () => {
  /*
   * บั๊กที่เกือบหลุดไปจริง และเป็นเหตุผลที่เทสต์ข้อนี้มีอยู่
   *
   * เบราว์เซอร์ใช้การเชื่อมต่อเดิมซ้ำ (keep-alive) และเนื้อคำขอถูกอ่านจากซ็อกเก็ต
   * ไม่ใช่จากสายที่ handler วิ่งอยู่ · ตอนแรกผูกงานด้วย `AsyncLocalStorage.run()`
   * ซึ่งครอบไม่ถึงตรงนั้น — คำขอ **ที่สองเป็นต้นไป** บนการเชื่อมต่อเดียวกันจึงเขียน
   * ลงฐานข้อมูลของคำขอ **ก่อนหน้า** เงียบ ๆ โดยไม่มี error เลยสักบรรทัด
   *
   * อาการโผล่ที่เส้นทางคำอวยพรก่อน (เทสต์ถัดไปคือตัวที่จับได้) เส้นทางอัพโหลดรอด
   * มาได้ในรอบนั้น — แต่รอดด้วยรายละเอียดของการอ่านสตรีมที่เราไม่ได้ตั้งใจให้เป็น
   * ไม่ใช่ด้วยการออกแบบ · ข้อนี้จึงตรึงเส้นทางที่แขกพันคนใช้จริงไว้ตรง ๆ
   * และสลับงานไปมาหลายรอบในการเชื่อมต่อเดียว เพราะคำขอแรกของแต่ละการเชื่อมต่อ
   * *ถูกเสมอ* — ยิงงานละครั้งจึงผ่านได้ทั้งที่ระบบพัง
   */
  const before = { main: (await items('main')).length, rina: (await items('rina')).length };

  for (let round = 0; round < 3; round += 1) {
    assert.equal((await upload('rina', `รอบ ${round}`, '#7aa2c8')).status, 201);
    assert.equal((await upload('main', `รอบ ${round}`, '#c8a27a')).status, 201);
  }

  assert.equal((await items('main')).length, before.main + 3);
  assert.equal((await items('rina')).length, before.rina + 3);
});

test('the files themselves live in different folders on disk', async () => {
  const main = await fs.readdir(path.join(dataDir, 'uploads'));
  const rina = await fs.readdir(path.join(dataDir, 'events', 'rina', 'uploads'));

  assert.ok(main.length > 0 && rina.length > 0, 'ทั้งสองงานต้องมีไฟล์ของตัวเอง');
  const shared = main.filter((name) => rina.includes(name));
  assert.deepEqual(shared, [], 'ไฟล์ต้องไม่ปนโฟลเดอร์กัน');

  // งานเริ่มต้นต้องอยู่ที่เดิมทุกอย่าง — เครื่องที่รันอยู่วันนี้อัปเดตขึ้นมาแล้วต้อง
  // ไม่ต้องย้ายไฟล์และไม่ต้อง migrate อะไรเลย
  await fs.access(path.join(dataDir, 'db', 'wedding.db'));
  await fs.access(path.join(dataDir, 'events', 'rina', 'db', 'wedding.db'));
});

test('a wish written at one event is not read out at the other', async () => {
  const write = (slug, author, body) => {
    // เส้นทางนี้รับ multipart เพราะคำอวยพรแนบรูปมาด้วยได้
    const form = new FormData();
    form.append('author', author);
    form.append('body', body);
    return fetch(url(slug, '/api/messages'), { method: 'POST', body: form });
  };

  assert.equal((await write('main', 'ป้าแดง', 'ขอให้มีความสุขนะ')).status, 201);
  assert.equal((await write('rina', 'Adam', 'Selamat pengantin baru')).status, 201);

  const mine = await (await fetch(url('main', '/api/messages'))).json();
  const theirs = await (await fetch(url('rina', '/api/messages'))).json();
  assert.deepEqual(mine.messages.map((one) => one.author), ['ป้าแดง']);
  assert.deepEqual(theirs.messages.map((one) => one.author), ['Adam']);
});

test('logging in to one event is not logging in to the other', async () => {
  // เจ้าภาพของรินาตั้งรหัสของตัวเอง และรหัสนั้นต้องใช้กับงานอื่นไม่ได้
  const rina = await login('rina', 'rina-only-password');
  assert.ok(rina.cookie, 'รหัสของงานตัวเองต้องเข้าได้');

  const crossed = await fetch(url('main', '/admin'), { headers: { cookie: rina.cookie } });
  const html = await crossed.text();
  assert.ok(
    html.includes('name="password"'),
    'คุกกี้แอดมินของอีกงานต้องเป็นแค่คุกกี้ที่ไม่รู้จัก ไม่ใช่กุญแจ',
  );

  const wrongDoor = await login('main', 'rina-only-password');
  assert.equal(wrongDoor.cookie, undefined ?? null, 'รหัสของลูกค้ารายหนึ่งต้องเปิดงานของอีกรายไม่ได้');

  // กุญแจหลักของเจ้าของระบบยังต้องเปิดได้ทุกงาน — ลูกค้าลืมรหัสตอนตีสองเกิดขึ้นจริง
  assert.ok((await login('rina', 'test-password')).cookie, 'ADMIN_PASSWORD ต้องเปิดได้ทุกงาน');
});

test('a booth session belongs to the event that sent it', async () => {
  const send = async (slug, token) => {
    const form = new FormData();
    form.append('manifest', JSON.stringify({
      token,
      createdAt: '2026-09-03T10:00:00.000Z',
      event: { title: slug },
      template: 'strip',
      effect: 'clean',
      shots: [],
    }));
    form.append('sheet', new Blob([await jpeg('#ffffff')]), 'sheet.jpg');
    form.append('shots', new Blob([await jpeg('#000000')]), 'shot-1.jpg');
    const response = await fetch(url(slug, '/api/booth/upload'), {
      method: 'POST',
      headers: { 'x-booth-key': KEY },
      body: form,
    });
    return response.status;
  };

  assert.equal(await send('main', 'AAA111'), 201);
  assert.equal(await send('rina', 'BBB222'), 201);

  // โทเคนบนกระดาษของงานหนึ่ง ต้องเปิดไม่ได้ที่อีกงาน — และต้องเป็น 404 ที่อธิบายได้
  // ไม่ใช่หน้าพัง เพราะคนที่สแกนคือแขกที่ถือกระดาษยืนอยู่จริง ๆ
  assert.equal((await fetch(url('main', '/p/AAA111'))).status, 200);
  assert.equal((await fetch(url('rina', '/p/AAA111'))).status, 404);
  assert.equal((await fetch(url('rina', '/p/BBB222'))).status, 200);
  assert.equal((await fetch(url('main', '/p/BBB222'))).status, 404);
});

test('a TV paired to one event stays on that event', async () => {
  const openTv = async (slug) => {
    const response = await fetch(url(slug, '/tv'), { redirect: 'manual' });
    const jar = response.headers.getSetCookie().find((one) => one.startsWith('tv_device='));
    const html = await response.text();
    return {
      jar: jar ? jar.split(';')[0] : '',
      code: html.match(/class="tv__code">([0-9A-Z]{6})</)?.[1] ?? null,
    };
  };

  const tv = await openTv('rina');
  assert.match(tv.code ?? '', /^[0-9A-Z]{6}$/);

  // รหัสที่ขึ้นบนจอของงานหนึ่ง ต้องไม่มีความหมายอะไรเลยในหน้าแอดมินของอีกงาน
  const mainAdmin = (await login('main', 'test-password')).cookie;
  const stolen = await fetch(url('main', '/admin/tv'), {
    method: 'POST',
    headers: { cookie: mainAdmin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: tv.code, mode: 'cinema' }),
    redirect: 'manual',
  });
  assert.match(stolen.headers.get('location'), /bad=1/, 'รหัสของจออีกงานต้องใช้ไม่ได้');

  const rinaAdmin = (await login('rina', 'rina-only-password')).cookie;
  const claimed = await fetch(url('rina', '/admin/tv'), {
    method: 'POST',
    headers: { cookie: rinaAdmin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: tv.code, mode: 'wall' }),
    redirect: 'manual',
  });
  assert.equal(claimed.headers.get('location'), '/admin/tv?done=1');

  const state = await (await fetch(url('rina', '/api/tv/state'), {
    headers: { cookie: tv.jar },
  })).json();
  assert.equal(state.paired, true);
});

test('each event wears its own name, and the default one is untouched', async () => {
  const rina = await (await fetch(url('rina', '/?lang=en'))).text();
  const main = await (await fetch(url('main', '/?lang=en'))).text();

  // ตัวแปลภาษาถูกฝังไว้ทั้งชุดในทุกหน้า — ตัด <script> ทิ้งก่อนค่อยดูข้อความที่คนเห็น
  const visible = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
  assert.ok(visible(rina).includes('งานของรินา'), 'งานที่สองต้องขึ้นชื่อของตัวเอง');
  assert.ok(!visible(main).includes('งานของรินา'), 'งานเริ่มต้นต้องไม่ถูกเปลี่ยนชื่อตาม');

  assert.deepEqual(listEvents().map((one) => one.slug).sort(), ['main', 'rina']);
});

test('a made-up event name falls back to the default, it never invents one', async () => {
  // ลิงก์ที่พิมพ์ผิดหรือคนลองสุ่มชื่อ ต้องไม่ได้ฐานข้อมูลใหม่แถมมาให้
  const response = await fetch(url('ไม่มีจริง', '/api/items'));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).items.length, (await items('main')).length);

  const traversal = await fetch(`${app.baseUrl}/api/items?event=../../etc`);
  assert.equal(traversal.status, 200);
  await fs.access(path.join(dataDir, 'events', 'rina'));
  const strays = await fs.readdir(path.join(dataDir, 'events'));
  assert.deepEqual(strays, ['rina'], 'ห้ามมีโฟลเดอร์งานโผล่มาจากค่าที่ผู้ใช้พิมพ์');
});
