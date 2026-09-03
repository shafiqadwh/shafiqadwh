import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { after, test } from 'node:test';
import { login, startTestServer, useTempDataDir } from './helpers/app.js';
import { makeJpeg } from './helpers/fixtures.js';

/**
 * คอนโซลของเจ้าของระบบ — เปิดงานใหม่ ตั้งโดเมน ตั้งรหัสให้ลูกค้า ดูยอดทุกงาน
 *
 * ข้อที่สำคัญที่สุดในไฟล์นี้: **คุกกี้ของลูกค้าต้องไม่มีวันกลายเป็นกุญแจของคอนโซล**
 * ลูกค้าที่ล็อกอินหน้า /admin ของงานตัวเองคือคนที่มีสิทธิ์ในงานเดียว ถ้าคุกกี้ใบนั้น
 * เปิด /console ได้ด้วย เท่ากับลูกค้าทุกรายเห็นและแก้งานของลูกค้าทุกรายได้
 */

const dataDir = useTempDataDir('console');
const app = await startTestServer();

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const post = (route, fields, cookie = null) => fetch(`${app.baseUrl}${route}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    ...(cookie ? { cookie } : {}),
  },
  body: new URLSearchParams(fields),
  redirect: 'manual',
});

async function operator() {
  const response = await post('/console/login', { password: 'test-password' });
  const jar = response.headers.getSetCookie().find((one) => one.startsWith('console_session='));
  return jar ? jar.split(';')[0] : null;
}

/**
 * ยิงคำขอโดยกำหนด Host เอง — ต้องใช้ `http` ดิบ ไม่ใช่ `fetch`
 *
 * `Host` เป็น forbidden header ของ fetch: ตั้งไปก็ถูกทิ้งเงียบ ๆ แล้วคำขอจะไปถึง
 * เซิร์ฟเวอร์ในชื่อ 127.0.0.1 เหมือนเดิม — เทสต์จะ "ผ่าน" โดยไม่เคยทดสอบอะไรเลย
 * (เจอจริงตอนเขียนข้อนี้: ได้ 0 รูปเพราะคำขอตกไปที่งานเริ่มต้น ไม่ใช่งานของโดเมน)
 */
function asHost(host, route) {
  const { port } = app.server.address();
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port, path: route, headers: { host } },
      (response) => {
        let body = '';
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve(JSON.parse(body)));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

const page = async (cookie) => (await fetch(`${app.baseUrl}/console`, {
  headers: cookie ? { cookie } : {},
})).text();

test('the console asks for the master password, and nothing else opens it', async () => {
  assert.ok((await page(null)).includes('name="password"'), 'ยังไม่ล็อกอินต้องเจอหน้าใส่รหัส');

  // รหัสของลูกค้าเปิดคอนโซลไม่ได้ · และคุกกี้แอดมินของลูกค้าก็ไม่ใช่กุญแจ
  const wrong = await post('/console/login', { password: 'not-the-password' });
  assert.equal(wrong.status, 401);

  const customer = await login(app.baseUrl);
  assert.ok((await page(customer)).includes('name="password"'), 'คุกกี้ของลูกค้าต้องเปิดคอนโซลไม่ได้');

  // และเส้นทางที่เปลี่ยนแปลงข้อมูลต้องกันด้วย ไม่ใช่กันแค่หน้าจอ
  const sneaky = await post('/console/events', { slug: 'sneaky', title: 'x' }, customer);
  assert.equal(sneaky.status, 302);
  assert.equal(sneaky.headers.get('location'), '/console');
  await assert.rejects(() => fs.access(path.join(dataDir, 'events', 'sneaky')));
});

test('the operator opens a new event, and it works from that moment on', async () => {
  const cookie = await operator();
  assert.ok(cookie);

  const made = await post('/console/events', {
    slug: 'sara-yusuf',
    title: 'งานแต่งซาร่า และ ยูซุฟ',
    names: 'Sara & Yusuf',
    kind: 'wedding',
    starts_on: '2026-11-14',
    password: 'sara-admin-2026',
  }, cookie);
  assert.equal(made.headers.get('location'), '/console?made=sara-yusuf');

  // งานใหม่ต้องพร้อมรับแขกทันที ไม่ต้องรีสตาร์ต ไม่ต้องสร้างโฟลเดอร์เอง
  const form = new FormData();
  const file = await makeJpeg(path.join(dataDir, 'sara.jpg'), { width: 400, height: 300 });
  form.append('files', new Blob([await fs.readFile(file)]), 'sara.jpg');
  const sent = await fetch(`${app.baseUrl}/api/upload?event=sara-yusuf&lang=th`, {
    method: 'POST', body: form,
  });
  assert.equal(sent.status, 201, await sent.text());

  // และรหัสที่ตั้งให้ลูกค้าตอนสร้าง ต้องใช้ได้เลยกับงานนั้น และเฉพาะงานนั้น
  const theirs = await post('/admin/login?event=sara-yusuf', { password: 'sara-admin-2026' });
  assert.ok(theirs.headers.getSetCookie().some((one) => one.startsWith('admin_session=')));
  const elsewhere = await post('/admin/login', { password: 'sara-admin-2026' });
  assert.equal(elsewhere.status, 401);

  const html = await page(cookie);
  assert.ok(html.includes('งานแต่งซาร่า และ ยูซุฟ'));
  assert.ok(html.includes('Sara &amp; Yusuf') || html.includes('Sara & Yusuf'));
});

test('a bad slug is refused, and never becomes a folder', async () => {
  const cookie = await operator();

  for (const slug of ['../escape', 'มีไทย', 'ends-', '']) {
    const response = await post('/console/events', { slug, title: 'x' }, cookie);
    assert.equal(response.headers.get('location'), '/console?bad=slug', `ต้องปฏิเสธ "${slug}"`);
  }

  // ตัวพิมพ์ใหญ่ไม่ใช่ความผิด แค่แปลงให้เป็นตัวพิมพ์เล็ก — ค่านี้ไปเป็นชื่อโฟลเดอร์
  // และเป็นค่าใน URL ซึ่งทั้งสองอย่างต้องมีหน้าตาเดียวเสมอ ไม่ใช่สองแบบที่ชนกันเอง
  const shouted = await post('/console/events', { slug: 'BINTANG', title: 'บินตัง' }, cookie);
  assert.equal(shouted.headers.get('location'), '/console?made=bintang');

  // ชื่อย่อซ้ำก็ต้องไม่ทับงานที่มีอยู่
  const again = await post('/console/events', { slug: 'sara-yusuf', title: 'ทับ' }, cookie);
  assert.equal(again.headers.get('location'), '/console?bad=taken');

  const folders = await fs.readdir(path.join(dataDir, 'events'));
  assert.deepEqual(folders.sort(), ['bintang', 'sara-yusuf']);
});

test('setting a domain sends that domain to that event, and takes ?event= away', async () => {
  const cookie = await operator();
  const saved = await post('/console/events/sara-yusuf', {
    title: 'งานแต่งซาร่า และ ยูซุฟ',
    host: 'Sara-Yusuf.Example.Com',
    kind: 'wedding',
  }, cookie);
  assert.equal(saved.headers.get('location'), '/console?saved=1');

  // โฮสต์ถูกเก็บเป็นตัวพิมพ์เล็กเสมอ — Host header ที่เข้ามาไม่ได้ถูกกำหนดตัวพิมพ์
  const seen = await asHost('sara-yusuf.example.com', '/api/items');
  assert.equal(seen.items.length, 1, 'โดเมนของงานต้องพาไปที่งานนั้น');

  /*
   * และบนโดเมนของลูกค้า `?event=` ต้องไม่มีความหมาย — ไม่งั้นใครก็ตามที่รู้ชื่อย่อ
   * ของงานอื่นจะเปิดดูงานนั้นผ่านโดเมนของลูกค้ารายนี้ได้
   */
  const crossed = await asHost('sara-yusuf.example.com', '/api/items?event=main');
  assert.equal(crossed.items.length, 1, 'โดเมนของลูกค้าต้องหมายถึงงานของลูกค้าเท่านั้น');

  // คุกกี้ที่ค้างมาจากการเปิดด้วย ?event= ที่อื่น ก็ต้องไม่มีผลบนโดเมนของลูกค้าเช่นกัน
  // (ทางลัดที่เงียบกว่า ?event= เพราะไม่มีอะไรให้เห็นในแถบที่อยู่)
  const withCookie = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: app.server.address().port,
      path: '/api/items',
      headers: { host: 'sara-yusuf.example.com', cookie: 'event=main' },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve(JSON.parse(body)));
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(withCookie.items.length, 1, 'คุกกี้ค้างต้องไม่พาไปงานอื่นบนโดเมนของลูกค้า');
});

test('the console counts each day of a three-day event separately', async () => {
  const cookie = await operator();
  const { runInEvent, findEvent } = await import('../src/lib/tenancy.js');
  const { db } = await import('../src/db.js');

  // ย้อนวันของรูปที่มีอยู่ให้เป็นเมื่อวาน แล้วเติมของวันนี้เข้าไปอีกใบ
  runInEvent(findEvent('sara-yusuf'), () => {
    db.prepare("UPDATE items SET created_at = datetime('now', '-1 day')").run();
  });

  const form = new FormData();
  const file = await makeJpeg(path.join(dataDir, 'sara-2.jpg'), { width: 400, height: 300 });
  form.append('files', new Blob([await fs.readFile(file)]), 'sara-2.jpg');
  await fetch(`${app.baseUrl}/api/upload?event=sara-yusuf&lang=th`, { method: 'POST', body: form });

  const { dailyCounts } = await import('../src/repo.js');
  const days = runInEvent(findEvent('sara-yusuf'), () => dailyCounts());
  assert.equal(days.length, 2, 'สองวันต้องเป็นสองแถว ไม่ใช่ยอดรวมก้อนเดียว');
  assert.deepEqual(days.map((one) => one.photos), [1, 1]);

  const html = await page(cookie);
  assert.ok(html.includes(days[0].day) && html.includes(days[1].day), 'ทั้งสองวันต้องขึ้นในคอนโซล');
});

test('archiving keeps the event and its photos, it never deletes anything', async () => {
  const cookie = await operator();
  await post('/console/events/sara-yusuf/archive', { archived: 'on' }, cookie);

  const html = await page(cookie);
  assert.ok(html.includes('เก็บเข้าลิ้นชักแล้ว'));

  // ของทุกอย่างต้องยังอยู่ครบ — "เก็บเข้าลิ้นชัก" ไม่ใช่ "ลบ"
  await fs.access(path.join(dataDir, 'events', 'sara-yusuf', 'db', 'wedding.db'));
  const still = await fetch(`${app.baseUrl}/api/items?event=sara-yusuf`);
  assert.equal((await still.json()).items.length, 2);
});

test('a TV on a customer domain cannot be pulled into an event that has no domain', async () => {
  /*
   * ทะเบียนจอเป็นของทั้งเครื่อง เจ้าภาพงานไหนก็จับคู่จอที่กำลังโชว์รหัสอยู่ได้ —
   * แต่จอต้องไปถึงงานนั้นได้จริงด้วย · จอที่เปิดอยู่บนโดเมนของลูกค้ารายหนึ่ง
   * ไปเปิดงานที่ยังไม่มีโดเมนไม่ได้ เพราะโดเมนของลูกค้าหมายถึงงานของลูกค้าเท่านั้น
   * (กติกาข้อเดียวกับที่ทำให้ ?event= ใช้ไม่ได้บนโดเมนที่ถูกจองแล้ว)
   *
   * ถ้าไม่กันตรงนี้ การกดยืนยันจะ "สำเร็จ" แล้วทีวีก็ขึ้นรูปของงานอื่นไปทั้งงาน
   */
  const cookie = await operator();
  await post('/console/events', { slug: 'no-domain-yet', title: 'งานที่ยังไม่มีโดเมน' }, cookie);

  // จอเปิดที่โดเมนของ sara-yusuf ซึ่งตั้งโดเมนไว้แล้วในเทสต์ก่อนหน้า
  const opened = await new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: app.server.address().port,
      path: '/tv',
      headers: { host: 'sara-yusuf.example.com' },
    }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        code: body.match(/class="tv__code">([0-9A-Z]{6})</)?.[1] ?? null,
      }));
    });
    request.on('error', reject);
    request.end();
  });
  assert.match(opened.code ?? '', /^[0-9A-Z]{6}$/);

  const admin = await post('/admin/login?event=no-domain-yet', { password: 'test-password' });
  const jar = admin.headers.getSetCookie().find((one) => one.startsWith('admin_session=')).split(';')[0];

  const refused = await post('/admin/tv?event=no-domain-yet', { code: opened.code, mode: 'wall' }, jar);
  assert.match(refused.headers.get('location'), /nodomain=1/,
    'ต้องบอกว่าให้ตั้งโดเมนก่อน ไม่ใช่จับคู่สำเร็จแล้วไปขึ้นรูปผิดงาน');

  // และข้อความนั้นต้องขึ้นบนหน้าจริง ไม่ใช่มีแค่ในลิงก์
  const shown = await (await fetch(`${app.baseUrl}/admin/tv?event=no-domain-yet&nodomain=1`, {
    headers: { cookie: jar },
  })).text();
  assert.ok(shown.replace(/<script[\s\S]*?<\/script>/g, '').includes('ตั้งโดเมนของงานนี้ก่อน'));
});

test('one domain belongs to one event — and a refused domain leaves nothing behind', async () => {
  /*
   * เดิมปล่อยให้ไปชนดัชนี unique เอง ผลคือหน้า 500 เปล่า ๆ กับ SQLITE_CONSTRAINT
   * ใน log · และที่แย่กว่านั้นคือ `createEvent` แทรกแถวกับสร้างโฟลเดอร์ไปแล้ว
   * ก่อนถึงบรรทัดที่ล้ม เหลืองานครึ่ง ๆ กลาง ๆ ค้างในทะเบียนที่ไม่มีใครสั่งให้มี
   */
  const cookie = await operator();

  const clash = await post('/console/events', {
    slug: 'clash', title: 'ชนโดเมน', host: 'sara-yusuf.example.com',
  }, cookie);
  assert.equal(clash.headers.get('location'), '/console?bad=host');

  const { findEvent } = await import('../src/lib/tenancy.js');
  assert.equal(findEvent('clash'), null, 'งานที่ถูกปฏิเสธต้องไม่ถูกสร้างครึ่ง ๆ กลาง ๆ');
  await assert.rejects(() => fs.access(path.join(dataDir, 'events', 'clash')));

  // แก้งานที่มีอยู่ให้ไปใช้โดเมนของงานอื่นก็ต้องถูกปฏิเสธเหมือนกัน
  const moved = await post('/console/events/bintang', {
    title: 'บินตัง', host: 'sara-yusuf.example.com',
  }, cookie);
  assert.equal(moved.headers.get('location'), '/console?bad=host');
  assert.ok(!findEvent('bintang').host, 'งานที่ถูกปฏิเสธต้องไม่ได้โดเมนติดไปด้วย');

  // แต่บันทึกโดเมนเดิมของตัวเองซ้ำต้องได้ ไม่ใช่ชนกับตัวเอง
  const same = await post('/console/events/sara-yusuf', {
    title: 'งานแต่งซาร่า และ ยูซุฟ', host: 'sara-yusuf.example.com',
  }, cookie);
  assert.equal(same.headers.get('location'), '/console?saved=1');
});
