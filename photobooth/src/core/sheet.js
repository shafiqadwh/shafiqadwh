import QRCode from 'qrcode';
import sharp from 'sharp';
import { fitLines, isArabic, trim } from '../../../shared/text.js';
import { themeById } from '../../../shared/themes.js';
import { DPI } from './paper.js';
import { applyEffect } from './effects.js';
import { layoutFor, shotsFor } from './templates.js';

/**
 * ประกอบแผ่นที่จะพิมพ์ — รูป + กรอบ + ชื่องาน + QR
 *
 * ทุกอย่างในไฟล์นี้ทำงานโดยไม่รู้จักกล้อง เครื่องพิมพ์ หรือ Electron เลย
 * รับ buffer เข้า คืน buffer ออก · แปลว่าทดสอบได้ทั้งหมดโดยไม่ต้องมีฮาร์ดแวร์
 * ซึ่งจำเป็น เพราะนี่คือชิ้นที่ผิดแล้วรู้ตอนกระดาษออกจากเครื่องไปแล้ว
 */

/*
 * เกณฑ์ว่า QR ใหญ่พอสแกนไหม วัดที่ "ขนาดโมดูล" ไม่ใช่ขนาดรวม
 *
 * โมดูลคือช่องสี่เหลี่ยมเล็กที่สุดใน QR · กล้องมือถือต้องแยกมันออกจากช่องข้าง ๆ
 * ให้ได้ ขนาดรวมจึงไม่ใช่ตัวชี้ขาด — ที่อยู่ยาวขึ้นแปลว่าโมดูลมากขึ้นในกรอบเท่าเดิม
 * แต่ละช่องจึงเล็กลงทั้งที่ QR ยังใหญ่เท่าเดิม (ทดสอบแล้ว: 39 ตัวอักษร → 29×29
 * โมดูล แต่ 85 ตัวอักษร → 37×37 ในกรอบขนาดเดียวกัน)
 *
 * 0.45 มม./โมดูล เป็นเกณฑ์เผื่อไว้สำหรับระยะถือกระดาษอ่านปกติ (~25 ซม.)
 * — เป็นค่าประมาณจากกฎทั่วไปของ QR ไม่ใช่ค่าที่วัดจากเครื่องพิมพ์ตัวนี้
 * **ตัวตัดสินจริงคือเอากระดาษที่พิมพ์แล้วมาสแกนด้วยมือถือ** ค่านี้แค่กันไม่ให้
 * แผ่นที่แย่ชัด ๆ หลุดไปถึงเครื่องพิมพ์โดยไม่มีใครเอะใจ
 */
export const MIN_QR_MODULE_MM = 0.45;

/*
 * QR ไม่ควรโตเกินนี้ ต่อให้แถบล่างจะสูงพอ
 *
 * แบบโพลารอยด์มีขอบล่างหนา ๆ ตามทรงของมัน · ปล่อยให้ QR สูงเท่าแถบจะได้ QR
 * ขนาด 40 มม. ที่เด่นกว่าชื่องานเสียอีก (เห็นกับตาตอนเรนเดอร์แผ่นแรก)
 * แผ่นนี้เป็นของที่ระลึก QR เป็นแค่ทางไปโหลดไฟล์ ไม่ใช่พระเอกของแผ่น
 */
const MAX_QR_MM = 26;

const mm = (px) => (px / DPI) * 25.4;


/** ผืนสีทึบขนาดที่ขอ — ใช้เป็นพื้นแผ่นและพื้นช่องที่ยังไม่มีรูป */
function canvas(width, height, colour) {
  return sharp({ create: { width, height, channels: 3, background: colour } });
}

// ขอบเงียบรอบ QR เป็นส่วนหนึ่งของมาตรฐาน ไม่ใช่ของตกแต่ง — ไม่มีขอบแล้วกล้อง
// หามุมไม่เจอเมื่อ QR ติดกับขอบรูปหรือพื้นสี
const QR_MARGIN = 2;

async function qrLayer(url, size) {
  const options = { errorCorrectionLevel: 'M', margin: QR_MARGIN };
  const data = await QRCode.toBuffer(url, {
    ...options,
    type: 'png',
    width: size,
    color: { dark: '#1f1a17', light: '#ffffff' },
  });
  // ถามไลบรารีว่าที่อยู่นี้กินกี่โมดูล แทนที่จะเดาจากความยาวสตริง
  const modules = QRCode.create(url, options).modules.size + QR_MARGIN * 2;
  return { data, moduleMm: mm(size / modules) };
}


/**
 * แถบล่างของแต่ละแผ่น/แถบ: ชื่องานกับ QR
 *
 * อาหรับสลับข้าง — QR ไปซ้าย ข้อความชิดขวา · ไม่ใช่ความสวยงามอย่างเดียว
 * ภาษาที่อ่านขวาไปซ้ายวางข้อความชิดซ้ายแล้วอ่านสะดุด เหมือนย่อหน้าที่เริ่มผิดข้าง
 */
async function footerLayers(footer, { title, subtitle, qrUrl, colours }) {
  const layers = [];
  // 8% ไม่ใช่ 12% — ที่ 12% QR ในแถบล่างของสามแบบจากสี่แบบเล็กจนต่ำกว่าเกณฑ์
  // (เจอตอนเรนเดอร์จริงครั้งแรก ไม่ได้เจอจากการอ่านโค้ด)
  const pad = Math.round(footer.height * 0.08);
  const rtl = isArabic(title) || isArabic(subtitle);

  let qrSize = 0;
  let qrModuleMm = 0;
  if (qrUrl) {
    qrSize = Math.min(Math.max(0, footer.height - pad * 2), Math.round((MAX_QR_MM / 25.4) * DPI));
    const qr = await qrLayer(qrUrl, qrSize);
    qrModuleMm = qr.moduleMm;
    layers.push({
      input: qr.data,
      left: rtl ? footer.left + pad : footer.left + footer.width - pad - qrSize,
      // กลางแนวตั้งเหมือนบล็อกข้อความ — แถบที่สูงกว่า QR (แบบโพลารอยด์) จะเห็นชัด
      // ว่า QR ลอยอยู่บนสุดขณะที่ชื่องานอยู่กลาง ดูเหมือนวางพลาดมากกว่าตั้งใจ
      top: footer.top + Math.round((footer.height - qrSize) / 2),
    });
  }

  const textWidth = footer.width - (qrSize > 0 ? qrSize + pad * 3 : pad * 2);
  const textLeft = rtl && qrSize > 0 ? footer.left + qrSize + pad * 2 : footer.left + pad;
  const align = rtl ? 'right' : 'left';

  const room = footer.height - pad * 2;
  const parts = [];

  if (title) {
    parts.push(...await fitLines(trim(title, 42), {
      colour: colours.ink,
      maxWidth: textWidth,
      maxHeight: subtitle ? Math.round(room * 0.64) : room,
      startPt: Math.round(mm(footer.height) * 0.62),
      align,
      bold: true,
      dpi: DPI,
    }));
  }
  if (subtitle) {
    parts.push(...await fitLines(trim(subtitle, 54), {
      colour: colours.accentDark,
      maxWidth: textWidth,
      maxHeight: Math.round(room * 0.3),
      startPt: Math.round(mm(footer.height) * 0.34),
      align,
      dpi: DPI,
      maxLines: 1,
    }));
  }

  const lead = Math.round(pad * 0.3);
  const textHeight = parts.reduce((sum, part) => sum + part.info.height, 0)
    + Math.max(0, parts.length - 1) * lead;

  // ยึดจากบนของบล็อกข้อความแล้วเดินลงทีละบรรทัด · เดิมหนีบเฉพาะ "ตำแหน่งที่วาด"
  // แต่ไม่หนีบตัวเคอร์เซอร์ พอบล็อกสูงเกินแถบ บรรทัดที่สองจึงไปทับบรรทัดแรก
  let cursor = Math.max(footer.top, footer.top + Math.round((footer.height - textHeight) / 2));

  for (const part of parts) {
    layers.push({
      input: part.data,
      left: rtl ? textLeft + Math.max(0, textWidth - part.info.width) : textLeft,
      top: cursor,
    });
    cursor += part.info.height + lead;
  }

  return { layers, qrSize, qrModuleMm };
}

/** เส้นประกลางแผ่นสำหรับตัด — วาดด้วย SVG ไม่ต้องพึ่งฟอนต์ */
function cutLayer(layout, colour) {
  if (layout.cuts.length === 0) return null;
  const lines = layout.cuts
    .map(({ x }) => `<line x1="${x}" y1="0" x2="${x}" y2="${layout.height}" `
      + `stroke="${colour}" stroke-width="2" stroke-dasharray="14 12" opacity="0.5"/>`)
    .join('');
  return {
    input: Buffer.from(
      `<svg width="${layout.width}" height="${layout.height}" xmlns="http://www.w3.org/2000/svg">${lines}</svg>`,
    ),
    left: 0,
    top: 0,
  };
}

/**
 * ประกอบแผ่นหนึ่งใบ
 *
 * `photos` เรียงตามลำดับที่ถ่าย · รูปไม่ครบตามที่แบบต้องการจะ **ไม่** เงียบ ๆ
 * ปล่อยช่องว่าง แต่โยนออกมาเลย — แผ่นที่มีช่องโหว่คือกระดาษกับหมึกที่เสียไปแล้ว
 * และ dye-sub ย้อนกลับไม่ได้ ต้องหยุดก่อนสั่งพิมพ์ ไม่ใช่หลังจากนั้น
 */
export async function composeSheet({
  photos,
  template = 'classic',
  paper = '4x6',
  effect = 'clean',
  theme = 'wedding',
  title = '',
  subtitle = '',
  qrUrl = null,
  landscape = false,
  format = 'jpeg',
}) {
  const needed = shotsFor(template);
  if (!Array.isArray(photos) || photos.length < needed) {
    throw new Error(
      `แบบ "${template}" ต้องใช้รูป ${needed} ใบ แต่ได้มา ${photos?.length ?? 0} ใบ`,
    );
  }

  const layout = layoutFor(template, paper, { landscape });
  const colours = themeById(theme).colours;

  const slotLayers = await Promise.all(layout.slots.map(async (slot) => ({
    input: await applyEffect(photos[slot.shot], effect, { width: slot.width, height: slot.height }),
    left: slot.left,
    top: slot.top,
  })));

  const footers = await Promise.all(
    layout.footers.map((footer) => footerLayers(footer, { title, subtitle, qrUrl, colours })),
  );

  const layers = [
    ...slotLayers,
    ...footers.flatMap((one) => one.layers),
    cutLayer(layout, colours.accentDark),
  ].filter(Boolean);

  const image = canvas(layout.width, layout.height, colours.paper).composite(layers);
  const data = format === 'png'
    ? await image.png().toBuffer()
    : await image.jpeg({ quality: 95, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();

  const qrPx = footers[0]?.qrSize ?? 0;
  const qrModuleMm = footers[0]?.qrModuleMm ?? 0;

  return {
    data,
    width: layout.width,
    height: layout.height,
    dpi: DPI,
    // ให้ผู้เรียกตรวจได้ว่า QR ที่ออกมาสแกนไหวจริงไหม โดยไม่ต้องรอไปวัดบนกระดาษ
    qrMm: qrPx > 0 ? Number(mm(qrPx).toFixed(1)) : 0,
    qrModuleMm: Number(qrModuleMm.toFixed(3)),
    qrTooSmall: qrPx > 0 && qrModuleMm < MIN_QR_MODULE_MM,
  };
}
