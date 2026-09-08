import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readSession, reserveSession, saveSession } from '../src/main/session.js';
import { uploadPending, uploadSession } from '../src/main/upload.js';

/**
 * การส่งรอบถ่ายขึ้นเว็บ — จุดที่ความผิดพลาด **เอากลับไม่ได้**
 *
 * รอบถ่ายถูกพิมพ์ลงกระดาษไปแล้วตั้งแต่คืนงาน กระดาษอยู่ในมือแขกคนอื่นแล้ว
 * สิ่งที่ยังแก้ได้คือสิ่งที่อยู่ในเครื่องบูธ · ความผิดพลาดสองแบบในไฟล์นี้จึงหนักกว่า
 * "ส่งไม่สำเร็จ" ทุกแบบ เพราะสองแบบนี้ไม่มีใครรู้ตัวและย้อนคืนไม่ได้
 *
 *   1. **จดว่าส่งแล้วทั้งที่ไม่ได้ส่งถึงเว็บเรา** → รอบนั้นไม่ถูกส่งซ้ำอีกตลอดกาล
 *      QR บนกระดาษตายถาวร
 *   2. **ส่งขึ้นเว็บผิดงาน** → รูปของลูกค้าคนหนึ่งไปโผล่ในอัลบั้มของลูกค้าอีกคน
 *
 * "ส่งไม่สำเร็จ" ตรงข้ามกับสองข้อนั้น: กดส่งใหม่ก็จบ · ไฟล์นี้จึงยอมให้ล้มบ่อย
 * แต่ไม่ยอมให้ผ่านแบบผิด ๆ แม้แต่ครั้งเดียว
 */

const roots = [];
const servers = [];

after(async () => {
  for (const server of servers) await new Promise((done) => server.close(done));
  for (const root of roots) await fs.rm(root, { recursive: true, force: true });
});

/** เว็บปลอมที่ตอบตามที่สั่ง — คืนที่อยู่กับบันทึกคำขอที่เข้ามา */
async function fakeWeb(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    handler(req, res);
  });
  servers.push(server);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

/** รอบถ่ายหนึ่งรอบบนดิสก์จริง — ไม่ต้องเป็นรูปจริง ฝั่งบูธไม่ได้ตรวจไบต์ */
async function aRound(root, { baseUrl = 'https://a.example', eventTitle = 'งาน ก' } = {}) {
  const { token } = await reserveSession(root);
  await saveSession(root, {
    token,
    photos: [Buffer.from('shot-one')],
    sheet: { data: Buffer.from('sheet-bytes'), width: 1200, height: 1800, dpi: 300 },
    gif: null,
    settings: { eventTitle, baseUrl, paper: '4x6', qrTarget: 'own' },
    effect: 'soft',
    template: 'strip',
  });
  return token;
}

async function tempRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `booth-upload-${name}-`));
  roots.push(root);
  return root;
}

test('a captive portal answering 200 is not mistaken for a successful send', async () => {
  /*
   * เน็ตที่มีหน้าล็อกอิน (โรงแรม ร้านกาแฟ WiFi ของสถานที่) ตอบ 200 พร้อมหน้า HTML
   * ให้ทุก URL · ของเดิมเชื่อแค่สถานะแล้วจด `uploaded: true` ทับลงไป = รอบนั้น
   * หายจากคิวตลอดกาลทั้งที่ไม่มีอะไรขึ้นเว็บเลย
   */
  const root = await tempRoot('portal');
  const web = await fakeWeb((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><body>กรุณาล็อกอินเพื่อใช้อินเทอร์เน็ต</body></html>');
  });
  const token = await aRound(root, { baseUrl: web.url });

  const failed = await uploadSession(root, token, { baseUrl: web.url, key: 'k' })
    .then(() => null, (error) => error);

  assert.ok(failed, 'ต้องล้ม ไม่ใช่ผ่าน');
  assert.match(failed.message, /ไม่ใช่คำตอบของเว็บเรา/);
  assert.equal((await readSession(root, token)).uploaded, false,
    'ต้องยังอยู่ในคิว เพราะยังไม่มีอะไรขึ้นเว็บจริง');
});

test('a 200 that answers about some other round is refused too', async () => {
  // ที่อยู่ที่พิมพ์ผิดไปชนเว็บอื่นที่บังเอิญตอบ JSON ได้ — โทเคนที่ตอบกลับมาต้องตรง
  const root = await tempRoot('other');
  const web = await fakeWeb((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: 'ZZZZZZ' }));
  });
  const token = await aRound(root, { baseUrl: web.url });

  const failed = await uploadSession(root, token, { baseUrl: web.url, key: 'k' })
    .then(() => null, (error) => error);

  assert.ok(failed);
  assert.equal((await readSession(root, token)).uploaded, false);
});

test('a real answer from our own site is what marks the round as sent', async () => {
  const root = await tempRoot('ok');
  const web = await fakeWeb((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: req.headers['x-expect-token'], shots: 1 }));
  });
  const token = await aRound(root, { baseUrl: web.url });

  // เว็บปลอมสะท้อนโทเคนที่บูธส่งมาในเฮดเดอร์ — ผ่าน fetchImpl เพื่อไม่ต้องแกะ multipart
  const result = await uploadSession(root, token, {
    baseUrl: web.url,
    key: 'k',
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'x-expect-token': token } }),
  });

  assert.deepEqual(result, { token, duplicate: false });
  assert.equal((await readSession(root, token)).uploaded, true);
  assert.ok((await readSession(root, token)).uploadedAt);
  assert.deepEqual(web.seen, ['/api/booth/upload']);
});

test('a site that takes the call and never answers does not hang the whole queue', async () => {
  /*
   * `fetch` ของ Node ไม่มี timeout ติดมาเลย · ปลายทางที่รับซ็อกเก็ตแล้วเงียบ
   * (เราเตอร์ค้าง พอร์ตที่ forward ไปผิดเครื่อง) ทำให้ตัวส่งค้างอยู่อย่างนั้นตลอดไป
   * และมันค้างที่รอบแรก แปลว่าอีกหลายร้อยรอบไม่ถูกส่งเลยโดยไม่มีอะไรบอก
   */
  const root = await tempRoot('silent');
  const web = await fakeWeb(() => {});  // รับสายแล้วไม่ตอบอะไรเลย
  const token = await aRound(root, { baseUrl: web.url });

  const started = Date.now();
  const failed = await uploadSession(root, token, { baseUrl: web.url, key: 'k', timeoutMs: 400 })
    .then(() => null, (error) => error);

  assert.ok(failed, 'ต้องเลิกรอเอง ไม่ใช่ค้างไปจนกว่าใครจะปิดโปรแกรม');
  assert.ok(Date.now() - started < 10000, 'ต้องเลิกรอตามเวลาที่ตั้ง');
  assert.match(failed.message, /ไม่ตอบ/);
  assert.equal((await readSession(root, token)).uploaded, false);
});

test('a round printed for one event never goes up on another event site', async () => {
  /*
   * บูธตัวเดียววิ่งหลายงาน และการส่งเกิดทีหลัง · เจ้าของที่รับงานที่สองแล้วเปลี่ยน
   * ที่อยู่เว็บก่อนจะได้กดส่งงานแรก จะดันรูปของลูกค้าคนแรกขึ้นเว็บของลูกค้าคนที่สอง
   * — ความเสียหายที่เอากลับไม่ได้ และไม่มีใครรู้ตัว
   */
  const root = await tempRoot('mixup');
  const web = await fakeWeb((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: 'ANY' }));
  });

  const first = await aRound(root, { baseUrl: 'https://งาน-ก.example', eventTitle: 'งาน ก' });

  const failed = await uploadSession(root, first, { baseUrl: web.url, key: 'k' })
    .then(() => null, (error) => error);

  assert.ok(failed, 'ต้องปฏิเสธ ไม่ใช่ส่งไปให้งานผิด');
  assert.match(failed.message, /งาน-ก\.example/, 'ต้องบอกที่อยู่ที่ถูกต้องไว้ด้วย');
  assert.deepEqual(web.seen, [], 'ต้องไม่มีไบต์ไหนถูกยิงไปที่เว็บของงานอื่นเลย');
  assert.equal((await readSession(root, first)).uploaded, false, 'ต้องยังค้างไว้ให้ส่งทีหลังได้');
});

test('one round for the wrong site does not stop the rest of the night from going up', async () => {
  const root = await tempRoot('mixed');
  const web = await fakeWeb((req, res) => {
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, token: req.headers['x-expect-token'] }));
  });

  const stranger = await aRound(root, { baseUrl: 'https://อีกงาน.example' });
  const mine = await aRound(root, { baseUrl: web.url });
  // รอบเก่าที่บันทึกไว้ก่อนมีการจดปลายทาง — ไม่มีอะไรให้เทียบ จึงส่งตามที่ตั้งไว้ตอนนี้
  const legacy = await aRound(root, { baseUrl: web.url });
  const file = path.join(root, legacy, 'session.json');
  const old = JSON.parse(await fs.readFile(file, 'utf8'));
  delete old.uploadTo;
  await fs.writeFile(file, JSON.stringify(old, null, 2));

  const report = await uploadPending(root, {
    baseUrl: web.url,
    key: 'k',
    fetchImpl: (url, init) => fetch(url, {
      ...init,
      headers: { ...init.headers, 'x-expect-token': JSON.parse(init.body.get('manifest')).token },
    }),
  });

  assert.equal(report.total, 3);
  assert.deepEqual(report.sent.map((one) => one.token).sort(), [legacy, mine].sort());
  assert.deepEqual(report.failed.map((one) => one.token), [stranger]);
  assert.equal((await readSession(root, stranger)).uploaded, false);
  assert.equal((await readSession(root, mine)).uploaded, true);
  assert.equal((await readSession(root, legacy)).uploaded, true);
});
