import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';

/**
 * ประกอบ "เฟรม" ของหนังงานแต่ง — รูปหนึ่งใบ หรือการ์ดข้อความหนึ่งใบ
 *
 * ทำไมไม่ใช้ drawtext ของ ffmpeg: ffmpeg ที่ติดมากับ Debian bookworm (ตัวที่อยู่
 * ในอิมเมจของโปรเจกต์นี้) ไม่ได้ build มากับ harfbuzz ตัว drawtext จึงวางสระกับ
 * วรรณยุกต์ไทยด้วยการเลื่อนตำแหน่งแบบง่าย ๆ ผลคือ "ปี่ ญี่ปุ่น เกี๊ยะ" ออกมาเพี้ยน
 * ซึ่งรับไม่ได้สำหรับของที่บ่าวสาวจะเก็บไว้ดูตลอดชีวิต
 *
 * ตรงนี้จึงเรนเดอร์ตัวหนังสือด้วย Pango ที่ติดมากับ sharp (เป็น dependency เดิม
 * ของโปรเจกต์อยู่แล้ว) ซึ่งจัดรูปอักษรผ่าน harfbuzz เต็มรูปแบบ ทดสอบแล้วภาษาไทย
 * ซ้อนสระ-วรรณยุกต์ถูกต้องทุกคำ และรองรับ RTL กับภาษาจีนไว้ในตัวสำหรับอนาคต
 *
 * ส่วนรูปทรงกับไล่เฉดใช้ SVG (librsvg ไม่ต้องพึ่งฟอนต์ถ้าไม่มีตัวหนังสือ)
 * แล้ว ffmpeg รับหน้าที่เข้ารหัสอย่างเดียว
 */

export const FRAME_WIDTH = 1920;
export const FRAME_HEIGHT = 1080;

// ฟอนต์เดินทางมากับโปรเจกต์ ไม่ใช่ของที่ติดตั้งในระบบ เพราะอิมเมจ node:slim
// ไม่มีฟอนต์ไทยเลยสักตัว และ NAS ตัวนี้ต่อเน็ตออกจากในคอนเทนเนอร์ไม่ได้
const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);
const FONT_REGULAR = path.join(FONT_DIR.pathname, 'NotoSerifThai-Regular.ttf');
const FONT_BOLD = path.join(FONT_DIR.pathname, 'NotoSerifThai-SemiBold.ttf');

const INK = {
  cream: '#f7ecd9',
  gold: '#e6c88a',
  dim: '#c3ae8d',
  paper: '#14100c',
};

/**
 * Pango อ่านข้อความที่ส่งเข้าไปเป็น markup ข้อความจากแขกจึงต้อง escape ก่อนเสมอ
 * ไม่งั้นคำอวยพรที่มีเครื่องหมาย & หรือ < จะทำให้การเรนเดอร์ล้มทั้งเฟรม
 * (เจอจริงตอนทดสอบ: ชื่อ "Sofwan & 'Aishah" ทำให้ sharp โยน invalid markup)
 */
export function escapeMarkup(value) {
  return String(value ?? '')
    // อักขระควบคุมทำให้ Pango จัดบรรทัดเพี้ยน ตัดทิ้งก่อน
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** ตัดข้อความยาวเกินจอ ไม่ให้การ์ดใบเดียวกินเวลาอ่านเป็นนาที */
export function trim(value, limit) {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > limit ? `${text.slice(0, limit).trim()}…` : text;
}

/** เรนเดอร์ข้อความหนึ่งก้อนเป็นภาพโปร่งใส คืนทั้งบัฟเฟอร์และขนาดที่ได้จริง */
async function ink(text, {
  size,
  colour = INK.cream,
  width = FRAME_WIDTH - 320,
  align = 'centre',
  bold = false,
  spacing = 0,
  lineHeight = null,
}) {
  const attrs = [`foreground="${colour}"`];
  if (spacing) attrs.push(`letter_spacing="${Math.round(spacing * 1024)}"`);
  if (lineHeight) attrs.push(`line_height="${lineHeight}"`);

  const markup = `<span ${attrs.join(' ')}>${text}</span>`;

  return sharp({
    text: {
      text: markup,
      fontfile: bold ? FONT_BOLD : FONT_REGULAR,
      font: `${bold ? 'Noto Serif Thai SemiBold' : 'Noto Serif Thai'} ${size}`,
      width,
      align,
      rgba: true,
      wrap: 'word',
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

/** วางภาพย่อยลงกลางแนวนอน ที่ระยะ top ที่กำหนด แล้วคืนขอบล่างที่ใช้ไป */
function centred(layers, { data, info }, top) {
  layers.push({
    input: data,
    left: Math.round((FRAME_WIDTH - info.width) / 2),
    top: Math.round(top),
  });
  return top + info.height;
}

/**
 * เกรนฟิล์มบาง ๆ คลุมทั้งเฟรม
 *
 * ไม่ได้ใส่เพื่อความเท่อย่างเดียว — พื้นไล่เฉดกว้าง ๆ บนความลึกสี 8 บิตจะเห็นเป็น
 * วงแหวนเป็นชั้น ๆ (banding) ชัดมากบนจอทีวีใหญ่ในห้องมืด การโปรยจุดรบกวนจาง ๆ
 * ทับไว้ทำให้ขอบชั้นแตกตัวจนตาไม่จับ และได้อารมณ์ฟิล์มเหมือนโหมดโรงหนังของสไลด์โชว์
 *
 * สร้างครั้งเดียวแล้วใช้ซ้ำทุกเฟรม ไม่งั้นหนัง 800 เฟรมต้องสุ่มจุดสองล้านจุดใหม่ทุกใบ
 */
let grainCache = null;
async function grain() {
  if (grainCache) return grainCache;
  const pixels = Buffer.allocUnsafe(FRAME_WIDTH * FRAME_HEIGHT);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = 121 + Math.floor(Math.random() * 14);
  grainCache = await sharp(pixels, {
    raw: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 1 },
  }).png().toBuffer();
  return grainCache;
}

function svg(markup) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}">${markup}</svg>`);
}

/** พื้นหลังการ์ดข้อความ — ไล่เฉดจากกลางจอออกไปมืด แบบเดียวกับการ์ดชื่อในสไลด์โชว์ */
function darkBackdrop() {
  return svg(`
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="72%">
        <stop offset="0%" stop-color="#2c2016"/>
        <stop offset="62%" stop-color="#181209"/>
        <stop offset="100%" stop-color="#0b0806"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  `);
}

/** ลายเส้นคั่นแบบเดียวกับ #flourish ในหน้าเว็บ ให้หนังกับเว็บดูเป็นชุดเดียวกัน */
function flourish(width) {
  const half = width / 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${Math.round(width * 0.1)}" viewBox="0 0 240 24">
    <g fill="none" stroke="#c9a86a" stroke-width="1.1">
      <path d="M4 12h${Math.round(half / 3)}"/>
      <path d="M${240 - Math.round(half / 3)} 12h${Math.round(half / 3)}"/>
      <circle cx="112" cy="12" r="5"/>
      <circle cx="128" cy="12" r="5"/>
      <path d="M96 12l8-5v10z" fill="#c9a86a" stroke="none"/>
      <path d="M144 12l-8-5v10z" fill="#c9a86a" stroke="none"/>
    </g>
  </svg>`);
}

/**
 * แถบคำบรรยายที่ขอบล่าง — วางทับบนรูปแบบเดียวกับที่โหมดโรงหนังทำ
 * ไม่ใช่กันพื้นที่ไว้ข้างล่างแยกต่างหาก รูปของแขกจะได้ใหญ่เต็มเฟรมที่สุด
 *
 * คืนเป็นชั้นโปร่งใสขนาดเท่าเฟรม เพราะต้องใช้ทั้งกับรูป (composite ใน sharp)
 * และกับวิดีโอ (overlay ใน ffmpeg) ให้หน้าตาออกมาเหมือนกันเป๊ะ
 */
export async function captionLayer({ name, wish } = {}) {
  // ตัดช่องว่างก่อนตัดสินว่ามีอะไรจะเขียนไหม — แขกพิมพ์ชื่อเป็นเคาะวรรคล้วนได้จริง
  // และ Pango จะโยน "no text to render" ทำให้เฟรมนั้นพังทั้งใบ (เทสต์จับได้)
  const label = trim(name, 60);
  const words = trim(wish, 150);
  const hasWish = words.length > 0;
  if (!label && !hasWish) return null;

  const bandHeight = hasWish ? 330 : 200;
  const layers = [{
    input: svg(`<defs><linearGradient id="s" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="rgba(8,6,4,0.94)"/>
        <stop offset="55%" stop-color="rgba(8,6,4,0.72)"/>
        <stop offset="100%" stop-color="rgba(8,6,4,0)"/>
      </linearGradient></defs>
      <rect y="${FRAME_HEIGHT - bandHeight}" width="100%" height="${bandHeight}" fill="url(#s)"/>`),
    left: 0,
    top: 0,
  }];

  const parts = [];
  if (hasWish) {
    parts.push(await ink(escapeMarkup(words), {
      size: 40, colour: INK.cream, width: FRAME_WIDTH - 480, lineHeight: 1.3,
    }));
  }
  if (label) {
    parts.push(await ink(escapeMarkup(label), {
      size: 28, colour: INK.gold, spacing: 0.2,
    }));
  }

  const gap = 18;
  const total = parts.reduce((sum, part) => sum + part.info.height, 0) + gap * (parts.length - 1);
  let cursor = FRAME_HEIGHT - 62 - total;
  for (const part of parts) cursor = centred(layers, part, cursor) + gap;

  return sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * เฟรมของรูปหนึ่งใบ
 *
 * รูปจากมือถือส่วนใหญ่เป็นแนวตั้ง วางบนเฟรม 16:9 แล้วเหลือแถบดำสองข้าง จึงเอา
 * รูปเดิมมาเบลอเต็มเฟรมเป็นพื้นหลังเหมือนที่สไลด์โชว์ทำ — เต็มจอโดยไม่ต้อง crop
 * รูปของแขกทิ้ง และหนังกับจอในงานก็หน้าตาเป็นชุดเดียวกัน
 */
export async function photoFrame(sourcePath, { name, wish } = {}) {
  const raw = await fs.readFile(sourcePath);
  // หมุนตาม EXIF ครั้งเดียวตรงนี้ รูปจากไอโฟนที่ถ่ายแนวตั้งจะได้ไม่นอนทั้งเรื่อง
  const oriented = await sharp(raw, { failOn: 'none' }).rotate().toBuffer();

  const backdrop = await sharp(oriented)
    .resize(FRAME_WIDTH, FRAME_HEIGHT, { fit: 'cover' })
    .blur(38)
    .modulate({ brightness: 0.42, saturation: 0.8 })
    .toBuffer();

  const picture = await sharp(oriented)
    .resize(FRAME_WIDTH - 200, FRAME_HEIGHT - 84, { fit: 'inside', withoutEnlargement: false })
    .toBuffer({ resolveWithObject: true });

  const layers = [
    { input: backdrop, left: 0, top: 0 },
    {
      input: picture.data,
      left: Math.round((FRAME_WIDTH - picture.info.width) / 2),
      top: Math.round((FRAME_HEIGHT - picture.info.height) / 2),
    },
  ];

  const caption = await captionLayer({ name, wish });
  if (caption) layers.push({ input: caption, left: 0, top: 0 });
  layers.push({ input: await grain(), blend: 'overlay' });

  return sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3, background: INK.paper },
  })
    .composite(layers)
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/**
 * การ์ดข้อความล้วน — ใช้ทั้งการ์ดเปิดเรื่อง คำอวยพรที่ไม่ได้แนบรูป และการ์ดปิดท้าย
 * ทั้งสามใบหน้าตาเป็นชุดเดียวกัน ต่างกันแค่ขนาดตัวอักษรกับสิ่งที่ใส่เข้าไป
 */
export async function textCard({ eyebrow, headline, body, footer, big = false } = {}) {
  const layers = [{ input: darkBackdrop(), left: 0, top: 0 }];

  const blocks = [];
  eyebrow = trim(eyebrow, 40);
  headline = trim(headline, 260);
  body = trim(body, 200);
  footer = trim(footer, 120);

  if (eyebrow) {
    blocks.push(await ink(escapeMarkup(eyebrow), {
      size: big ? 64 : 44, colour: INK.gold, spacing: 0.3, bold: true,
    }));
  }
  if (eyebrow || headline) {
    const art = flourish(big ? 460 : 360);
    const meta = await sharp(art).png().toBuffer({ resolveWithObject: true });
    blocks.push(meta);
  }
  if (headline) {
    blocks.push(await ink(escapeMarkup(headline), {
      size: big ? 86 : 58, colour: INK.cream, width: FRAME_WIDTH - 420, lineHeight: 1.15,
    }));
  }
  if (body) {
    blocks.push(await ink(escapeMarkup(body), {
      size: 44, colour: INK.cream, width: FRAME_WIDTH - 620, lineHeight: 1.4,
    }));
  }
  if (footer) {
    blocks.push(await ink(escapeMarkup(footer), {
      size: 30, colour: INK.dim, spacing: 0.16, width: FRAME_WIDTH - 420,
    }));
  }

  // จัดทุกก้อนให้อยู่กลางเฟรมในแนวตั้ง โดยเว้นช่องไฟระหว่างก้อนเท่า ๆ กัน
  const gap = 40;
  const total = blocks.reduce((sum, block) => sum + block.info.height, 0) + gap * (blocks.length - 1);
  let cursor = (FRAME_HEIGHT - total) / 2;
  for (const block of blocks) cursor = centred(layers, block, cursor) + gap;

  layers.push({ input: await grain(), blend: 'overlay' });

  return sharp({
    create: { width: FRAME_WIDTH, height: FRAME_HEIGHT, channels: 3, background: INK.paper },
  })
    .composite(layers)
    .png({ compressionLevel: 6 })
    .toBuffer();
}

/** การ์ดเปิดเรื่อง ใช้ข้อมูลงานชุดเดียวกับที่การ์ด QR และสไลด์โชว์ใช้ */
export function openingCard() {
  const meta = [config.event.date, config.event.venue].filter(Boolean).join('   ·   ');
  return textCard({
    eyebrow: config.event.monogram,
    headline: config.event.coupleNames || config.event.title,
    footer: meta,
    big: true,
  });
}

/** การ์ดปิดท้าย ใช้ภาษาหลักของงานตามที่ตั้งไว้ใน .env */
export function closingCard(t) {
  return textCard({
    headline: t('film.thanks'),
    footer: config.event.coupleNames || config.event.title,
  });
}

/** การ์ดคำอวยพรที่แขกไม่ได้แนบรูปมา */
export function wishCard(message) {
  return textCard({
    eyebrow: '❞',
    headline: trim(message.body, 220),
    footer: message.author || null,
  });
}
