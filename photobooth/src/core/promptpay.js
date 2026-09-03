/**
 * QR พร้อมเพย์ — สร้างเองบนเครื่อง ไม่ต้องต่อเน็ต ไม่ต้องมี API ของธนาคาร
 *
 * QR ที่แอปธนาคารไทยสแกนได้เป็นสตริงตามมาตรฐาน EMVCo (EMV QRCPS) ซึ่งเป็นแค่
 * การเรียงข้อมูลแบบ <รหัส><ความยาว 2 หลัก><ค่า> ต่อกัน แล้วปิดท้ายด้วย CRC —
 * **คำนวณได้ครบทั้งหมดในเครื่อง** จึงใช้ได้ในเต็นท์ที่ไม่มีสัญญาณ ซึ่งเป็นที่ที่
 * บูธนี้ตั้งอยู่จริง
 *
 * ⚠️ **สิ่งที่ไฟล์นี้ทำไม่ได้ และไม่มีทางทำได้: บอกว่าเงินเข้าแล้วหรือยัง**
 * การยืนยันว่าจ่ายจริงต้องดูจากแอปธนาคารของเจ้าของบูธเท่านั้น (หรือต่อ API ของ
 * ธนาคาร/ผู้ให้บริการชำระเงิน ซึ่งเป็นคนละเรื่องและต้องสมัครแยก) · โปรแกรมจึงต้อง
 * ให้ **คนกดยืนยัน** เสมอ ห้ามเดาจากการที่ QR ถูกแสดงไปแล้ว
 */

const AID = 'A000000677010111';

/** <รหัส><ความยาวสองหลัก><ค่า> — หน่วยเดียวของทั้งมาตรฐานนี้ */
const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/**
 * CRC-16/CCITT-FALSE — poly 0x1021, ตั้งต้น 0xFFFF, ไม่กลับบิต ไม่ xor ตอนจบ
 *
 * ผิดตัวเดียวคือ QR ที่แอปธนาคารทุกแอปปฏิเสธ · ค่าตรวจมาตรฐานของอัลกอริทึมนี้คือ
 * CRC ของ "123456789" ต้องได้ 0x29B1 — เทสต์ยึดค่านั้นไว้
 */
export function crc16(input) {
  let crc = 0xffff;
  for (const char of String(input)) {
    crc ^= (char.charCodeAt(0) & 0xff) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * เบอร์/เลขบัตร/e-Wallet ที่รับเงิน → รูปแบบที่มาตรฐานต้องการ
 *
 * รับได้หลายหน้าตาเพราะคนพิมพ์เบอร์ตัวเองไม่เหมือนกัน: `081-234-5678`,
 * `0812345678`, `+66812345678` คือเบอร์เดียวกันทั้งหมด · พิมพ์ผิดคือเงินเข้า
 * บัญชีคนอื่น จึงคืน null เมื่อไม่เข้ารูปแบบไหนเลย แทนที่จะเดาให้
 */
export function payTarget(value) {
  const digits = String(value ?? '').replace(/\D/g, '');

  // เบอร์มือถือ — มาตรฐานเก็บเป็น 0066 ตามด้วยเบอร์ที่ตัด 0 นำหน้าออก
  if (digits.length === 13 && digits.startsWith('0066')) return { tag: '01', value: digits };
  if (digits.length === 11 && digits.startsWith('66')) return { tag: '01', value: `00${digits}` };
  if (digits.length === 10 && digits.startsWith('0')) return { tag: '01', value: `0066${digits.slice(1)}` };

  // เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก · เบอร์ที่จัดรูปแล้วถูกจับไปข้างบนแล้ว
  if (digits.length === 13) return { tag: '02', value: digits };
  // e-Wallet 15 หลัก (TrueMoney ฯลฯ)
  if (digits.length === 15) return { tag: '03', value: digits };

  return null;
}

/** ราคาที่ใส่ลง QR ได้จริง — บาท ทศนิยมไม่เกินสองตำแหน่ง */
export const isPrice = (value) =>
  Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= 100000;

/**
 * สตริงที่จะเอาไปทำเป็น QR
 *
 * ระบุจำนวนเงินไว้ในตัว QR เลย แขกจึงไม่ต้องพิมพ์ยอดเอง (พิมพ์ผิดคือได้เงินไม่ครบ
 * หรือเกิน แล้วต้องมานั่งทอน) · ตอนมีจำนวนเงินใช้รหัส 12 = "ใช้ครั้งเดียว"
 * ตอนไม่มีใช้ 11 = "สแกนซ้ำได้" ตามที่มาตรฐานกำหนด
 *
 * ไม่ใส่หมายเลขอ้างอิง (แท็ก 62) โดยตั้งใจ — การโอนพร้อมเพย์แบบบุคคลไม่ได้ส่ง
 * ค่านั้นกลับมาให้ผู้รับเสมอ ใส่ไปก็เท่ากับสัญญาสิ่งที่ตรวจสอบไม่ได้ ·
 * การกระทบยอดใช้ "เวลา + จำนวนเงิน" จากบันทึกการขาย ซึ่งตรงกับสลิปในแอปธนาคาร
 */
export function promptPayPayload({ target, amount = 0 } = {}) {
  const to = payTarget(target);
  if (!to) return null;

  /*
   * ลำดับช่อง: ประเทศ (58) มาก่อนสกุลเงิน (53) และจำนวนเงิน (54)
   *
   * มาตรฐานบังคับแค่ว่า CRC ต้องอยู่ท้ายสุด ที่เหลืออ่านจากรหัสไม่ใช่จากตำแหน่ง
   * — แต่ QR พร้อมเพย์ที่หมุนเวียนอยู่ในไทยส่วนใหญ่เรียงแบบนี้ และแอปธนาคาร
   * ทุกแอปสแกนของกันเองมาหลายปีแล้ว · เมื่อเลือกไม่ได้ด้วยเหตุผลทางเทคนิค
   * ก็เลือกรูปแบบที่ถูกใช้งานจริงมากที่สุด
   */
  const priced = isPrice(amount);
  const body = [
    field('00', '01'),
    field('01', priced ? '12' : '11'),
    field('29', field('00', AID) + field(to.tag, to.value)),
    field('58', 'TH'),
    field('53', '764'),
    ...(priced ? [field('54', Number(amount).toFixed(2))] : []),
  ].join('');

  // CRC คิดรวม "6304" ที่เป็นหัวของตัวมันเองด้วย ตามที่มาตรฐานกำหนด
  const withTag = `${body}6304`;
  return withTag + crc16(withTag);
}

/**
 * แกะสตริงกลับเป็นคู่ <รหัส, ค่า> — มีไว้ให้เทสต์ตรวจว่าเรียงถูก
 *
 * ตัวอ่านที่เขียนแยกจากตัวเขียนคือวิธีเดียวที่จะรู้ว่าความยาวที่นับไว้ตรงกับของจริง
 * (นับผิดหนึ่งตัว = สตริงที่ยังดูเหมือนใช้ได้ แต่ทุกแอปปฏิเสธ)
 */
export function parsePayload(payload) {
  const out = {};
  let i = 0;
  while (i + 4 <= payload.length) {
    const id = payload.slice(i, i + 2);
    const length = Number(payload.slice(i + 2, i + 4));
    if (!Number.isInteger(length)) return null;
    const value = payload.slice(i + 4, i + 4 + length);
    if (value.length !== length) return null;
    out[id] = value;
    i += 4 + length;
  }
  return i === payload.length ? out : null;
}

/** QR ใบนี้ยังไม่ถูกแก้ระหว่างทางใช่ไหม — ใช้ตรวจของที่เราสร้างเอง */
export function payloadValid(payload) {
  if (typeof payload !== 'string' || payload.length < 8) return false;
  const body = payload.slice(0, -4);
  return body.endsWith('6304') && crc16(body) === payload.slice(-4);
}
