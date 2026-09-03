import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { config } from '../config.js';

/**
 * ทั้งอัลบั้มของบูธเป็นไฟล์เดียว
 *
 * แยกจาก `zip.js` (ของแขกที่อัปโหลดผ่านเว็บ) เพราะเป็นคนละงานคนละตาราง — ความ
 * แยกขาดระหว่างรูปเว็บกับรูปบูธเป็นกติกาของโปรเจกต์นี้ ไม่ใช่เรื่องบังเอิญ
 *
 * สตรีมออกไปเลย ไม่ประกอบไว้ในหน่วยความจำก่อน · งานสามวันคือแผ่นหลายร้อยใบบวก
 * รูปดิบอีกหลายเท่า ส่วน NAS ที่รันอยู่มีแรมจำกัด
 */

/** ชื่อในไฟล์ zip: เรียงตามเวลาถ่ายจริง แล้วต่อด้วยรหัสรอบเพื่อให้ย้อนกลับไปหาได้ */
const stamp = (row) => String(row.taken_at || row.created_at || '')
  .replace(/[:T]/g, '-').replace(/\..*$/, '').slice(0, 19) || 'unknown';

/**
 * รอบถ่ายเดียวทั้งชุด — แผ่น + รูปดิบทุกใบ + ภาพเคลื่อนไหว
 *
 * ชื่อไฟล์ข้างในตั้งให้อ่านรู้เรื่องตอนแตกออกมาปนกับไฟล์อื่นในเครื่องแขก
 * ("photobooth-KWJ1D0-sheet.jpg") ไม่ใช่ "sheet.jpg" ที่ทับของเดิมได้และไม่บอกอะไร
 */
export function streamBoothSession(res, { session, shots }) {
  const stem = `photobooth-${session.token}`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${stem}.zip"`);

  const archive = archiver('zip', { store: true });
  archive.on('warning', (error) => console.warn('[booth-zip]', error.message));
  archive.on('error', (error) => {
    console.error('[booth-zip]', error);
    res.destroy(error);
  });
  archive.pipe(res);

  const add = (name, as) => {
    const source = path.join(config.paths.booth, name);
    if (name && fs.existsSync(source)) archive.file(source, { name: as });
  };

  add(session.sheet_name, `${stem}-sheet.jpg`);
  shots.forEach((shot, index) => add(shot.stored_name, `${stem}-${index + 1}.jpg`));
  if (session.gif_name) add(session.gif_name, `${stem}.gif`);

  return archive.finalize();
}

export function streamBoothAlbum(res, { album, sessions, shots }) {
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="photobooth-${album}-${day}.zip"`);

  const archive = archiver('zip', { store: true }); // ไฟล์ JPEG ถูกบีบมาแล้ว
  archive.on('warning', (error) => console.warn('[booth-zip]', error.message));
  archive.on('error', (error) => {
    console.error('[booth-zip]', error);
    res.destroy(error);
  });
  archive.pipe(res);

  /*
   * แยกสองโฟลเดอร์: แผ่นที่พิมพ์ กับรูปดิบ
   *
   * เจ้าภาพส่วนใหญ่อยากได้แผ่น (คือของที่แขกได้ถือกลับบ้าน) ส่วนรูปดิบมีไว้ให้
   * คนที่จะเอาไปทำอย่างอื่นต่อ · กองรวมกันแล้วต้องมานั่งคัดเองทีหลัง
   */
  const byToken = new Map(sessions.map((row) => [row.token, row]));

  for (const row of sessions) {
    const source = path.join(config.paths.booth, row.sheet_name);
    if (fs.existsSync(source)) {
      archive.file(source, { name: `sheets/${stamp(row)}-${row.token}.jpg` });
    }
    // ภาพเคลื่อนไหวไปอยู่โฟลเดอร์ของตัวเอง — เจ้าภาพมักอยากได้ทั้งชุดนี้ไปโพสต์
    const anim = row.gif_name && path.join(config.paths.booth, row.gif_name);
    if (anim && fs.existsSync(anim)) {
      archive.file(anim, { name: `animated/${stamp(row)}-${row.token}.gif` });
    }
  }

  for (const shot of shots) {
    const source = path.join(config.paths.booth, shot.stored_name);
    const row = byToken.get(shot.token);
    if (!row || !fs.existsSync(source)) continue;
    archive.file(source, {
      name: `originals/${stamp(row)}-${shot.token}-${shot.sort_order}${path.extname(shot.stored_name)}`,
    });
  }

  return archive.finalize();
}
