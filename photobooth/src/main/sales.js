import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * สมุดบัญชีของบูธ — หนึ่งบรรทัดต่อหนึ่งรอบที่ส่งมอบไป
 *
 * มีไว้ตอบคำถามเดียวตอนเก็บบูธ: **วันนี้ได้เท่าไร กี่รอบ** แล้วเอาไปกระทบยอดกับ
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
  await fs.appendFile(file, `${JSON.stringify(row)}\n`);
  return row;
}

/**
 * ยอดของวันหนึ่ง — จำนวนรอบ จำนวนรอบฟรี และเงินรวม
 *
 * ยังไม่มีไฟล์ = ยังไม่ได้ขายอะไรวันนี้ ซึ่งเป็นสภาพปกติตอนเปิดบูธ ไม่ใช่ error
 */
export async function takings(dir, day = dayOf()) {
  let text;
  try {
    text = await fs.readFile(fileFor(dir, day), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[sales] อ่านสมุดบัญชีไม่ได้:', error.message);
    return { day, rounds: 0, free: 0, total: 0 };
  }

  const summary = { day, rounds: 0, free: 0, total: 0 };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      summary.rounds += 1;
      if (row.free) summary.free += 1;
      else summary.total += Number(row.amount) || 0;
    } catch {
      // บรรทัดที่เขียนไม่จบเพราะไฟดับ — ข้ามไป ยอดที่เหลือยังใช้ได้
    }
  }
  summary.total = Math.round(summary.total * 100) / 100;
  return summary;
}
