import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * กล้องใหญ่ต่อสาย USB — ลั่นชัตเตอร์จริง ไม่ใช่ตัดเฟรมจากวิดีโอ
 *
 * **ทำไมไม่ใช้ Live View ของกล้องมาเป็นภาพพรีวิว** (ซึ่งเป็นสิ่งแรกที่ทุกคนคิดถึง)
 * เพราะ Live View เปิดค้างทั้งคืนทำให้เกิดสามอย่างที่ฆ่างานได้จริง:
 *   1. เซนเซอร์ร้อนจนกล้อง **ปิด Live View เอง** กลางงาน
 *   2. แบตหมดใน 1–1.5 ชั่วโมง
 *   3. HDMI ของ D7000/700D ไม่ใช่ clean output — เมนูกับกรอบโฟกัสไปโผล่บนจอแขก
 * และเมื่อกล้องตัด **จอบูธจะดำทันที** ซึ่งคือบูธที่หยุดรับเงินกลางคิว
 *
 * สถาปัตยกรรมที่เลือกจึงแยกสองหน้าที่ออกจากกันคนละอุปกรณ์
 *   เว็บแคม → ภาพสดบนจอ (ไม่มีวันร้อน ไม่มีวันตัด)
 *   กล้องใหญ่ → นั่งเฉย ๆ รอคำสั่ง ตื่นเฉพาะตอนลั่นชัตเตอร์
 * ผลคือกล้องเย็น แบตอยู่ได้ทั้งคืน และได้ไฟล์เต็มความละเอียดจากเซนเซอร์ APS-C
 *
 * ⚠️ **โมดูลนี้ไม่เคยถูกทดสอบกับกล้องจริงจากเครื่องพัฒนา** — เขียนตามสเปกของ
 * libgphoto2 และมีเทสต์คุมทุกเส้นทางด้วยกล้องจำลอง แต่ตัวตัดสินคือเจ้าของบูธ
 * ต้องเสียบกล้องจริงลองหนึ่งรอบก่อนวันงาน
 */

/** เวลาที่ยอมรอ · กล้องที่ค้างต้องไม่ทำให้แขกยืนรอไปด้วย — เกินนี้ตกไปใช้เว็บแคม */
const CAPTURE_TIMEOUT_MS = 12000;
const DETECT_TIMEOUT_MS = 8000;

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * ไฟล์ที่ได้เป็น JPEG จริงไหม
 *
 * gphoto2 คืนรหัส 0 ได้ทั้งที่ไฟล์ถูกตัดกลางคัน (สาย USB หลวม การ์ดเต็ม) ·
 * ส่งไฟล์พังต่อให้ sharp = รอบนั้นล้มตอนประกอบแผ่น ซึ่งไกลจากต้นเหตุจนหาไม่เจอ
 */
export const isJpeg = (data) =>
  Buffer.isBuffer(data) && data.length > 3 && data.subarray(0, 3).equals(JPEG_MAGIC);

/**
 * แกะรายชื่อกล้องจากผลของ `gphoto2 --auto-detect`
 *
 * รูปแบบผลลัพธ์เป็นตารางสองคอลัมน์คั่นด้วยช่องว่างหลายตัว บรรทัดหัวตารางกับเส้นคั่น
 * ต้องไม่ถูกนับเป็นกล้อง — ยึดที่คอลัมน์ขวาต้องขึ้นต้นด้วย `usb:` ซึ่งหัวตาราง
 * (คำว่า "Port") ไม่มีทางตรง
 */
export function parseCameras(stdout) {
  const found = [];
  for (const line of String(stdout ?? '').split('\n')) {
    const match = line.match(/^(\S.*?)\s{2,}(usb:[\d,]+)\s*$/);
    if (match) found.push({ model: match[1].trim(), port: match[2] });
  }
  return found;
}

/**
 * แปลข้อความผิดพลาดของ gphoto2 เป็นสิ่งที่คนหน้าบูธ **ลงมือแก้ได้**
 *
 * "PTP I/O Error" บนจอกลางงานมีค่าเท่ากับไม่มีข้อความเลย · ทุกบรรทัดในตารางนี้
 * มาจากสาเหตุที่เกิดจริงกับบูธที่ใช้ gphoto2 และมีทางแก้ที่ทำได้ภายในหนึ่งนาที
 */
const HINTS = [
  [/could not claim|device is busy|resource busy/i,
    'มีโปรแกรมอื่นจับกล้องอยู่ — ตัวจัดการไฟล์ของ Linux มักเปิดกล้องเองอัตโนมัติ '
    + 'สั่ง `pkill -f gvfs-gphoto2` แล้วลองใหม่'],
  [/out of focus|focus/i,
    'กล้องโฟกัสไม่ได้จึงไม่ยอมลั่นชัตเตอร์ — ปรับสวิตช์ที่เลนส์เป็น M แล้วล็อกระยะไว้ '
    + '(บูธควรตั้ง MF อยู่แล้ว เพราะเร็วกว่าและไม่หลุดกลางคิว)'],
  [/could not detect any camera|no camera found|unknown model/i,
    'ไม่พบกล้อง — เช็กว่าสาย USB เสียบแน่น กล้องเปิดอยู่ และไม่ได้ค้างอยู่ในโหมดเล่นภาพ'],
  [/enoent|command not found|no such file/i,
    'ยังไม่ได้ติดตั้ง gphoto2 บนเครื่องนี้ — บน Debian/Ubuntu สั่ง `sudo apt install gphoto2`'],
  [/timed out|หมดเวลา/i,
    'กล้องไม่ตอบในเวลาที่กำหนด — ปิดเปิดกล้องหนึ่งครั้ง แล้วเช็กว่าแบตกล้องยังมี'],
  [/no space|card.*full|memory/i,
    'การ์ดในกล้องเต็ม — เปลี่ยนการ์ดหรือลบไฟล์เก่าออก'],
];

export function explain(stderr) {
  const text = String(stderr ?? '');
  for (const [pattern, hint] of HINTS) {
    if (pattern.test(text)) return hint;
  }
  // ไม่รู้จักก็ต้องส่งของจริงออกไป ไม่ใช่กลืนแล้วบอกว่า "เกิดข้อผิดพลาด"
  const first = text.split('\n').map((line) => line.trim()).filter(Boolean)[0];
  return first ? `กล้องตอบกลับมาว่า: ${first}` : 'สั่งกล้องไม่สำเร็จ โดยไม่มีข้อความอธิบาย';
}

/** รันคำสั่งหนึ่งครั้ง · ไม่โยน error ออกไป — ผู้เรียกเป็นคนตัดสินว่าล้มแล้วทำอะไรต่อ */
function runner(spawnImpl) {
  return (bin, args, timeout) => new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: error.message });
      return;
    }

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });

    const done = (code, extra = '') => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr: stderr + extra });
    };

    /*
     * หมดเวลาแล้ว **ตอบทันที ไม่รอให้กระบวนการปิดตัวก่อน**
     *
     * ฆ่าแล้วรอ 'close' ดูสมเหตุสมผลกว่า แต่กระบวนการที่ค้างอยู่ในไดรเวอร์ USB
     * อาจไม่ยอมตายเลย (สถานะ D — uninterruptible sleep ซึ่งเกิดจริงกับ USB ที่
     * ครึ่งหลุดครึ่งติด) แล้วคำสั่งนี้จะค้างตลอดไปพร้อมกับแขกที่ยืนรออยู่
     * สั่งฆ่าไปด้วยแล้วเดินหน้าต่อ · `resolve` ซ้ำไม่มีผลถ้ามันปิดตัวตามมาทีหลัง
     */
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(-1, '\ntimed out — หมดเวลารอกล้องตอบ');
    }, timeout);

    // ไบนารีที่ไม่มีอยู่จะยิง 'error' แล้วไม่มี 'close' ตามมา — ต้องรับทั้งสองทาง
    child.once('error', (error) => done(-1, error.message));
    child.once('close', (code) => done(code ?? -1));
  });
}

/**
 * ตัวคุมกล้องหนึ่งตัว
 *
 * `spawnImpl` กับ `bin` ฉีดเข้ามาได้เพื่อให้เทสต์ขับได้ทุกเส้นทางโดยไม่ต้องมีกล้องจริง
 * ซึ่งจำเป็น เพราะเส้นทางที่ต้องมั่นใจที่สุดคือ **เส้นทางที่กล้องพัง** ไม่ใช่เส้นทางที่ดี
 */
export function createCamera({
  bin = process.env.BOOTH_GPHOTO2 || 'gphoto2',
  spawnImpl = spawn,
  captureTimeoutMs = CAPTURE_TIMEOUT_MS,
  detectTimeoutMs = DETECT_TIMEOUT_MS,
} = {}) {
  const run = runner(spawnImpl);

  /*
   * คำสั่งต้องเดินทีละคำสั่ง — กล้องหนึ่งตัวรับได้ทีละงาน
   *
   * ยิงพร้อมกันสองคำสั่งจะได้ "Could not claim the USB device" ซึ่งอ่านแล้วเหมือน
   * สายหลวม ทั้งที่เป็นความผิดของเราเอง · ต่อคิวไว้ตรงนี้ที่เดียว ผู้เรียกจึงไม่ต้องรู้
   */
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work, work);
    queue = next.then(() => {}, () => {});
    return next;
  };

  // กล้องบางตัวไม่รับคำสั่งเก็บลงการ์ด · ลองครั้งเดียวแล้วจำไว้ ไม่ใช่ลองซ้ำทุกรูป
  let cardWorks = true;

  const detect = () => serial(async () => {
    const result = await run(bin, ['--auto-detect'], detectTimeoutMs);
    if (result.code !== 0) return { ok: false, reason: explain(result.stderr) };

    const cameras = parseCameras(result.stdout);
    if (cameras.length === 0) {
      return { ok: false, reason: explain('could not detect any camera') };
    }
    // เจอกล้องแล้ว = เสียบใหม่/เปิดใหม่ · ให้โอกาสคำสั่งเก็บลงการ์ดอีกครั้ง
    cardWorks = true;
    return { ok: true, model: cameras[0].model, port: cameras[0].port };
  });

  /**
   * ลั่นชัตเตอร์หนึ่งครั้ง แล้วคืนไฟล์ JPEG
   *
   * `keepOnCard` สั่งให้กล้องเขียนลงการ์ดด้วย ไม่ใช่แค่ส่งผ่านสายมา — D7000 มีช่อง
   * การ์ดสองช่อง ตั้งให้เขียนพร้อมกันได้ **ทุกรูปที่ลูกค้าจ่ายเงินแล้วจึงมีสำเนาอยู่ใน
   * กล้องเสมอ** คืนนั้นถ้าคอมดับหรือดิสก์เต็ม รูปยังอยู่ครบ · กล้องที่ไม่รับคำสั่งนี้
   * ต้องยังถ่ายได้ตามปกติ ไม่ใช่ล้มทั้งรอบเพราะของแถมชิ้นเดียว
   */
  const capture = (file, { keepOnCard = true } = {}) => serial(async () => {
    const base = ['--capture-image-and-download', '--filename', file, '--force-overwrite'];

    /*
     * โฟลเดอร์ปลายทางต้องมีอยู่ก่อน — gphoto2 ไม่สร้างให้
     *
     * เครื่องที่เพิ่งลงใหม่และตั้งโหมดกล้องใหญ่ไว้ตั้งแต่แรก จะยังไม่มีโฟลเดอร์ข้อมูล
     * เลยจนกว่าจะจองรอบถ่ายรอบแรก ซึ่งเกิด **หลัง** การถ่ายในโหมดจ่ายทีหลัง
     * — แขกคนแรกของบูธใหม่จะเจอกล้องที่ถ่ายไม่ได้โดยไม่มีอะไรผิดเลยสักอย่าง
     */
    await fs.mkdir(path.dirname(file), { recursive: true }).catch(() => {});

    const attempt = async (args) => {
      await fs.rm(file, { force: true }).catch(() => {});
      const result = await run(bin, args, captureTimeoutMs);
      if (result.code !== 0) return { ok: false, stderr: result.stderr };

      const data = await fs.readFile(file).catch(() => null);
      await fs.rm(file, { force: true }).catch(() => {});
      if (!isJpeg(data)) {
        return { ok: false, stderr: `${result.stderr}\nไฟล์ที่กล้องส่งมาไม่ใช่รูป JPEG ที่สมบูรณ์` };
      }
      return { ok: true, data };
    };

    if (keepOnCard && cardWorks) {
      const withCard = await attempt(['--set-config', 'capturetarget=1', ...base]);
      if (withCard.ok) return withCard;
      cardWorks = false;
      console.warn('[camera] กล้องไม่รับคำสั่งเก็บลงการ์ด — ถ่ายต่อโดยไม่มีสำเนาในกล้อง');
    }

    const plain = await attempt(base);
    return plain.ok ? plain : { ok: false, reason: explain(plain.stderr) };
  });

  return { detect, capture };
}
