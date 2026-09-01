import { config } from '../config.js';

/*
 * สีของธีมต่องาน — ฉีดเป็นตัวแปร CSS ทับ :root ที่อยู่ใน app.css
 *
 * ทับเฉพาะตัวที่ตั้งค่ามาจริง ๆ · งานที่ไม่ตั้งอะไรเลยได้สตริงว่าง ซึ่งแปลว่า
 * ไม่มี <style> โผล่ในหน้าเลยแม้แต่ไบต์เดียว หน้าตาจึงเหมือนก่อนมีฟีเจอร์นี้เป๊ะ
 * ไม่ใช่ "เหมือนเพราะบังเอิญค่าเริ่มต้นชุดใหม่ตรงกับของเก่า"
 */
const VARIABLES = Object.freeze([
  ['accent', '--accent'],
  ['accentDark', '--accent-dark'],
  ['paper', '--paper'],
  ['blush', '--blush'],
]);

// ค่านี้ถูกวางลงใน <style> ของทุกหน้า · `colour()` ใน config.js กรองให้แล้วชั้นหนึ่ง
// แต่กรองซ้ำที่นี่ด้วย เพราะฟังก์ชันนี้รับ theme จากที่อื่นได้ (เทสต์ ตัวเรียกในอนาคต)
// — ด่านสุดท้ายก่อนถึงหน้าเว็บควรกันตัวเอง ไม่ใช่ฝากความปลอดภัยไว้กับคนเรียก
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function themeStyle(theme = config.theme) {
  const rules = VARIABLES
    .filter(([key]) => typeof theme?.[key] === 'string' && HEX.test(theme[key].trim()))
    .map(([key, name]) => `${name}: ${theme[key].trim()};`);
  return rules.length ? `:root { ${rules.join(' ')} }` : '';
}
