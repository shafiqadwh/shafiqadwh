import sharp from 'sharp';
import { applyEffect } from './effects.js';

/**
 * ภาพเคลื่อนไหวจากรูปชุดเดียวกับที่พิมพ์ลงแผ่น
 *
 * เป็นของที่แขกได้กลับไป "ใช้จริง" มากที่สุด — แผ่นกระดาษอยู่ในกระเป๋า แต่ GIF
 * ถูกส่งต่อในไลน์กลุ่มครอบครัวคืนนั้นเลย · เลือก GIF ไม่ใช่ WebP/วิดีโอ เพราะ
 * แอปแชททุกตัวเล่นให้เองโดยไม่ต้องกด และส่งต่อได้โดยไม่กลายเป็นไฟล์แนบ
 *
 * ใช้เอฟเฟคตัวเดียวกับที่แขกเลือกไว้บนแผ่น — ได้แผ่นโทนฟิล์มแต่ GIF สีสด
 * คือของสองชิ้นที่ดูเหมือนมาจากคนละงาน
 */

// 540 พอสำหรับดูบนมือถือและส่งในแชท · ใหญ่กว่านี้ไฟล์โตเร็วมากเพราะ GIF เก็บ
// ทุกเฟรมเต็มใบ ไม่ได้บีบข้ามเฟรมแบบวิดีโอ
export const GIF_WIDTH = 540;
export const GIF_DELAY_MS = 420;

/**
 * ไป-กลับ แทนที่จะวนกลับไปเฟรมแรกดื้อ ๆ
 *
 * 1→2→3→2 ทำให้รอยต่อตอนวนซ้ำไม่กระตุก ซึ่งเป็นสิ่งที่ทำให้ GIF ของบูธดูตั้งใจ
 * ไม่ใช่ภาพสไลด์ที่วนอยู่ · สองเฟรมไม่ต้องทำ (ไป-กลับ = วนธรรมดาอยู่แล้ว)
 */
export const bounceOrder = (count) => (count > 2
  ? [...Array(count).keys(), ...[...Array(count - 2).keys()].map((i) => count - 2 - i)]
  : [...Array(count).keys()]);

/**
 * ประกอบ GIF จากรูปดิบของรอบถ่าย · คืน null เมื่อทำไม่ได้/ไม่ควรทำ
 *
 * รูปเดียวไม่มีอะไรให้เคลื่อนไหว (แบบเต็มใบถ่ายใบเดียว) — คืน null ไม่ใช่โยน error
 * เพราะมันไม่ใช่ความผิดพลาด และการถ่ายต้องไม่ล้มเพราะของแถมชิ้นนี้
 */
export async function makeGif(photos, {
  effect = 'clean', width = GIF_WIDTH, delayMs = GIF_DELAY_MS,
} = {}) {
  if (!Array.isArray(photos) || photos.length < 2) return null;

  const first = await sharp(photos[0]).metadata();
  const ratio = first.height && first.width ? first.height / first.width : 0.75;
  const height = Math.max(1, Math.round(width * ratio));

  /*
   * ทุกเฟรมต้องขนาดเท่ากันเป๊ะ ไม่งั้นการต่อเฟรมล้ม · บังคับด้วย cover + centre
   * ที่ตำแหน่ง centre ไม่ใช่ attention เพราะ attention ตัดคนละที่ในแต่ละเฟรม
   * แล้วภาพจะกระตุกไปมาเหมือนกล้องสั่น (ดูคอมเมนต์ใน effects.js)
   */
  const frames = await Promise.all(photos.map(
    (photo) => applyEffect(photo, effect, { width, height, position: 'centre' }),
  ));

  const order = bounceOrder(frames.length).map((index) => frames[index]);

  return sharp(order, { join: { across: 1, animated: true } })
    // ต้องส่ง delay เป็นอาร์เรย์ต่อเฟรม · ส่งเลขเดียวแล้ว libvips ใส่ให้เฟรมแรก
    // เฟรมเดียว ที่เหลือเป็น 0 (วัดแล้ว ได้ [400, 0, 0]) = เฟรมหลังกระพริบผ่านไปเลย
    .gif({ loop: 0, delay: order.map(() => delayMs) })
    .toBuffer();
}
