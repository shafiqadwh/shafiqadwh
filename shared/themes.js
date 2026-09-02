import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * ธีมที่โปรแกรมแชร์รูปกับ photo booth ใช้ร่วมกัน
 *
 * อ่านจาก `themes.json` ไฟล์เดียว ไม่ใช่ต่างคนต่างประกาศ — ลูกค้าคนเดียวกันซื้อ
 * ทั้งสองอย่างเป็นแพ็กคู่ ถ้าสีของงานบนเว็บกับบนรูปที่พิมพ์ออกมาไม่เหมือนกัน
 * มันเห็นทันทีตั้งแต่แผ่นแรกที่แขกถือขึ้นมาเทียบกับจอ
 *
 * อ่านด้วย fs ไม่ใช่ `import ... with { type: 'json' }` เพราะสองแพ็กเกจนี้อยู่
 * คนละโฟลเดอร์และคนละ node_modules — path ของไฟล์ข้อมูลชัดเจนกว่า resolver
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const file = JSON.parse(fs.readFileSync(path.join(here, 'themes.json'), 'utf8'));

export const THEMES = Object.freeze(
  file.themes.map((theme) => Object.freeze({
    ...theme,
    colours: Object.freeze({ ...theme.colours }),
    effects: Object.freeze([...theme.effects]),
    templates: Object.freeze([...theme.templates]),
  })),
);

export const THEME_IDS = Object.freeze(THEMES.map((theme) => theme.id));

/** ธีมแรกคือค่าเริ่มต้น · id ที่ไม่รู้จัก (พิมพ์ผิดใน .env) ตกกลับมาที่ตัวนี้ ไม่ใช่ระเบิด */
export const DEFAULT_THEME = THEMES[0];

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? DEFAULT_THEME;
}

/** ชื่อธีมในภาษาที่ขอ · ภาษาที่ยังไม่ได้แปลตกกลับไปอังกฤษ ไม่ใช่ขึ้นเป็น id ดิบ */
export function themeName(theme, lang) {
  return theme.name?.[lang] ?? theme.name?.en ?? theme.id;
}
