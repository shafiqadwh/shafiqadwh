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
    const items = db.prepare(`
      SELECT id, kind, stored_name, playback_name, bytes, width, height, duration, uploader
      FROM items
      WHERE status = 'visible'
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

