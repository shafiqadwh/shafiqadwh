import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { FFPROBE } from './media.js';

const run = promisify(execFile);

/**
 * คลังเพลงสำหรับหนังงานแต่ง — แยกเป็นกลุ่มตามงาน
 *
 * เพลงที่มากับโปรแกรมโหลดด้วย `scripts/fetch-music.sh` ลง `data/music/library/<กลุ่ม>/`
 * ส่วนเพลงที่เจ้าของอัพเองอยู่ในกลุ่ม `mine` — กลุ่มปกติกลุ่มหนึ่งเหมือนกลุ่มอื่น
 * ไม่มีเส้นทางพิเศษ
 *
 * อ่านรายชื่อจากโฟลเดอร์จริง ไม่ใช่จากทะเบียนที่เก็บแยก ด้วยเหตุผลเดียวกับ
 * `listFilms()` และ `listPapers()`: ใครลบไฟล์ทิ้งเองจาก File Station รายการก็หาย
 * ตามไปเอง ไม่มีรายการผีค้างให้เลือกแล้วเรนเดอร์ล้มกลางทาง
 */

// ลำดับนี้คือลำดับที่แสดงในหน้าเว็บ กลุ่มที่ไม่รู้จักไปต่อท้าย ส่วน "ของฉัน" อยู่บนสุด
// เพราะคนที่อุตส่าห์อัพเพลงเองมาย่อมอยากใช้เพลงตัวเองก่อน
export const THEME_ORDER = ['mine', 'wedding', 'graduation', 'birthday', 'calm'];

const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac']);

function libraryRoot() {
  return path.join(config.paths.music, 'library');
}

/** โฟลเดอร์ของกลุ่มหนึ่ง — ชื่อกลุ่มมาจากผู้ใช้ได้ จึงต้องกันการเดินออกนอกคลัง */
export function themeDir(theme) {
  const name = path.basename(String(theme ?? ''));
  if (!name || name !== theme || name.startsWith('.')) return null;
  return path.join(libraryRoot(), name);
}

/** ไฟล์เพลงหนึ่งเพลงจาก id ที่หน้าเว็บส่งมา — รูปแบบ "<กลุ่ม>/<ชื่อไฟล์>" */
export function trackPath(id) {
  const raw = String(id ?? '');
  const slash = raw.indexOf('/');
  if (slash < 1) return null;

  const dir = themeDir(raw.slice(0, slash));
  if (!dir) return null;

  const file = raw.slice(slash + 1);
  if (!file || path.basename(file) !== file || file.startsWith('.')) return null;
  if (!AUDIO.has(path.extname(file).toLowerCase())) return null;

  return path.join(dir, file);
}

/**
 * ความยาวของไฟล์เสียง เก็บผลไว้ข้าง ๆ ไฟล์
 *
 * ffprobe ต่อไฟล์ใช้เวลาไม่มาก แต่คลังยี่สิบกว่าเพลงคูณทุกครั้งที่เปิดหน้าแอดมิน
 * (ซึ่ง poll ทุกยี่สิบวินาที) คือการเผา CPU ของ NAS ทิ้งเปล่า ๆ
 */
async function durationOf(filePath) {
  const sidecar = `${filePath}.json`;
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }

  try {
    const cached = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    // ผูกกับขนาดไฟล์ด้วย ไฟล์ถูกเขียนทับด้วยเพลงอื่นแล้วค่าเก่าจะไม่ถูกใช้ต่อ
    if (cached.bytes === stat.size && Number.isFinite(cached.seconds)) return cached;
  } catch {
    // ยังไม่เคยวัด หรือไฟล์กำกับเสีย — วัดใหม่
  }

  let seconds = 0;
  try {
    const { stdout } = await run(FFPROBE, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      filePath,
    ], { timeout: 20000 });
    seconds = Math.round(Number(stdout.trim()) || 0);
  } catch {
    return null; // อ่านไม่ได้ = ไม่ใช่ไฟล์เสียงที่ใช้ได้ ไม่ต้องเอาไปให้เลือก
  }
  if (seconds <= 0) return null;

  const info = { seconds, bytes: stat.size };
  await fs.writeFile(sidecar, JSON.stringify(info)).catch(() => {});
  return info;
}

/** คลังทั้งหมด จัดกลุ่มตาม theme พร้อมความยาวรวมของแต่ละกลุ่ม */
export async function listLibrary() {
  let themes;
  try {
    themes = await fs.readdir(libraryRoot(), { withFileTypes: true });
  } catch {
    return [];
  }

  const groups = [];
  for (const entry of themes) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;

    let names;
    try {
      names = await fs.readdir(path.join(libraryRoot(), entry.name));
    } catch {
      continue;
    }

    const tracks = [];
    for (const name of names.sort()) {
      if (name.startsWith('.') || !AUDIO.has(path.extname(name).toLowerCase())) continue;
      const filePath = path.join(libraryRoot(), entry.name, name);
      const info = await durationOf(filePath);
      if (!info) continue;

      tracks.push({
        id: `${entry.name}/${name}`,
        theme: entry.name,
        title: name.replace(/\.[^.]+$/, ''),
        seconds: info.seconds,
        bytes: info.bytes,
      });
    }

    if (tracks.length > 0) {
      groups.push({
        theme: entry.name,
        tracks,
        seconds: tracks.reduce((sum, track) => sum + track.seconds, 0),
      });
    }
  }

  return groups.sort((a, b) => {
    const left = THEME_ORDER.indexOf(a.theme);
    const right = THEME_ORDER.indexOf(b.theme);
    if (left !== right) return (left < 0 ? 99 : left) - (right < 0 ? 99 : right);
    return a.theme.localeCompare(b.theme);
  });
}

/**
 * แปลง id ที่ผู้ใช้เลือกมาเป็นเส้นทางไฟล์จริง โดยคงลำดับและของซ้ำไว้
 *
 * เลือกเพลงเดิมสองครั้งติดกันเป็นเรื่องที่ตั้งใจได้ (เจ้าของบอกเองว่าใส่ซ้ำก็ได้)
 * จึงห้ามยุบของซ้ำทิ้ง — ที่ต้องคัดออกคือเพลงที่ไฟล์หายไปแล้วเท่านั้น
 */
export async function resolveTracks(ids) {
  const out = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const filePath = trackPath(id);
    if (!filePath) continue;
    try {
      await fs.access(filePath);
    } catch {
      continue;
    }
    out.push(filePath);
  }
  return out;
}

/** ความยาวรวมของเพลงที่เลือก — ใช้บอกว่ายังขาดอีกกี่นาที */
export async function totalSeconds(ids) {
  let total = 0;
  for (const id of Array.isArray(ids) ? ids : []) {
    const filePath = trackPath(id);
    if (!filePath) continue;
    const info = await durationOf(filePath);
    if (info) total += info.seconds;
  }
  return total;
}

export async function deleteTrack(id) {
  const filePath = trackPath(id);
  // ลบได้เฉพาะเพลงที่อัพเอง เพลงที่มากับโปรแกรมโหลดใหม่ได้เสมอด้วย fetch-music.sh
  // แต่ลบทิ้งจากหน้าเว็บแล้วผู้ใช้จะงงว่าทำไมมันกลับมาตอนรันสคริปต์
  if (!filePath || !String(id).startsWith('mine/')) return false;
  try {
    await fs.stat(filePath);
  } catch {
    return false;
  }
  await fs.rm(filePath, { force: true });
  await fs.rm(`${filePath}.json`, { force: true });
  return true;
}
