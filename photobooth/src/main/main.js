import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, globalShortcut, ipcMain, screen } from 'electron';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { themeById } from '../../../shared/themes.js';
import { composeSheet } from '../core/sheet.js';
import { listEffects } from '../core/effects.js';
import { listTemplates, shotsFor } from '../core/templates.js';
import { canPublish, loadSettings, photoUrl, saveSettings, sheetQrUrl } from './settings.js';
import { discardSession, isToken, reserveSession, saveSession } from './session.js';
import { uploadSession } from './upload.js';
import { preparePrintFile, printSheet } from './print.js';
import { createRemote } from '../core/keys.js';
import { registerGlobalKeys } from './remote.js';
import { openWindows } from './windows.js';

/**
 * Electron main — หน้าต่าง กับสะพานระหว่างหน้าจอกับแกนประกอบแผ่น
 *
 * งานหนักทั้งหมด (sharp, ไฟล์, เครื่องพิมพ์) อยู่ฝั่งนี้ ไม่ใช่ในหน้าเว็บ
 * เพราะ sharp เป็นโมดูลเนทีฟที่รันใน renderer ไม่ได้ · และเพราะหน้าจอที่แขก
 * เห็นไม่ควรมีสิทธิ์แตะดิสก์หรือสั่งพิมพ์ได้เองอยู่แล้ว
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const renderer = path.join(here, '..', 'renderer');

/*
 * ที่เก็บข้อมูลของบูธ
 *
 * `BOOTH_USER_DATA` ให้เทสต์ (และการซ้อมก่อนงาน) ชี้ไปที่โฟลเดอร์ชั่วคราวได้
 * โดยไม่ไปทับค่าตั้งกับรอบถ่ายจริงของเครื่อง — ซ้อมแล้วรูปจริงหายคือสิ่งที่ต้องกัน
 */
const dataRoot = () => path.join(process.env.BOOTH_USER_DATA || app.getPath('userData'), 'booth');
const sessionsDir = () => path.join(dataRoot(), 'sessions');
const outboxDir = () => path.join(dataRoot(), 'outbox');

const windows = { guest: null, operator: null };

const alive = (win) => Boolean(win) && !win.isDestroyed();

/**
 * สะพานระหว่างสองจอ — ใครส่งอะไรมา ส่งต่อให้อีกจอ
 *
 * ทำเป็นทางเดียวใช้ได้ทั้งสองทิศโดยตั้งใจ: จอหน้าส่งสถานะกับภาพไปให้จอหลัง
 * จอหลังส่งคำสั่งกลับมาให้จอหน้า · ใช้ท่อเดียวกันจึงไม่มีทางที่ทิศหนึ่งใช้ได้
 * อีกทิศเงียบ ซึ่งเป็นอาการที่หาสาเหตุยากที่สุดเวลาอยู่หน้างาน
 */
function relay(from, message) {
  if (!message || typeof message.type !== 'string') return;
  for (const win of [windows.guest, windows.operator]) {
    if (alive(win) && win.webContents !== from) win.webContents.send('booth:message', message);
  }
}

/** ปุ่มรีโมทสั่งงานที่จอหน้าเสมอ — จอหน้าคือที่เดียวที่รู้ว่าตอนนี้อยู่ขั้นไหน */
const press = createRemote((action) => {
  if (alive(windows.guest)) windows.guest.webContents.send('booth:message', { type: 'action', action });
});

async function createWindow() {
  const settings = await loadSettings(dataRoot());
  const opened = await openWindows({ BrowserWindow, screen }, {
    renderer,
    preload: path.join(here, 'preload.cjs'),
    windowed: process.env.BOOTH_WINDOWED === '1',
    operator: settings.operatorScreen,
    // เปิดจอช่างภาพบนเครื่องจอเดียวได้ สำหรับซ้อมก่อนงานและสำหรับเทสต์
    force: process.env.BOOTH_OPERATOR === '1',
  });

  windows.guest = opened.guest;
  windows.operator = opened.operator;

  // ปุ่มที่หน้าจอรับเองไม่ได้ (ปุ่มเสียงที่เดสก์ท็อปยึดไว้) — ที่เหลือหน้าจอจัดการเอง
  if (settings.remote.enabled) {
    registerGlobalKeys(globalShortcut, settings.remote.globalKeys, press);
  }
  return opened;
}

/** รูปจากกล้องมาเป็น data URL — แปลงเป็น Buffer ก่อนส่งต่อให้ sharp */
function decodeShot(dataUrl) {
  const comma = String(dataUrl ?? '').indexOf(',');
  if (comma < 0) throw new Error('รูปที่ส่งมาจากกล้องอ่านไม่ออก');
  return Buffer.from(dataUrl.slice(comma + 1), 'base64');
}

ipcMain.handle('booth:setup', async () => {
  const settings = await loadSettings(dataRoot());
  return {
    settings,
    theme: themeById(settings.theme),
    shots: shotsFor(settings.template),
    templates: listTemplates(settings.lang),
    // โชว์เฉพาะเอฟเฟคที่เลือกไว้ตั้งแต่ต้น ไม่ใช่ทั้งเจ็ดแบบ — แขกยืนหน้าบูธ
    // เลือกจากรายการยาว ๆ คือแถวที่ยาวขึ้นตามไปด้วย
    effects: listEffects(settings.lang).filter((one) => settings.effects.includes(one.id)),
  };
});

ipcMain.handle('booth:save-settings', async (event, patch) => saveSettings(dataRoot(), patch));

ipcMain.on('booth:broadcast', (event, message) => relay(event.sender, message));

/**
 * ประกอบแผ่นจากรูปที่เพิ่งถ่าย แล้วคืนภาพตัวอย่างขนาดจอ
 *
 * ไม่ส่งแผ่นเต็ม 1200×1800 กลับไปให้หน้าจอ — ไฟล์ใหญ่โดยไม่ได้อะไรเพิ่ม
 * จอบูธกว้างพันกว่าพิกเซล ตัวอย่างกว้าง 700 ก็เกินพอแล้ว
 */
// รูปเกินกว่าที่แบบไหนก็ใช้ ไม่มีเหตุผลให้รับ — กันหน้าจอที่ผิดพลาดส่งมาเป็นร้อยใบ
// แล้วกินหน่วยความจำจนกระบวนการหลักตายกลางงาน
const MAX_SHOTS = 8;

ipcMain.handle('booth:compose', async (event, { shots, effect }) => {
  if (!Array.isArray(shots) || shots.length === 0 || shots.length > MAX_SHOTS) {
    throw new Error(`จำนวนรูปไม่ถูกต้อง: ${Array.isArray(shots) ? shots.length : typeof shots}`);
  }
  const settings = await loadSettings(dataRoot());
  const photos = shots.map(decodeShot);

  // จองโทเคนก่อนประกอบ — QR ต้องมีโทเคนอยู่ข้างในตั้งแต่แรก จะได้ประกอบรอบเดียว
  const { token } = await reserveSession(sessionsDir());
  const qrUrl = sheetQrUrl(settings, token);

  const sheet = await composeSheet({
    photos,
    template: settings.template,
    paper: settings.paper,
    effect,
    theme: settings.theme,
    title: settings.eventTitle,
    subtitle: settings.eventSubtitle,
    qrUrl,
  });

  await saveSession(sessionsDir(), {
    token, photos, sheet, settings, effect, template: settings.template,
  });

  return {
    token,
    qrUrl,
    qrModuleMm: sheet.qrModuleMm,
    qrTooSmall: sheet.qrTooSmall,
    // ไม่ส่งแผ่นเต็ม 1200×1800 กลับไปให้หน้าจอ — ไฟล์ใหญ่โดยไม่ได้อะไรเพิ่ม
    preview: `data:image/jpeg;base64,${(await sharp(sheet.data)
      .resize({ width: 700 })
      .jpeg({ quality: 82 })
      .toBuffer()).toString('base64')}`,
  };
});

ipcMain.handle('booth:discard', async (event, { token }) => {
  if (!isToken(token)) throw new Error(`โทเคนไม่ถูกต้อง: ${token}`);
  await discardSession(sessionsDir(), token);
  return { ok: true };
});

/**
 * ส่งมอบรูปให้แขก — พิมพ์ ขึ้น QR บนจอ หรือทั้งสองอย่าง ตามที่ตั้งไว้
 *
 * รวมเป็นเส้นเดียวเพราะหน้าจอไม่ควรต้องรู้กติกาว่าโหมดไหนทำอะไรบ้าง · มันรู้แค่
 * "แขกกดปุ่มแล้ว" ส่วนที่เหลือเป็นเรื่องของค่าตั้ง
 *
 * โหมด screen ส่งรูปขึ้นเว็บ **ตอนนั้นเลย** ไม่ใช่ทีหลังแบบโหมดพิมพ์ เพราะแขก
 * ยืนสแกนอยู่ตรงหน้า · ส่งไม่สำเร็จก็ยังขึ้น QR ให้ พร้อมบอกว่ารูปจะมาทีหลัง —
 * หน้า /p/<รหัส> อธิบายให้เองอยู่แล้ว และลิงก์นั้นถูกต้องตั้งแต่แรก
 */
ipcMain.handle('booth:deliver', async (event, { token }) => {
  if (!isToken(token)) throw new Error(`โทเคนไม่ถูกต้อง: ${token}`);
  const settings = await loadSettings(dataRoot());
  const dir = path.join(sessionsDir(), token);
  const out = { token, printed: false, qr: null, url: null, published: false };

  if (settings.deliver !== 'screen') {
    const prepared = await preparePrintFile({
      dir, sheetPath: path.join(dir, 'sheet.jpg'), settings,
    });
    await printSheet({
      sheetPath: prepared.path, settings, token, outbox: outboxDir(), copies: prepared.pages,
    });
    out.printed = true;
  }

  if (settings.deliver !== 'print' && canPublish(settings)) {
    out.url = photoUrl(settings, token);
    try {
      await uploadSession(sessionsDir(), token, {
        baseUrl: settings.baseUrl, key: settings.uploadKey,
      });
      out.published = true;
    } catch (error) {
      // เน็ตล่มกลางงานไม่ใช่เหตุให้แขกกลับมือเปล่า — QR ยังถูกต้อง รูปตามไปทีหลัง
      console.warn('[booth] ส่งรูปขึ้นเว็บไม่สำเร็จ ณ ตอนนี้:', error.message);
    }
    out.qr = await QRCode.toDataURL(out.url, { width: 720, margin: 1 });
  }

  return out;
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ปุ่มที่ยึดไว้ทั้งเครื่องต้องคืนตอนปิด ไม่งั้นเจ้าของเครื่องเสียปุ่มนั้นไปจนกว่าจะล็อกเอาต์
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
