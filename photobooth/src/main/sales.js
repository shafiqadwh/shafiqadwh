import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * สมุดบัญชีของบูธ — หนึ่งบรรทัดต่อหนึ่งรอบที่ส่งมอบไป
 *
 * มีไว้ตอบคำถามเดียวตอนเก็บบูธ: **กะนี้ได้เท่าไร กี่รอบ** แล้วเอาไปกระทบยอดกับ
 * แอปธนาคารได้ · โปรแกรมไม่มีทางรู้ว่าเงินเข้าจริงไหม (ดู core/promptpay.js)
 * สิ่งที่จดไว้จึงเป็น "คนกดยืนยันว่าได้รับแล้ว" ไม่ใช่ "ธนาคารแจ้งว่าเงินเข้า" —
 * เขียนให้ตรงตามนั้น จะได้ไม่หลงคิดว่าตัวเลขนี้เป็นยอดที่ธนาคารรับรอง
 *
 * เขียนแบบต่อท้ายทีละบรรทัด ไม่ใช่อ่านมาทั้งไฟล์แล้วเขียนทับ — บูธรันด้วย
 * แบตเตอรี่ในเต็นท์ ไฟดับกลางเขียนทับคือเสียยอดทั้งวัน ส่วนต่อท้ายเสียได้
 * อย่างมากคือบรรทัดสุดท้ายบรรทัดเดียว และบรรทัดที่อ่านไม่ออกถูกข้ามไปเฉย ๆ
 */

const dayOf = (when = new Date()) => {
  // เวลาท้องถิ่นของเครื่อง ไม่ใช่ UTC — "ยอดวันนี้" ของคนขายคือวันตามนาฬิกาที่เขาดู
  const pad = (n) => String(n).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
};

const fileFor = (dir, day) => path.join(dir, 'sales', `${day}.ndjson`);

/**
 * จดหนึ่งรอบ · `free = true` คือรอบที่ไม่คิดเงิน (ถ่ายซ้อม เพื่อน แก้ให้ลูกค้า)
 *
 * รอบฟรีต้องอยู่ในสมุดด้วย ไม่ใช่หายไปเฉย ๆ — ไม่งั้นจำนวนแผ่นที่พิมพ์กับจำนวน
 * รอบที่เก็บเงินจะไม่ตรงกัน แล้วตอนนับกระดาษที่เหลือจะงงว่าหายไปไหน
 */
export async function recordSale(dir, { token, amount = 0, free = false, when = new Date() } = {}) {
  const row = {
    at: when.toISOString(),
    token: String(token ?? ''),
    amount: free ? 0 : Math.round(Number(amount) * 100) / 100,
    free: Boolean(free),
  };
  const file = fileFor(dir, dayOf(when));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${await needsNewline(file) ? '\n' : ''}${JSON.stringify(row)}\n`);
  return row;
}

/**
 * ไฟล์จบด้วยบรรทัดที่เขียนไม่จบอยู่หรือเปล่า
 *
 * ไฟดับกลางเขียนทำให้บรรทัดสุดท้ายขาด **และไม่มี `\n` ปิดท้าย** · รอบถัดไปที่
 * ต่อท้ายเข้าไปจะไปเกาะอยู่บรรทัดเดียวกับเศษนั้น กลายเป็นบรรทัดที่อ่านไม่ออก
 * แล้ว **การขายรอบใหม่ก็หายไปด้วย** ทั้งที่มันเขียนสำเร็จ
 * (วัดแล้วเจอจริง: จด 3 รอบ อ่านกลับได้ 2 รอบ เงินหายไปหนึ่งรอบเงียบ ๆ)
 *
 * ขึ้นบรรทัดใหม่ให้ก่อน — เศษที่ขาดก็เสียแค่บรรทัดของมันเอง ตามที่ตั้งใจไว้แต่แรก
 */
async function needsNewline(file) {
  try {
    const { size } = await fs.stat(file);
    if (size === 0) return false;
    const handle = await fs.open(file, 'r');
    try {
      const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
      return buffer[0] !== 0x0a;
    } finally {
      await handle.close();
    }
  } catch {
    return false;   // ยังไม่มีไฟล์ = ไม่ต้องขึ้นบรรทัดใหม่
  }
}

/**
 * ยอดของ **กะนี้** — ไม่ใช่ของวันตามปฏิทิน
 *
 * บูธเลิกดึกข้ามเที่ยงคืนเป็นเรื่องปกติ (งานปัจฉิม งานวัด งานแต่งตอนเย็น)
 * ถ้านับตามวันปฏิทิน ตัวเลขบนจอจะรีเซ็ตเป็นศูนย์ตอนเที่ยงคืนทั้งที่บูธยังเปิดอยู่
 * — **วัดแล้วเจอจริง: บูธเปิด 19:00–00:30 รับไป 150 บาท จอโชว์ 50 บาท**
 * แล้วเจ้าของก็เก็บบูธกลับบ้านโดยเชื่อตัวเลขนั้น
 *
 * "กะนี้" = ไล่ย้อนจากตอนนี้ไปเรื่อย ๆ จนเจอ **ช่องว่างเกิน 6 ชั่วโมง**
 * ซึ่งตรงกับที่คนหมายถึงจริง ๆ · หน้าต่างเวลาตายตัวใช้ไม่ได้: กว้างพอจะครอบ
 * งานเลิกดึกก็กว้างจนไปกินยอดกะกลางวันของเมื่อวานด้วย (ลองแล้ว 18 ชม. เจอปัญหานี้)
 *
 * กฎเดียวใช้กับ "ตอนนี้" ด้วย — เปิดบูธวันใหม่แล้วยังไม่มีใครจ่าย จอต้องขึ้น 0
 * ไม่ใช่ยอดของเมื่อวานที่ยังค้างอยู่ในไฟล์
 *
 * ไฟล์ยังแยกตามวันปฏิทินเหมือนเดิม — นั่นคือบันทึกสำหรับกระทบยอดย้อนหลัง
 * ส่วนตัวเลขนี้คือสิ่งที่คนหน้าบูธต้องการรู้ตอนนี้ คนละคำถามกัน
 */
const SHIFT_GAP_MS = 6 * 60 * 60 * 1000;

export async function takings(dir, now = new Date()) {
  const rows = [];
  // อ่านสองวัน — กะที่ข้ามเที่ยงคืนมีบรรทัดอยู่คนละไฟล์
  for (const day of [dayOf(new Date(now.getTime() - 86400000)), dayOf(now)]) {
    let text;
    try {
      text = await fs.readFile(fileFor(dir, day), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('[sales] อ่านสมุดบัญชีไม่ได้:', error.message);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      // บรรทัดที่เขียนไม่จบเพราะไฟดับ — ข้ามไป ยอดที่เหลือยังใช้ได้
      try {
        const row = JSON.parse(line);
        if (Number.isFinite(Date.parse(row.at))) rows.push(row);
      } catch { /* ข้าม */ }
    }
  }

  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  const summary = { day: dayOf(now), rounds: 0, free: 0, total: 0 };
  let next = now.getTime();
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const at = Date.parse(rows[i].at);
    if (next - at > SHIFT_GAP_MS) break;
    next = at;
    summary.rounds += 1;
    if (rows[i].free) summary.free += 1;
    else summary.total += Number(rows[i].amount) || 0;
  }
  summary.total = Math.round(summary.total * 100) / 100;
  return summary;
}
