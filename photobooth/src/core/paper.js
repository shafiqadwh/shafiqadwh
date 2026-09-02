/**
 * ขนาดกระดาษกับการแปลงนิ้ว → พิกเซล
 *
 * เครื่องพิมพ์ dye-sub รับงานเป็นพิกเซลตรง ๆ ที่ 300 dpi · ตัวเลขทุกตัวใน
 * `templates.js` จึงเป็นพิกเซลจริงบนกระดาษ ไม่ใช่สัดส่วนที่ต้องมาคูณทีหลัง
 * — เผลอคิดเป็นสัดส่วนเมื่อไร ขอบขาวจะไม่เท่ากันบนกระดาษคนละขนาด
 *
 * ห้ามลดต่ำกว่า 300 dpi: ที่ 200 dpi ตัวอักษรชื่องานเริ่มเห็นขอบหยัก และ QR
 * เริ่มสแกนไม่ติดจากระยะมือถือปกติ (โมดูลเล็กกว่าที่กล้องแยกออก)
 */
export const DPI = 300;

export const PAPERS = Object.freeze({
  '4x6': { id: '4x6', widthIn: 4, heightIn: 6, label: '4×6 นิ้ว (มาตรฐาน)' },
  '5x7': { id: '5x7', widthIn: 5, heightIn: 7, label: '5×7 นิ้ว' },
  '6x8': { id: '6x8', widthIn: 6, heightIn: 8, label: '6×8 นิ้ว' },
});

export const DEFAULT_PAPER = '4x6';

/*
 * ── ขนาดสินค้า ≠ ขนาดกระดาษที่ใส่เครื่อง ──────────────────────────────────
 *
 * เครื่อง dye-sub ใส่ม้วน 4×6 แล้วพิมพ์เต็มแผ่นพอดี สองอย่างนี้จึงเป็นค่าเดียวกัน
 * แต่อิงค์เจ็ทที่ใส่ A4 ไม่ใช่ — สินค้ายังเป็น 4×6 เหมือนเดิม แค่ไปนั่งอยู่กลาง
 * หน้า A4 แล้วตัดออกมาทีหลัง · แยกสองความหมายนี้ออกจากกันตั้งแต่ในโครงข้อมูล
 * ไม่งั้นโค้ดที่คำนวณผังจะเริ่มเดาว่ากำลังพูดถึงอันไหน
 *
 * `same` = พิมพ์เต็มขนาดสินค้า (dye-sub หรือกระดาษรูป 4×6 ในอิงค์เจ็ท)
 */
export const PAGES = Object.freeze({
  same: { id: 'same', label: 'เท่าขนาดสินค้า (ไม่ต้องตัด)' },
  A4: { id: 'A4', widthMm: 210, heightMm: 297, label: 'A4 (ตัดออกมาทีหลัง)' },
  A5: { id: 'A5', widthMm: 148, heightMm: 210, label: 'A5' },
  letter: { id: 'letter', widthMm: 215.9, heightMm: 279.4, label: 'Letter' },
});

export const DEFAULT_PAGE = 'same';

export const inches = (value) => Math.round(value * DPI);
export const mmToPx = (value) => Math.round((value / 25.4) * DPI);
export const pxToMm = (value) => (value / DPI) * 25.4;

/** หน้ากระดาษจริงที่ใส่ในเครื่องพิมพ์ · `same` คืน null เพราะไม่มีหน้ารองรับ */
export function pageSize(id = DEFAULT_PAGE) {
  const page = PAGES[id] ?? PAGES[DEFAULT_PAGE];
  if (!page.widthMm) return null;
  return {
    id: page.id,
    width: mmToPx(page.widthMm),
    height: mmToPx(page.heightMm),
    widthMm: page.widthMm,
    heightMm: page.heightMm,
  };
}

/**
 * ขนาดกระดาษเป็นพิกเซล · `landscape` สลับด้านให้ ไม่ต้องประกาศกระดาษเพิ่มอีกชุด
 * กระดาษที่ไม่รู้จักตกกลับไป 4×6 แทนที่จะโยน — หน้างานที่กระดาษหมดแล้วสลับม้วน
 * ต้องพิมพ์ได้ต่อ ไม่ใช่แอปค้างเพราะค่าใน config พิมพ์ผิด
 */
export function paperSize(id = DEFAULT_PAPER, { landscape = false } = {}) {
  const paper = PAPERS[id] ?? PAPERS[DEFAULT_PAPER];
  const width = inches(paper.widthIn);
  const height = inches(paper.heightIn);
  return landscape
    ? { id: paper.id, width: height, height: width, landscape: true }
    : { id: paper.id, width, height, landscape: false };
}
