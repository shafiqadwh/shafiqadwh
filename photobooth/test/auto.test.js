import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { measure, planFrom } from '../src/core/auto.js';
import { applyEffect } from '../src/core/effects.js';

/**
 * ฟิลเตอร์อัตโนมัติ — **ภาพที่ดีอยู่แล้วต้องถูกแตะน้อยมาก**
 *
 * ข้อนั้นคือทั้งหมดที่แยก "auto" ออกจาก "พรีเซ็ตอีกตัวหนึ่ง" และเป็นสิ่งที่เจ้าของ
 * ขอมาตรง ๆ: สวยขึ้นชัดเจน แต่ไม่แต่งเยอะ · ทั้งสองอย่างเป็นจริงพร้อมกันได้ทางเดียว
 * คือดูภาพก่อนแล้วค่อยตัดสิน
 *
 * ตัววัดกับตัวคิดค่าเป็นฟังก์ชันบริสุทธิ์ทั้งคู่ ป้อนพิกเซลที่รู้ค่าแน่นอนเข้าไปแล้ว
 * ตรวจตัวเลขที่ได้ — จึงไม่ต้องมีรูปถ่ายจริงมาเป็นตัวตั้ง และไม่มีข้อไหนที่ผ่านเพราะ
 * "ดูแล้วน่าจะโอเค"
 *
 * ⚠️ สิ่งที่ไฟล์นี้ตรวจ **ไม่ได้** คือความสวย · ตัวเลขบอกได้แค่ว่าทำในสิ่งที่อ้าง
 * ตัดสินว่าสวยไหมต้องเอารูปคนจริงจากบูธมาดูด้วยตา
 */

/** ภาพจำลองจากรายการพิกเซล — ป้อนค่าที่รู้แน่นอน แล้วตรวจสิ่งที่วัดได้ */
const from = (pixels) => measure(Buffer.from(pixels.flat()), 3);

/** ภาพเทาเรียบทั้งใบที่ค่าหนึ่ง ๆ ซ้ำ n พิกเซล */
const flat = (value, n = 100) => Array.from({ length: n }, () => [value, value, value]);

/** ไล่ระดับเต็มช่วง 0–255 — ภาพที่ใช้ช่วงเต็มอยู่แล้ว */
const fullRange = () => Array.from({ length: 256 }, (_, v) => [v, v, v]);

test('a photo that is already right is barely touched', () => {
  /*
   * ข้อสำคัญที่สุดของทั้งไฟล์ · ถ้าข้อนี้ไม่ผ่าน ตัวแต่งอัตโนมัติจะกลายเป็นตัวที่
   * ทำให้ภาพดี ๆ แย่ลง ซึ่งแย่กว่าการไม่มีมันเลย
   */
  const stats = from(fullRange());
  const plan = planFrom(stats);

  assert.deepEqual(plan.linear.a, [1, 1, 1], 'ภาพช่วงเต็มแล้วยังไปดึงระดับอีก');
  assert.deepEqual(plan.linear.b, [0, 0, 0]);
});

test('an underexposed photo is lifted, but never past the ceiling', () => {
  // ภาพที่มืดและแบน — อาการปกติของบูธในเต็นท์ที่ไฟไม่พอ
  const dark = Array.from({ length: 60 }, (_, i) => {
    const v = 10 + i;
    return [v, v, v];
  });
  const plan = planFrom(from(dark));

  assert.ok(plan.linear.a[0] > 1.2, `ดึงน้อยเกินไป: ${plan.linear.a[0]}`);
  assert.ok(plan.linear.a[0] <= 1.8, `ดึงเกินเพดาน: ${plan.linear.a[0]}`);

  // และผลลัพธ์ต้องไม่ไหม้ — จุดขาวที่คิดไว้ต้องอยู่ใต้ 255
  const stats = from(dark);
  const top = plan.linear.a[0] * stats.high + plan.linear.b[0];
  assert.ok(top <= 253, `จุดขาวหลังดึงไหม้: ${top}`);
});

test('shadows are never crushed, no matter how the photo came out', () => {
  /*
   * **ข้อนี้คือบทเรียนที่แพงที่สุดของไฟล์นี้** · รอบแรกเขียนแบบ auto-levels ตำรา
   * (ยืด [p0.5, p99.5] ให้เต็มช่วง) แล้วเรนเดอร์ออกมาดู — เงาถูกดันไปที่ **−7**
   * ตันสนิท และค่ากลางทั้งภาพ **ตกจาก 71 เหลือ 38** คือภาพใต้แสงน้อยกลับมืดลง
   * ไม่มีตัวเลขตัวไหนในเทสต์ชุดแรกจับได้เลย เห็นตอนเอาภาพออกมาดูด้วยตาเท่านั้น
   *
   * ตอนนี้จุดดำถูกดึงลงได้มากสุด 14 ระดับ ไม่ว่าภาพต้นทางจะเป็นยังไง
   */
  for (const start of [5, 20, 60, 110]) {
    const photo = Array.from({ length: 60 }, (_, i) => [start + i, start + i, start + i]);
    const stats = from(photo);
    const plan = planFrom(stats);

    const bottom = plan.linear.a[0] * stats.low + plan.linear.b[0];
    assert.ok(bottom >= 0, `เงาตันสนิทที่ภาพเริ่มจาก ${start}: ${bottom.toFixed(1)}`);
    assert.ok(plan.linear.b[0] >= -14.001,
      `ดึงจุดดำลงเกินเพดาน: ${plan.linear.b[0].toFixed(1)}`);
  }
});

test('an underexposed photo comes out brighter, never darker', () => {
  /*
   * ฟังดูเหมือนไม่ต้องเขียนก็ได้ แต่นี่คือสิ่งที่โค้ดรอบแรกทำผิดจริง ๆ · `a` ชนเพดาน
   * แล้ว แต่ `b` ยังคิดจากเจตนาที่ทำไม่ได้แล้ว ผลคือทั้งภาพถูกลบด้วยค่าคงที่ก้อนใหญ่
   * — ตัวเลขทุกตัวยังอยู่ในกรอบที่ตั้งไว้ ไม่มีอะไรดูผิด แต่ภาพมืดลง
   */
  for (const start of [10, 30, 55]) {
    const photo = Array.from({ length: 60 }, (_, i) => [start + i, start + i, start + i]);
    const stats = from(photo);
    const plan = planFrom(stats);

    const after_ = plan.linear.a[1] * stats.meanLuma + plan.linear.b[1];
    assert.ok(after_ > stats.meanLuma,
      `ภาพที่เริ่มจาก ${start} มืดลงแทนที่จะสว่างขึ้น: ${stats.meanLuma.toFixed(1)} → ${after_.toFixed(1)}`);
  }
});

test('a warm cast is cooled by a measured amount, not neutralised outright', () => {
  /*
   * งานแต่งใต้ไฟเหลืองทั้งงานเป็นเรื่องปกติ และความอุ่นนั้นคือบรรยากาศที่เจ้าภาพ
   * ตั้งใจ ไม่ใช่ความผิดพลาด · แก้ให้ผิวดูเป็นผิวคน แต่ไม่ลากทั้งภาพกลับไปเป็นแสงกลางวัน
   */
  const warm = Array.from({ length: 100 }, (_, i) => [180 + (i % 40), 150 + (i % 40), 110 + (i % 40)]);
  const plan = planFrom(from(warm));

  assert.ok(plan.gains[2] > plan.gains[0], 'อมเหลืองแล้วต้องยกน้ำเงินขึ้นเทียบกับแดง');
  assert.equal(plan.gains[1], 1, 'ช่องเขียวเป็นหลัก ต้องไม่ถูกขยับ ไม่งั้นความสว่างเปลี่ยนตามการแก้สี');
  for (const gain of plan.gains) {
    assert.ok(gain >= 0.94 && gain <= 1.06, `เกินเพดาน ±6%: ${plan.gains.join(', ')}`);
  }

  /*
   * ระยะห่างสูงสุดระหว่างสองช่องคือสิ่งที่ตาเห็น ไม่ใช่เพดานของแต่ละช่อง
   * เริ่มไว้ที่ ±12% ต่อช่อง แล้วเรนเดอร์ออกมาเจอว่าโคมไฟกลายเป็นสีฟ้า เพราะระยะห่าง
   * จริงคือ 1.12/0.88 = 27% ไม่ใช่ 12% — เห็นได้ด้วยตาเท่านั้น ตัวเลขไม่ได้ผิดกรอบ
   */
  const spread = Math.max(...plan.gains) / Math.min(...plan.gains);
  assert.ok(spread <= 1.14, `แก้สีแรงเกินจนเปลี่ยนบรรยากาศของฉาก: ${spread.toFixed(3)}`);
});

test('a neutral photo is left alone instead of being nudged for no reason', () => {
  const plan = planFrom(from(flat(128)));
  assert.deepEqual(plan.gains, [1, 1, 1], 'ภาพที่สมดุลอยู่แล้วต้องไม่ถูกขยับ');
});

test('a red backdrop is not mistaken for a red cast on the light', () => {
  /*
   * นี่คือเหตุผลที่ใช้พิกเซลสว่างสุด 10% แทน gray-world · ฉากหลังแดงเต็มเฟรมจะทำให้
   * gray-world อ่านว่า "ภาพนี้อมแดง" แล้วถอดแดงออกจนผิวคนเขียว ซึ่งเป็นความเสียหาย
   * ที่เห็นชัดที่สุดบนใบหน้า และบูธที่มี backdrop คือบูธทุกบูธ
   */
  const scene = [
    ...Array.from({ length: 90 }, () => [150, 20, 20]),   // ฉากหลังแดงเข้ม
    ...Array.from({ length: 10 }, () => [200, 200, 200]), // แสงสะท้อนสีกลาง
  ];
  const plan = planFrom(from(scene));

  for (const gain of plan.gains) {
    assert.ok(Math.abs(gain - 1) < 0.03,
      `ฉากหลังแดงถูกอ่านเป็นแสงสีแดง แล้วไปแก้สีทั้งภาพ: ${plan.gains.join(', ')}`);
  }
});

test('a flat photo gets more colour than one that already has plenty', () => {
  const flatColour = planFrom(from(Array.from({ length: 100 }, () => [130, 126, 122])));
  const rich = planFrom(from(Array.from({ length: 100 }, () => [220, 60, 40])));

  assert.ok(flatColour.saturation > rich.saturation,
    `ภาพจืดต้องได้สีเพิ่มมากกว่าภาพสีจัด: ${flatColour.saturation} vs ${rich.saturation}`);
  assert.ok(flatColour.saturation <= 1.12, 'เกิน 1.12 แล้วผิวคนเริ่มออกส้ม');
  assert.ok(rich.saturation >= 1.0, 'ห้ามลดสีของภาพที่สีจัดอยู่แล้ว');
});

test('a single channel is never pushed into clipping on its own', () => {
  /*
   * จุดขาวคิดจากความสว่างรวม แต่ช่องแดงของภาพที่อมแดงจะสูงกว่านั้น และยังต้องคูณ
   * เกนของสมดุลแสงขาวอีกชั้น · ไม่ตรวจตรงนี้แล้วเสื้อแดงจะกลายเป็นก้อนสีตัน
   * ทั้งที่ภาพรวมดูไม่ไหม้เลย
   */
  const reddish = Array.from({ length: 100 }, (_, i) => [190 + (i % 50), 60 + (i % 50), 40 + (i % 50)]);
  const stats = from(reddish);
  const plan = planFrom(stats);

  for (let c = 0; c < 3; c += 1) {
    const peak = plan.linear.a[c] * stats.channelHigh[c] + plan.linear.b[c];
    assert.ok(peak <= 253, `ช่องที่ ${c} ไหม้: ${peak}`);
  }
});

test('a blown-out photo is handled instead of dividing by nothing', () => {
  // ทุกพิกเซลไหม้หมด = ไม่เหลือพิกเซลให้อ่านสีของแสง · ต้องไม่ได้ NaN ออกมา
  const plan = planFrom(from(flat(255)));
  for (const value of [...plan.linear.a, ...plan.linear.b, plan.saturation]) {
    assert.ok(Number.isFinite(value), `ได้ค่าที่ไม่ใช่ตัวเลข: ${value}`);
  }
});

test('an empty image never crashes the round', () => {
  const stats = measure(Buffer.alloc(0), 3);
  const plan = planFrom(stats);
  assert.equal(stats.pixels, 0);
  for (const value of [...plan.linear.a, ...plan.linear.b, plan.saturation]) {
    assert.ok(Number.isFinite(value));
  }
});

test('the whole pipeline really widens a dull photo without burning it', async () => {
  /*
   * ตัววัดกับตัวคิดค่าพิสูจน์ตัวเองได้ แต่ไม่ได้พิสูจน์ว่า sharp ทำตามที่สั่ง —
   * ข้อนี้เดินทั้งเส้นจริงแล้ววัดผลจากพิกเซลที่ออกมา
   */
  const width = 240;
  const height = 160;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i += 1) {
    // ภาพหม่น ช่วงแคบ อมเหลือง — อาการรวมของบูธที่ไฟไม่พอใต้โคมเหลือง
    const v = 70 + ((i % 60) | 0);
    pixels[i * 3] = v + 14;
    pixels[i * 3 + 1] = v + 6;
    pixels[i * 3 + 2] = v;
  }
  const dull = await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();

  const spread = async (buffer) => {
    const { data } = await sharp(buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    let low = 255;
    let high = 0;
    let burnt = 0;
    for (let i = 0; i < data.length; i += 3) {
      const y = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      low = Math.min(low, y);
      high = Math.max(high, y);
      if (data[i] >= 254 && data[i + 1] >= 254 && data[i + 2] >= 254) burnt += 1;
    }
    return { span: high - low, burnt, pixels: data.length / 3 };
  };

  const before_ = await spread(dull);
  const after_ = await spread(await applyEffect(dull, 'auto', { width, height, position: 'centre' }));

  assert.ok(after_.span > before_.span * 1.4,
    `ช่วงความสว่างต้องกว้างขึ้นจริง: ${before_.span.toFixed(1)} → ${after_.span.toFixed(1)}`);
  assert.ok(after_.burnt / after_.pixels < 0.01,
    `ไฮไลท์ไหม้ ${((after_.burnt / after_.pixels) * 100).toFixed(1)}% ของภาพ`);
});

test('a broken file falls through instead of taking the round down', async () => {
  /*
   * **ตัวแต่งอัตโนมัติที่ทำให้รอบของแขกพัง แย่กว่าการไม่มีตัวแต่งอัตโนมัติ**
   * ไฟล์ที่วัดไม่ได้ต้องผ่านไปได้ ไม่ใช่โยนออกมากลางรอบที่แขกยืนรออยู่
   */
  const out = await applyEffect(Buffer.from('ไม่ใช่รูป'), 'auto', { width: 40, height: 40 })
    .then(() => 'ผ่าน', (error) => error.message);
  assert.equal(typeof out, 'string');
});
