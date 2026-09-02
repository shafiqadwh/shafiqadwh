import sharp from 'sharp';
import { mmToPx, pageSize, pxToMm } from './paper.js';

/**
 * วางแผ่นขนาดสินค้าลงบนหน้ากระดาษจริง พร้อมเส้นตัด
 *
 * ใช้กับอิงค์เจ็ทที่ใส่ A4: สินค้ายังเป็น 4×6 เหมือนเดิม แค่ไปนั่งอยู่บนหน้า A4
 * แล้วตัดออกมาทีหลัง — ได้ของขนาดเท่าสินค้าจริงโดยไม่ต้องซื้อกระดาษรูป
 *
 * สองเรื่องที่ทำให้ต่างจาก "แค่พิมพ์ให้พอดีหน้า"
 *
 * 1. **ห้ามย่อ/ขยายแผ่นเด็ดขาด** แผ่นถูกประกอบมาที่ 300 dpi พอดีขนาดสินค้าแล้ว
 *    ย่อลงคือ QR เล็กลงจนอาจสแกนไม่ติด ขยายขึ้นคือภาพเบลอ · วางเท่าเดิมเสมอ
 *    ถ้าใหญ่เกินหน้ากระดาษให้บอกออกมา ไม่ใช่ย่อให้เงียบ ๆ
 * 2. **วางได้กี่ใบก็วางให้เต็ม** A4 หนึ่งแผ่นใส่ 4×6 ได้สองใบถ้าวางตะแคง
 *    — หมึกกับกระดาษครึ่งหนึ่งต่อรูปหนึ่งใบ ซึ่งสำคัญมากตอนเดโมที่พิมพ์ทิ้งเยอะ
 */

// ขอบที่หัวพิมพ์อิงค์เจ็ทเข้าไม่ถึง · Epson ส่วนใหญ่ราว 3 มม. เผื่อเป็น 5
// ถ้าวางชิดกว่านี้ ไดรเวอร์จะย่อทั้งหน้าลงให้พอดีเอง แล้วขนาดสินค้าจะเพี้ยนทันที
export const SAFE_MARGIN_MM = 5;

const CROP_MARK_MM = 4;

// ช่องว่างระหว่างใบ — ตัดด้วยกรรไกรต้องมีที่ให้ใบมีดเดิน ไม่ใช่ตัดคาบเส้นสองใบพร้อมกัน
const GUTTER_MM = 3;

/**
 * วางได้กี่ใบต่อหน้า และวางตรงไหนบ้าง
 *
 * ลองทั้งวางตั้งและวางตะแคง แล้วเลือกทางที่ได้จำนวนมากกว่า · เป็นฟังก์ชันบริสุทธิ์
 * เพื่อให้ทดสอบเลขได้โดยไม่ต้องเรนเดอร์ภาพจริง
 */
export function planPage({ sheet, page, marginMm = SAFE_MARGIN_MM, want = 1 }) {
  const margin = mmToPx(marginMm);
  const gutter = mmToPx(GUTTER_MM);
  const usableW = page.width - margin * 2;
  const usableH = page.height - margin * 2;

  const options = [
    { rotate: 0, w: sheet.width, h: sheet.height },
    { rotate: 90, w: sheet.height, h: sheet.width },
  ];

  // n ใบกินที่ n×ขนาด บวกช่องว่าง (n−1) ช่อง · แก้สมการกลับเป็นจำนวนใบที่ลงได้
  const howMany = (available, size) => Math.floor((available + gutter) / (size + gutter));

  let best = null;
  for (const option of options) {
    const cols = howMany(usableW, option.w);
    const rows = howMany(usableH, option.h);
    const fits = cols * rows;
    if (fits > 0 && (!best || fits > best.fits)) best = { ...option, cols, rows, fits };
  }

  if (!best) {
    return {
      fits: 0,
      slots: [],
      reason: `แผ่นขนาด ${pxToMm(sheet.width).toFixed(0)}×${pxToMm(sheet.height).toFixed(0)} มม. `
        + `ใหญ่เกินกว่าที่หน้ากระดาษ ${page.widthMm}×${page.heightMm} มม. จะรับได้ `
        + `(เผื่อขอบข้างละ ${marginMm} มม.)`,
    };
  }

  const count = Math.min(want, best.fits);
  const used = { cols: Math.min(count, best.cols), rows: Math.ceil(count / best.cols) };

  // จัดกลุ่มที่วางจริงให้อยู่กลางหน้า ไม่ใช่ชิดมุมบนซ้าย — พิมพ์ใบเดียวบน A4
  // แล้วรูปไปกองมุมหนึ่งดูเหมือนพิมพ์พลาด ทั้งที่ตั้งใจ
  const blockW = used.cols * best.w + (used.cols - 1) * gutter;
  const blockH = used.rows * best.h + (used.rows - 1) * gutter;
  const originX = Math.round((page.width - blockW) / 2);
  const originY = Math.round((page.height - blockH) / 2);

  const slots = [];
  for (let i = 0; i < count; i += 1) {
    slots.push({
      left: originX + (i % used.cols) * (best.w + gutter),
      top: originY + Math.floor(i / used.cols) * (best.h + gutter),
      width: best.w,
      height: best.h,
      rotate: best.rotate,
    });
  }

  return { fits: best.fits, cols: best.cols, rows: best.rows, rotate: best.rotate, slots };
}

/** เส้นตัดสั้น ๆ ที่มุมของแต่ละใบ — อยู่นอกภาพ ไม่กินเนื้อรูป */
function cropMarks(slots, page) {
  const len = mmToPx(CROP_MARK_MM);
  const lines = [];

  for (const slot of slots) {
    const x1 = slot.left;
    const y1 = slot.top;
    const x2 = slot.left + slot.width;
    const y2 = slot.top + slot.height;

    for (const [x, y] of [[x1, y1], [x2, y1], [x1, y2], [x2, y2]]) {
      // ลากออกจากมุมไปด้านนอกทั้งแนวตั้งและแนวนอน แล้วหนีบไว้ในหน้ากระดาษ
      const dx = x === x1 ? -len : len;
      const dy = y === y1 ? -len : len;
      lines.push(`<line x1="${x}" y1="${y}" x2="${Math.max(0, Math.min(page.width, x + dx))}" y2="${y}"/>`);
      lines.push(`<line x1="${x}" y1="${y}" x2="${x}" y2="${Math.max(0, Math.min(page.height, y + dy))}"/>`);
    }
  }

  return Buffer.from(
    `<svg width="${page.width}" height="${page.height}" xmlns="http://www.w3.org/2000/svg">`
    + `<g stroke="#8a8a8a" stroke-width="2">${lines.join('')}</g></svg>`,
  );
}

/**
 * วางแผ่นลงหน้ากระดาษจริง คืนภาพขนาดหน้ากระดาษพร้อมพิมพ์
 *
 * `copies` คือจำนวนที่อยากได้ · วางได้เท่าไรก็วาง ที่เหลือผู้เรียกพิมพ์หน้าถัดไป
 * — ตัวเลข `placed` กับ `remaining` บอกกลับไปให้ ไม่ต้องไปคำนวณซ้ำข้างนอก
 */
export async function mountOnPage(sheetImage, {
  sheet, page: pageId, copies = 1, marginMm = SAFE_MARGIN_MM, cropGuides = true,
}) {
  const page = pageSize(pageId);
  if (!page) throw new Error(`หน้ากระดาษ "${pageId}" ไม่ต้องวาง — พิมพ์เต็มขนาดสินค้าได้เลย`);

  const plan = planPage({ sheet, page, marginMm, want: copies });
  if (plan.fits === 0) throw new Error(plan.reason);

  const layers = [];
  for (const slot of plan.slots) {
    const image = slot.rotate
      ? await sharp(sheetImage).rotate(slot.rotate).toBuffer()
      : sheetImage;
    layers.push({ input: image, left: slot.left, top: slot.top });
  }
  if (cropGuides) layers.push({ input: cropMarks(plan.slots, page), left: 0, top: 0 });

  const data = await sharp({
    create: { width: page.width, height: page.height, channels: 3, background: '#ffffff' },
  })
    .composite(layers)
    .jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    .toBuffer();

  return {
    data,
    width: page.width,
    height: page.height,
    page: page.id,
    placed: plan.slots.length,
    perPage: plan.fits,
    remaining: Math.max(0, copies - plan.slots.length),
    rotated: Boolean(plan.rotate),
  };
}
