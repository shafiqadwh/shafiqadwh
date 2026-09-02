import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { PAGES, mmToPx, pageSize, paperSize, pxToMm } from '../src/core/paper.js';
import { SAFE_MARGIN_MM, mountOnPage, planPage } from '../src/core/mount.js';
import { lpArgs, preparePrintFile } from '../src/main/print.js';
import { normaliseSettings } from '../src/main/settings.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

/**
 * วางแผ่นขนาดสินค้าลงหน้ากระดาษจริง — เส้นทางของอิงค์เจ็ทที่ใส่ A4
 *
 * ความผิดพลาดที่ต้องกันให้ได้คือ **สินค้าออกมาไม่เท่าขนาดจริงโดยไม่มีใครสังเกต**
 * ย่อลง 3% ตาดูไม่ออก แต่ 4×6 ที่กลายเป็น 3.9×5.8 นิ้วคือของที่ขายไม่ได้
 * และ QR ที่เล็กลงตามอาจสแกนไม่ติด — สองอย่างนี้รู้ตัวก็ต่อเมื่อเอาไม้บรรทัดไปวัด
 */

const sheet = paperSize('4x6');

test('a 4x6 lands on A4 at exactly its real size, never scaled', () => {
  const page = pageSize('A4');
  const plan = planPage({ sheet, page, want: 1 });

  assert.equal(plan.slots.length, 1);
  const slot = plan.slots[0];

  // ตะแคงได้ แต่ด้านสองด้านต้องเป็นขนาดเดิมเป๊ะ ไม่มีการย่อหรือขยาย
  const sides = [slot.width, slot.height].sort((a, b) => a - b);
  assert.deepEqual(sides, [sheet.width, sheet.height].sort((a, b) => a - b),
    'ขนาดที่วางต้องเท่าแผ่นต้นฉบับทุกด้าน');

  assert.equal(Math.round(pxToMm(sheet.width)), 102, '4 นิ้ว = 102 มม.');
  assert.equal(Math.round(pxToMm(sheet.height)), 152, '6 นิ้ว = 152 มม.');
});

test('nothing is placed where an inkjet cannot print', () => {
  // หัวพิมพ์เข้าไม่ถึงขอบราว 3 มม. · วางชิดกว่านั้นแล้วไดรเวอร์จะย่อทั้งหน้าให้พอดีเอง
  // ซึ่งคือการย่อสินค้าโดยที่เราไม่ได้สั่ง
  for (const pageId of ['A4', 'A5', 'letter']) {
    const page = pageSize(pageId);
    const plan = planPage({ sheet: paperSize('4x6'), page, want: 4 });
    if (plan.slots.length === 0) continue;

    const margin = mmToPx(SAFE_MARGIN_MM);
    for (const slot of plan.slots) {
      assert.ok(slot.left >= margin, `${pageId}: ชิดขอบซ้ายเกินไป`);
      assert.ok(slot.top >= margin, `${pageId}: ชิดขอบบนเกินไป`);
      assert.ok(slot.left + slot.width <= page.width - margin, `${pageId}: ล้นขอบขวา`);
      assert.ok(slot.top + slot.height <= page.height - margin, `${pageId}: ล้นขอบล่าง`);
    }
  }
});

test('two 4x6 fit on one A4, which halves the paper and ink per print', () => {
  // เหตุผลที่ทำเรื่องนี้ตั้งแต่แรก: เดโมพิมพ์ทิ้งเยอะ และเจ้าของยังไม่ได้ซื้อ dye-sub
  const plan = planPage({ sheet, page: pageSize('A4'), want: 2 });
  assert.equal(plan.fits, 2, 'A4 ต้องใส่ 4×6 ได้สองใบ');
  assert.equal(plan.slots.length, 2);

  // และต้องไม่ทับกัน ไม่งั้นตัดออกมาแล้วใบหนึ่งแหว่ง
  const [a, b] = plan.slots;
  const overlap = a.left < b.left + b.width && b.left < a.left + a.width
    && a.top < b.top + b.height && b.top < a.top + a.height;
  assert.ok(!overlap, 'สองใบบนหน้าเดียวกันต้องไม่ทับกัน');

  // มีช่องว่างให้กรรไกรเดิน ไม่ใช่ชิดกันจนตัดคาบสองใบ
  const gapMm = pxToMm(Math.abs(b.top - (a.top + a.height)));
  assert.ok(gapMm >= 2, `ช่องตัดแคบเกินไป (${gapMm.toFixed(1)} มม.)`);
});

test('asking for more than fits reports the leftover instead of dropping it', async () => {
  const image = await sharp({
    create: { width: sheet.width, height: sheet.height, channels: 3, background: '#8899aa' },
  }).jpeg().toBuffer();

  const mounted = await mountOnPage(image, { sheet, page: 'A4', copies: 5 });
  assert.equal(mounted.placed, 2);
  assert.equal(mounted.remaining, 3, 'ที่เหลือต้องบอกกลับมา ไม่ใช่หายไปเงียบ ๆ');
  assert.equal(mounted.perPage, 2);
});

test('the mounted page really is A4 at 300 dpi', async () => {
  const image = await sharp({
    create: { width: sheet.width, height: sheet.height, channels: 3, background: '#8899aa' },
  }).jpeg().toBuffer();

  const mounted = await mountOnPage(image, { sheet, page: 'A4', copies: 1 });
  const meta = await sharp(mounted.data).metadata();

  assert.equal(meta.width, mmToPx(210));
  assert.equal(meta.height, mmToPx(297));
  assert.equal(meta.width, 2480);
  assert.equal(meta.height, 3508);
});

test('a sheet too big for the page says so instead of shrinking it', async () => {
  // 6×8 ไม่มีทางลง A5 · ต้องบอกเป็นข้อความที่คนอ่านรู้เรื่องพร้อมตัวเลขจริง
  const big = paperSize('6x8');
  const image = await sharp({
    create: { width: big.width, height: big.height, channels: 3, background: '#8899aa' },
  }).jpeg().toBuffer();

  await assert.rejects(
    () => mountOnPage(image, { sheet: big, page: 'A5', copies: 1 }),
    /ใหญ่เกิน/,
  );
});

test('mounting is refused for the size that needs no mounting', async () => {
  const image = await sharp({
    create: { width: 10, height: 10, channels: 3, background: '#fff' },
  }).jpeg().toBuffer();
  await assert.rejects(() => mountOnPage(image, { sheet, page: 'same' }), /ไม่ต้องวาง/);
});

test('the print command never lets the driver rescale a mounted page', () => {
  /*
   * `fit-to-page` ย่อภาพลงให้พอดี "พื้นที่ที่พิมพ์ได้" ซึ่งเล็กกว่าหน้ากระดาษ
   * ราว 3 มม. รอบด้าน — สินค้า 4×6 จะหดเหลือราว 3.9×5.8 นิ้วโดยไม่มีใครสังเกต
   * หน้าที่วางมาแล้วเผื่อขอบไว้เองแล้ว จึงต้องสั่งพิมพ์ที่ 100% เท่านั้น
   */
  const mounted = lpArgs({ paper: '4x6', page: 'A4', copies: 1, file: '/x.jpg' });
  assert.ok(mounted.includes('media=A4'));
  assert.ok(mounted.includes('scaling=100'));
  assert.ok(!mounted.includes('fit-to-page'), 'หน้าที่วางมาแล้วห้ามให้ไดรเวอร์ย่อซ้ำ');
  assert.ok(!mounted.some((arg) => arg.includes('Borderless')), 'อิงค์เจ็ทกระดาษธรรมดาไม่ใช่ไร้ขอบ');

  // ส่วนกระดาษที่เท่าขนาดสินค้าพอดี ยังต้องพิมพ์เต็มแผ่นไร้ขอบเหมือนเดิม
  const direct = lpArgs({ paper: '4x6', page: 'same', copies: 1, file: '/x.jpg' });
  assert.ok(direct.includes('media=4x6'));
  assert.ok(direct.includes('fit-to-page'));
  assert.ok(direct.includes('StpBorderless=True'));
});

test('every page size is a real size, and "same" means no page at all', () => {
  assert.equal(pageSize('same'), null, '"เท่าขนาดสินค้า" ไม่มีหน้ารองรับ');
  assert.equal(pageSize('ไม่มีขนาดนี้'), null, 'ค่าที่ไม่รู้จักตกกลับไปที่ same');

  for (const [id, page] of Object.entries(PAGES)) {
    if (id === 'same') continue;
    const size = pageSize(id);
    assert.ok(size.width > 0 && size.height > 0, `${id} ขนาดไม่ถูกต้อง`);
    assert.equal(size.width, mmToPx(page.widthMm));
  }
});

// ── เตรียมไฟล์สำหรับพิมพ์ (จุดที่ผิดแล้วกระดาษเสียทุกใบ) ────────────────────

const work = await fs.mkdtemp(path.join(os.tmpdir(), 'mount-test-'));
after(() => fs.rm(work, { recursive: true, force: true }));

async function sessionDir(name) {
  const dir = path.join(work, name);
  await fs.mkdir(dir, { recursive: true });
  const sheetPath = path.join(dir, 'sheet.jpg');
  await fs.writeFile(sheetPath, await sharp({
    create: { width: sheet.width, height: sheet.height, channels: 3, background: '#8899aa' },
  }).jpeg().toBuffer());
  return { dir, sheetPath };
}

test('a dye-sub job sends the product sheet straight through, untouched', async () => {
  const { dir, sheetPath } = await sessionDir('direct');
  const prepared = await preparePrintFile({
    dir, sheetPath, settings: normaliseSettings({ printPage: 'same', copies: 2 }),
  });

  assert.equal(prepared.path, sheetPath, 'ต้องไม่สร้างไฟล์กลางโดยไม่จำเป็น');
  assert.equal(prepared.pages, 2);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['sheet.jpg']);
});

test('an A4 job writes a separate page file and never overwrites the guest sheet', async () => {
  /*
   * `sheet.jpg` คือของที่จะอัปโหลดให้แขกโหลด · `page.jpg` เป็นเรื่องของเครื่องพิมพ์
   * ทับกันเมื่อไร แขกจะได้ไฟล์ที่มีขอบขาว เส้นตัด และรูปตะแคงติดไปด้วย
   */
  const { dir, sheetPath } = await sessionDir('a4');
  const before = await fs.readFile(sheetPath);

  const prepared = await preparePrintFile({
    dir, sheetPath, settings: normaliseSettings({ printPage: 'A4', copies: 2 }),
  });

  assert.equal(path.basename(prepared.path), 'page.jpg');
  assert.equal(prepared.perPage, 2);
  assert.equal(prepared.pages, 1, 'สองใบลงหน้าเดียวได้ จึงสั่งพิมพ์หน้าเดียว');

  const meta = await sharp(prepared.path).metadata();
  assert.equal(meta.width, 2480);
  assert.equal(meta.height, 3508);

  assert.deepEqual(await fs.readFile(sheetPath), before, 'แผ่นของแขกต้องไม่ถูกแตะเลย');
});

test('more copies than fit on one page means more pages, not lost prints', async () => {
  const { dir, sheetPath } = await sessionDir('many');
  const prepared = await preparePrintFile({
    dir, sheetPath, settings: normaliseSettings({ printPage: 'A4', copies: 4 }),
  });
  assert.equal(prepared.pages, 2, '4 ใบ ÷ 2 ใบต่อหน้า = 2 หน้า');
});
