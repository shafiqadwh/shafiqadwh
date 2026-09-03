/**
 * เทถังขยะทิ้งถาวรเดี๋ยวนี้ โดยไม่ต้องรอครบ TRASH_RETENTION_DAYS
 *
 * มีไว้สำหรับ "เก็บกวาดของทดสอบก่อนวันงาน" — ปกติของในถังขยะจะถูกกวาดเองเมื่อ
 * ครบกำหนด (ค่าเริ่มต้น 7 วัน) ซึ่งช้าเกินไปเมื่ออยากเริ่มงานจริงด้วยกำแพงที่สะอาด
 *
 * ⚠️ ลบไฟล์จริงบนดิสก์ + แถวในฐานข้อมูล **กู้คืนไม่ได้อีกเลย** จึงต้องสั่ง --yes
 * ถึงจะลงมือจริง เรียกเปล่า ๆ จะแค่รายงานว่ามีอะไรอยู่ในถังขยะบ้าง
 *
 * อยู่ใต้ src/ เพราะโฟลเดอร์นี้ถูก mount เข้าคอนเทนเนอร์อยู่แล้ว (scripts/ ไม่ได้)
 * จึงใช้ได้ทันทีหลัง update.sh โดยไม่ต้องแก้ docker-compose.yml
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { deleteItemRow, listTrash } from '../repo.js';
import { formatBytes } from '../lib/media.js';
import { forEachEvent } from '../lib/tenancy.js';

/** ไฟล์ทุกก้อนที่เป็นของ item นี้ — ต้นฉบับ สำเนาที่แปลงแล้ว และรูปย่อ */
function filesOf(row) {
  return [
    path.join(config.paths.uploads, row.stored_name),
    row.playback_name ? path.join(config.paths.derived, row.playback_name) : null,
    row.thumb_name ? path.join(config.paths.derived, row.thumb_name) : null,
  ].filter(Boolean);
}

/*
 * เครื่องหนึ่งเครื่องรับได้หลายงาน — ต้องเทให้ครบทุกงาน
 *
 * เดิมทำกับงานเดียวเพราะมีงานเดียว · ถ้าไม่วนให้ครบ สคริปต์จะรายงานว่า "ถังขยะ
 * ว่างอยู่แล้ว" ทั้งที่ของทดสอบของงานอื่นยังกองอยู่ ซึ่งเป็นคำตอบที่ผิดในจังหวะ
 * ที่เจ้าของกำลังเก็บกวาดก่อนวันงานพอดี
 */
const go = process.argv.includes('--yes');
let total = 0;
let totalBytes = 0;

await forEachEvent(async (event) => {
  const rows = listTrash();
  if (rows.length === 0) return;

  const bytes = rows.reduce((sum, row) => sum + (row.bytes || 0), 0);
  const images = rows.filter((row) => row.kind === 'image').length;
  console.log(`[${event.slug}] ในถังขยะ: รูป ${images} ใบ · วิดีโอ ${rows.length - images} คลิป`
    + ` · รวม ${formatBytes(bytes)}`);
  total += rows.length;
  totalBytes += bytes;
  if (!go) return;

  for (const row of rows) {
    // ลบไฟล์ก่อนแล้วค่อยลบแถว — สลับกันแล้วถ้าล้มกลางทางจะเหลือไฟล์กำพร้าที่ไม่มี
    // อะไรอ้างถึงอีกเลย กินพื้นที่ไปเงียบ ๆ จนกว่าจะมีคนไปไล่ดูด้วยมือ
    await Promise.all(filesOf(row).map((file) => fs.rm(file, { force: true })));
    deleteItemRow(row.id);
  }
});

if (total === 0) {
  console.log('ถังขยะว่างอยู่แล้วทุกงาน ไม่มีอะไรต้องลบ');
} else if (!go) {
  console.log('');
  console.log('นี่คือการลบถาวร กู้คืนไม่ได้ ถ้าแน่ใจแล้วสั่งซ้ำโดยเติม --yes ต่อท้าย');
} else {
  console.log(`ลบถาวรแล้ว ${total} รายการ · คืนพื้นที่ ${formatBytes(totalBytes)}`);
}
