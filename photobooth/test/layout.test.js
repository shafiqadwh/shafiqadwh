import assert from 'node:assert/strict';
import test from 'node:test';
import { PAPERS, paperSize } from '../src/core/paper.js';
import { TEMPLATE_IDS, layoutFor, shotsFor } from '../src/core/templates.js';

/**
 * ผังบนกระดาษ — ของที่ผิดตรงนี้รู้ตัวตอนกระดาษออกจากเครื่องพิมพ์ไปแล้ว
 *
 * dye-sub ย้อนกลับไม่ได้ ทุกแผ่นที่ผิดคือกระดาษกับหมึกที่เสียไปจริง ๆ และหน้างาน
 * มีแขกยืนรออยู่ · เทสต์ชุดนี้จึงไล่ทุกแบบคูณทุกขนาดกระดาษ ไม่ใช่ตรวจแค่ 4×6
 */

const overlap = (a, b) =>
  a.left < b.left + b.width && b.left < a.left + a.width
  && a.top < b.top + b.height && b.top < a.top + a.height;

test('every template on every paper stays inside the page', () => {
  for (const paperId of Object.keys(PAPERS)) {
    for (const templateId of TEMPLATE_IDS) {
      const layout = layoutFor(templateId, paperId);
      const page = paperSize(paperId);

      assert.equal(layout.width, page.width, `${templateId}/${paperId} กว้างไม่ตรงกระดาษ`);
      assert.equal(layout.height, page.height, `${templateId}/${paperId} สูงไม่ตรงกระดาษ`);

      for (const box of [...layout.slots, ...layout.footers]) {
        assert.ok(box.left >= 0 && box.top >= 0,
          `${templateId}/${paperId} มีกล่องเริ่มนอกหน้ากระดาษ`);
        assert.ok(box.left + box.width <= layout.width,
          `${templateId}/${paperId} มีกล่องล้นขอบขวา (${box.left + box.width} > ${layout.width})`);
        assert.ok(box.top + box.height <= layout.height,
          `${templateId}/${paperId} มีกล่องล้นขอบล่าง (${box.top + box.height} > ${layout.height})`);
        assert.ok(box.width > 0 && box.height > 0,
          `${templateId}/${paperId} มีกล่องขนาดติดลบหรือศูนย์`);
      }
    }
  }
});

test('nothing on the sheet is drawn on top of anything else', () => {
  // รูปทับรูป หรือชื่องานทับรูป เป็นของที่มองข้ามง่ายมากตอนแก้ตัวเลขสัดส่วน
  // เพราะแบบอื่นยังดูดีอยู่ — ตรวจทุกคู่ ไม่ใช่ดูด้วยตาทีละแบบ
  for (const paperId of Object.keys(PAPERS)) {
    for (const templateId of TEMPLATE_IDS) {
      const layout = layoutFor(templateId, paperId);
      const boxes = [...layout.slots, ...layout.footers];
      for (let i = 0; i < boxes.length; i += 1) {
        for (let j = i + 1; j < boxes.length; j += 1) {
          assert.ok(!overlap(boxes[i], boxes[j]),
            `${templateId}/${paperId}: กล่อง ${i} กับ ${j} ทับกัน`);
        }
      }
    }
  }
});

test('each template asks for the number of shots it actually places', () => {
  for (const templateId of TEMPLATE_IDS) {
    const layout = layoutFor(templateId, '4x6');
    const used = new Set(layout.slots.map((slot) => slot.shot));
    assert.equal(used.size, shotsFor(templateId),
      `${templateId} บอกว่าต้องถ่าย ${shotsFor(templateId)} ใบ แต่ผังใช้จริง ${used.size} ใบ`);

    // ดัชนีรูปต้องเป็น 0..n-1 ติดกัน ไม่ใช่ข้ามเลข — ไม่งั้นจะไปหยิบรูปที่ไม่มี
    for (let i = 0; i < used.size; i += 1) {
      assert.ok(used.has(i), `${templateId} ข้ามรูปใบที่ ${i}`);
    }
  }
});

test('the strip really is two identical copies, with a line to cut between them', () => {
  // ที่มาของแบบนี้: แถบหนึ่งแปะสมุดอวยพรของเจ้าภาพ อีกแถบแขกเอากลับบ้าน
  // ถ้าสองแถบไม่เหมือนกัน หรือไม่มีเส้นตัด แบบนี้ก็ไม่ได้ทำหน้าที่ของมัน
  const layout = layoutFor('strip', '4x6');
  assert.equal(layout.slots.length, 6, 'สามรูป สองสำเนา = หกช่อง');
  assert.equal(layout.footers.length, 2, 'แต่ละแถบต้องมีชื่องานกับ QR ของตัวเอง');
  assert.equal(layout.cuts.length, 1, 'ต้องมีเส้นตัดกลางแผ่น');
  assert.equal(layout.cuts[0].x, Math.round(layout.width / 2));

  const [left, right] = [layout.slots.slice(0, 3), layout.slots.slice(3)];
  for (let i = 0; i < 3; i += 1) {
    assert.equal(left[i].shot, right[i].shot, 'สองแถบต้องใช้รูปชุดเดียวกันเรียงเหมือนกัน');
    assert.equal(left[i].width, right[i].width);
    assert.equal(left[i].height, right[i].height);
    assert.equal(left[i].top, right[i].top, 'สองแถบต้องอยู่ระดับเดียวกัน ตัดแล้วจะได้เท่ากัน');
  }
});

test('an unknown paper or template falls back instead of throwing', () => {
  // หน้างานกระดาษหมดแล้วสลับม้วน หรือค่าใน config พิมพ์ผิด — ต้องพิมพ์ต่อได้
  // ไม่ใช่แอปค้างกลางงานที่มีคนต่อแถวอยู่
  const layout = layoutFor('ไม่มีแบบนี้', 'ไม่มีขนาดนี้');
  assert.equal(layout.width, paperSize('4x6').width);
  assert.equal(layout.slots.length, 1);
});

test('landscape swaps the page without needing a second set of papers', () => {
  const portrait = paperSize('4x6');
  const landscape = paperSize('4x6', { landscape: true });
  assert.equal(landscape.width, portrait.height);
  assert.equal(landscape.height, portrait.width);
});

test('4x6 at 300 dpi is exactly 1200x1800, because printers take pixels', () => {
  const page = paperSize('4x6');
  assert.equal(page.width, 1200);
  assert.equal(page.height, 1800);
});
