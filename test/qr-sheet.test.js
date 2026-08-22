import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import sharp from 'sharp';
import QR from 'qrcode';
import { useTempDataDir, startTestServer, login } from './helpers/app.js';

/**
 * การ์ด QR หลายใบต่อกระดาษหนึ่งแผ่น
 *
 * งานนี้แขกพันคน หลายสิบโต๊ะ สามวัน — พิมพ์การ์ด A5 ใบเดียวต่อ A4 คือทิ้งกระดาษ
 * ไปครึ่งแผ่นทุกใบ ของที่เทียบมาจาก albumkahwin.com มีตัวเลือกนี้อยู่แล้ว
 *
 * ข้อที่สำคัญที่สุดในไฟล์นี้คือข้อสุดท้าย: **ถอด QR ที่เรนเดอร์ออกมาจริงกลับเป็น
 * ตารางโมดูล แล้วเทียบกับตารางที่ควรจะเป็นของ URL นั้น** การ์ดที่สวยแต่สแกนไม่ติด
 * คือกระดาษเปล่าหนึ่งพันใบในวันงาน และไม่มีใครรู้จนกว่าจะสายเกินไป
 */

useTempDataDir('qrsheet');
process.env.BASE_URL = 'https://wedding.shafiq-lap.com';

const app = await startTestServer();
const cookie = await login(app.baseUrl);

after(() => app.close());

async function card(query = '') {
  const response = await fetch(`${app.baseUrl}/admin/qr${query}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  return response.text();
}

const countOf = (html, needle) => html.split(needle).length - 1;

test('the card page stays closed to anyone who is not the host', async () => {
  const response = await fetch(`${app.baseUrl}/admin/qr?sheet=4`, { redirect: 'manual' });
  assert.ok(response.status === 401 || response.status === 302, `got ${response.status}`);
});

test('without ?sheet nothing about the old card changes', async () => {
  const html = await card();

  // ค่าเริ่มต้นต้องเป็นของเดิมเป๊ะ — การ์ดที่พิมพ์แจกไปแล้วจะได้ไม่กลายพันธุ์
  assert.equal(countOf(html, '<article class="qr-card">'), 2);
  assert.ok(!html.includes('qr-sheet'), 'ค่าเริ่มต้นไม่ควรถูกจับลงกริดกระดาษ');
  // @page บังคับทั้งเอกสาร สโคปด้วย selector ไม่ได้ จึงต้องไม่โผล่มาในโหมดเดิม
  assert.ok(!html.includes('@page'), '@page ไม่ควรมีผลกับโหมดใบเดียวต่อแผ่น');
});

test('four cards land on one portrait sheet', async () => {
  const html = await card('?sheet=4');
  assert.equal(countOf(html, '<article class="qr-card">'), 4);
  assert.match(html, /class="qr-sheet qr-sheet--4"/);
  assert.match(html, /@page \{ size: A4 portrait; margin: 0; \}/);
});

test('two full-size cards land on one landscape sheet', async () => {
  const html = await card('?sheet=2');
  assert.equal(countOf(html, '<article class="qr-card">'), 2);
  assert.match(html, /class="qr-sheet qr-sheet--2"/);
  // การ์ด A5 สูง 210 มม. สองใบเรียงลงมาบน A4 แนวตั้งเป็น 420 มม. — ล้นกระดาษ
  // แล้วใบที่สองถูกดันไปหน้าใหม่ กลายเป็นแผ่นละใบเหมือนเดิม (วัดมาแล้วว่าเป็นอย่างนั้นจริง)
  assert.match(html, /@page \{ size: A4 landscape; margin: 0; \}/);
});

test('a nonsense ?sheet falls back to the plain card', async () => {
  for (const query of ['?sheet=3', '?sheet=abc', '?sheet=999', '?sheet=', '?sheet=-4']) {
    const html = await card(query);
    assert.ok(!html.includes('qr-sheet'), `${query} ควรตกกลับไปโหมดเดิม`);
    assert.equal(countOf(html, '<article class="qr-card">'), 2, query);
  }
});

test('picking a sheet size keeps the venue choice', async () => {
  // งานนี้จัดสามวันคนละที่ การ์ดแบบไม่ระบุสถานที่จึงมีอยู่ — กดเปลี่ยนจำนวนใบต่อแผ่น
  // แล้วชื่อร้านโผล่กลับมาเองคือการแจกข้อมูลผิดให้แขกในวันที่จัดที่บ้าน
  const html = await card('?sheet=4&venue=0');
  // EJS หนี & เป็น &amp; ซึ่งถูกต้องตามมาตรฐาน HTML และเบราว์เซอร์อ่านกลับเป็น & เอง
  assert.match(html, /href="\/admin\/qr\?sheet=2&amp;venue=0"/);
  assert.ok(!html.includes('qr-card__venue'), 'venue=0 แต่ยังมีบรรทัดสถานที่');
});

test('every card still carries all four languages', async () => {
  const html = await card('?sheet=4');
  // นี่คือสิ่งที่การ์ดของเราต่างจากบริการสำเร็จรูป — ย่อขนาดลงได้ แต่ห้ามหายไป
  for (const code of ['th', 'ms', 'en', 'ar']) {
    // นับเฉพาะบล็อกบนการ์ด ไม่ใช่ lang ของ <html> ที่ครอบทั้งหน้าอยู่
    assert.equal(countOf(html, `class="qr-card__block" lang="${code}"`), 4,
      `ภาษา ${code} ไม่ครบทั้งสี่ใบ`);
  }
  assert.match(html, /dir="rtl"/);
});

test('the printed QR really encodes the event address', async () => {
  const html = await card('?sheet=4');
  const dataUrl = html.match(/src="(data:image\/png;base64,[^"]+)"/)[1];
  const png = Buffer.from(dataUrl.split(',')[1], 'base64');

  const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true });
  // การ์ด A6 ใส่ QR ได้ ~32 มม. · 500 px ที่ขนาดนั้นคือ ~400 dpi เหลือเฟือ
  assert.equal(info.width, 500);

  const expected = QR.create('https://wedding.shafiq-lap.com', { errorCorrectionLevel: 'M' });
  const size = expected.modules.size;
  const MARGIN = 1; // ขอบเงียบที่ qrDataUrl() ตั้งไว้
  const unit = info.width / (size + MARGIN * 2);

  let wrong = 0;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const x = Math.round((col + MARGIN + 0.5) * unit);
      const y = Math.round((row + MARGIN + 0.5) * unit);
      const dark = data[y * info.width + x] < 128;
      // BitMatrix ของ qrcode รับ (แถว, คอลัมน์) ไม่ใช่ (x, y) — สลับแล้วลายจะกลับด้าน
      // โดยที่มุมกำหนดตำแหน่งยังตรงอยู่ ทำให้ดูเผิน ๆ เหมือนถูก
      if (dark !== Boolean(expected.modules.get(row, col))) wrong += 1;
    }
  }
  assert.equal(wrong, 0, `โมดูลไม่ตรง ${wrong} ช่อง — QR ที่พิมพ์ออกมาไม่ใช่ที่อยู่ของงาน`);
});
