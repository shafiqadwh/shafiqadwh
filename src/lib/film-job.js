import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { lockOwner } from './film-lock.js';
import { runExport } from './film-run.js';

/**
 * งาน export ที่สั่งจากหน้าแอดมิน — เก็บสถานะไว้บนดิสก์ ไม่ใช่แค่ในหน่วยความจำ
 *
 * เจ้าของกดปุ่มแล้วต้องปิดมือถือไปทำอย่างอื่นได้ กลับมาเปิดหน้าใหม่ต้องเห็นว่างาน
 * ไปถึงไหนแล้ว ถ้าเก็บไว้ในตัวแปรเฉย ๆ การรีเฟรชหน้าจะไม่เห็นอะไรเลยเพราะนั่นเป็น
 * คนละ request และถ้าคอนเทนเนอร์รีสตาร์ทกลางทาง สถานะจะหายไปทั้งที่ไฟล์คลิปย่อย
 * ยังอยู่ครบ
 *
 * ไฟล์สถานะเป็นแค่ "ป้ายบอกว่าเกิดอะไรขึ้น" ไม่ใช่ตัวคุมงาน ตัวที่กันไม่ให้สอง
 * งานรันชนกันจริง ๆ คือ film-lock.js ซึ่งกันข้ามคอนเทนเนอร์ได้ด้วย
 */

const STATUS_PATH = path.join(config.paths.export, 'status.json');

// สถานะในหน่วยความจำของโปรเซสนี้ ใช้ตอบเร็ว ๆ โดยไม่ต้องอ่านดิสก์ทุกครั้งที่ poll
let current = null;

async function persist(status) {
  try {
    await fs.mkdir(config.paths.export, { recursive: true });
    await fs.writeFile(STATUS_PATH, JSON.stringify(status));
  } catch {
    // เขียนไม่ได้ก็ยังทำงานต่อได้ แค่หน้าเว็บจะไม่เห็นความคืบหน้าหลังรีเฟรช
  }
}

async function readPersisted() {
  try {
    return JSON.parse(await fs.readFile(STATUS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function update(patch) {
  current = { ...current, ...patch, updatedAt: new Date().toISOString() };
  void persist(current);
  return current;
}

/** ไฟล์หนังที่ทำเสร็จแล้ว มีอยู่จริงไหม และใหญ่แค่ไหน */
export async function existingFilm() {
  const filmPath = path.join(config.paths.export, 'wedding-film.mp4');
  try {
    const stat = await fs.stat(filmPath);
    if (stat.size < 1024) return null;
    return { path: filmPath, bytes: stat.size, madeAt: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

/**
 * สถานะปัจจุบันสำหรับหน้าแอดมิน
 *
 * ถ้าไฟล์สถานะบอกว่า "กำลังทำอยู่" แต่ล็อกไม่มีใครถือแล้ว แปลว่างานนั้นตายไปกลางทาง
 * (คอนเทนเนอร์ถูกรีสตาร์ทตอนกำลังเรนเดอร์) ต้องรายงานตามจริงว่าหยุดไปแล้ว
 * ไม่ใช่ปล่อยให้หน้าเว็บหมุนรอตลอดกาล
 */
export async function jobStatus() {
  const stored = current ?? (await readPersisted());
  const film = await existingFilm();
  const owner = await lockOwner();

  if (stored?.state === 'running' && !owner) {
    const stopped = { ...stored, state: 'stopped', error: 'งานหยุดกลางทาง (เซิร์ฟเวอร์รีสตาร์ท) — กดเริ่มใหม่ได้ ระบบจะทำต่อจากเดิม' };
    current = stopped;
    void persist(stopped);
    return { ...stopped, film, busyElsewhere: false };
  }

  return {
    ...(stored ?? { state: 'idle' }),
    film,
    // งานที่สั่งจาก ssh ก็ถือล็อกเหมือนกัน ปุ่มในเว็บต้องรู้และไม่ให้กดซ้อน
    busyElsewhere: Boolean(owner) && owner.source !== 'web' && stored?.state !== 'running',
  };
}

/**
 * เริ่มงานแบบไม่รอให้เสร็จ — ผู้เรียกได้คำตอบทันที แล้วไปดูความคืบหน้าที่ /status
 *
 * ห้าม await ตัวงานใน handler ของ express เด็ดขาด งานนี้ใช้เวลาเป็นสิบ ๆ นาที
 * เบราว์เซอร์กับ reverse proxy ตัดการเชื่อมต่อไปก่อนนานแล้ว
 */
export async function startJob(options = {}) {
  if (current?.state === 'running') {
    const error = new Error('มีงาน export กำลังทำอยู่แล้ว');
    error.code = 'BUSY';
    throw error;
  }

  // ต้องถามล็อกบนดิสก์ด้วย ไม่ใช่ดูแค่สถานะในหน่วยความจำของโปรเซสนี้
  //
  // เทสต์จับได้: งานที่สั่งจาก ssh รันอยู่ในคอนเทนเนอร์คนละตัว โปรเซสนี้จึงไม่รู้
  // เลยว่ามีงานอยู่ ปุ่มตอบ 200 ว่าเริ่มแล้ว หน้าเว็บขึ้นแถบความคืบหน้า แล้วอีก
  // ครู่หนึ่งค่อยพลิกเป็น "ล้มเหลว" ซึ่งอ่านแล้วงงว่าตกลงเกิดอะไรขึ้น
  const owner = await lockOwner();
  if (owner) {
    const error = new Error(owner.source === 'web'
      ? 'มีงาน export กำลังทำอยู่แล้ว'
      : 'มีงาน export กำลังรันอยู่แล้ว (เริ่มจาก SSH)');
    error.code = 'LOCKED';
    throw error;
  }

  update({
    state: 'running',
    phase: 'starting',
    done: 0,
    total: 0,
    counts: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  runExport({ ...options, source: 'web' }, (progress) => {
    update({
      phase: progress.phase,
      done: progress.done ?? 0,
      total: progress.total ?? 0,
      counts: progress.counts ?? current?.counts ?? null,
      secondsLeft: progress.secondsLeft ?? null,
    });
  })
    .then((result) => {
      update({
        state: 'done',
        phase: 'done',
        bytes: result.bytes,
        counts: result.counts,
        finishedAt: new Date().toISOString(),
      });
    })
    .catch((error) => {
      update({
        state: 'failed',
        phase: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString(),
      });
    });

  return current;
}
