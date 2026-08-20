import fs from 'node:fs/promises';
import sharp from 'sharp';
import { FRAME_WIDTH, FRAME_HEIGHT, INK, escapeMarkup, grain, ink, trim } from './film.js';

/**
 * เฟรมแบบ "กำแพงรูป" สำหรับหนังที่ export — โพลารอยด์กระจายเต็มจอ ทีละใบสว่างขึ้นมา
 *
 * ทำไมไม่อัดหน้าจอจากสไลด์โชว์ของจริง: ในคอนเทนเนอร์ไม่มีเบราว์เซอร์ และการอัดจอ
 * แบบเรียลไทม์แปลว่าต้องรอเท่าความยาวหนังจริง ๆ ตรงนี้จึงประกอบเฟรมขึ้นเองด้วย sharp
 * ให้ได้อารมณ์เดียวกับกำแพงบนจอในงาน แต่เร็วกว่าและคมกว่า
 *
 * ต่างจากกำแพงบนเว็บตรงที่ตรงนี้เป็นภาพนิ่งทีละเฟรม ไม่มีการเลื่อนไหลระหว่างใบ
 * ความรู้สึก "ทีละใบสว่างขึ้นมา" มาจากการที่แต่ละคลิปเฟดเข้าออกต่อกัน
 */

const COLS = 5;
const ROWS = 3;
export const SLOTS = COLS * ROWS;

const CARD_PAD = 0.055;      // ขอบกรอบโพลารอยด์ เทียบกับความกว้างการ์ด
const CARD_FOOT = 0.17;      // ขอบล่างที่หนากว่า ไว้ใส่ชื่อคนส่ง
const DIM = 0.42;            // ใบที่ไม่ใช่ไฮไลท์หรี่ลงเท่าไหร่

/**
 * ตำแหน่งและมุมเอียงของแต่ละช่อง — คงที่ ไม่สุ่มใหม่ทุกเฟรม
 *
 * ถ้าสุ่มใหม่ทุกเฟรม กำแพงจะกระโดดไปมาทั้งจอทุกครั้งที่เปลี่ยนไฮไลท์
 * ซึ่งดูเหมือนภาพเสียมากกว่ากองรูปที่วางนิ่งอยู่บนโต๊ะ
 */
function slots() {
  const out = [];
  for (let row = 0; row < ROWS; row += 1) {
    for (let col = 0; col < COLS; col += 1) {
      const noise = Math.sin((row * 7 + col * 13 + 1) * 12.9898) * 43758.5453;
      const jitterX = (((noise % 1) + 1) % 1) - 0.5;
      const jitterY = ((((noise * 1.7) % 1) + 1) % 1) - 0.5;
      out.push({
        x: (col + 0.5) / COLS + jitterX * 0.055,
        y: (row + 0.5) / ROWS + jitterY * 0.06,
        rotate: jitterX * 14,
        shrink: 0.84 + Math.abs(jitterY) * 0.3,
      });
    }
  }
  return out;
}

const SLOT_LIST = slots();

/** พื้นกำแพง — ไล่เฉดมืดกับลายกระเบื้องจาง ๆ แบบเดียวกับ .wall ในหน้าเว็บ */
function backdrop() {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${FRAME_WIDTH}" height="${FRAME_HEIGHT}">
    <defs>
      <radialGradient id="g" cx="50%" cy="42%" r="78%">
        <stop offset="0%" stop-color="#241a12"/>
        <stop offset="62%" stop-color="#14100c"/>
        <stop offset="100%" stop-color="#0b0806"/>
      </radialGradient>
      <pattern id="tile" width="84" height="84" patternUnits="userSpaceOnUse">
        <rect width="84" height="84" fill="none"/>
        <path d="M0 0H84M0 0V84" stroke="rgba(255,255,255,0.035)" stroke-width="1"/>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect width="100%" height="100%" fill="url(#tile)"/>
  </svg>`);
}

/**
 * โพลารอยด์หนึ่งใบ — คืนภาพโปร่งใสที่หมุนเอียงแล้ว พร้อมขนาดจริงหลังหมุน
 *
 * ช่องว่างสำหรับรูป (hole) มีไว้ให้ ffmpeg เอาวิดีโอไปวางข้างหลังทีหลัง
 * การ์ดจึงถูกวาดโดยเว้นรูตรงกลางไว้ ไม่ใช่วาดรูปทับลงไป
 */
async function card({ photoPath, name, width, rotate, hole = false }) {
  const pad = Math.round(width * CARD_PAD);
  const photoWidth = width - pad * 2;
  const photoHeight = Math.round(photoWidth * 1.18);
  const foot = Math.round(width * CARD_FOOT);
  const height = pad + photoHeight + foot;

  const layers = [];

  if (!hole && photoPath) {
    const raw = await fs.readFile(photoPath);
    const photo = await sharp(raw, { failOn: 'none' })
      .rotate()
      .resize(photoWidth, photoHeight, { fit: 'cover' })
      .toBuffer();
    layers.push({ input: photo, left: pad, top: pad });
  } else if (hole) {
    // เจาะรูโปร่งใสตรงช่องรูป เพื่อให้วิดีโอที่อยู่ข้างหลังทะลุขึ้นมาเห็นได้
    //
    // ต้องเป็นสี่เหลี่ยม "ทึบ" ไม่ใช่โปร่งใส — dest-out ลบตามค่า alpha ของภาพที่เอามาทาบ
    // ทาบด้วยของโปร่งใสจึงไม่ลบอะไรเลย ครั้งแรกทำผิดตรงนี้ ได้การ์ดขาวเปล่า
    // วิดีโอเล่นอยู่ข้างหลังแต่ไม่มีรูให้ทะลุขึ้นมา
    layers.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${photoWidth}" height="${photoHeight}">
        <rect width="100%" height="100%" fill="#000"/></svg>`),
      left: pad,
      top: pad,
      blend: 'dest-out',
    });
  }

  if (name) {
    const label = await ink(escapeMarkup(trim(name, 28)), {
      size: Math.max(9, Math.round(width * 0.062)),
      colour: '#4a3f31',
      width: photoWidth,
    });
    layers.push({
      input: label.data,
      left: Math.round((width - label.info.width) / 2),
      top: Math.min(pad + photoHeight + Math.round(foot * 0.22), height - label.info.height - 2),
    });
  }

  const flat = await sharp({
    create: { width, height, channels: 4, background: '#fbf7ef' },
  })
    .composite(layers)
    .png()
    .toBuffer();

  const rotated = await sharp(flat)
    .rotate(rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer({ resolveWithObject: true });

  return { data: rotated.data, width: rotated.info.width, height: rotated.info.height };
}

function clamp(value, low, high) {
  return high < low ? Math.round((low + high) / 2) : Math.min(Math.max(value, low), high);
}

/**
 * เฟรมกำแพงหนึ่งเฟรม โดยใบที่ index = hot ถูกยกขึ้นมาใหญ่และสว่างเต็มที่
 *
 * neighbours คือรายการที่จะวางเป็นฉากหลัง ใช้รูปย่อเพราะมีสิบกว่าใบต่อเฟรม
 * ถ้าใช้รูปเต็มทุกใบ การประกอบเฟรมเดียวจะกินเวลาและแรมเกินจำเป็นมาก
 */
export async function wallFrame({ neighbours, hot, hotIsVideo = false }) {
  const layers = [{ input: backdrop(), left: 0, top: 0 }];
  const slotWidth = FRAME_WIDTH / COLS;

  // ── ใบรอบ ๆ ────────────────────────────────────────────────────────────
  for (let index = 0; index < SLOT_LIST.length && index < neighbours.length; index += 1) {
    const slot = SLOT_LIST[index];
    const entry = neighbours[index];
    if (!entry) continue;

    const width = Math.round(slotWidth * 0.66 * slot.shrink);
    let piece;
    try {
      piece = await card({ photoPath: entry.photoPath, name: entry.name, width, rotate: slot.rotate });
    } catch {
      continue; // รูปเสียใบเดียวไม่ควรทำให้ทั้งเฟรมพัง
    }

    const dimmed = await sharp(piece.data).modulate({ brightness: DIM }).png().toBuffer();
    layers.push({
      input: dimmed,
      left: clamp(Math.round(slot.x * FRAME_WIDTH - piece.width / 2), 0, FRAME_WIDTH - piece.width),
      top: clamp(Math.round(slot.y * FRAME_HEIGHT - piece.height / 2), 0, FRAME_HEIGHT - piece.height),
    });
  }

  // ── ใบไฮไลท์ วางทับตรงกลาง ไม่เอียง ────────────────────────────────────
  const hotWidth = Math.round(FRAME_WIDTH * 0.26);
  const hotCard = await card({
    photoPath: hot.photoPath,
    name: hot.name,
    width: hotWidth,
    rotate: 0,
    hole: hotIsVideo,
  });

  const left = Math.round((FRAME_WIDTH - hotCard.width) / 2);
  const top = Math.round((FRAME_HEIGHT - hotCard.height) / 2);

  // เงาใต้ใบไฮไลท์ ทำให้มันลอยเหนือกองรูปอย่างเห็นได้ชัด
  // เบลอก่อนวาง ไม่งั้นได้สี่เหลี่ยมดำขอบคมซึ่งดูเหมือนภาพผิดมากกว่าเงา
  const shadow = await sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${hotCard.width + 120}" height="${hotCard.height + 120}">
      <rect x="46" y="46" width="${hotCard.width + 28}" height="${hotCard.height + 34}"
            rx="12" fill="rgba(0,0,0,0.72)"/></svg>`))
    .blur(22)
    .png()
    .toBuffer();
  layers.push({ input: shadow, left: left - 60, top: top - 60 });
  layers.push({ input: hotCard.data, left, top });

  // ตำแหน่งช่องรูปของใบไฮไลท์ ffmpeg เอาไปวางวิดีโอให้ทะลุรูขึ้นมาพอดี
  const pad = Math.round(hotWidth * CARD_PAD);
  const window = {
    left: left + pad,
    top: top + pad,
    width: hotWidth - pad * 2,
    height: Math.round((hotWidth - pad * 2) * 1.18),
  };

  const stack = [...layers, { input: await grain(), blend: 'overlay' }];

  // เจาะรูทะลุ "ทั้งเฟรม" ไม่ใช่แค่ในตัวการ์ด
  //
  // ครั้งแรกเจาะไว้ตอนสร้างการ์ด แล้วรูถูกถมกลับด้วยพื้นกำแพงตอนประกอบชั้นสุดท้าย
  // ผลคือได้การ์ดขาวเปล่า วิดีโอเล่นอยู่ข้างหลังแต่ไม่มีทางทะลุขึ้นมา
  if (hotIsVideo) {
    stack.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${window.width}" height="${window.height}">
        <rect width="100%" height="100%" fill="#000"/></svg>`),
      left: window.left,
      top: window.top,
      blend: 'dest-out',
    });
  }

  const png = await sharp({
    create: {
      width: FRAME_WIDTH,
      height: FRAME_HEIGHT,
      channels: 4,
      background: hotIsVideo ? { r: 20, g: 16, b: 12, alpha: 1 } : INK.paper,
    },
  })
    .composite(stack)
    .png({ compressionLevel: 6 })
    .toBuffer();

  return { png, window };
}
