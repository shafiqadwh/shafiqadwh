import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../config.js';
import { ink, trim } from './film.js';
import { normaliseName, pickDisplayName } from './guests.js';
import { listItemsForPaper, listMessagesForPaper } from '../repo.js';
import { sourceFor, thumbFor } from './film-plan.js';

/**
 * เรียงหน้ากระดาษ A4 สำหรับ PDF สองเล่ม — สมุดคำอวยพร กับ รายชื่อคนอัพรูป
 *
 * ตัวหนังสือทุกตัวเรนเดอร์ด้วย `ink()` จาก film.js ซึ่งเป็น Pango ที่ติดมากับ sharp
 * ห้ามเขียนตัวเรนเดอร์ใหม่: ตัวนั้นคือตัวเดียวในโปรเจกต์ที่พิสูจน์แล้วว่าวางสระกับ
 * วรรณยุกต์ไทยถูก และเรียงอาหรับขวาไปซ้ายถูก
 *
 * หนึ่งหน้า = หนึ่งภาพ JPEG แล้วให้ pdf.js ห่อเป็นไฟล์ — เหตุผลอยู่ในหัวไฟล์นั้น
 */

// A4 ที่ 150 DPI — ละเอียดพอสำหรับพิมพ์จริง โดยไฟล์ยังไม่ใหญ่จนส่งทางไลน์ไม่ได้
export const PAGE = { width: 1240, height: 1754 };
const MARGIN = { top: 110, bottom: 130, left: 100, right: 100 };
const COLUMN = PAGE.width - MARGIN.left - MARGIN.right;

// ชุดสีสำหรับกระดาษ ไม่ใช่ชุดสีของหนัง — บนจอเรามีพื้นมืดให้เล่น บนกระดาษไม่มี
// พิมพ์พื้นเข้มเต็มหน้าเปลืองหมึกและอ่านยากกว่าเดิม
const PAPER = {
  bg: '#fdfaf3',
  ink: '#2a231a',
  soft: '#6f6049',
  rule: '#ddd0b6',
  accent: '#9c7838',
};

const JPEG = { quality: 82, mozjpeg: true, chromaSubsampling: '4:4:4' };

/** หน้ากระดาษที่กำลังเรียงอยู่ — สะสม layer ไว้ แล้วบอกได้ว่าเหลือที่ว่างเท่าไร */
function newSheet() {
  return { layers: [], y: MARGIN.top };
}

const roomLeft = (sheet) => PAGE.height - MARGIN.bottom - sheet.y;

function place(sheet, block, { left = MARGIN.left, gap = 0 } = {}) {
  sheet.layers.push({ input: block.data, left: Math.round(left), top: Math.round(sheet.y) });
  sheet.y += block.info.height + gap;
}

function rule(width, colour = PAPER.rule) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="2">`
    + `<rect width="${width}" height="1" y="0.5" fill="${colour}"/></svg>`,
  );
}

/** ปิดหน้านี้เป็นภาพหนึ่งใบ พร้อมเลขหน้าที่ขอบล่าง */
async function flush(sheet, pageNumber) {
  const layers = [...sheet.layers];

  if (pageNumber > 1) {
    const label = await ink(String(pageNumber), {
      size: 20, colour: PAPER.soft, width: COLUMN, align: 'centre',
    });
    layers.push({
      input: label.data,
      left: Math.round(MARGIN.left + (COLUMN - label.info.width) / 2),
      top: PAGE.height - 78,
    });
  }

  return sharp({
    create: { width: PAGE.width, height: PAGE.height, channels: 3, background: PAPER.bg },
  })
    .composite(layers)
    .jpeg(JPEG)
    .toBuffer();
}

/** หน้าปกของทั้งสองเล่ม — จัดกลางแนวตั้ง ใช้ข้อมูลงานชุดเดียวกับการ์ด QR และหนัง */
async function coverPage(heading, subtitle) {
  const blocks = [];
  if (config.event.monogram) {
    blocks.push(await ink(config.event.monogram, {
      size: 44, colour: PAPER.accent, width: COLUMN, align: 'centre', spacing: 0.3,
    }));
  }
  blocks.push(await ink(heading, {
    size: 66, colour: PAPER.ink, width: COLUMN, align: 'centre', bold: true, lineHeight: 1.2,
  }));
  if (config.event.names) {
    blocks.push(await ink(config.event.names, {
      size: 40, colour: PAPER.ink, width: COLUMN, align: 'centre', lineHeight: 1.3,
    }));
  }
  const meta = [config.event.date, config.event.venue].filter(Boolean).join('   ·   ');
  if (meta) {
    blocks.push(await ink(meta, {
      size: 26, colour: PAPER.soft, width: COLUMN, align: 'centre',
    }));
  }
  if (subtitle) {
    blocks.push(await ink(subtitle, {
      size: 24, colour: PAPER.soft, width: COLUMN, align: 'centre',
    }));
  }

  const gap = 46;
  const total = blocks.reduce((sum, b) => sum + b.info.height, 0) + gap * (blocks.length - 1);
  const sheet = newSheet();
  sheet.y = (PAGE.height - total) / 2;
  for (const block of blocks) {
    place(sheet, block, { left: MARGIN.left + (COLUMN - block.info.width) / 2, gap });
  }

  return flush(sheet, 1);
}

/**
 * หัวชื่อแขกหนึ่งคน คืนความสูงรวมไว้ให้ผู้เรียกเช็คก่อนว่าลงหน้านี้พอไหม
 * ต้องรู้ความสูงก่อนวาง ไม่งั้นหัวชื่อจะไปโดดอยู่ท้ายหน้าโดยไม่มีเนื้อหาตามมา
 */
async function guestHeading(name, note) {
  const title = await ink(name, {
    size: 38, colour: PAPER.accent, width: COLUMN, bold: true, align: 'left',
  });
  const sub = note
    ? await ink(note, { size: 21, colour: PAPER.soft, width: COLUMN, align: 'left' })
    : null;
  return { title, sub, height: title.info.height + (sub ? sub.info.height + 6 : 0) + 26 };
}

function placeHeading(sheet, heading) {
  place(sheet, heading.title, { gap: heading.sub ? 6 : 12 });
  if (heading.sub) place(sheet, heading.sub, { gap: 12 });
  sheet.layers.push({ input: rule(COLUMN), left: MARGIN.left, top: Math.round(sheet.y) });
  sheet.y += 14;
}

/**
 * วันที่แบบสั้นสำหรับกำกับใต้คำอวยพร ตามภาษาของเล่มนั้น
 * เล่มภาษาไทยได้ พ.ศ. เล่มอาหรับได้เลขอาหรับ — ไม่ใช่ทุกเล่มเป็นอังกฤษเหมือนกันหมด
 */
function shortDate(value, lang) {
  const date = new Date(`${String(value ?? '').replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat(lang, {
    // TZ ถูกตั้งไว้ใน docker-compose แล้ว ปล่อยให้ Node ใช้เขตเวลาของคอนเทนเนอร์
    // ตรงกับเวลาที่แขกเห็นบนหน้าเว็บ ไม่ต้องมีค่าคงที่ซ้ำอีกที่
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

/**
 * รูปที่แนบมากับคำอวยพร ย่อให้พอดีกรอบ
 *
 * วิดีโอใช้ภาพปกที่ระบบทำไว้แล้วตอนอัพโหลด — เฟรมวิดีโอในกระดาษทำอะไรไม่ได้อยู่แล้ว
 * ถ้าไฟล์หาย (ลบทิ้งจาก File Station) ให้ข้ามไป ไม่ใช่ทำทั้งเล่มพัง
 */
async function attachment(item, box) {
  const file = item.item_kind === 'video' || item.kind === 'video'
    ? thumbFor({ thumb_name: item.item_thumb ?? item.thumb_name })
    : (thumbFor({ thumb_name: item.item_thumb ?? item.thumb_name })
      ?? sourceFor({ stored_name: item.item_stored ?? item.stored_name }));
  if (!file) return null;

  try {
    await fs.access(file);
  } catch {
    return null;
  }

  try {
    const { data, info } = await sharp(file, { failOn: 'none' })
      .rotate()
      .resize(box.width, box.height, { fit: 'inside', withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });
    return { data, info };
  } catch {
    return null;
  }
}

/** กรอบบาง ๆ รอบรูป ให้รูปพื้นขาวไม่กลืนไปกับกระดาษ */
function frame(width, height) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 8}" height="${height + 8}">`
    + `<rect x="0.5" y="0.5" width="${width + 7}" height="${height + 7}" rx="3" `
    + `fill="none" stroke="${PAPER.rule}"/></svg>`,
  );
}

/**
 * เล่มที่ 1 — สมุดคำอวยพร จัดกลุ่มตามชื่อแขก ไหลต่อกันไป
 *
 * ชื่อคนเดียวกันที่ยาวข้ามหน้าจะขึ้นหัวซ้ำพร้อมคำว่า "(ต่อ)" — ไม่งั้นคนอ่านหน้าถัดไป
 * จะไม่รู้ว่าคำอวยพรที่เห็นอยู่เป็นของใคร
 */
export async function wishesPages(t, lang = 'th', onProgress = () => {}) {
  const rows = listMessagesForPaper();

  const byGuest = new Map();
  for (const row of rows) {
    const key = normaliseName(row.author);
    if (!byGuest.has(key)) byGuest.set(key, []);
    byGuest.get(key).push(row);
  }

  const collator = new Intl.Collator([lang, 'th', 'ms', 'en', 'ar'], { sensitivity: 'base', numeric: true });
  const guests = [...byGuest.entries()]
    .map(([key, messages]) => ({
      key,
      messages,
      name: key === '' ? t('gallery.anonymous') : pickDisplayName(messages.map((m) => m.author)),
    }))
    .sort((a, b) => {
      if ((a.key === '') !== (b.key === '')) return a.key === '' ? 1 : -1;
      return collator.compare(a.name, b.name);
    });

  const pages = [];
  let sheet = newSheet();
  let pageNumber = 1;

  const startNewPage = async () => {
    pages.push({ jpeg: await flush(sheet, pageNumber), width: PAGE.width, height: PAGE.height });
    pageNumber += 1;
    sheet = newSheet();
  };

  pages.push({
    jpeg: await coverPage(t('paper.wishes_title'), t('paper.wishes_subtitle', { n: rows.length })),
    width: PAGE.width,
    height: PAGE.height,
  });
  pageNumber = 2;

  let done = 0;
  for (const guest of guests) {
    let heading = await guestHeading(guest.name, t('paper.wishes_from', { n: guest.messages.length }));
    let headingPlaced = false;
    // แยก "หน้านี้ยังไม่ได้วางหัว" ออกจาก "แขกคนนี้ยังไม่เคยขึ้นหัวเลย" — ไม่งั้นแขก
    // ที่ขึ้นต้นพอดีตอนขึ้นหน้าใหม่ จะได้คำว่า (ต่อ) ทั้งที่เพิ่งเริ่มบรรทัดแรกของตัวเอง
    let everPlaced = false;

    for (const message of guest.messages) {
      const body = await ink(trim(message.body, 900), {
        size: 27, colour: PAPER.ink, width: COLUMN - 40, align: 'left', lineHeight: 1.45,
      });
      const stamp = await ink(shortDate(message.created_at, lang), {
        size: 18, colour: PAPER.soft, width: COLUMN - 40, align: 'left',
      });
      const picture = message.item_id && message.item_status !== 'hidden'
        ? await attachment(message, { width: 520, height: 520 })
        : null;

      const blockHeight = body.info.height + 8 + stamp.info.height
        + (picture ? picture.info.height + 26 : 0) + 40;
      const need = blockHeight + (headingPlaced ? 0 : heading.height);

      if (roomLeft(sheet) < need && sheet.y > MARGIN.top) {
        await startNewPage();
        headingPlaced = false;
        if (everPlaced) heading = await guestHeading(`${guest.name} ${t('paper.continued')}`, null);
      }

      if (!headingPlaced) {
        placeHeading(sheet, heading);
        headingPlaced = true;
        everPlaced = true;
      }

      place(sheet, body, { left: MARGIN.left + 40, gap: 8 });
      place(sheet, stamp, { left: MARGIN.left + 40, gap: picture ? 26 : 40 });

      if (picture) {
        sheet.layers.push({
          input: frame(picture.info.width, picture.info.height),
          left: MARGIN.left + 36,
          top: Math.round(sheet.y - 4),
        });
        place(sheet, picture, { left: MARGIN.left + 40, gap: 40 });
      }

      done += 1;
      onProgress({ done, total: rows.length });
    }

    sheet.y += 18;
  }

  if (sheet.layers.length > 0) await startNewPage();
  return { pages, counts: { guests: guests.length, wishes: rows.length } };
}

/**
 * เล่มที่ 2 — ใครส่งรูปอะไรมาบ้าง ชื่อแขกแล้วตามด้วยรูปย่อทุกใบของคนนั้น
 *
 * ใช้ภาพย่อที่ระบบทำไว้ตอนอัพโหลดอยู่แล้ว ไม่ต้องเปิดไฟล์ต้นฉบับความละเอียดเต็ม
 * ซึ่งบนงานที่มีรูปเป็นพันใบคือความต่างระหว่างไม่กี่นาทีกับครึ่งชั่วโมง
 */
export async function uploadersPages(t, lang = 'th', onProgress = () => {}) {
  const rows = listItemsForPaper();

  const byGuest = new Map();
  for (const row of rows) {
    const key = normaliseName(row.uploader);
    if (!byGuest.has(key)) byGuest.set(key, []);
    byGuest.get(key).push(row);
  }

  const collator = new Intl.Collator([lang, 'th', 'ms', 'en', 'ar'], { sensitivity: 'base', numeric: true });
  const guests = [...byGuest.entries()]
    .map(([key, items]) => ({
      key,
      items,
      name: key === '' ? t('gallery.anonymous') : pickDisplayName(items.map((i) => i.uploader)),
    }))
    .sort((a, b) => {
      if ((a.key === '') !== (b.key === '')) return a.key === '' ? 1 : -1;
      return collator.compare(a.name, b.name);
    });

  const COLUMNS = 4;
  const GAP = 18;
  const CELL = Math.floor((COLUMN - GAP * (COLUMNS - 1)) / COLUMNS);

  const pages = [];
  let sheet = newSheet();
  let pageNumber = 1;

  const startNewPage = async () => {
    pages.push({ jpeg: await flush(sheet, pageNumber), width: PAGE.width, height: PAGE.height });
    pageNumber += 1;
    sheet = newSheet();
  };

  pages.push({
    jpeg: await coverPage(t('paper.uploaders_title'), t('paper.uploaders_subtitle', { n: rows.length })),
    width: PAGE.width,
    height: PAGE.height,
  });
  pageNumber = 2;

  let done = 0;
  for (const guest of guests) {
    const photos = guest.items.filter((i) => i.kind === 'image').length;
    const videos = guest.items.length - photos;
    let heading = await guestHeading(guest.name, t('paper.uploaded_count', { photos, videos }));
    let headingPlaced = false;
    let everPlaced = false;

    for (let index = 0; index < guest.items.length; index += COLUMNS) {
      const row = guest.items.slice(index, index + COLUMNS);
      const need = CELL + GAP + (headingPlaced ? 0 : heading.height);

      if (roomLeft(sheet) < need && sheet.y > MARGIN.top) {
        await startNewPage();
        headingPlaced = false;
        if (everPlaced) heading = await guestHeading(`${guest.name} ${t('paper.continued')}`, null);
      }

      if (!headingPlaced) {
        placeHeading(sheet, heading);
        headingPlaced = true;
        everPlaced = true;
      }

      for (let column = 0; column < row.length; column += 1) {
        const item = row[column];
        const file = thumbFor(item);
        const left = MARGIN.left + column * (CELL + GAP);
        if (!file) continue;

        try {
          await fs.access(file);
          const cell = await sharp(file, { failOn: 'none' })
            .rotate()
            .resize(CELL, CELL, { fit: 'cover', position: 'attention' })
            .toBuffer();
          sheet.layers.push({ input: cell, left, top: Math.round(sheet.y) });
        } catch {
          // ไฟล์ย่อหาย — เว้นช่องไว้เฉย ๆ ดีกว่าทำทั้งเล่มพัง
          continue;
        }

        if (item.kind === 'video') {
          sheet.layers.push({
            input: Buffer.from(
              `<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34">`
              + `<circle cx="17" cy="17" r="16" fill="rgba(12,9,6,0.62)"/>`
              + `<path d="M13 10l12 7-12 7z" fill="#fdfaf3"/></svg>`,
            ),
            left: left + CELL - 42,
            top: Math.round(sheet.y) + CELL - 42,
          });
        }

        done += 1;
        onProgress({ done, total: rows.length });
      }

      sheet.y += CELL + GAP;
    }

    sheet.y += 20;
  }

  if (sheet.layers.length > 0) await startNewPage();
  return { pages, counts: { guests: guests.length, items: rows.length } };
}
