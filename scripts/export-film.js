#!/usr/bin/env node
/**
 * รวมทุกอย่างที่แขกส่งมาในงาน ให้เป็นไฟล์วีดีโอเดียว
 *
 *   node scripts/export-film.js
 *   node scripts/export-film.js --music /app/data/song.mp3 --seconds 6
 *
 * ทำงานหลังจบงาน อ่านฐานข้อมูลแบบอ่านอย่างเดียว ไม่แตะของที่เว็บกำลังใช้อยู่
 * รันซ้ำได้ตลอด คลิปที่ทำเสร็จแล้วจะถูกข้าม (กฎ idempotency ของโปรเจกต์)
 *
 * สิ่งที่ได้: รูปทุกใบเรียงตามเวลาจริงของงาน ไม่ซ้ำ · วิดีโอของแขกพร้อมเสียงเดิม
 * · คำอวยพรทั้งที่แนบรูปและไม่แนบ · การ์ดเปิดและปิด · ไม่มี QR (ประกอบเฟรมเองทั้งหมด
 * จึงไม่มีทางหลุดเข้ามา) · ใส่เพลงคลอได้ถ้าระบุ --music
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { translator } from '../src/i18n.js';
import { readDeck, dedupe, buildTimeline, sourceFor } from '../src/lib/film-plan.js';
import { photoFrame, openingCard, closingCard, wishCard, captionLayer } from '../src/lib/film.js';
import { stillClip, videoClip, concatClips, mixMusic, alreadyDone } from '../src/lib/film-encode.js';

// ── อ่านตัวเลือกจากบรรทัดคำสั่ง ─────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    seconds: 6,
    maxVideoSeconds: 30,
    music: null,
    out: path.join(config.paths.data, 'export', 'wedding-film.mp4'),
    work: path.join(config.paths.data, 'export', 'parts'),
    motion: false,
    keepDuplicates: false,
    limit: 0,
  };

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

  if (!(options.seconds > 0)) throw new Error('--seconds ต้องมากกว่า 0');
  if (!(options.maxVideoSeconds > 0)) throw new Error('--max-video-seconds ต้องมากกว่า 0');
  return options;
}

// ── ลงมือทำ ────────────────────────────────────────────────────────────────

function say(message) {
  process.stdout.write(`${message}\n`);
}

async function buildClip(entry, index, options, t) {
  const stem = String(index).padStart(4, '0');
  const clipPath = path.join(options.work, `${stem}-${entry.key}.mp4`);
  if (await alreadyDone(clipPath)) return { clipPath, skipped: true };

  const framePath = path.join(options.work, `${stem}-${entry.key}.png`);

  if (entry.kind === 'video') {
    // คำบรรยายของวิดีโอเป็นชั้นโปร่งใสที่ ffmpeg เอาไปวางทับ ไม่ใช่เฟรมเต็ม
    const caption = await captionLayer({ name: entry.name, wish: entry.wish });
    let captionPath = null;
    if (caption) {
      captionPath = framePath;
      await fs.writeFile(captionPath, caption);
    }
    await videoClip(sourceFor(entry.item), clipPath, {
      seconds: options.maxVideoSeconds,
      captionPath,
    });
    if (captionPath) await fs.rm(captionPath, { force: true });
    return { clipPath };
  }

  let frame;
  if (entry.kind === 'opening') frame = await openingCard();
  else if (entry.kind === 'closing') frame = await closingCard(t);
  else if (entry.kind === 'wish') frame = await wishCard(entry.message);
  else frame = await photoFrame(sourceFor(entry.item), { name: entry.name, wish: entry.wish });

  await fs.writeFile(framePath, frame);
  const seconds = entry.kind === 'opening' || entry.kind === 'closing'
    ? Math.max(options.seconds, 7)
    : entry.kind === 'wish'
      ? Math.max(options.seconds, 8)
      : options.seconds;

  await stillClip(framePath, clipPath, { seconds, motion: options.motion });
  await fs.rm(framePath, { force: true });
  return { clipPath };
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

  if (options.music) await fs.access(options.music);

  // ตรวจว่าเรนเดอร์ตัวหนังสือไทยได้จริงก่อน ไม่ใช่ไปพังตอนนาทีที่สี่สิบ
  // ถ้าฟอนต์หายไปจากอิมเมจหรือ mount ไม่ติด จะรู้ทันทีในสองวินาทีแรก
  try {
    await wishCard({ body: 'ทดสอบการเรนเดอร์ตัวอักษร', author: 'ระบบ' });
  } catch (error) {
    throw new Error(`เรนเดอร์ตัวหนังสือไม่ได้ (${error.message})\n`
      + '  ตรวจว่าโฟลเดอร์ assets/fonts ถูก mount เข้าไปในคอนเทนเนอร์แล้ว');
  }

  await fs.mkdir(options.work, { recursive: true });
  await fs.mkdir(path.dirname(options.out), { recursive: true });

  const t = translator(config.i18n.default);
  const deck = readDeck();

  const before = deck.items.length;
  if (!options.keepDuplicates) {
    say('ตรวจไฟล์ซ้ำ');
    deck.items = await dedupe(deck.items);
  }
  const removed = before - deck.items.length;

  const timeline = buildTimeline(deck, options);

  const photos = timeline.filter((entry) => entry.kind === 'image').length;
  const videos = timeline.filter((entry) => entry.kind === 'video').length;
  const wishes = timeline.filter((entry) => entry.kind === 'wish').length;
  const attached = timeline.filter((entry) => entry.wish).length;

  say(`รูป ${photos} ใบ · วิดีโอ ${videos} คลิป · คำอวยพรเดี่ยว ${wishes} · คำอวยพรบนรูป ${attached}`);
  say(removed > 0
    ? `ไฟล์ที่อัปซ้ำถูกตัดออก ${removed} รายการ จากทั้งหมด ${before}`
    : `ไม่พบไฟล์ที่อัปซ้ำ จากทั้งหมด ${before} รายการ`);

  const clips = [];
  const started = Date.now();
  for (const [index, entry] of timeline.entries()) {
    const { clipPath, skipped } = await buildClip(entry, index, options, t);
    clips.push(clipPath);

    const done = index + 1;
    if (done % 10 === 0 || done === timeline.length) {
      const rate = (Date.now() - started) / done / 1000;
      const left = Math.round((timeline.length - done) * rate / 60);
      say(`  ${done}/${timeline.length}${skipped ? ' (ข้ามของเดิม)' : ''} · เหลืออีกราว ${left} นาที`);
    }
  }

  say('ต่อคลิปทั้งหมดเข้าด้วยกัน');
  const silent = options.music
    ? path.join(options.work, 'film-silent.mp4')
    : options.out;
  await fs.rm(silent, { force: true });
  await concatClips(clips, silent, options.work);

  if (options.music) {
    say('ผสมเพลงคลอ');
    await fs.rm(options.out, { force: true });
    await mixMusic(silent, options.music, options.out);
    await fs.rm(silent, { force: true });
  }

  const { size } = await fs.stat(options.out);
  say(`\nเสร็จแล้ว: ${options.out}  (${(size / 1024 / 1024).toFixed(0)} MB)`);
  say(`คลิปย่อยยังอยู่ที่ ${options.work} — ลบทิ้งได้ถ้าไม่ต้องการรันซ้ำอีก`);
}

main().catch((error) => {
  process.stderr.write(`\nล้มเหลว: ${error.message}\n`);
  process.exitCode = 1;
});
