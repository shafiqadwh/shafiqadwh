import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { translator } from '../i18n.js';
import { acquireLock } from './film-lock.js';
import { readDeck, dedupe, buildTimeline, sourceFor } from './film-plan.js';
import { photoFrame, openingCard, closingCard, wishCard, captionLayer } from './film.js';
import { stillClip, videoClip, concatClips, mixMusic, alreadyDone } from './film-encode.js';

/**
 * เดินงาน export หนังทั้งเรื่อง — ใช้ร่วมกันทั้งปุ่มในหน้าเว็บและสคริปต์ที่รันผ่าน ssh
 *
 * แยกออกมาจากสคริปต์เพราะตอนนี้มีสองทางเข้า และตรรกะต้องเป็นชุดเดียวกันเป๊ะ
 * ไม่งั้นหนังที่ได้จากปุ่มกับจากคำสั่งจะไม่เหมือนกัน ซึ่งเป็นบั๊กประเภทที่หาสาเหตุยาก
 *
 * ผู้เรียกส่ง onProgress เข้ามาเพื่อรับความคืบหน้า — ฝั่ง cli พิมพ์ลงจอ
 * ฝั่งเว็บเก็บลงไฟล์สถานะให้หน้าแอดมิน poll อ่าน
 */

export const DEFAULTS = {
  seconds: 6,
  maxVideoSeconds: 30,
  music: null,
  motion: false,
  keepDuplicates: false,
  limit: 0,
};

export function defaultPaths() {
  return {
    out: path.join(config.paths.export, 'wedding-film.mp4'),
    work: path.join(config.paths.export, 'parts'),
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
  const options = { ...DEFAULTS, ...defaultPaths(), ...input };
  const lock = await acquireLock(options.source ?? 'cli');

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
    const counts = {
      photos: timeline.filter((entry) => entry.kind === 'image').length,
      videos: timeline.filter((entry) => entry.kind === 'video').length,
      wishes: timeline.filter((entry) => entry.kind === 'wish').length,
      attached: timeline.filter((entry) => entry.wish).length,
      duplicatesRemoved: removed,
      total: timeline.length,
    };
    onProgress({ phase: 'building', counts, done: 0, total: timeline.length });

    const clips = [];
    const started = Date.now();
    for (const [index, entry] of timeline.entries()) {
      const { clipPath } = await buildClip(entry, index, options, t);
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
    const silent = options.music ? path.join(options.work, 'film-silent.mp4') : options.out;
    await fs.rm(silent, { force: true });
    await concatClips(clips, silent, options.work);

    if (options.music) {
      onProgress({ phase: 'music', counts, done: timeline.length, total: timeline.length });
      await fs.rm(options.out, { force: true });
      await mixMusic(silent, options.music, options.out);
      await fs.rm(silent, { force: true });
    }

    const { size } = await fs.stat(options.out);
    return { out: options.out, work: options.work, bytes: size, counts };
  } finally {
    await lock.release();
  }
}
