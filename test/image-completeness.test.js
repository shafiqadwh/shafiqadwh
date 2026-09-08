import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * อิมเมจที่ Docker สร้าง **ต้องมีทุกอย่างที่โค้ดต้องใช้**
 *
 * เทสต์อื่นทั้งหมดรันจากรากโปรเจกต์ ซึ่งมีไฟล์ครบทุกโฟลเดอร์อยู่แล้ว — จึงมองไม่เห็น
 * ความต่างระหว่าง "repository มีไฟล์" กับ "คอนเทนเนอร์มีไฟล์" เลยแม้แต่นิดเดียว
 *
 * **เกิดขึ้นจริงแล้วหนึ่งครั้ง**: `src/lib/film.js` เริ่ม import `../../shared/text.js`
 * ตอนรวมตัวเรนเดอร์ตัวหนังสือกับ photo booth แต่ไม่มีใครเติม `COPY shared` ลง
 * Dockerfile · เป็น static import ที่ถูกดึงมาตั้งแต่ `src/server.js` โหลด
 * (server → routes/admin → film-job → film-run → film) ผลคือ **เว็บทั้งเว็บไม่ขึ้น**
 * ด้วย ERR_MODULE_NOT_FOUND ไม่ใช่แค่ export หนังพัง — และจะรู้ตัวก็ต่อเมื่อ
 * build อิมเมจใหม่บนเครื่องจริงแล้วเปิดไม่ได้
 *
 * ข้อนี้จึงไม่ตรวจว่า "มี COPY shared ไหม" (ซึ่งกันได้แค่กรณีเดิม) แต่ **ไล่หา
 * ทุกโฟลเดอร์ที่ src/ อ้างถึงข้ามออกไปข้างนอก แล้วบังคับให้ทุกตัวอยู่ในอิมเมจ**
 * โฟลเดอร์ที่ใช้ร่วมกันตัวถัดไปจึงถูกจับได้ตั้งแต่ยังไม่ทันขึ้นเครื่องจริง
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** ไล่ทุกไฟล์ .js ใต้ src/ */
function sources(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * โฟลเดอร์ระดับบนสุดที่ src/ อ้างถึงโดยออกไปนอก src/
 *
 * จับทั้ง `import x from '../../shared/y.js'` และ `import('../../shared/y.js')`
 * โดยคิดพาธจริงแล้วดูว่าโผล่ออกไปนอก src/ หรือเปล่า — เชื่อถือได้กว่าการเดา
 * จากจำนวนจุดจุดในสตริง ซึ่งผิดทันทีที่ไฟล์อยู่ลึกคนละชั้นกัน
 */
function outsideDirs() {
  const found = new Set();
  for (const file of sources(path.join(root, 'src'))) {
    const code = fs.readFileSync(file, 'utf8');
    for (const [, spec] of code.matchAll(/from\s+'(\.[^']+)'|import\('(\.[^']+)'\)/g)) {
      const target = path.resolve(path.dirname(file), spec);
      const relative = path.relative(path.join(root, 'src'), target);
      if (!relative.startsWith('..')) continue;
      // ../<โฟลเดอร์>/... เมื่อคิดจากรากโปรเจกต์
      const top = path.relative(root, target).split(path.sep)[0];
      if (top && top !== '..') found.add(top);
    }
  }
  return [...found];
}

test('every folder the server imports is actually put into the image', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  const copied = new Set(
    [...dockerfile.matchAll(/^COPY\s+(?!--from)(\S+)\s/gm)].map(([, name]) => name),
  );

  const needed = outsideDirs();
  assert.ok(needed.length > 0, 'ตัวไล่หาต้องเจออะไรบ้าง ไม่งั้นเทสต์นี้ผ่านฟรี');

  for (const dir of needed) {
    assert.ok(
      copied.has(dir),
      `src/ import จาก "${dir}/" แต่ Dockerfile ไม่ได้ COPY เข้าไป — `
      + 'อิมเมจใหม่จะเปิดเว็บไม่ขึ้นเลยด้วย ERR_MODULE_NOT_FOUND',
    );
  }
});

test('the same folders are mounted, so a code change needs only a restart', () => {
  /*
   * โค้ดถูก bind mount เข้าไปทับของในอิมเมจ (`./src:/app/src:ro` ฯลฯ) เพื่อให้
   * `scripts/update.sh` แค่ restart ไม่ต้อง rebuild · โฟลเดอร์ที่อยู่ในอิมเมจแต่
   * ไม่ได้ mount จะกลายเป็น **ของเก่าค้างจากวันที่ build** ทั้งที่ไฟล์อื่นใหม่หมด
   * ซึ่งเป็นความไม่ตรงกันที่หาสาเหตุยากมากเพราะทุกอย่างดูอัปเดตแล้ว
   */
  const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  for (const dir of outsideDirs()) {
    assert.match(
      compose,
      new RegExp(`\\./${dir}:/app/${dir}`),
      `"${dir}/" อยู่ในอิมเมจแล้วแต่ไม่ได้ mount — แก้โค้ดแล้ว restart จะยังได้ของเก่า`,
    );
  }
});
