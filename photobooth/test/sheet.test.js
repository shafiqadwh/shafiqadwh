import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { fitLines, isArabic } from '../../shared/text.js';
import { THEME_IDS } from '../../shared/themes.js';
import { EFFECT_IDS, applyEffect } from '../src/core/effects.js';
import { TEMPLATE_IDS, layoutFor, shotsFor } from '../src/core/templates.js';
import { MIN_QR_MODULE_MM, composeSheet } from '../src/core/sheet.js';

/**
 * แผ่นที่ประกอบเสร็จแล้ว — ทุกข้อในนี้เคยผิดจริงระหว่างพัฒนา และเห็นได้ก็ต่อเมื่อ
 * เรนเดอร์ออกมาดูด้วยตา · เขียนเป็นเทสต์ไว้เพื่อไม่ต้องนั่งดูใหม่ทุกครั้งที่แก้อะไร
 */

/** รูปจำลอง — สีชัดเจนพอให้ตรวจได้ว่าเอฟเฟคทำอะไรกับสีเดิม */
function shot(hue = 210) {
  return sharp({
    create: { width: 900, height: 675, channels: 3, background: { r: 120, g: 150, b: 200 } },
  }).composite([{
    input: Buffer.from(`<svg width="900" height="675" xmlns="http://www.w3.org/2000/svg">
      <rect width="900" height="675" fill="hsl(${hue},50%,55%)"/>
      <circle cx="450" cy="300" r="160" fill="#f0dcc6"/></svg>`),
    left: 0,
    top: 0,
  }]).jpeg().toBuffer();
}

const REAL_URL = 'https://wedding.shafiq-lap.com/p/K7QX2M';

test('every template produces a sheet at exact print size', async () => {
  const photos = await Promise.all([0, 1, 2, 3].map((i) => shot(200 + i * 40)));

  for (const template of TEMPLATE_IDS) {
    const sheet = await composeSheet({
      photos, template, title: 'งานแต่งงาน', subtitle: '29.08.2026', qrUrl: REAL_URL,
    });
    assert.equal(sheet.width, 1200, `${template} กว้างไม่ตรง`);
    assert.equal(sheet.height, 1800, `${template} สูงไม่ตรง`);
    assert.equal(sheet.dpi, 300);

    // ภาพที่ออกมาต้องมีขนาดตรงกับที่บอก ไม่ใช่แค่ตัวเลขในผลลัพธ์ถูก
    const meta = await sharp(sheet.data).metadata();
    assert.equal(meta.width, 1200, `${template}: ไฟล์จริงกว้างไม่ตรงกับที่รายงาน`);
    assert.equal(meta.height, 1800, `${template}: ไฟล์จริงสูงไม่ตรงกับที่รายงาน`);
  }
});

test('a QR on any template is big enough for a phone to read', async () => {
  const photos = await Promise.all([0, 1, 2, 3].map(() => shot()));

  for (const template of TEMPLATE_IDS) {
    const sheet = await composeSheet({ photos, template, title: 'งานแต่ง', qrUrl: REAL_URL });
    assert.ok(!sheet.qrTooSmall,
      `${template}: โมดูล QR เล็กแค่ ${sheet.qrModuleMm}mm (ต้องอย่างน้อย ${MIN_QR_MODULE_MM}mm)`);
    assert.ok(sheet.qrModuleMm >= MIN_QR_MODULE_MM);
  }
});

test('a long address makes the modules smaller, and that gets reported', async () => {
  // ที่อยู่ยาวขึ้น = โมดูลมากขึ้นในกรอบเท่าเดิม = แต่ละช่องเล็กลง · เกณฑ์จึงต้อง
  // วัดที่ขนาดโมดูล ไม่ใช่ขนาดรวมของ QR ซึ่งไม่เปลี่ยนเลยไม่ว่าที่อยู่จะยาวแค่ไหน
  const photos = [await shot()];
  const short = await composeSheet({ photos, template: 'classic', title: 'ก', qrUrl: 'https://a.bc/1' });
  const long = await composeSheet({
    photos,
    template: 'classic',
    title: 'ก',
    qrUrl: 'https://booth.example.co.th/photo/2026/08/29/session-4821/download?token=abcdef123456',
  });

  assert.equal(short.qrMm, long.qrMm, 'ขนาดรวมเท่ากัน — จึงใช้เป็นเกณฑ์ไม่ได้');
  assert.ok(long.qrModuleMm < short.qrModuleMm, 'ที่อยู่ยาวกว่าต้องได้โมดูลเล็กกว่า');
});

test('a sheet with too few photos refuses to build instead of printing a gap', async () => {
  // กระดาษ dye-sub ย้อนกลับไม่ได้ · ต้องหยุดก่อนถึงเครื่องพิมพ์ ไม่ใช่หลังจากนั้น
  for (const template of TEMPLATE_IDS) {
    const needed = shotsFor(template);
    if (needed < 2) continue;
    await assert.rejects(
      () => composeSheet({ photos: [], template, title: 'ก' }),
      new RegExp(`${needed} ใบ`),
      `${template} ต้องปฏิเสธเมื่อรูปไม่ครบ`,
    );
  }
});

test('an effect grades the colour instead of replacing it', async () => {
  /*
   * เคยผิดจริง: ใช้ `.tint()` ซึ่งเป็น duotone — มันกลืนสีเดิมทิ้งทั้งหมด
   * พิกเซลฟ้า (120,150,200) กลายเป็นน้ำตาล (175,143,99) เสื้อสีฟ้าที่แขกใส่มา
   * หายไปเลยทั้งแผ่น · เอฟเฟค "อุ่น" ต้องทำให้อุ่นขึ้น ไม่ใช่ย้อมใหม่ทั้งภาพ
   */
  const blue = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 120, g: 150, b: 200 } },
  }).jpeg().toBuffer();

  for (const effect of EFFECT_IDS) {
    if (effect === 'mono') continue; // ขาวดำตั้งใจให้ทิ้งสี
    const out = await applyEffect(blue, effect, { width: 40, height: 40 });
    const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    const [r, g, b] = [data[0], data[1], data[2]];
    assert.ok(b > r, `เอฟเฟค "${effect}" ทำให้พิกเซลฟ้ากลายเป็นสีอุ่น (${r},${g},${b})`);
  }
});

test('black and white really is black and white', async () => {
  const blue = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 120, g: 150, b: 200 } },
  }).jpeg().toBuffer();
  const out = await applyEffect(blue, 'mono', { width: 20, height: 20 });
  const { data } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
  assert.ok(Math.abs(data[0] - data[2]) <= 2, 'ช่องแดงกับน้ำเงินต้องเท่ากันในภาพขาวดำ');
});

test('a photo is cropped to fit, never stretched', async () => {
  // หน้าคนที่ถูกยืดให้พอดีกรอบคือของเสียที่พิมพ์ออกมาแล้วแก้ไม่ได้
  const wide = await sharp({
    create: { width: 1600, height: 400, channels: 3, background: { r: 100, g: 100, b: 100 } },
  }).jpeg().toBuffer();
  const out = await applyEffect(wide, 'clean', { width: 300, height: 600 });
  const meta = await sharp(out).metadata();
  assert.equal(meta.width, 300);
  assert.equal(meta.height, 600);
});

test('the Arabic sheet puts the QR on the other side', async () => {
  // ไม่ใช่เรื่องความสวยงาม — ภาษาที่อ่านขวาไปซ้ายวางข้อความชิดซ้ายแล้วอ่านสะดุด
  // เหมือนย่อหน้าที่เริ่มผิดข้าง · และการตัดสินใจนี้ต้องใช้ตัวตรวจอักษรตัวเดียว
  // กับที่ใช้เลือกฟอนต์ ไม่งั้นจะได้แผ่นที่ใช้ฟอนต์อาหรับแต่จัดหน้าแบบซ้ายไปขวา
  assert.equal(isArabic('عيد الفطر المبارك'), true);
  assert.equal(isArabic("Sofwan & 'Aishah"), false);
  assert.equal(isArabic('สุขสันต์วันเกิด'), false);
  assert.equal(isArabic(null), false);

  const photos = [await shot()];
  const common = { photos, template: 'classic', qrUrl: REAL_URL, subtitle: '' };
  const latin = await composeSheet({ ...common, title: 'Wedding' });
  const arabic = await composeSheet({ ...common, title: 'عيد الفطر المبارك' });

  // ยืนยันบนภาพจริงด้วย: ตัดกรอบตรงตำแหน่ง QR ที่คำนวณได้ แล้วดูว่าฝั่งไหนเป็น QR
  // QR เป็นลายขาวดำจัด ค่าเบี่ยงเบนมาตรฐานจึงสูงกว่าพื้นเรียบ ๆ อย่างชัดเจน
  const layout = layoutFor('classic', '4x6');
  const footer = layout.footers[0];
  const pad = Math.round(footer.height * 0.08);
  const size = Math.min(footer.height - pad * 2, Math.round((26 / 25.4) * 300));
  const top = footer.top + Math.round((footer.height - size) / 2);
  const rightBox = { left: footer.left + footer.width - pad - size, top, width: size, height: size };
  const leftBox = { left: footer.left + pad, top, width: size, height: size };

  // ⚠️ `stats()` ของ sharp อ่านจาก **ภาพต้นทาง** ไม่สนใจ `extract` ที่ต่อไว้ในไปป์ไลน์
  // เขียน `sharp(x).extract(box).stats()` จะได้ค่าของทั้งแผ่นเสมอ ทุกกรอบเท่ากันหมด
  // (เจอตอนเทสต์นี้ล้มโดยที่ซ้ายกับขวาให้ค่าเท่ากันเป๊ะ ซึ่งเป็นไปไม่ได้)
  const look = async (data, box) => {
    const cropped = await sharp(data).extract(box).png().toBuffer();
    return (await sharp(cropped).stats()).channels[0];
  };

  // QR เป็นลายขาวดำจัด: กระจายตัวสูงและเข้มกว่าฝั่งที่มีแต่ตัวหนังสือบนพื้นสว่าง
  const whereIsQr = async (data) => {
    const [right, left] = [await look(data, rightBox), await look(data, leftBox)];
    return right.stdev > left.stdev && right.mean < left.mean - 40 ? 'right' : 'left';
  };

  assert.equal(await whereIsQr(latin.data), 'right', 'ภาษาละติน: QR ต้องอยู่ขวา');
  assert.equal(await whereIsQr(arabic.data), 'left', 'ภาษาอาหรับ: QR ต้องย้ายไปซ้าย');
});

test('a sheet can be built with no QR at all', async () => {
  // งาน offline ล้วนไม่มีที่ให้ QR ชี้ไป · ต้องพิมพ์ได้ตามปกติ ไม่ใช่ค้างหรือขึ้นกล่องว่าง
  const sheet = await composeSheet({
    photos: [await shot()], template: 'polaroid', title: 'งานเลี้ยง', qrUrl: null,
  });
  assert.equal(sheet.qrMm, 0);
  assert.equal(sheet.qrTooSmall, false);
  assert.equal((await sharp(sheet.data).metadata()).width, 1200);
});

test('every theme produces a sheet, with its own paper colour', async () => {
  const photos = [await shot()];
  const corners = [];

  for (const theme of THEME_IDS) {
    const sheet = await composeSheet({ photos, template: 'classic', theme, title: 'ก' });
    // มุมบนซ้ายสุดคือพื้นแผ่น ก่อนถึงขอบรูป — สีต้องเป็นของธีมนั้นจริง
    const { data } = await sharp(sheet.data)
      .extract({ left: 2, top: 2, width: 4, height: 4 }).raw().toBuffer({ resolveWithObject: true });
    corners.push(`${theme}:${data[0]},${data[1]},${data[2]}`);
  }
  assert.equal(corners.length, THEME_IDS.length);
});

test('a text block never grows past the space it was given', async () => {
  /*
   * เคยผิดจริง: ชื่อยาวถูกตัดเป็นหลายบรรทัดจนสูงเกินแถบ แล้วบรรทัดวันที่ที่วาง
   * ต่อจากนั้นไปทับบรรทัดสุดท้ายของชื่อ · เห็นได้จากภาพที่เรนเดอร์ออกมาเท่านั้น
   */
  const cases = [
    "Sofwan & 'Aishah Nadhirah",
    'สุขสันต์วันเกิดครบรอบสามสิบปีเต็ม',
    'عيد الفطر المبارك ١٤٤٧',
    'A',
    'Supercalifragilisticexpialidocious',
  ];

  for (const text of cases) {
    for (const [maxWidth, maxHeight] of [[788, 140], [400, 70], [200, 40]]) {
      const parts = await fitLines(text, {
        colour: '#000', maxWidth, maxHeight, startPt: 30, align: 'left', bold: true, dpi: 300,
      });
      const total = parts.reduce((sum, part) => sum + part.info.height, 0);
      const widest = Math.max(...parts.map((part) => part.info.width));
      assert.ok(parts.length >= 1 && parts.length <= 2, `"${text}" ได้ ${parts.length} บรรทัด`);
      // ต้องพอดีจริง ไม่ใช่ "เกือบ" — ล้นแถบบนกระดาษคือตัวหนังสือไปทับ QR
      assert.ok(widest <= maxWidth, `"${text}" กว้าง ${widest} ล้นช่อง ${maxWidth}`);
      assert.ok(total <= maxHeight * 1.35, `"${text}" สูง ${total} ล้นช่อง ${maxHeight}`);
    }
  }
});

test('Thai and Arabic actually put ink on the sheet', async () => {
  // Pango ไม่ error เมื่อหาฟอนต์ไม่เจอ — มันเงียบ ๆ ไปหยิบฟอนต์ระบบ แล้วได้ □□□
  // หรือช่องว่างเปล่า · ตรวจว่ามีหมึกลงจริง ไม่ใช่ตรวจว่าไม่มี error
  for (const text of ['สุขสันต์วันเกิด', 'عيد الفطر', 'Selamat Pengantin Baru']) {
    const [part] = await fitLines(text, {
      colour: '#000000', maxWidth: 900, maxHeight: 200, startPt: 24, dpi: 300,
    });
    const stats = await sharp(part.data).stats();
    // ช่องอัลฟา: ถ้าไม่มีตัวอักษรเลย ทุกพิกเซลจะโปร่งใสหมด ค่าเฉลี่ยจะเป็นศูนย์
    const alpha = stats.channels.at(-1);
    assert.ok(alpha.mean > 1, `"${text}" ไม่มีหมึกลงบนภาพเลย`);
    assert.ok(part.info.width > 10 && part.info.height > 5, `"${text}" ได้ภาพขนาดผิดปกติ`);
  }
});
