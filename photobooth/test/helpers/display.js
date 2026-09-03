import { spawn } from 'node:child_process';

/**
 * จอปลอมสำหรับเทสต์ที่ต้องเปิดหน้าต่างจริง
 *
 * เทสต์ที่ขับ Electron ต้องมี X server · เครื่อง CI กับคอนเทนเนอร์ไม่มีจอ จึงยก
 * Xvfb ขึ้นมาเอง · เดิมทุกไฟล์ก๊อปโค้ดชุดนี้ไปคนละก๊อปพร้อมเลขจอตายตัวคนละเลข
 *
 * **ปัญหาที่ทำให้ต้องรวมมาไว้ที่เดียว**: Xvfb ที่ถูกฆ่าทิ้งกลางทาง (เทสต์ล้ม,
 * กด Ctrl-C, timeout) ทิ้งไฟล์ `/tmp/.X<เลข>-lock` ค้างไว้ แล้วรอบถัดไปเปิดจอ
 * เลขเดิมไม่ได้ตลอดไป — ผลคือทั้งไฟล์ถูก **ข้าม** เงียบ ๆ พร้อมข้อความว่า
 * "ไม่มีทั้ง DISPLAY และ Xvfb" ซึ่งอ่านแล้วนึกว่าเครื่องไม่มี Xvfb
 * (เกิดขึ้นจริง: สี่ข้อใน screen-mode.test.js ถูกข้ามอยู่พักหนึ่งโดยไม่มีใครรู้)
 *
 * ลองหลายเลขแทนที่จะยึดเลขเดียว — ล็อกค้างหนึ่งเลขจึงแค่ข้ามไปใช้เลขถัดไป
 * และไม่ต้องไปลบไฟล์ใน /tmp ของใครทิ้ง ซึ่งอาจเป็นจอที่คนอื่นใช้อยู่จริง
 */
export async function startDisplay(numbers) {
  if (process.env.DISPLAY) return null;

  const problems = [];
  for (const number of numbers) {
    const child = spawn('Xvfb', [`:${number}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'pipe'], detached: true });

    let complaint = '';
    child.stderr.on('data', (chunk) => { complaint += chunk; });

    const ok = await new Promise((done) => {
      child.once('error', () => done(false));
      child.once('exit', () => done(false));
      // ยังไม่ตายใน 1.2 วินาที = ขึ้นแล้ว · Xvfb ที่ล้มจะล้มทันที ไม่ใช่ค่อย ๆ ล้ม
      setTimeout(() => done(true), 1200);
    });

    if (ok) {
      process.env.DISPLAY = `:${number}`;
      return child;
    }
    child.kill('SIGKILL');
    problems.push(`:${number} ${complaint.trim().split('\n').pop() ?? 'ไม่ทราบสาเหตุ'}`);
  }

  throw new Error(`เปิดจอปลอมไม่ได้เลยสักเลข — ${problems.join(' · ')}`);
}
