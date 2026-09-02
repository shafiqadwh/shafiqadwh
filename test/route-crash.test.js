import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir, login } from './helpers/app.js';

/**
 * คำขอเดียวต้องไม่ฆ่าเว็บทั้งงาน
 *
 * Express 4 เรียก handler แล้ว **ทิ้งค่าที่คืนมา** — handler ที่เป็น async แล้ว
 * โยน error ออกมาจึงกลายเป็น unhandled rejection ซึ่ง Node 22 ตั้งค่าเริ่มต้นให้
 * ฆ่าทั้งโปรเซส (พิสูจน์แล้วด้วย Express เปล่า ๆ: เซิร์ฟเวอร์ดับทันที ไม่ตอบอะไรเลย)
 *
 * บนเครื่องจริง Docker ยกกลับมาให้ในสิบกว่าวินาที แต่ถ้าสาเหตุยังอยู่ เช่นดิสก์เต็ม
 * ระหว่างงาน คำขอถัดไปก็ฆ่าซ้ำได้เรื่อย ๆ — เว็บล่ม ๆ ติด ๆ ตลอดงานแต่ง
 */

const dataDir = useTempDataDir('route-crash');
const app = await startTestServer();
after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('every async route is wrapped so its errors reach the error handler', async () => {
  const sources = await Promise.all(['admin', 'gallery', 'slideshow']
    .map((name) => fs.readFile(new URL(`../src/routes/${name}.js`, import.meta.url), 'utf8')));

  for (const source of sources) {
    // handler แบบ async ที่ยังไม่ถูกห่อ = ระเบิดเวลาที่รอวันมีคนเรียกตอนระบบมีปัญหา
    const bare = [...source.matchAll(/\.(get|post)\([^\n]*?, (async \()/g)]
      .filter((m) => !source.slice(Math.max(0, m.index - 6), m.index + m[0].length).includes('wrap('));
    assert.deepEqual(bare.map((m) => m[0].slice(0, 60)), [], 'ยังมี async handler ที่ไม่ได้ห่อ');
  }
});

test('multer callbacks catch their own errors instead of letting them escape', async () => {
  // multer ทิ้ง Promise ที่ callback คืนมา จึงต้องดักเองในนั้น ไม่ใช่หวังพึ่ง wrap()
  for (const name of ['upload', 'guestbook']) {
    const source = await fs.readFile(new URL(`../src/routes/${name}.js`, import.meta.url), 'utf8');
    assert.ok(!/\(req, res, async \(uploadError\)/.test(source),
      `${name}.js ยังส่ง async callback ให้ multer ตรง ๆ`);
    assert.match(source, /\.catch\(\(error\) => \{/, `${name}.js ไม่ได้ดัก error ของตัวเอง`);
  }
});

test('the server survives a request that blows up, and says so honestly', async () => {
  // ยิงของที่ทำให้เส้นทางจริงพัง: id ที่ทำให้ getItem คืน undefined แล้วเดินต่อ
  // (เส้นทางนี้ควรได้ 404 ไม่ใช่ทำเว็บล่ม) แล้วยืนยันว่าเซิร์ฟเวอร์ยังรับงานต่อได้
  const before = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(before.status, 200);

  for (const url of ['/media/999999', '/thumb/abc', '/display/-1', '/download/0']) {
    const response = await fetch(`${app.baseUrl}${url}`);
    assert.equal(response.status, 404, `${url} ควรเป็น 404 — ไม่มีของ ไม่ใช่เว็บพัง`);
  }

  // ตัวชี้ขาด: เว็บยังตอบอยู่หลังจากนั้น
  const after = await fetch(`${app.baseUrl}/healthz`);
  assert.equal(after.status, 200, 'เซิร์ฟเวอร์ตายหลังเจอคำขอที่มีปัญหา');
});

test('a file missing from disk is a 404, not a server fault', async () => {
  // เกิดขึ้นจริงบนเครื่องนี้มาแล้ว (คลังเพลงกลายเป็นของ root จนคอนเทนเนอร์อ่านไม่ได้)
  // เดิมตอบ 500 ทุกกรณี ซึ่งพาเจ้าของไล่หาสาเหตุผิดทาง — แถวยังอยู่ ไฟล์ต่างหากที่หาย
  const { makeJpeg, uploadFiles } = await import('./helpers/fixtures.js');
  const { getItem } = await import('../src/repo.js');
  const path = await import('node:path');

  const source = await makeJpeg(path.join(dataDir, 'gone.jpg'), { width: 400, height: 300 });
  const { body } = await uploadFiles(app.baseUrl, [source]);
  const row = getItem(body.ids[0]);
  await fs.rm(path.join(dataDir, 'uploads', row.stored_name), { force: true });

  const response = await fetch(`${app.baseUrl}/media/${row.id}`);
  assert.equal(response.status, 404, 'ไฟล์ที่ไม่อยู่บนดิสก์ต้องเป็น 404');

  // และเว็บต้องยังรับงานต่อได้ — ทางที่แก้ไปคือปล่อยให้ error วิ่งผ่าน wrap()
  assert.equal((await fetch(`${app.baseUrl}/healthz`)).status, 200);
});

test('there is a process-level net for anything that still escapes', async () => {
  const source = await fs.readFile(new URL('../src/server.js', import.meta.url), 'utf8');
  // งานเบื้องหลัง คิวแปลงวิดีโอ และตัวจับเวลา ไม่ได้วิ่งผ่าน wrap() จึงต้องมีชั้นนี้
  assert.match(source, /process\.on\('unhandledRejection'/);
});
