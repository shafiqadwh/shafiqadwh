import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { acquireLock, lockOwner } from './film-lock.js';
import { STYLES, runExport } from './film-run.js';
import { currentEvent } from './tenancy.js';

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

/*
 * ที่อยู่ของไฟล์สถานะ **ต้องคิดตอนใช้ ไม่ใช่ตอนโหลดโมดูล**
 *
 * เดิมเป็นค่าคงที่ระดับโมดูล ซึ่งถูกคำนวณครั้งเดียวตอนบูต = โฟลเดอร์ของงาน
 * เริ่มต้นเสมอ · วัดแล้วเห็นจริง: สั่ง export ของงาน alpha แล้วไฟล์สถานะไป
 * โผล่ในโฟลเดอร์ของงาน main และงาน beta เปิดหน้าแอดมินเห็น state=running
 * ทั้งที่ไม่ได้สั่งอะไรเลย
 */
const statusPath = () => path.join(config.paths.export, 'status.json');

// สถานะในหน่วยความจำของโปรเซสนี้ ใช้ตอบเร็ว ๆ โดยไม่ต้องอ่านดิสก์ทุกครั้งที่ poll
// **แยกต่องาน** — ตัวแปรเดียวทั้งโปรเซสทำให้หน้าแอดมินของงานหนึ่งเห็น
// ความคืบหน้าของอีกงานที่กำลังเรนเดอร์อยู่
const memory = new Map();
const current = () => memory.get(currentEvent().slug) ?? null;
const remember = (status) => memory.set(currentEvent().slug, status);

async function persist(status) {
  try {
    await fs.mkdir(config.paths.export, { recursive: true });
    await fs.writeFile(statusPath(), JSON.stringify(status));
  } catch {
    // เขียนไม่ได้ก็ยังทำงานต่อได้ แค่หน้าเว็บจะไม่เห็นความคืบหน้าหลังรีเฟรช
  }
}

async function readPersisted() {
  try {
    return JSON.parse(await fs.readFile(statusPath(), 'utf8'));
  } catch {
    return null;
  }
}

function update(patch) {
  const status = { ...current(), ...patch, updatedAt: new Date().toISOString() };
  remember(status);
  void persist(status);
  return status;
}

/**
 * หนังทุกเรื่องที่เคยสร้างไว้ เรียงจากใหม่ไปเก่า
 *
 * เดิมเก็บไฟล์เดียวชื่อตายตัวแล้วทับทุกครั้งที่สร้างใหม่ — เจ้าของบอกว่าอยาก
 * ลองหลายแบบแล้วเทียบกัน ตอนนี้แต่ละครั้งจึงได้ไฟล์ของตัวเอง พร้อมไฟล์ข้อมูล
 * ข้าง ๆ ที่บอกว่าใช้รูปแบบไหนและมีอะไรอยู่ในนั้นบ้าง
 *
 * รายการอ่านจากโฟลเดอร์จริง ไม่ใช่จากทะเบียนที่เก็บแยก ถ้าใครลบไฟล์ทิ้งเองจาก
 * File Station รายการก็หายตามไปเอง ไม่มีรายการผีค้างให้กดแล้วเจอ 404
 */
export async function listFilms() {
  let names;
  try {
    names = await fs.readdir(config.paths.films);
  } catch {
    return [];
  }

  const films = [];
  for (const name of names) {
    if (!name.endsWith('.mp4')) continue;
    const filePath = path.join(config.paths.films, name);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (stat.size < 1024) continue;

    let meta = {};
    try {
      meta = JSON.parse(await fs.readFile(`${filePath}.json`, 'utf8'));
    } catch {
      // ไม่มีไฟล์ข้อมูลก็ยังแสดงได้ แค่บอกรายละเอียดได้น้อยกว่า
    }

    films.push({
      id: name,
      bytes: stat.size,
      madeAt: meta.madeAt ?? stat.mtime.toISOString(),
      style: meta.style ?? (name.includes('-wall') ? 'wall' : 'cinema'),
      counts: meta.counts ?? null,
      seconds: meta.seconds ?? null,
      music: meta.music ?? false,
    });
  }

  return films.sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

/**
 * เส้นทางของหนังเรื่องหนึ่งจากชื่อที่หน้าเว็บส่งมา
 *
 * ชื่อมาจากผู้ใช้ จึงต้องกันการเดินออกนอกโฟลเดอร์ — "../../.env" เป็นชื่อไฟล์
 * ที่ส่งมาได้ และถ้าเอาไปต่อ path ตรง ๆ จะอ่านหรือลบไฟล์นอกโฟลเดอร์ได้
 */
export function filmPath(id) {
  const name = path.basename(String(id ?? ''));
  if (!name.endsWith('.mp4') || name !== id) return null;
  return path.join(config.paths.films, name);
}

export async function deleteFilm(id) {
  const target = filmPath(id);
  if (!target) return false;
  try {
    await fs.stat(target);
  } catch {
    return false;
  }
  await fs.rm(target, { force: true });
  await fs.rm(`${target}.json`, { force: true });
  return true;
}

/**
 * สถานะปัจจุบันสำหรับหน้าแอดมิน
 *
 * ถ้าไฟล์สถานะบอกว่า "กำลังทำอยู่" แต่ล็อกไม่มีใครถือแล้ว แปลว่างานนั้นตายไปกลางทาง
 * (คอนเทนเนอร์ถูกรีสตาร์ทตอนกำลังเรนเดอร์) ต้องรายงานตามจริงว่าหยุดไปแล้ว
 * ไม่ใช่ปล่อยให้หน้าเว็บหมุนรอตลอดกาล
 */
export async function jobStatus() {
  const stored = current() ?? (await readPersisted());
  const films = await listFilms();
  const owner = await lockOwner();

  if (stored?.state === 'running' && !owner) {
    const stopped = { ...stored, state: 'stopped', error: 'งานหยุดกลางทาง (เซิร์ฟเวอร์รีสตาร์ท) — กดเริ่มใหม่ได้ ระบบจะทำต่อจากเดิม' };
    remember(stopped);
    void persist(stopped);
    return { ...stopped, films, busyElsewhere: false };
  }

  return {
    ...(stored ?? { state: 'idle' }),
    films,
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
  if (current()?.state === 'running') {
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

  const styles = (Array.isArray(options.styles) && options.styles.length > 0)
    ? options.styles.filter((style) => STYLES.includes(style))
    : [STYLES.includes(options.style) ? options.style : 'cinema'];

  // ถือล็อกให้ได้ *ก่อน* ประกาศว่างานเริ่มแล้ว
  //
  // ถ้าปล่อยให้ runExport ไปขอเอง จะมีช่วงสั้น ๆ ที่สถานะบอกว่า "กำลังทำ" แต่ยัง
  // ไม่มีใครถือล็อก แล้ว jobStatus() จะอ่านว่างานตายกลางทางและรายงานว่า "หยุดกลางทาง"
  // ทั้งที่เพิ่งกดปุ่มไปเมื่อครู่ — เห็นชัดตอนทำหลายรูปแบบ เพราะมี await คั่นก่อนเริ่มจริง
  const held = await acquireLock('web');

  update({
    state: 'running',
    phase: 'starting',
    done: 0,
    total: 0,
    counts: null,
    error: null,
    styleIndex: 0,
    styleTotal: styles.length,
    styles,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  void runAll(styles, options, held);
  return current();
}

/**
 * เรนเดอร์ทีละรูปแบบจนครบ แล้วค่อยรายงานว่าเสร็จ
 *
 * ความยาวกับเตียงเสียงคิด **ครั้งเดียว** ในรอบแรก แล้วส่งต่อให้รอบถัดไปใช้ซ้ำ —
 * ไม่งั้นหนังสองเรื่องที่มาจากรูปชุดเดียวกันจะยาวไม่เท่ากันและเพลงคนละชุด
 * ซึ่งเป็นเรื่องที่คนดูสังเกตเห็นทันทีเมื่อเปิดสองไฟล์เทียบกัน
 */
async function runAll(styles, options, held) {
  const made = [];
  let shared = {};

  try {
    for (const [index, style] of styles.entries()) {
      update({ styleIndex: index, phase: 'starting', done: 0, total: 0 });

      const result = await runExport({ ...options, ...shared, style, source: 'web', lock: held }, (progress) => {
        update({
          phase: progress.phase,
          done: progress.done ?? 0,
          total: progress.total ?? 0,
          counts: progress.counts ?? current()?.counts ?? null,
          secondsLeft: progress.secondsLeft ?? null,
          styleIndex: index,
        });
      });

      // ไฟล์ข้อมูลข้าง ๆ หนัง บอกว่าเรื่องนี้ใช้รูปแบบไหนและมีอะไรอยู่ข้างใน
      // เก็บไว้ตอนนี้เลย เพราะข้อมูลพวกนี้อ่านย้อนหลังจากตัวไฟล์ mp4 ไม่ได้
      await fs.writeFile(`${result.out}.json`, JSON.stringify({
        madeAt: new Date().toISOString(),
        style: result.style,
        counts: result.counts,
        seconds: result.plan?.secondsPerPhoto ?? null,
        music: Boolean(options.music) || (options.tracks?.length ?? 0) > 0,
        tracks: options.tracks?.length ?? 0,
      })).catch(() => {});

      made.push(result);

      // รอบถัดไปใช้ความยาวและเตียงเสียงชุดเดิม ไม่คิดใหม่
      shared = {
        plan: result.plan,
        bed: shared.bed ?? bedFrom(result, options),
      };
    }

    /*
     * เก็บกวาดคลิปย่อยเมื่อหนังครบทุกเรื่องแล้ว
     *
     * คลิปถูกเก็บไว้ระหว่างทางเพื่อให้รันซ้ำแล้วทำต่อจากเดิมได้ แต่พอจบงานแล้ว
     * มันไม่มีประโยชน์อีกเลย — งาน 800 รูปคือคลิปย่อยราว 800 ไฟล์ต่อหนึ่งรูปแบบ
     * และค่าเริ่มต้นคือทำสองรูปแบบ จึงกองสะสมรอบละสองชุดบน NAS ที่เก็บวิดีโอ
     * งานแต่งอยู่แล้ว **ล้างเฉพาะตอนสำเร็จ** ตอนล้มต้องเก็บไว้ ไม่งั้นกดใหม่
     * ก็ต้องเรนเดอร์ใหม่ทั้งเรื่อง ซึ่งเป็นเหตุผลที่มีคลิปย่อยตั้งแต่แรก
     */
    for (const result of made) {
      await fs.rm(result.work, { recursive: true, force: true }).catch(() => {});
    }

    update({
      state: 'done',
      phase: 'done',
      bytes: made.reduce((sum, one) => sum + one.bytes, 0),
      counts: made.at(-1)?.counts ?? null,
      styleIndex: styles.length,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    update({
      state: 'failed',
      phase: 'failed',
      error: error.message,
      finishedAt: new Date().toISOString(),
    });
  } finally {
    await held.release().catch(() => {});
  }
}

/** เตียงเสียงที่รอบแรกสร้างไว้ อยู่ในโฟลเดอร์งานของรูปแบบนั้น */
function bedFrom(result, options) {
  if (!(options.tracks?.length > 0)) return undefined;
  return path.join(result.work, 'music-bed.m4a');
}
