import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * เขียนไฟล์ PDF ที่มี "ภาพหนึ่งใบต่อหนึ่งหน้า" — ไม่มีตัวหนังสือใน PDF เลย
 *
 * ทำไมไม่ใช้ไลบรารีที่วาดตัวหนังสือเป็น: โปรเจกต์นี้จ่ายค่าบทเรียนเรื่องการจัดรูป
 * อักษรไปแล้วรอบหนึ่ง — `drawtext` ของ ffmpeg วางสระกับวรรณยุกต์ไทยเพี้ยนเพราะ
 * ไม่มี harfbuzz ต้องย้ายไปเรนเดอร์ด้วย Pango ที่ติดมากับ sharp แทน ไลบรารี PDF
 * ที่จัดตัวอักษรเองจะดึงความเสี่ยงเรื่อง shaping กับการเรียงขวาไปซ้ายของอาหรับ
 * กลับเข้ามาใหม่ทั้งก้อน สำหรับของที่บ่าวสาวจะเก็บไว้ตลอดชีวิต
 *
 * และการเพิ่มแพ็กเกจใหม่มีราคาที่จับต้องได้บน NAS เครื่องนี้: `node_modules`
 * ฝังอยู่ใน image ส่วนโค้ด bind-mount เข้าไป `scripts/update.sh` จึงแค่ restart
 * ถ้าเพิ่ม dependency จะต้อง `docker compose build` ใหม่ทั้งอิมเมจ
 *
 * ที่แลกไป: ตัวหนังสือใน PDF เลือกหรือค้นหาไม่ได้ เพราะมันเป็นภาพ
 *
 * PDF ที่มีแต่ภาพ JPEG เป็นรูปแบบที่ง่ายที่สุดเท่าที่ PDF จะเป็นได้ — ไม่ต้องฝังฟอนต์
 * ไม่ต้องบีบอัดเอง เพราะ `DCTDecode` คือ "ข้างในนี้เป็น JPEG" ส่งไบต์ผ่านไปตรง ๆ ได้เลย
 */

// A4 หน่วยของ PDF คือ point (1/72 นิ้ว) — 210mm × 297mm
export const A4_WIDTH_PT = 595.28;
export const A4_HEIGHT_PT = 841.89;

function dictionary(entries) {
  return `<<${entries.join('')}>>`;
}

/**
 * ข้อความใน PDF — ต้องเข้ารหัสก่อน escape ไม่ใช่หลัง
 *
 * ทั้งไฟล์นี้เขียนด้วย latin1 ซึ่ง **ตัดตัวอักษรหลายไบต์ให้เหลือไบต์ล่างตัวเดียว**
 * ชื่อเรื่องภาษาไทยจึงกลายเป็นขยะ และที่ร้ายกว่านั้นคือไบต์ที่เหลือบังเอิญเป็น
 * `(` `)` หรือ `\` ได้ — เช่น "ษ" (U+0E29) เหลือไบต์ 0x29 คือวงเล็บปิด
 * แล้วพจนานุกรมก็พังทั้งอัน โดยที่การ escape ข้อความต้นฉบับไว้ก่อนช่วยอะไรไม่ได้เลย
 *
 * สเปก PDF รองรับ UTF-16BE นำหน้าด้วย BOM สำหรับข้อความที่ไม่ใช่ ASCII
 * เข้ารหัสก่อนแล้วค่อย escape ไบต์อันตราย จึงถูกทั้งการอ่านออกและความปลอดภัยของรูปแบบ
 */
export function pdfString(value) {
  const text = String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  const bytes = /^[\x20-\x7e]*$/.test(text)
    ? Buffer.from(text, 'latin1')
    : Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);

  const escaped = [];
  for (const byte of bytes) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) escaped.push(0x5c);
    escaped.push(byte);
  }
  return Buffer.from(escaped).toString('latin1');
}

/**
 * ประกอบไฟล์ทั้งก้อนในหน่วยความจำ แล้วค่อยเขียนทีเดียว
 *
 * ตาราง xref ต้องบอก "ออฟเซ็ตเป็นไบต์" ของทุกวัตถุ ซึ่งรู้ได้ก็ต่อเมื่อประกอบเสร็จแล้ว
 * การไล่เขียนทีละชิ้นลงไฟล์แล้วมาไล่นับทีหลังคือจุดที่พลาดง่ายที่สุดของรูปแบบนี้
 */
export function buildPdf(pages, { title = '' } = {}) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('PDF ต้องมีอย่างน้อยหนึ่งหน้า');
  }

  const chunks = [];
  const offsets = [0]; // วัตถุหมายเลข 0 เป็นหัวว่างตามสเปก
  let length = 0;

  const push = (value) => {
    const buffer = Buffer.isBuffer(value) ? value : Buffer.from(value, 'latin1');
    chunks.push(buffer);
    length += buffer.length;
  };

  const object = (number, body, stream = null) => {
    offsets[number] = length;
    push(`${number} 0 obj\n${body}\n`);
    if (stream) {
      push('stream\n');
      push(stream);
      push('\nendstream\n');
    }
    push('endobj\n');
  };

  // 1 = Catalog · 2 = Pages · จากนั้นหน้าละ 3 วัตถุ (Page, เนื้อหา, ภาพ)
  const pageNumber = (index) => 3 + index * 3;
  const contentNumber = (index) => 4 + index * 3;
  const imageNumber = (index) => 5 + index * 3;

  push('%PDF-1.4\n');
  // ไบต์สูงกว่า 127 สี่ตัวบอกโปรแกรมที่อ่านต่อว่าไฟล์นี้เป็นไบนารี ไม่ใช่ข้อความ
  push(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  object(1, dictionary(['/Type /Catalog', ' /Pages 2 0 R']));
  object(2, dictionary([
    '/Type /Pages',
    ` /Kids [${pages.map((_, i) => `${pageNumber(i)} 0 R`).join(' ')}]`,
    ` /Count ${pages.length}`,
  ]));

  pages.forEach((page, index) => {
    if (!Buffer.isBuffer(page.jpeg) || page.jpeg.length === 0) {
      throw new Error(`หน้า ${index + 1} ไม่มีข้อมูลภาพ`);
    }

    // เมทริกซ์ cm ยืดภาพขนาด 1×1 หน่วยให้เต็มหน้า — ตัวภาพเก็บพิกเซลไว้เท่าเดิม
    const content = `q ${A4_WIDTH_PT} 0 0 ${A4_HEIGHT_PT} 0 0 cm /Im0 Do Q`;

    object(pageNumber(index), dictionary([
      '/Type /Page',
      ' /Parent 2 0 R',
      ` /MediaBox [0 0 ${A4_WIDTH_PT} ${A4_HEIGHT_PT}]`,
      ` /Resources <</XObject <</Im0 ${imageNumber(index)} 0 R>>>>`,
      ` /Contents ${contentNumber(index)} 0 R`,
    ]));

    object(contentNumber(index), dictionary([`/Length ${content.length}`]), content);

    object(imageNumber(index), dictionary([
      '/Type /XObject',
      ' /Subtype /Image',
      ` /Width ${page.width}`,
      ` /Height ${page.height}`,
      ' /ColorSpace /DeviceRGB',
      ' /BitsPerComponent 8',
      ' /Filter /DCTDecode',
      ` /Length ${page.jpeg.length}`,
    ]), page.jpeg);
  });

  const infoNumber = 3 + pages.length * 3;
  object(infoNumber, dictionary([
    `/Title (${pdfString(title)})`,
    ' /Producer (wedding-share)',
  ]));

  const total = infoNumber + 1;
  const xrefAt = length;
  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i += 1) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  push(xref);
  push(`trailer\n${dictionary([`/Size ${total}`, ' /Root 1 0 R', ` /Info ${infoNumber} 0 R`])}\n`);
  push(`startxref\n${xrefAt}\n%%EOF\n`);

  return Buffer.concat(chunks);
}

/**
 * เขียนลงไฟล์ชั่วคราวก่อนแล้วค่อย rename ทับ
 *
 * แบบเดียวกับ `atomically()` ของงาน export หนัง — แกลลอรี่อ่านรายการจากโฟลเดอร์จริง
 * ถ้าเขียนตรง ๆ แล้วดับกลางทาง จะมีไฟล์ครึ่งใบโผล่ในรายการให้กดแล้วเปิดไม่ขึ้น
 */
export async function writePdf(pages, outPath, options = {}) {
  const buffer = buildPdf(pages, options);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  const temporary = `${outPath}.part`;
  await fs.writeFile(temporary, buffer);
  await fs.rename(temporary, outPath);
  return buffer.length;
}
