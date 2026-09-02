import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, ipcMain } from 'electron';
import sharp from 'sharp';
import { themeById } from '../../../shared/themes.js';
import { composeSheet } from '../core/sheet.js';
import { listEffects } from '../core/effects.js';
import { listTemplates, shotsFor } from '../core/templates.js';
import { loadSettings, qrUrlFor, saveSettings } from './settings.js';
import { discardSession, isToken, reserveSession, saveSession } from './session.js';
import { preparePrintFile, printSheet } from './print.js';

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

let window = null;

function createWindow() {
  window = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: '#101014',
    // บูธเปิดค้างทั้งงาน แขกไม่ควรเห็นแถบเมนูหรือปิดหน้าต่างได้โดยบังเอิญ
    fullscreen: process.env.BOOTH_WINDOWED !== '1',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  return window.loadFile(path.join(renderer, 'index.html'));
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
  const qrUrl = qrUrlFor(settings, token);

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

ipcMain.handle('booth:print', async (event, { token }) => {
  // โทเคนมาจากฝั่งหน้าจอ แล้วถูกเอาไปต่อเป็นพาธ · ถึงหน้าจอจะเป็นโค้ดของเราเอง
  // ก็ไม่ใช่เหตุผลให้เชื่อค่าที่ข้ามขอบเขตกระบวนการมา — ตรวจรูปแบบก่อนเสมอ
  if (!isToken(token)) throw new Error(`โทเคนไม่ถูกต้อง: ${token}`);
  const settings = await loadSettings(dataRoot());
  const dir = path.join(sessionsDir(), token);
  const prepared = await preparePrintFile({
    dir,
    sheetPath: path.join(dir, 'sheet.jpg'),
    settings,
  });

  const result = await printSheet({
    sheetPath: prepared.path,
    settings,
    token,
    outbox: outboxDir(),
    copies: prepared.pages,
  });

  return { ...result, page: settings.printPage, perPage: prepared.perPage };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
