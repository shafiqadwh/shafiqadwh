import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * เรนเดอร์ตัวหนังสือไทย/มลายู/อังกฤษ/อาหรับ ให้ออกมาเป็นภาพ
 *
 * โค้ดชุดนี้ย้ายมาจาก `src/lib/film.js` ของโปรแกรมแชร์รูป ซึ่งผ่านงานจริงมาแล้ว
 * — ย้ายมาไว้ตรงกลางเพราะ photo booth ต้องเขียนชื่องานลงบนแผ่นที่พิมพ์ออกมา
 * และการเขียนตัวเรนเดอร์ตัวหนังสือขึ้นใหม่แปลว่าต้องไปเจอกับดักเดิมอีกรอบ
 *
 * สองกับดักที่จ่ายค่าบทเรียนไปแล้ว และห้ามลืม
 *
 * 1. **drawtext ของ ffmpeg วางสระ/วรรณยุกต์ไทยเพี้ยน** เพราะ ffmpeg ของ Debian
 *    ไม่ได้ build มากับ harfbuzz · Pango ที่ติดมากับ sharp จัดรูปอักษรถูกต้อง
 * 2. **Pango ไม่ error เมื่อหาไฟล์ฟอนต์ไม่เจอ** — มันเงียบ ๆ ไปหยิบฟอนต์ระบบ
 *    ตัวไหนก็ได้ ซึ่งบนเครื่องที่ไม่มีฟอนต์ไทยจะได้ □□□ ทั้งแผ่นโดยไม่มีอะไรเตือน
 *    รู้ตอนกระดาษออกจากเครื่องพิมพ์แล้วก็สายไป — จึงต้องตรวจไฟล์เองก่อนเสมอ
 */

// ฟอนต์เดินทางมากับโปรเจกต์ ไม่ใช่ของที่ติดตั้งในระบบ — เครื่องปลายทางทั้งสองแบบ
// (คอนเทนเนอร์ node:slim บน NAS และมินิพีซีของบูธ) ไม่มีฟอนต์ไทย/อาหรับติดมาเลย
const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'fonts');

const FONTS = {
  latin: {
    regular: path.join(FONT_DIR, 'NotoSerifThai-Regular.ttf'),
    bold: path.join(FONT_DIR, 'NotoSerifThai-SemiBold.ttf'),
    family: 'Noto Serif Thai',
  },
  arabic: {
    regular: path.join(FONT_DIR, 'NotoNaskhArabic-Regular.ttf'),
    bold: path.join(FONT_DIR, 'NotoNaskhArabic-SemiBold.ttf'),
    family: 'Noto Naskh Arabic',
  },
};

// ช่วงอักษรอาหรับพื้นฐาน บวกส่วนขยายที่ใช้จริงในข้อความทั่วไป
const ARABIC = /[\u0600-\u06ff\u0750-\u077f\ufb50-\ufdff\ufe70-\ufeff]/;

let fontsChecked = false;

export function assertFonts() {
  if (fontsChecked) return;
  const missing = [];
  for (const face of Object.values(FONTS)) {
    for (const file of [face.regular, face.bold]) {
      if (!fs.existsSync(file)) missing.push(file);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `ไม่พบไฟล์ฟอนต์ ${missing.length} ไฟล์ — ข้อความไทย/อาหรับจะกลายเป็นกล่องสี่เหลี่ยม\n`
      + `  ${missing.join('\n  ')}`,
    );
  }
  fontsChecked = true;
}

/**
 * เลือกฟอนต์จาก "ตัวอักษรที่อยู่ในข้อความจริง" ไม่ใช่จากภาษาที่ตั้งไว้
 *
 * งานเดียวกันมีชื่อทั้งอักษรไทยและอาหรับได้ (เจ้าสาวชื่อ 'Aishah Nadhirah
 * เขียนเป็นอาหรับบนการ์ด) จึงต้องดูเป็นข้อความ ๆ ไป ไม่ใช่ดูจากภาษาของงาน
 */
export const isArabic = (text) => ARABIC.test(String(text ?? ''));

export function fontFor(text) {
  assertFonts();
  return isArabic(text) ? FONTS.arabic : FONTS.latin;
}

/**
 * Pango อ่านข้อความที่ส่งเข้าไปเป็น markup — ชื่อที่มี & หรือ < ทำให้เรนเดอร์ล้ม
 * ทั้งแผ่น (เจอจริง: ชื่อ "Sofwan & 'Aishah" ทำให้ sharp โยน invalid markup)
 *
 * `ink()` เรียกตัวนี้ให้เองแล้ว ผู้เรียกไม่ต้องจำ — เดิมต้องห่อเองทุกที่ 17 จุด
 * ซึ่งลืมได้ทุกจุด และจุดที่ลืมจะพังก็ต่อเมื่อมีแขกชื่อมี & เข้ามาพอดี
 */
function escapeMarkup(value) {
  return String(value ?? '')
    // อักขระควบคุมทำให้ Pango จัดบรรทัดเพี้ยน ตัดทิ้งก่อน
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * ข้อความหนึ่งก้อน → ภาพ PNG พื้นโปร่ง พร้อมขนาดจริงที่ได้
 *
 * `width` เป็นความกว้างสูงสุดที่ยอมให้ตัดบรรทัด — ต้องระบุเสมอ ไม่มีค่าเริ่มต้น
 * เพราะขนาดกระดาษของ photo booth กับเฟรมหนัง 1920 กว้างไม่เท่ากันเลย
 *
 * `dpi` สำคัญกว่าที่เห็น: `size` เป็น **พอยต์** ไม่ใช่พิกเซล และ sharp เรนเดอร์
 * ที่ 72 dpi ถ้าไม่บอก · หัวเรื่อง 20pt จึงออกมาสูง 20px บนแผ่นพิมพ์กว้าง 1200px
 * ซึ่งเล็กจนอ่านไม่ออก (เห็นกับตาตอนเรนเดอร์แผ่นแรก) · งานพิมพ์ต้องส่ง 300 มา
 * ส่วนหนังที่คิดเป็นพิกเซลบนจอปล่อยค่าเริ่มต้นไว้เหมือนเดิม
 */
export function ink(text, {
  size, colour, width, align = 'centre', bold = false, spacing = 0, lineHeight = null, dpi = null,
}) {
  const attrs = [`foreground="${colour}"`];
  if (spacing) attrs.push(`letter_spacing="${Math.round(spacing * 1024)}"`);
  if (lineHeight) attrs.push(`line_height="${lineHeight}"`);

  const safe = escapeMarkup(text);
  const face = fontFor(safe);

  /*
   * ⚠️ `width` กับ `dpi` ของ sharp ไม่ได้อยู่ในหน่วยเดียวกัน
   *
   * วัดจริงที่ 25pt/300dpi กับข้อความที่กว้างตามธรรมชาติ 1405px:
   *   ส่ง width=788  → ได้ 485×415  (ตัดบรรทัดถี่กว่าที่สั่งมาก ~5 บรรทัด)
   *   ส่ง width=3283 → ได้ 1405×81  (ไม่ตัดเลย)
   * ทั้งสองค่าไม่เข้ากับสูตรแปลงหน่วยแบบตรงไปตรงมาสูตรไหนเลย
   *
   * จึงไม่พึ่งการตัดบรรทัดของ sharp ในงานพิมพ์ — ผู้เรียกฝั่งพิมพ์ส่ง `width`
   * กว้าง ๆ ให้ไม่ตัด แล้วขึ้นบรรทัดเองด้วย `fitLines()` ซึ่งวัดทีละบรรทัดจริง
   * ส่วนหนัง (ไม่ส่ง dpi) ยังใช้การตัดบรรทัดของ sharp เหมือนเดิมทุกประการ
   */
  return sharp({
    text: {
      text: `<span ${attrs.join(' ')}>${safe}</span>`,
      fontfile: bold ? face.bold : face.regular,
      font: `${face.family}${bold ? ' SemiBold' : ''} ${size}`,
      width,
      align,
      rgba: true,
      wrap: 'word',
      ...(dpi ? { dpi } : {}),
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

// กว้างพอที่จะไม่มีทางถูกตัดบรรทัด — ใช้ตอนอยากรู้ "ความกว้างตามธรรมชาติ" ของข้อความ
const NO_WRAP = 20000;

/**
 * จัดข้อความให้พอดีกรอบ แล้วคืนเป็นบรรทัด ๆ ที่วางต่อกันได้เลย
 *
 * ขึ้นบรรทัดเองแทนที่จะให้ sharp ทำ ด้วยเหตุผลในคอมเมนต์ของ `ink()` ข้างบน
 * และได้ของแถมที่จำเป็นกับงานพิมพ์: **รู้ความสูงจริงของทุกบรรทัดก่อนวาง**
 * จึงไม่มีทางที่บล็อกข้อความจะล้นแถบไปทับรูป ซึ่งบนกระดาษแก้ทีหลังไม่ได้
 *
 * ลองบรรทัดเดียวก่อนเสมอ ค่อยยอมขึ้นสองบรรทัดเมื่อย่อจนเล็กสุดแล้วยังไม่พอ
 * — ชื่องานบรรทัดเดียวอ่านง่ายกว่าและดูตั้งใจกว่าเสมอ
 */
export async function fitLines(text, {
  colour, maxWidth, maxHeight, startPt, minPt = 8, align = 'left', bold = false, dpi = null, maxLines = 2,
}) {
  const render = (value, size) => ink(value, { size, colour, width: NO_WRAP, align, bold, dpi });

  for (let lines = 1; lines <= maxLines; lines += 1) {
    const chunks = lines === 1 ? [text] : splitEvenly(text, lines);
    if (chunks.length < lines) continue; // คำเดียวยาว ๆ แบ่งไม่ได้ ก็ไม่ต้องเสียเวลาลอง

    for (let size = Math.round(startPt); size >= minPt; size = Math.round(size * 0.88)) {
      const parts = await Promise.all(chunks.map((chunk) => render(chunk, size)));
      const widest = Math.max(...parts.map((part) => part.info.width));
      const total = parts.reduce((sum, part) => sum + part.info.height, 0);
      if (widest <= maxWidth && total <= maxHeight) return parts;
    }
  }

  /*
   * เล็กสุดแล้วยังไม่พอ — ตัดข้อความให้สั้นลงจนพอดี
   *
   * ยอมให้ชื่อถูกตัดเป็น "Sofwan & 'Aishah N…" ดีกว่าปล่อยให้ล้นแถบไปทับ QR
   * บนกระดาษ ซึ่งทำให้ทั้งชื่อและ QR ใช้ไม่ได้พร้อมกัน · บนจอยังแก้ได้ บนกระดาษไม่ได้
   */
  let cut = String(text);
  let last = await render(cut, minPt);
  while (last.info.width > maxWidth && cut.length > 2) {
    cut = trim(cut, Math.max(1, Math.floor((cut.length - 1) * 0.9)));
    last = await render(cut, minPt);
  }
  return [last];
}

/** แบ่งข้อความเป็น n ท่อนตามช่องว่าง ให้แต่ละท่อนยาวใกล้เคียงกัน */
function splitEvenly(text, n) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length < n) return [text];

  const target = Math.ceil(words.length / n);
  const chunks = [];
  for (let i = 0; i < words.length; i += target) chunks.push(words.slice(i, i + target).join(' '));
  return chunks;
}

/**
 * ตัดข้อความยาวเกินแล้วต่อ … — ชื่องานที่ยาวเกินกรอบต้องไม่ดันของอื่นตกขอบกระดาษ
 *
 * ยุบช่องว่างซ้ำด้วย เพราะชื่อที่แขกพิมพ์มามีเว้นวรรครัว ๆ ได้ และช่องว่างซ้อน
 * ทำให้การนับความยาวเพี้ยนจากที่ตาเห็น · พฤติกรรมนี้คือของเดิมที่หนังใช้มาตลอด
 */
export function trim(value, limit) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
}
