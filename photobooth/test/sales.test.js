import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { recordSale, takings } from '../src/main/sales.js';

/**
 * สมุดบัญชีของบูธ — ตัวเลขที่เจ้าของเชื่อตอนเก็บบูธ
 *
 * ทั้งไฟล์นี้ว่าด้วยเรื่องเดียว: **ตัวเลขบนจอต้องตรงกับเงินที่รับมาจริง**
 * ตัวเลขที่ผิดแบบเงียบ ๆ แย่กว่าตัวเลขที่หายไปทั้งก้อน เพราะไม่มีอะไรบอกให้รู้ตัว
 */

const dirs = [];
const fresh = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sales-'));
  dirs.push(dir);
  return dir;
};

after(async () => {
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** เวลาตามนาฬิกาที่คนหน้าบูธมองอยู่ · ต้องกำหนดเอง ไม่ใช่เวลาจริงตอนรันเทสต์ */
const at = (day, hour, minute = 0) => new Date(2026, 8, day, hour, minute, 0, 0);

test('a booth that runs past midnight keeps counting the same shift', async () => {
  /*
   * งานปัจฉิม ม.6 เลิกหลังเที่ยงคืน — นับตามวันปฏิทินแล้วตัวเลขบนจอรีเซ็ตเป็นศูนย์
   * ทั้งที่บูธยังเปิดอยู่ · วัดก่อนแก้: รับไป 150 บาท จอโชว์ 50 แล้วเจ้าของก็เก็บ
   * บูธกลับบ้านโดยเชื่อตัวเลขนั้น
   */
  const dir = await fresh();
  await recordSale(dir, { token: 'AAA111', amount: 50, when: at(3, 19, 30) });
  await recordSale(dir, { token: 'BBB222', amount: 50, when: at(3, 23, 50) });
  await recordSale(dir, { token: 'CCC333', amount: 50, when: at(4, 0, 15) });

  const shift = await takings(dir, at(4, 0, 30));
  assert.equal(shift.rounds, 3, 'สามรอบของคืนเดียวกันต้องนับรวมกัน');
  assert.equal(shift.total, 150);

  // และไฟล์ยังแยกตามวันปฏิทินเหมือนเดิม — นั่นคือบันทึกสำหรับกระทบยอดย้อนหลัง
  assert.deepEqual(
    (await fs.readdir(path.join(dir, 'sales'))).sort(),
    ['2026-09-03.ndjson', '2026-09-04.ndjson'],
  );
});

test('yesterday takings do not follow you into tonight', async () => {
  const dir = await fresh();
  await recordSale(dir, { token: 'OLD001', amount: 300, when: at(3, 13, 0) });
  await recordSale(dir, { token: 'NEW001', amount: 50, when: at(3, 19, 30) });

  // กะกลางวันจบไปแล้วหกชั่วโมงกว่า — ยอดคืนนี้ต้องเริ่มนับใหม่ ไม่ใช่ต่อจากตอนบ่าย
  const tonight = await takings(dir, at(3, 20, 0));
  assert.equal(tonight.rounds, 1);
  assert.equal(tonight.total, 50);

  // เปิดบูธวันถัดไปแล้วยังไม่มีใครจ่าย ต้องขึ้น 0 ไม่ใช่ยอดที่ค้างอยู่ในไฟล์
  assert.deepEqual(await takings(dir, at(4, 19, 0)), {
    day: '2026-09-04', rounds: 0, free: 0, total: 0,
  });
});

test('a line torn off by a power cut only costs its own line', async () => {
  /*
   * บูธรันด้วยแบตเตอรี่ · ไฟดับกลางเขียนทิ้งบรรทัดที่ไม่มี `\n` ปิดท้ายไว้
   * แล้วรอบถัดไปไปเกาะอยู่บรรทัดเดียวกับเศษนั้น — **การขายรอบใหม่หายไปด้วย**
   * ทั้งที่มันเขียนสำเร็จ · วัดก่อนแก้: จด 3 รอบ อ่านกลับได้ 2 เงินหายหนึ่งรอบเงียบ ๆ
   */
  const dir = await fresh();
  await recordSale(dir, { token: 'AAA111', amount: 50, when: at(4, 19, 0) });

  const file = path.join(dir, 'sales', '2026-09-04.ndjson');
  await fs.appendFile(file, '{"at":"2026-09-04T12:0');   // ไฟดับตรงนี้

  await recordSale(dir, { token: 'BBB222', amount: 50, when: at(4, 19, 5) });

  const shift = await takings(dir, at(4, 19, 10));
  assert.equal(shift.rounds, 2, 'รอบที่เขียนหลังไฟดับต้องยังอยู่');
  assert.equal(shift.total, 100);
});

test('a free round counts as a round but never as money', async () => {
  const dir = await fresh();
  await recordSale(dir, { token: 'AAA111', amount: 50, when: at(4, 19, 0) });
  // ส่งราคามาด้วยแต่สั่งฟรี — ต้องจดเป็นศูนย์ ไม่ใช่เชื่อ amount ที่ส่งมา
  await recordSale(dir, { token: 'BBB222', amount: 50, free: true, when: at(4, 19, 5) });

  const shift = await takings(dir, at(4, 19, 10));
  // จำนวนรอบต้องตรงกับกระดาษที่หายไปจริง ส่วนเงินต้องตรงกับที่รับมาจริง
  assert.equal(shift.rounds, 2);
  assert.equal(shift.free, 1);
  assert.equal(shift.total, 50);
});
