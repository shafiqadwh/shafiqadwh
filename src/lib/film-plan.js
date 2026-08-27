import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

/**
 * เลือกและเรียงลำดับสิ่งที่จะเข้าหนัง — ส่วนที่เป็นตรรกะล้วน ไม่ยุ่งกับ ffmpeg
 * แยกออกมาจากสคริปต์เพื่อให้เขียนเทสต์จับได้ว่าอะไรถูกตัดทิ้งและอะไรถูกเรียงไว้ตรงไหน
 */

// ── หยิบของออกมาจากฐานข้อมูล ────────────────────────────────────────────────

export function readDeck() {
  // เปิดแบบอ่านอย่างเดียว — สคริปต์นี้รันคู่ไปกับเว็บที่ยังเปิดอยู่ได้ และไม่มีทาง
  // เขียนทับอะไรแม้โค้ดจะมีบั๊ก
  const db = new Database(config.paths.db, { readonly: true, fileMustExist: true });
  try {
    // `deleted_at IS NULL` ขาดไม่ได้ และไม่ได้ซ้ำซ้อนกับ status —
    // การลบรูปไม่ได้แตะ status เลย รูปในถังขยะจึงยังเป็น 'visible' อยู่ทุกใบ
    // ตกบรรทัดนี้เมื่อไร หนังจะหยิบรูปที่เจ้าภาพตั้งใจลบทิ้งกลับมาใส่ให้ (เจอมาแล้วจริง)
    const items = db.prepare(`
      SELECT id, kind, stored_name, playback_name, thumb_name, bytes, width, height, duration, uploader
      FROM items
      WHERE status = 'visible' AND deleted_at IS NULL
      ORDER BY id ASC
    `).all();

    const messages = db.prepare(`
      SELECT id, author, body, item_id
      FROM messages
      WHERE status = 'visible'
      ORDER BY id ASC
    `).all();

    return { items, messages };
  } finally {
    db.close();
  }
}

/**
 * ตัดไฟล์ที่อัปซ้ำออก
 *
 * เจ้าของขอว่า "แสดงรูปไม่ซ้ำกัน" — ในงานจริงมีรูปเดียวกันถูกส่งเข้ามาหลายครั้ง
 * ทั้งจากคนเดียวกันกดซ้ำ และจากการที่รูปถูกส่งต่อกันในไลน์แล้วหลายคนอัปเข้ามา
 *
 * เทียบด้วยแฮชของเนื้อไฟล์จริง ไม่ใช่ขนาดไฟล์
 *
 * เดิมใช้ขนาดไบต์บวกมิติ คิดว่าไฟล์คนละใบคงไม่บังเอิญเท่ากันเป๊ะ — ผิด
 * ตอนทดสอบด้วยรูปสีพื้น 8 ใบคนละสี ถูกตัดทิ้งไป 2 ใบเพราะบีบอัดแล้วได้ขนาด
 * เท่ากันพอดี รูปงานจริงคงไม่ชนกันแบบนั้น แต่ "คงไม่" ไม่ดีพอสำหรับของที่
 * ตัดรูปของแขกทิ้งถาวรโดยไม่มีใครรู้
 *
 * อ่านไฟล์ทั้งหมดมาแฮชกินเวลาราวสิบวินาทีต่อรูปพันใบ ซึ่งไม่มีความหมายเลย
 * เทียบกับเวลาเข้ารหัสทั้งเรื่อง
 */
export async function dedupe(items) {
  const seen = new Map();
  const kept = [];

  for (const item of items) {
    let digest;
    try {
      digest = await hashFile(sourceFor(item));
    } catch {
      // อ่านไฟล์ไม่ได้ ปล่อยผ่านไปให้ขั้นตอนสร้างคลิปเป็นคนรายงานปัญหา
      kept.push(item);
      continue;
    }

    if (seen.has(digest)) continue;
    seen.set(digest, item.id);
    kept.push(item);
  }

  return kept;
}

export function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * รูปย่อของ item นี้ ถ้ามี
 *
 * โหมดกำแพงวางรูปสิบกว่าใบต่อเฟรม ถ้าอ่านไฟล์เต็มทุกใบทุกเฟรม การประกอบหนัง
 * จะช้าขึ้นหลายเท่าโดยที่ตาคนดูไม่เห็นความต่าง เพราะการ์ดกว้างไม่กี่ร้อยพิกเซล
 */
export function thumbFor(item) {
  return item.thumb_name ? path.join(config.paths.derived, item.thumb_name) : null;
}

/** ไฟล์จริงของ item นี้ — ใช้ตัวที่แปลงแล้วถ้ามี เหมือนที่ /media ทำ */
export function sourceFor(item) {
  return item.playback_name
    ? path.join(config.paths.derived, item.playback_name)
    : path.join(config.paths.uploads, item.stored_name);
}

/**
 * เรียงลำดับเรื่อง
 *
 * รูปเรียงตาม id ซึ่งคือลำดับเวลาที่แขกส่งเข้ามาจริง ๆ หนังจึงเดินไปตามงาน
 * ตั้งแต่คนมาถึงจนเลิกงานเองโดยไม่ต้องจัดอะไรเพิ่ม
 *
 * คำอวยพรที่แนบรูปมาจะไปเกาะกับรูปใบนั้น ส่วนที่ไม่แนบจะถูกโรยแทรกให้ห่างเท่า ๆ กัน
 * ตลอดเรื่อง ไม่กองรวมกันท้ายเรื่องจนคนดูเบื่อ
 */
export function buildTimeline({ items, messages }, options) {
  const wishFor = new Map();
  const loose = [];
  for (const message of messages) {
    if (message.item_id) wishFor.set(message.item_id, message);
    else loose.push(message);
  }

  const media = options.limit > 0 ? items.slice(0, options.limit) : items;
  const every = loose.length > 0 ? Math.max(4, Math.floor(media.length / (loose.length + 1))) : 0;

  const timeline = [{ key: 'opening', kind: 'opening' }];
  let next = 0;

  media.forEach((item, index) => {
    const wish = wishFor.get(item.id);
    timeline.push({
      key: `${item.kind}-${item.id}`,
      kind: item.kind,
      item,
      name: (wish && wish.author) || item.uploader,
      wish: wish ? wish.body : null,
    });

    if (every > 0 && next < loose.length && (index + 1) % every === 0) {
      const message = loose[next];
      next += 1;
      timeline.push({ key: `wish-${message.id}`, kind: 'wish', message });
    }
  });

  // คำอวยพรที่ยังไม่ได้แทรก (เช่นมีคำอวยพรมากกว่ารูป) ต่อท้ายก่อนการ์ดปิด
  for (; next < loose.length; next += 1) {
    timeline.push({ key: `wish-${loose[next].id}`, kind: 'wish', message: loose[next] });
  }

  timeline.push({ key: 'closing', kind: 'closing' });
  return timeline;
}

/**
 * คิดเองว่ารูปหนึ่งใบควรอยู่กี่วินาที และหนังทั้งเรื่องจะยาวเท่าไร
 *
 * งานหนึ่งมีรูปกี่ใบเดาไม่ได้ล่วงหน้า — งานเล็กอาจมีสามสิบใบ งานที่แขกพันคนอาจมี
 * สองพันใบ ถ้าตั้งวินาทีต่อใบตายตัวไว้ อย่างใดอย่างหนึ่งจะพัง: หกวินาทีกับสามสิบใบ
 * ได้หนังสามนาทีที่จบก่อนคนจะนั่งลง ส่วนหกวินาทีกับสองพันใบได้หนังสามชั่วโมง
 *
 * จึงไล่ระดับตามจำนวนรูป แล้ว **คุมไว้ในช่วง 4–8 วินาที** สองด้าน
 * ต่ำกว่าสี่วินาทีคนดูไม่ทันว่าในรูปมีใคร สูงกว่าแปดวินาทีรูปเดียวก็เริ่มน่าเบื่อ
 */
export const SECONDS_FLOOR = 4;
export const SECONDS_CEILING = 8;

export function secondsForPhotos(count) {
  if (count <= 0) return SECONDS_CEILING;
  if (count <= 40) return SECONDS_CEILING;
  if (count <= 120) return 7;
  if (count <= 300) return 6;
  if (count <= 700) return 5;
  return SECONDS_FLOOR;
}

/**
 * ความยาวรวมที่คาดไว้ คิดจากไทม์ไลน์จริง ไม่ใช่จำนวนรูปคูณ ๆ กันคร่าว ๆ
 *
 * ค่าพื้นของการ์ดเปิด/ปิด/คำอวยพรต้องตรงกับที่ `buildClip()` ใน film-run.js ใช้จริง
 * ไม่งั้นตัวเลขที่โชว์ก่อนกดปุ่มจะไม่ตรงกับหนังที่ได้ ซึ่งแย่กว่าไม่โชว์เลย
 */
export function planLength(timeline, { seconds = 'auto', maxVideoSeconds = 30 } = {}) {
  const photos = timeline.filter((entry) => entry.kind === 'image').length;
  const perPhoto = seconds === 'auto' || !Number.isFinite(Number(seconds))
    ? secondsForPhotos(photos)
    : Math.min(Math.max(Math.round(Number(seconds)), 1), 60);

  let total = 0;
  for (const entry of timeline) {
    if (entry.kind === 'video') {
      // ความยาวจริงอยู่ในฐานข้อมูลแล้ว ไม่ต้องเปิดไฟล์ซ้ำ คลิปที่ยาวเกินถูกตัด
      const duration = Number(entry.item?.duration) || maxVideoSeconds;
      total += Math.min(duration, maxVideoSeconds);
    } else if (entry.kind === 'opening' || entry.kind === 'closing') {
      total += Math.max(perPhoto, 7);
    } else if (entry.kind === 'wish') {
      total += Math.max(perPhoto, 8);
    } else {
      total += perPhoto;
    }
  }

  return { secondsPerPhoto: perPhoto, totalSeconds: Math.round(total), photos };
}
