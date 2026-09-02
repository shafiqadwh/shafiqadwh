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

export const inches = (value) => Math.round(value * DPI);

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
