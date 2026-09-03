import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { createLock } from './film-lock.js';
import { uploadersPages, wishesPages } from './paper.js';
import { writePdf } from './pdf.js';
import { currentEvent } from './tenancy.js';

/**
 * งานสร้าง PDF ที่สั่งจากหน้าแอดมิน — โครงเดียวกับงาน export หนัง
 *
 * เก็บสถานะไว้บนดิสก์ ไม่ใช่แค่ในหน่วยความจำ เพราะเจ้าของกดปุ่มแล้วต้องปิดมือถือ
 * ไปทำอย่างอื่นได้ กลับมาเปิดหน้าใหม่ต้องเห็นว่างานไปถึงไหน
 *
 * ใช้ไฟล์ล็อกคนละใบกับงานหนัง — สองงานนี้ไม่ได้แย่งไฟล์อะไรกัน การใช้ล็อกร่วมกัน
 * จะแปลว่าสร้าง PDF ไม่ได้ตลอดครึ่งชั่วโมงที่หนังกำลังเรนเดอร์อยู่
 */

export const KINDS = ['wishes', 'uploaders'];

/*
 * ที่อยู่ของไฟล์สถานะ **ต้องคิดตอนใช้ ไม่ใช่ตอนโหลดโมดูล**
 *
 * เดิมเป็นค่าคงที่ระดับโมดูล ซึ่งถูกคำนวณครั้งเดียวตอนบูต = โฟลเดอร์ของงาน
 * เริ่มต้นเสมอ · วัดแล้วเห็นจริง: สั่ง export ของงาน alpha แล้วไฟล์สถานะไป
 * โผล่ในโฟลเดอร์ของงาน main และงาน beta เปิดหน้าแอดมินเห็น state=running
 * ทั้งที่ไม่ได้สั่งอะไรเลย
 */
const statusPath = () => path.join(config.paths.export, 'paper-status.json');
const lock = createLock('.paper-lock', {
  busyMessage: () => 'มีงานสร้างเอกสารกำลังทำอยู่แล้ว',
});

// สถานะในหน่วยความจำ **ต่องาน** — ตัวแปรเดียวทั้งโปรเซสทำให้หน้าแอดมินของ
// งานหนึ่งเห็นความคืบหน้าของอีกงานที่กำลังเรนเดอร์อยู่
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

function fileName(kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  return `wedding-${kind}-${stamp}.pdf`;
}

/**
 * เอกสารทุกเล่มที่เคยสร้างไว้ เรียงจากใหม่ไปเก่า
 *
 * อ่านจากโฟลเดอร์จริง ไม่ใช่จากทะเบียนที่เก็บแยก — ถ้าใครลบไฟล์ทิ้งเองจาก
 * File Station รายการก็หายตามไปเอง ไม่มีรายการผีค้างให้กดแล้วเจอ 404
 */
export async function listPapers() {
  let names;
  try {
    names = await fs.readdir(config.paths.papers);
  } catch {
    return [];
  }

  const papers = [];
  for (const name of names) {
    if (!name.endsWith('.pdf')) continue;
    const filePath = path.join(config.paths.papers, name);

    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (stat.size < 512) continue;

    let meta = {};
    try {
      meta = JSON.parse(await fs.readFile(`${filePath}.json`, 'utf8'));
    } catch {
      // ไม่มีไฟล์ข้อมูลก็ยังแสดงได้ แค่บอกรายละเอียดได้น้อยกว่า
    }

    papers.push({
      id: name,
      bytes: stat.size,
      madeAt: meta.madeAt ?? stat.mtime.toISOString(),
      kind: meta.kind ?? (name.includes('-uploaders-') ? 'uploaders' : 'wishes'),
      pages: meta.pages ?? null,
      counts: meta.counts ?? null,
    });
  }

  return papers.sort((a, b) => b.madeAt.localeCompare(a.madeAt));
}

/**
 * เส้นทางของเอกสารหนึ่งเล่มจากชื่อที่หน้าเว็บส่งมา
 *
 * ชื่อมาจากผู้ใช้ จึงต้องกันการเดินออกนอกโฟลเดอร์ — "../../.env" เป็นชื่อไฟล์
 * ที่ส่งมาได้ และถ้าเอาไปต่อ path ตรง ๆ จะอ่านหรือลบไฟล์นอกโฟลเดอร์ได้
 */
export function paperPath(id) {
  const name = path.basename(String(id ?? ''));
  if (!name.endsWith('.pdf') || name !== id) return null;
  return path.join(config.paths.papers, name);
}

export async function deletePaper(id) {
  const target = paperPath(id);
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
 * ถ้าไฟล์สถานะบอกว่า "กำลังทำอยู่" แต่ล็อกไม่มีใครถือแล้ว แปลว่างานนั้นตายกลางทาง
 * ต้องรายงานตามจริง ไม่ใช่ปล่อยให้หน้าเว็บหมุนรอตลอดกาล
 */
export async function jobStatus() {
  const stored = current() ?? (await readPersisted());
  const papers = await listPapers();
  const owner = await lock.owner();

  if (stored?.state === 'running' && !owner) {
    const stopped = { ...stored, state: 'stopped', error: 'งานหยุดกลางทาง (เซิร์ฟเวอร์รีสตาร์ท) — กดเริ่มใหม่ได้' };
    remember(stopped);
    void persist(stopped);
    return { ...stopped, papers };
  }

  return { ...(stored ?? { state: 'idle' }), papers };
}

/**
 * เริ่มงานแบบไม่รอให้เสร็จ — ผู้เรียกได้คำตอบทันที แล้วไปดูความคืบหน้าที่ /status
 *
 * งานที่มีรูปเป็นพันใบใช้เวลาหลายนาที เบราว์เซอร์กับ reverse proxy ตัดการเชื่อมต่อ
 * ไปก่อนนานแล้ว ห้าม await ตัวงานใน handler ของ express เด็ดขาด
 */
export async function startJob({ kind, t, lang }) {
  if (!KINDS.includes(kind)) {
    const error = new Error(`ไม่รู้จักชนิดเอกสาร: ${kind}`);
    error.code = 'BAD_KIND';
    throw error;
  }
  if (current()?.state === 'running') {
    const error = new Error('มีงานสร้างเอกสารกำลังทำอยู่แล้ว');
    error.code = 'BUSY';
    throw error;
  }

  // ถือล็อกให้ได้ *ก่อน* ประกาศว่างานเริ่มแล้ว
  //
  // ถ้าไปถือทีหลังใน run() จะมีช่วงสั้น ๆ ที่สถานะบอกว่า "กำลังทำ" แต่ยังไม่มีใคร
  // ถือล็อก แล้ว jobStatus() จะอ่านว่างานตายกลางทางและรายงานว่า "หยุดกลางทาง"
  // ทั้งที่เพิ่งกดปุ่มไปเมื่อครู่ — เทสต์จับได้ตอน poll เร็ว ๆ หลังกดปุ่ม
  let handle;
  try {
    handle = await lock.acquire('web');
  } catch (error) {
    error.code = error.code ?? 'LOCKED';
    throw error;
  }

  update({
    state: 'running',
    kind,
    done: 0,
    total: 0,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  });

  void run({ kind, t, lang, handle });
  return current();
}

async function run({ kind, t, lang, handle }) {
  try {
    const build = kind === 'uploaders' ? uploadersPages : wishesPages;
    const { pages, counts } = await build(t, lang, (progress) => {
      update({ done: progress.done, total: progress.total });
    });

    const name = fileName(kind);
    const out = path.join(config.paths.papers, name);
    const bytes = await writePdf(pages, out, { title: t(`paper.${kind}_title`) });

    // ไฟล์ข้อมูลข้าง ๆ — จำนวนหน้ากับจำนวนแขกอ่านย้อนหลังจากตัว PDF ไม่ได้
    await fs.writeFile(`${out}.json`, JSON.stringify({
      madeAt: new Date().toISOString(),
      kind,
      pages: pages.length,
      counts,
    })).catch(() => {});

    update({
      state: 'done',
      id: name,
      pages: pages.length,
      bytes,
      counts,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    update({ state: 'failed', error: error.message, finishedAt: new Date().toISOString() });
  } finally {
    await handle.release().catch(() => {});
  }
}
