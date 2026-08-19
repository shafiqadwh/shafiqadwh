#!/usr/bin/env node
/**
 * รวมทุกอย่างที่แขกส่งมาในงาน ให้เป็นไฟล์วีดีโอเดียว
 *
 *   node scripts/export-film.js
 *   node scripts/export-film.js --music /app/data/music/song.mp3 --seconds 6
 *
 * ทำงานหลังจบงาน อ่านฐานข้อมูลแบบอ่านอย่างเดียว ไม่แตะของที่เว็บกำลังใช้อยู่
 * รันซ้ำได้ตลอด คลิปที่ทำเสร็จแล้วจะถูกข้าม (กฎ idempotency ของโปรเจกต์)
 *
 * ตรรกะทั้งหมดอยู่ใน src/lib/film-run.js เพราะปุ่มในหน้าแอดมินเรียกตัวเดียวกันนี้
 * ไฟล์นี้เหลือแค่การอ่านตัวเลือกจากบรรทัดคำสั่งกับพิมพ์ความคืบหน้าลงจอ
 */

import { beNice, runExport } from '../src/lib/film-run.js';

beNice();

function parseArgs(argv) {
  const options = {};
  const numbers = new Set(['seconds', 'maxVideoSeconds', 'limit']);

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const key = {
      '--seconds': 'seconds',
      '--max-video-seconds': 'maxVideoSeconds',
      '--music': 'music',
      '--out': 'out',
      '--work': 'work',
      '--limit': 'limit',
    }[flag];

    if (key) {
      const value = argv[i + 1];
      if (value == null) throw new Error(`${flag} ต้องตามด้วยค่า`);
      options[key] = numbers.has(key) ? Number(value) : value;
      i += 1;
    } else if (flag === '--motion') options.motion = true;
    else if (flag === '--keep-duplicates') options.keepDuplicates = true;
    else if (flag === '-h' || flag === '--help') options.help = true;
    else throw new Error(`ไม่รู้จักตัวเลือก: ${flag}`);
  }

  if (options.seconds !== undefined && !(options.seconds > 0)) {
    throw new Error('--seconds ต้องมากกว่า 0');
  }
  if (options.maxVideoSeconds !== undefined && !(options.maxVideoSeconds > 0)) {
    throw new Error('--max-video-seconds ต้องมากกว่า 0');
  }
  return options;
}

function say(message) {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    say(`วิธีใช้: node scripts/export-film.js [ตัวเลือก]

  --seconds N             รูปหนึ่งใบค้างจอกี่วินาที (ค่าเริ่มต้น 6)
  --max-video-seconds N   ตัดวิดีโอของแขกไม่ให้ยาวเกินกี่วินาที (ค่าเริ่มต้น 30)
  --music PATH            ไฟล์เพลงคลอ (ต้องมีสิทธิ์ใช้เอง)
  --out PATH              ไฟล์ผลลัพธ์
  --work DIR              ที่เก็บคลิปย่อย รันซ้ำแล้วข้ามของที่ทำเสร็จ
  --motion                ซูมช้า ๆ แบบ Ken Burns (ช้าลงและภาพนุ่มลงเล็กน้อย)
  --keep-duplicates       ไม่ตัดไฟล์ที่อัปซ้ำออก
  --limit N               ใช้รูปแค่ N ใบแรก สำหรับลองดูผลก่อน`);
    return;
  }

  let announced = false;
  const result = await runExport({ ...options, source: 'cli' }, (progress) => {
    if (progress.phase === 'scanning') return say(progress.message);

    if (progress.counts && !announced) {
      announced = true;
      const { photos, videos, wishes, attached, duplicatesRemoved } = progress.counts;
      say(`รูป ${photos} ใบ · วิดีโอ ${videos} คลิป · คำอวยพรเดี่ยว ${wishes} · คำอวยพรบนรูป ${attached}`);
      say(duplicatesRemoved > 0
        ? `ไฟล์ที่อัปซ้ำถูกตัดออก ${duplicatesRemoved} รายการ`
        : 'ไม่พบไฟล์ที่อัปซ้ำ');
    }

    if (progress.phase === 'joining') return say('ต่อคลิปทั้งหมดเข้าด้วยกัน');
    if (progress.phase === 'music') return say('ผสมเพลงคลอ');

    if (progress.phase === 'building' && progress.done > 0
        && (progress.done % 10 === 0 || progress.done === progress.total)) {
      say(`  ${progress.done}/${progress.total} · เหลืออีกราว ${Math.round(progress.secondsLeft / 60)} นาที`);
    }
    return undefined;
  });

  say(`\nเสร็จแล้ว: ${result.out}  (${(result.bytes / 1024 / 1024).toFixed(0)} MB)`);
  say(`คลิปย่อยยังอยู่ที่ ${result.work} — ลบทิ้งได้ถ้าไม่ต้องการรันซ้ำอีก`);
}

main().catch((error) => {
  process.stderr.write(`\nล้มเหลว: ${error.message}\n`);
  process.exitCode = 1;
});
