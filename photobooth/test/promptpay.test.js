import assert from 'node:assert/strict';
import test from 'node:test';
import {
  crc16, parsePayload, payTarget, payloadValid, promptPayPayload,
} from '../src/core/promptpay.js';

/**
 * QR พร้อมเพย์ที่แอปธนาคารต้องสแกนได้จริง
 *
 * ไฟล์นี้ตรวจได้แค่ว่า "สตริงถูกต้องตามมาตรฐาน" — **ตัวตัดสินจริงคือเจ้าของบูธ
 * สแกนด้วยแอปธนาคารของตัวเองหนึ่งครั้งก่อนเปิดขายจริง** และดูว่าขึ้นชื่อบัญชี
 * ตัวเองกับยอดที่ถูกต้อง · ผมสแกนแทนไม่ได้ และจะไม่อ้างว่าตรวจข้อนี้ให้แล้ว
 */

test('the checksum matches the published check value for this algorithm', () => {
  // CRC-16/CCITT-FALSE มีค่าตรวจมาตรฐานอยู่หนึ่งค่า: CRC ของ "123456789" = 0x29B1
  // ผิดตัวเดียวคือ QR ที่ทุกแอปปฏิเสธ จึงยึดค่าที่เผยแพร่ไว้ ไม่ใช่ค่าที่โค้ดเราคืนมาเอง
  assert.equal(crc16('123456789'), '29B1');
  assert.equal(crc16(''), 'FFFF');
});

test('a phone number is accepted however the owner types it', () => {
  const expected = { tag: '01', value: '0066812345678' };
  for (const written of ['0812345678', '081-234-5678', '081 234 5678', '+66812345678', '0066812345678']) {
    assert.deepEqual(payTarget(written), expected, `พิมพ์แบบ "${written}" ต้องได้เบอร์เดียวกัน`);
  }

  // เลขบัตรประชาชน 13 หลัก กับ e-Wallet 15 หลัก ใช้คนละแท็กกัน
  assert.deepEqual(payTarget('1234567890123'), { tag: '02', value: '1234567890123' });
  assert.deepEqual(payTarget('123456789012345'), { tag: '03', value: '123456789012345' });

  // พิมพ์ผิด = เงินเข้าบัญชีคนอื่น · ต้องปฏิเสธ ไม่ใช่เดาให้
  for (const bad of ['', '081234567', '08123456789', 'ไม่ใช่เบอร์', null, undefined, '12345678901234']) {
    assert.equal(payTarget(bad), null, `ต้องปฏิเสธ ${JSON.stringify(bad)}`);
  }
});

test('the payload is laid out exactly the way the standard describes', () => {
  const payload = promptPayPayload({ target: '0812345678', amount: 150 });
  const parsed = parsePayload(payload);

  assert.ok(parsed, 'ความยาวที่นับไว้ต้องตรงกับของจริงทุกช่อง');
  assert.equal(parsed['00'], '01', 'รุ่นของรูปแบบ');
  assert.equal(parsed['01'], '12', 'มีจำนวนเงิน = ใช้ครั้งเดียว');
  assert.equal(parsed['53'], '764', 'สกุลเงินบาท');
  assert.equal(parsed['54'], '150.00', 'จำนวนเงินสองตำแหน่งเสมอ');
  assert.equal(parsed['58'], 'TH');

  // ข้อมูลผู้รับเป็นชุดซ้อนอีกชั้น — ต้องมี AID ของพร้อมเพย์และเบอร์ที่จัดรูปแล้ว
  const merchant = parsePayload(parsed['29']);
  assert.equal(merchant['00'], 'A000000677010111');
  assert.equal(merchant['01'], '0066812345678');

  assert.ok(payloadValid(payload), 'CRC ต้องตรวจผ่านกับตัวมันเอง');
  assert.match(payload, /^000201/, 'ต้องขึ้นต้นตามมาตรฐาน');
  assert.match(payload, /6304[0-9A-F]{4}$/, 'ต้องปิดท้ายด้วย CRC สี่ตัวพิมพ์ใหญ่');
});

test('a QR without a price is a reusable one, with a price it is single use', () => {
  const open = parsePayload(promptPayPayload({ target: '0812345678' }));
  assert.equal(open['01'], '11', 'ไม่มียอด = สแกนซ้ำได้');
  assert.equal(open['54'], undefined, 'ไม่มียอดต้องไม่มีช่องจำนวนเงินเลย');

  const priced = parsePayload(promptPayPayload({ target: '0812345678', amount: 99.5 }));
  assert.equal(priced['54'], '99.50');
});

test('one changed character breaks the checksum, which is the whole point of it', () => {
  const payload = promptPayPayload({ target: '0812345678', amount: 100 });

  // เปลี่ยนยอดจาก 100.00 เป็น 900.00 โดยไม่แก้ CRC — แอปธนาคารต้องปฏิเสธ
  const tampered = payload.replace('54061 00.00'.replace(' ', ''), '5406900.00');
  assert.notEqual(tampered, payload, 'ต้องแก้ได้จริง ไม่งั้นเทสต์ข้อนี้ไม่ได้ทดสอบอะไร');
  assert.equal(payloadValid(tampered), false);
});

test('a booth with no payment details set produces no QR at all', () => {
  // ตั้งค่าไม่ครบต้องได้ null แล้วบูธข้ามขั้นจ่ายเงินไป — ไม่ใช่ QR ที่สแกนแล้ว
  // ขึ้นบัญชีมั่ว ๆ หรือขึ้น error ตอนแขกยืนรออยู่
  assert.equal(promptPayPayload({ target: '', amount: 100 }), null);
  assert.equal(promptPayPayload({ target: 'พร้อมเพย์', amount: 100 }), null);
  assert.equal(promptPayPayload({}), null);
});
