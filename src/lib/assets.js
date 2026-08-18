import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * ป้ายเวอร์ชันของไฟล์ static คิดจากเนื้อไฟล์จริงตอนแอปบูต
 *
 * ทำไมต้องมี: /static ตั้งแคชไว้ 7 วัน ซึ่งจำเป็นเพราะแขกร้อยคนโหลดหน้าเดียวกัน
 * แต่ผลข้างเคียงคือเครื่องที่เคยเปิดไปแล้วจะใช้ไฟล์เก่าต่อไปจนครบ 7 วัน
 * แม้เราจะแก้โค้ดและ deploy ใหม่แล้วก็ตาม
 *
 * เคยพังจริงมาแล้วบนทีวีที่งาน: หน้าเมนูขึ้นมาไม่มีสไตล์เลยเพราะ CSS ที่แคชไว้
 * ยังไม่มีกฎของหน้านั้น และเลือกโหมดไหนก็ได้สไลด์โชว์แบบเดิมเพราะ JS ที่แคชไว้
 * ยังไม่รู้จักโหมดใหม่ — อาการที่หาสาเหตุยากมากเพราะเซิร์ฟเวอร์ถูกทุกอย่าง
 *
 * พอที่อยู่ไฟล์มี ?v= ที่เปลี่ยนตามเนื้อไฟล์ เครื่องที่เคยแคชไว้จะเห็นเป็นคนละ
 * ที่อยู่แล้วโหลดใหม่เองทันที ไม่ต้องให้ใครไปกด Clear cache ที่ทีวีทุกเครื่อง
 */
function hashPublicFiles() {
  const hash = crypto.createHash('sha1');
  const roots = [path.join(config.paths.public, 'css'), path.join(config.paths.public, 'js')];

  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root).sort();
    } catch {
      continue; // โฟลเดอร์ไม่มีก็ข้ามไป ไม่ควรทำให้แอปบูตไม่ขึ้น
    }
    for (const name of names) {
      try {
        hash.update(name).update(fs.readFileSync(path.join(root, name)));
      } catch {
        // อ่านไม่ได้ก็ข้าม
      }
    }
  }

  return hash.digest('hex').slice(0, 10);
}

export const assetVersion = hashPublicFiles();
