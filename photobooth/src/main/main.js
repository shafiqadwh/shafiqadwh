import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, globalShortcut, ipcMain, screen } from 'electron';
import QRCode from 'qrcode';
import sharp from 'sharp';
import { themeById } from '../../../shared/themes.js';
import { composeSheet } from '../core/sheet.js';
import { makeGif } from '../core/animation.js';
import { listEffects } from '../core/effects.js';
import { listTemplates, shotsFor } from '../core/templates.js';
import {
  canPublish, ensureAlbumCode, isAlbumCode, loadSettings, photoUrl, sheetQrUrl,
} from './settings.js';
import { discardSession, isToken, listSessions, reserveSession, saveSession } from './session.js';
import { uploadPending, uploadSession } from './upload.js';
import { preparePrintFile, printSheet } from './print.js';
import { promptPayPayload } from '../core/promptpay.js';
import { recordSale, takings } from './sales.js';
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
  const settings = await ensureAlbumCode(dataRoot(), await loadSettings(dataRoot()));
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

  // ปิดจอหน้า = ปิดบูธ · กล้องกับสถานะอยู่ที่จอหน้าทั้งคู่ จอหลังที่เหลืออยู่ลำพัง
  // จึงเป็นจอที่กดอะไรก็ไม่มีอะไรตอบ ซึ่งดูเหมือนโปรแกรมค้างมากกว่าโปรแกรมที่ปิดแล้ว
  opened.guest.once('closed', () => app.quit());

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

ipcMain.on('booth:broadcast', (event, message) => relay(event.sender, message));

/**
 * งานหลังงาน — ส่งรอบถ่ายที่ยังค้างขึ้นเว็บ
 *
 * บูธทำงานในเต็นท์ที่ไม่มีเน็ต · QR ที่พิมพ์ไปแล้วถูกต้องตั้งแต่แรกเพราะโทเคนถูก
 * จองตั้งแต่ตอนถ่าย แต่ปลายทางจะว่างอยู่จนกว่าจะมีคนสั่งส่ง — **และตัวสั่งนั้นคือ
 * ปุ่มนี้** ไม่มีปุ่ม แขกที่สแกนกระดาษกลับบ้านไปก็ไม่มีวันได้รูปเลยสักคน
 *
 * ปุ่มอยู่บนจอช่างภาพ ไม่ใช่จอแขก — เป็นงานของคนทำงาน ไม่ใช่ของคนมาเที่ยวงาน
 */
let uploading = false;

ipcMain.handle('booth:pending', async () => {
  const settings = await loadSettings(dataRoot());
  const sessions = await listSessions(sessionsDir());
  return {
    pending: sessions.filter((one) => !one.uploaded).length,
    total: sessions.length,
    canPublish: canPublish(settings),
    // ลิงก์อัลบั้มของทั้งงาน — เจ้าภาพขอดูตรงหน้าบูธได้โดยไม่ต้องรอสแกนกระดาษใคร
    album: settings.qrTarget === 'album' && settings.baseUrl && isAlbumCode(settings.albumCode)
      ? `${settings.baseUrl}/b/${settings.albumCode}` : '',
  };
});

ipcMain.handle('booth:upload', async () => {
  const settings = await loadSettings(dataRoot());
  if (!canPublish(settings)) {
    throw new Error('ยังไม่ได้ตั้งที่อยู่เว็บกับกุญแจ — ส่งขึ้นเว็บไม่ได้');
  }
  // กดสองครั้งระหว่างที่รอบแรกยังส่งอยู่ = ส่งไฟล์ชุดเดียวกันขึ้นไปพร้อมกันสองสาย
  if (uploading) throw new Error('กำลังส่งอยู่ รอให้รอบนี้จบก่อน');
  uploading = true;

  try {
    return await uploadPending(sessionsDir(), {
      baseUrl: settings.baseUrl,
      key: settings.uploadKey,
      // งานสามวันมีหลายร้อยรอบและใช้เวลาเป็นนาที — คนกดต้องเห็นว่ามันเดินอยู่
      onProgress: (progress) => relay(null, { type: 'upload', ...progress }),
    });
  } finally {
    uploading = false;
  }
});

/**
 * ประกอบแผ่นจากรูปที่เพิ่งถ่าย แล้วคืนภาพตัวอย่างขนาดจอ
 *
 * ไม่ส่งแผ่นเต็ม 1200×1800 กลับไปให้หน้าจอ — ไฟล์ใหญ่โดยไม่ได้อะไรเพิ่ม
 * จอบูธกว้างพันกว่าพิกเซล ตัวอย่างกว้าง 700 ก็เกินพอแล้ว
 */
// รูปเกินกว่าที่แบบไหนก็ใช้ ไม่มีเหตุผลให้รับ — กันหน้าจอที่ผิดพลาดส่งมาเป็นร้อยใบ
// แล้วกินหน่วยความจำจนกระบวนการหลักตายกลางงาน
const MAX_SHOTS = 8;

ipcMain.handle('booth:compose', async (event, { shots, effect, token: paid }) => {
  if (!Array.isArray(shots) || shots.length === 0 || shots.length > MAX_SHOTS) {
    throw new Error(`จำนวนรูปไม่ถูกต้อง: ${Array.isArray(shots) ? shots.length : typeof shots}`);
  }
  const settings = await loadSettings(dataRoot());
  const photos = shots.map(decodeShot);

  // จองโทเคนก่อนประกอบ — QR ต้องมีโทเคนอยู่ข้างในตั้งแต่แรก จะได้ประกอบรอบเดียว
  // โหมดจ่ายก่อนถ่ายจองไปแล้วตอนรับเงิน จึงส่งโทเคนใบเดิมมาใช้ต่อ ไม่จองซ้ำ
  const { token } = isToken(paid) ? { token: paid } : await reserveSession(sessionsDir());
  const qrUrl = sheetQrUrl(settings, token);

  try {
    /*
     * ประกอบแผ่นกับ GIF **พร้อมกัน** — แขกยืนรออยู่ตรงหน้า
     *
     * วัดกับภาพจากเว็บแคมจริง: ทีละอย่าง 2,024 มิลลิวินาที · พร้อมกัน 1,101
     * ประหยัดเกือบหนึ่งวินาทีต่อแขกหนึ่งคน ซึ่งคูณด้วยจำนวนแขกทั้งงานแล้วเป็นแถวที่สั้นลง
     *
     * GIF เป็นของแถม ไม่ใช่ของหลัก — ทำไม่สำเร็จต้องไม่ทำให้รอบถ่ายล้ม
     */
    const [sheet, gif] = await Promise.all([
      composeSheet({
        photos,
        template: settings.template,
        paper: settings.paper,
        effect,
        theme: settings.theme,
        title: settings.eventTitle,
        subtitle: settings.eventSubtitle,
        qrUrl,
      }),
      settings.gif
        ? makeGif(photos, { effect }).catch((error) => {
          console.warn('[booth] ทำภาพเคลื่อนไหวไม่สำเร็จ ข้ามไป:', error.message);
          return null;
        })
        : null,
    ]);

    await saveSession(sessionsDir(), {
      token, photos, sheet, gif, settings, effect, template: settings.template,
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
  } catch (error) {
    // ที่จองไว้ต้องคืนเมื่อประกอบไม่สำเร็จ · ไม่คืนแล้วทุกครั้งที่กล้องส่งเฟรมเสีย
    // จะเหลือโฟลเดอร์เปล่าค้างไว้หนึ่งใบ งานสามวันได้กองขยะที่ไม่มีใครรู้ว่าคืออะไร
    await discardSession(sessionsDir(), token).catch(() => {});
    throw error;
  }
});

/**
 * ขอ QR พร้อมเพย์สำหรับรอบนี้
 *
 * สร้างใหม่ทุกครั้งแทนที่จะทำครั้งเดียวตอนเปิดบูธ เพราะราคาถูกแก้ระหว่างวันได้
 * (ลดราคาช่วงเย็น จัดโปรสองแผ่น) และการคิดสตริงกับวาด QR ใช้เวลาไม่กี่มิลลิวินาที
 *
 * `enabled: false` = บูธนี้ไม่ได้ขาย — หน้าจอข้ามขั้นจ่ายเงินไปเลย
 */
ipcMain.handle('booth:sale', async () => {
  const settings = await loadSettings(dataRoot());
  if (!settings.sale.enabled) return { enabled: false };

  const payload = promptPayPayload({ target: settings.sale.target, amount: settings.sale.price });
  if (!payload) {
    // ผ่านตัวตรวจของ settings มาแล้วยังสร้างไม่ได้ = มีอะไรผิดที่เราไม่รู้จัก
    // ปล่อยให้ขายฟรีดีกว่าให้บูธค้างคาแถว แต่ต้องดังพอให้เจ้าของเห็นใน log
    console.error('[booth] สร้าง QR พร้อมเพย์ไม่ได้ทั้งที่ค่าตั้งผ่านการตรวจแล้ว');
    return { enabled: false };
  }

  return {
    enabled: true,
    price: settings.sale.price,
    payWhen: settings.sale.payWhen,
    qr: await QRCode.toDataURL(payload, { width: 720, margin: 1 }),
    takings: await takings(dataRoot()),
    /*
     * มีจอช่างภาพอยู่จริงไหม — ตัวชี้ขาดว่า **ปุ่มยืนยันรับเงินอยู่จอไหน**
     *
     * ตอบตรงนี้ ไม่ใช่ตอน `booth:setup` · `openWindows` รอโหลดทั้งสองบานก่อนคืนค่า
     * แล้ว main.js จึงค่อยจำว่าบานไหนเป็นจอช่างภาพ — จอหน้าที่ถาม setup ตอนบูต
     * จึงถามเร็วกว่าที่ main จะรู้คำตอบ **วัดแล้วเจอจริง**: ปุ่ม "จ่ายแล้ว" โผล่บน
     * จอแขกทั้งที่เสียบจอที่สองอยู่ ซึ่งคือให้แขกยืนยันเงินให้ตัวเองได้
     *
     * และมันเป็นความจริงที่เปลี่ยนได้ระหว่างงานด้วย (จอช่างภาพถูกปิด/เปิดใหม่)
     * ถามตอนจะใช้จริงจึงถูกกว่าจำคำตอบไว้ตั้งแต่ตอนบูตทุกกรณี
     */
    hasOperator: alive(windows.operator),
  };
});

/**
 * คนกดยืนยันว่าได้รับเงินแล้ว — **นี่คือหลักฐานเดียวที่ระบบนี้มี**
 *
 * ไม่มีการตรวจกับธนาคาร และจะไม่แกล้งทำเป็นว่ามี · จดไว้ในสมุดบัญชีตามที่คนกด
 * แล้วให้เจ้าของกระทบยอดกับแอปธนาคารตอนเก็บบูธ
 */
ipcMain.handle('booth:paid', async (event, { token, free }) => {
  const settings = await loadSettings(dataRoot());

  /*
   * จ่ายก่อนถ่าย — ยังไม่มีโทเคน เพราะยังไม่มีรูป · จองไว้ตรงนี้เลย
   *
   * จองก่อนแล้วค่อยถ่าย ทำให้ **ทุกบรรทัดในสมุดบัญชีผูกกับรอบถ่ายจริงเสมอ**
   * ไม่ว่าจ่ายก่อนหรือจ่ายหลัง · ถ้าปล่อยให้บรรทัดของ "จ่ายก่อน" ไม่มีโทเคน
   * เวลาลูกค้าทักมาว่า "จ่ายแล้วไม่ได้รูป" จะไม่มีอะไรให้ค้นเลย
   */
  const ticket = isToken(token) ? token : (await reserveSession(sessionsDir())).token;

  await recordSale(dataRoot(), { token: ticket, amount: settings.sale.price, free: free === true });
  return { token: ticket, takings: await takings(dataRoot()) };
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

app.whenReady().then(createWindow).catch((error) => {
  // เปิดหน้าต่างไม่ได้ = ไม่มีบูธ · ตายพร้อมบอกเหตุ ดีกว่าค้างเป็นกระบวนการเงียบ
  // ที่ไม่มีหน้าต่างให้ใครเห็นและไม่มีอะไรบอกว่าเกิดอะไรขึ้น
  console.error('[booth] เปิดหน้าต่างไม่สำเร็จ:', error);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ปุ่มที่ยึดไว้ทั้งเครื่องต้องคืนตอนปิด ไม่งั้นเจ้าของเครื่องเสียปุ่มนั้นไปจนกว่าจะล็อกเอาต์
app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
