import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { translator } from '../i18n.js';
import { acquireLock } from './film-lock.js';
import { FFPROBE } from './media.js';
import { readDeck, dedupe, buildTimeline, planLength, sourceFor, thumbFor } from './film-plan.js';
import { photoFrame, openingCard, closingCard, wishCard, captionLayer } from './film.js';
import { SLOTS, wallFrame } from './film-wall.js';
import {
  stillClip, videoClip, wallVideoClip, concatClips, mixMusic, alreadyDone,
  buildMusicBed, encoderSignature,
} from './film-encode.js';

const run = promisify(execFile);

/**
 * เดินงาน export หนังทั้งเรื่อง — ใช้ร่วมกันทั้งปุ่มในหน้าเว็บและสคริปต์ที่รันผ่าน ssh
 *
 * แยกออกมาจากสคริปต์เพราะตอนนี้มีสองทางเข้า และตรรกะต้องเป็นชุดเดียวกันเป๊ะ
 * ไม่งั้นหนังที่ได้จากปุ่มกับจากคำสั่งจะไม่เหมือนกัน ซึ่งเป็นบั๊กประเภทที่หาสาเหตุยาก
 *
 * ผู้เรียกส่ง onProgress เข้ามาเพื่อรับความคืบหน้า — ฝั่ง cli พิมพ์ลงจอ
 * ฝั่งเว็บเก็บลงไฟล์สถานะให้หน้าแอดมิน poll อ่าน
 */

export const STYLES = ['cinema', 'wall'];

export const DEFAULTS = {
  // 'auto' = ให้โปรแกรมคิดจากจำนวนรูปเอง (planLength) ใส่ตัวเลขทับได้ถ้าอยากกำหนดเอง
  seconds: 'auto',
  maxVideoSeconds: 30,
  music: null,
  tracks: null,
  motion: false,
  keepDuplicates: false,
  limit: 0,
  style: 'cinema',
};

/** ชื่อไฟล์ของหนังเรื่องหนึ่ง — มีเวลากับรูปแบบอยู่ในชื่อ เรียงตามเวลาได้จากชื่อเลย */
export function filmName(style, when = new Date()) {
  const stamp = when.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `film-${stamp}-${style}.mp4`;
}

export function pathsFor(style) {
  return {
    out: path.join(config.paths.films, filmName(style)),
    // คลิปย่อยต้องแยกตามรูปแบบ ไม่งั้นคลิปของโหมดโรงหนังจะถูกเอาไปใช้ซ้ำ
    // ในหนังโหมดกำแพง เพราะชื่อไฟล์ชนกันพอดี แล้วได้หนังที่ปนกันสองแบบ
    work: path.join(config.paths.export, 'parts', style),
  };
}

/**
 * ลดความสำคัญของ CPU ตัวเองลง
 *
 * ปุ่มในหน้าเว็บทำให้งานนี้รันในคอนเทนเนอร์เดียวกับเว็บที่แขกกำลังใช้ ffmpeg ที่ถูก
 * เรียกต่อจากโปรเซสนี้สืบทอดค่าไปด้วย เว็บจึงยังตอบสนองอยู่แม้กำลังเรนเดอร์หนัง
 */
export function beNice() {
  try {
    os.setPriority(process.pid, os.constants.priority.PRIORITY_LOW);
  } catch {
    // บางแซนด์บ็อกซ์ไม่ให้เรียก setpriority เลย ไม่ใช่เรื่องคอขาดบาดตาย
  }
}

/**
 * ล้างคลิปเก่าทิ้งถ้ารอบนี้ใช้ค่าคนละชุดกับรอบก่อน
 *
 * `alreadyDone()` ข้ามคลิปที่ทำไว้แล้วเพื่อให้รันซ้ำเร็ว โดยดูแค่ว่า "มีไฟล์ชื่อนี้
 * อยู่แล้วไหม" ไม่ได้ดูว่ามันถูกเรนเดอร์ด้วยค่าอะไร ลายเซ็นนี้จึงต้องครอบทุกค่า
 * ที่เปลี่ยนแล้วทำให้คลิปเก่าใช้ต่อไม่ได้
 *
 * 1. **ตัวเข้ารหัส** — concat แบบ `-c copy` ต้องการคลิปที่พารามิเตอร์เหมือนกันทุกใบ
 *    เอาคลิปคนละตัวเข้ารหัสมาต่อกันจะได้หนังที่ภาพค้างกลางเรื่องโดยไม่มี error
 * 2. **วินาทีต่อรูป** — ค่านี้คิดจากจำนวนรูป (`secondsForPhotos`) จึงขยับเองเมื่อ
 *    มีรูปเพิ่มเข้ามา งานที่รันค้างไว้ตอนมี 30 ใบ (8 วิ/ใบ) แล้วมารันต่อตอนมี 800 ใบ
 *    (5 วิ/ใบ) จะได้คลิปยาวไม่เท่ากันปนกัน และหนังจะยาวไม่ตรงกับเพลงที่ตัดไว้
 * 3. **เพดานความยาววิดีโอ** — เปลี่ยนแล้วคลิปวิดีโอที่ตัดไว้เดิมก็ยาวผิด
 */
async function dropStaleParts(workDir, plan, options) {
  const stampPath = path.join(workDir, 'encoder.json');
  const now = [
    await encoderSignature(),
    `seconds=${plan.secondsPerPhoto}`,
    `maxVideo=${options.maxVideoSeconds}`,
  ].join(' ');

  let before = null;
  try {
    before = JSON.parse(await fs.readFile(stampPath, 'utf8')).encoder;
  } catch {
    // ยังไม่เคยมีลายเซ็น — โฟลเดอร์ว่างหรือมาจากเวอร์ชันก่อนหน้า
  }

  if (before && before !== now) {
    await fs.rm(workDir, { recursive: true, force: true });
    await fs.mkdir(workDir, { recursive: true });
  }
  await fs.writeFile(stampPath, JSON.stringify({ encoder: now })).catch(() => {});
}

/** ความยาวจริงของไฟล์ที่ต่อเสร็จแล้ว ถ้าอ่านไม่ได้ให้ใช้ค่าที่ประมาณไว้ */
async function filmSeconds(filePath, fallback) {
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath,
    ], { timeout: 20000 });
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback;
  } catch {
    return fallback;
  }
}

async function buildClip(entry, index, options, t, wall) {
  const stem = String(index).padStart(4, '0');
  const clipPath = path.join(options.work, `${stem}-${entry.key}.mp4`);
  if (await alreadyDone(clipPath)) return { clipPath, skipped: true };

  const framePath = path.join(options.work, `${stem}-${entry.key}.png`);

  // ── โหมดกำแพง ────────────────────────────────────────────────────────────
  //
  // การ์ดเปิดกับการ์ดปิดยังเป็นการ์ดข้อความเต็มจอเหมือนเดิม เพราะเป็นจังหวะเปิด
  // และปิดเรื่อง ส่วนคำอวยพรที่ไม่ได้แนบรูปก็ยังเป็นการ์ดข้อความ — กำแพงมีไว้โชว์รูป
  if (options.style === 'wall' && (entry.kind === 'image' || entry.kind === 'video')) {
    const built = await wall.frame(entry, entry.kind === 'video');
    await fs.writeFile(framePath, built.png);

    if (entry.kind === 'video') {
      await wallVideoClip(sourceFor(entry.item), clipPath, {
        framePath,
        window: built.window,
        seconds: options.maxVideoSeconds,
      });
    } else {
      await stillClip(framePath, clipPath, { seconds: options.seconds, motion: false });
    }

    await fs.rm(framePath, { force: true });
    return { clipPath };
  }

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

/**
 * ตัวประกอบเฟรมกำแพง — จำรายการรูปทั้งหมดไว้ แล้วหยิบเพื่อนบ้านรอบ ๆ ใบไฮไลท์
 *
 * เพื่อนบ้านเลื่อนไปตามใบที่กำลังไฮไลท์ กำแพงจึงค่อย ๆ เปลี่ยนไปทั้งเรื่อง
 * ไม่ใช่กองเดิมนิ่ง ๆ ตั้งแต่ต้นจนจบ แต่ก็ไม่กระโดดทั้งจอทุกเฟรมเพราะเลื่อนทีละใบ
 */
function makeWallPainter(timeline) {
  const media = timeline.filter((entry) => entry.kind === 'image' || entry.kind === 'video');
  const face = (entry) => ({
    photoPath: thumbFor(entry.item) ?? sourceFor(entry.item),
    name: entry.name,
  });

  return {
    async frame(entry, isVideo) {
      const at = media.indexOf(entry);
      const neighbours = [];
      for (let step = 1; neighbours.length < SLOTS && step <= media.length; step += 1) {
        const pick = media[(at + step) % media.length];
        if (pick !== entry) neighbours.push(face(pick));
      }
      return wallFrame({ neighbours, hot: face(entry), hotIsVideo: isVideo });
    },
  };
}

/** ตรวจว่าเรนเดอร์ตัวหนังสือได้จริงก่อน ไม่ใช่ไปพังตอนนาทีที่สี่สิบ */
export async function preflight() {
  try {
    await wishCard({ body: 'ทดสอบการเรนเดอร์ตัวอักษร', author: 'ระบบ' });
  } catch (error) {
    throw new Error(`เรนเดอร์ตัวหนังสือไม่ได้ (${error.message}) `
      + '— ตรวจว่าโฟลเดอร์ assets/fonts มากับโค้ดครบ');
  }
}

export async function runExport(input = {}, onProgress = () => {}) {
  const style = STYLES.includes(input.style) ? input.style : DEFAULTS.style;
  const options = { ...DEFAULTS, ...pathsFor(style), ...input, style };

  // ผู้เรียกที่ถือล็อกอยู่แล้วส่งมาได้ — งานที่ทำหลายรูปแบบต่อกันต้องถือใบเดียว
  // ตลอดทั้งงาน ไม่ใช่ปล่อยแล้วขอใหม่ระหว่างเรื่อง ซึ่งเปิดช่องให้งานอื่นแทรกกลางคัน
  const borrowed = input.lock ?? null;
  const lock = borrowed ?? await acquireLock(options.source ?? 'cli');

  try {
    if (options.music) await fs.access(options.music);
    await preflight();

    await fs.mkdir(options.work, { recursive: true });
    await fs.mkdir(path.dirname(options.out), { recursive: true });
    const t = translator(config.i18n.default);
    const deck = readDeck();

    const before = deck.items.length;
    if (!options.keepDuplicates) {
      onProgress({ phase: 'scanning', message: 'ตรวจไฟล์ซ้ำ' });
      deck.items = await dedupe(deck.items);
    }
    const removed = before - deck.items.length;

    const timeline = buildTimeline(deck, options);

    // ความยาวคิดครั้งเดียวที่นี่ แล้วใช้ค่าชุดเดียวกันทั้งการเรนเดอร์และการตัดเพลง
    // ผู้เรียกส่ง plan เข้ามาได้ เพื่อให้หนังสองแบบจากปุ่มเดียวยาวเท่ากันเป๊ะ
    const plan = options.plan ?? planLength(timeline, options);
    options.seconds = plan.secondsPerPhoto;

    // ต้องอยู่หลังคิดแผนเสร็จ เพราะลายเซ็นรวม "วินาทีต่อรูป" ซึ่งเพิ่งรู้ตรงนี้เอง
    // (เดิมเรียกก่อนอ่านข้อมูลด้วยซ้ำ จึงเทียบได้แค่ตัวเข้ารหัส)
    await dropStaleParts(options.work, plan, options);

    // กำแพงต้องรู้ว่ารอบ ๆ ใบไฮไลท์มีรูปอะไรบ้าง ใช้รูปย่อเพราะมีสิบกว่าใบต่อเฟรม
    const wall = makeWallPainter(timeline);
    const counts = {
      photos: timeline.filter((entry) => entry.kind === 'image').length,
      videos: timeline.filter((entry) => entry.kind === 'video').length,
      wishes: timeline.filter((entry) => entry.kind === 'wish').length,
      attached: timeline.filter((entry) => entry.wish).length,
      duplicatesRemoved: removed,
      total: timeline.length,
      secondsPerPhoto: plan.secondsPerPhoto,
      filmSeconds: plan.totalSeconds,
    };
    onProgress({ phase: 'building', counts, done: 0, total: timeline.length });

    const clips = [];
    const started = Date.now();
    for (const [index, entry] of timeline.entries()) {
      const { clipPath } = await buildClip(entry, index, options, t, wall);
      clips.push(clipPath);

      const done = index + 1;
      const rate = (Date.now() - started) / done;
      onProgress({
        phase: 'building',
        counts,
        done,
        total: timeline.length,
        secondsLeft: Math.round(((timeline.length - done) * rate) / 1000),
      });
    }

    onProgress({ phase: 'joining', counts, done: timeline.length, total: timeline.length });

    // เพลย์ลิสต์ที่ผู้ใช้เลือกมาก่อน ถ้าไม่มีค่อยตกไปที่ไฟล์เพลงเดี่ยวแบบเดิม
    const wantsMusic = (options.tracks && options.tracks.length > 0) || options.music;
    const silent = wantsMusic ? path.join(options.work, 'film-silent.mp4') : options.out;
    await fs.rm(silent, { force: true });
    await concatClips(clips, silent, options.work);

    if (wantsMusic) {
      onProgress({ phase: 'music', counts, done: timeline.length, total: timeline.length });

      // ความยาวจริงของหนังที่ได้ ไม่ใช่ค่าที่ประมาณไว้ — เพลงจะได้จบพอดีกับภาพ
      const played = await filmSeconds(silent, plan.totalSeconds);
      let bed = options.music;
      if (options.tracks && options.tracks.length > 0) {
        bed = options.bed ?? await buildMusicBed(
          options.tracks, played, path.join(options.work, 'music-bed.m4a'), options.work,
        );
      }

      await fs.rm(options.out, { force: true });
      await mixMusic(silent, bed, options.out);
      await fs.rm(silent, { force: true });
    }

    const { size } = await fs.stat(options.out);
    return {
      out: options.out, work: options.work, bytes: size, counts, style: options.style, plan,
    };
  } finally {
    if (!borrowed) await lock.release();
  }
}
