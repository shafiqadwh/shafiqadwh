import path from 'node:path';

/**
 * สองจอ — จอหน้าให้แขก จอหลังให้ช่างภาพ
 *
 * จอหน้า (guest) คือจอสัมผัสที่หันออกไปทางแขก มีกล้อง มีนับถอยหลัง มีปุ่มใหญ่
 * จอหลัง (operator) หันเข้าหาช่างภาพ เห็นสิ่งเดียวกันแบบย่อ พร้อมปุ่มสั่งงาน
 *
 * **กล้องหนึ่งตัวเปิดได้ทีละที่เดียว** จอหลังจึงเปิดกล้องเองไม่ได้ ต้องรับภาพ
 * ที่จอหน้าส่งต่อมาให้ (ดู booth.js ฝั่ง relay) — ข้อนี้เป็นข้อจำกัดของฮาร์ดแวร์
 * ไม่ใช่ทางที่เลือกเดิน
 */

/**
 * แจกจอ — งานคำนวณล้วน ไม่แตะ Electron จะได้ทดสอบได้โดยไม่ต้องมีจอจริง
 *
 * จอหน้าอยู่บนจอหลักเสมอ (เครื่องส่วนใหญ่เสียบจอสัมผัสตัวแรกเป็นจอหลัก)
 * ส่วนจอช่างภาพเอาจอถัดไปที่ไม่ใช่ตัวเดียวกัน
 *
 * **มีจอเดียวต้องได้หน้าต่างเดียว** ไม่ใช่สองหน้าต่างซ้อนกัน — จอช่างภาพที่ไป
 * ทับจอแขกคือบูธที่ใช้งานไม่ได้เลย ไม่ใช่บูธที่ขาดของเสริม
 */
export function planScreens(displays, primaryId, { operator = 'auto' } = {}) {
  const list = (Array.isArray(displays) ? displays : []).filter((one) => one?.bounds);
  if (list.length === 0) return { guest: null, operator: null };

  const guest = list.find((one) => one.id === primaryId) ?? list[0];
  const second = operator === 'off' ? null : list.find((one) => one !== guest);

  return { guest: guest.bounds, operator: second ? second.bounds : null };
}

/** วางหน้าต่างให้เต็มจอที่ตั้งใจ — ต้องบอกพิกัดเอง ไม่งั้นทั้งสองบานไปกองที่จอหลัก */
function windowOn(BrowserWindow, bounds, { preload, windowed, show = true }) {
  return new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: windowed ? Math.min(1280, bounds.width) : bounds.width,
    height: windowed ? Math.min(800, bounds.height) : bounds.height,
    show,
    backgroundColor: '#101014',
    // บูธเปิดค้างทั้งงาน แขกไม่ควรเห็นแถบเมนูหรือปิดหน้าต่างได้โดยบังเอิญ
    fullscreen: !windowed,
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
}

/**
 * เปิดหน้าต่างตามจอที่มี
 *
 * `force` ให้เปิดจอช่างภาพบนเครื่องจอเดียวได้ (ซ้อมก่อนงาน / เทสต์) โดยวางเยื้อง
 * ไม่ให้ทับกันสนิท
 */
export async function openWindows(deps, { renderer, preload, windowed, operator, force }) {
  const { BrowserWindow, screen } = deps;
  const plan = planScreens(screen.getAllDisplays(), screen.getPrimaryDisplay().id, { operator });
  if (!plan.guest) throw new Error('ไม่พบจอสำหรับเปิดหน้าต่างบูธ');

  const guest = windowOn(BrowserWindow, plan.guest, { preload, windowed });
  const opened = { guest, operator: null };
  const loading = [guest.loadFile(path.join(renderer, 'index.html'))];

  const where = plan.operator ?? (force
    ? { ...plan.guest, x: plan.guest.x + 60, y: plan.guest.y + 60 }
    : null);

  if (where) {
    opened.operator = windowOn(BrowserWindow, where, { preload, windowed: windowed || force });
    loading.push(opened.operator.loadFile(path.join(renderer, 'operator.html')));
  }

  await Promise.all(loading);
  return opened;
}
