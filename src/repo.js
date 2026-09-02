import { db } from './db.js';
import { groupGuests, normaliseName } from './lib/guests.js';

const statements = {
  insertItem: db.prepare(`
    INSERT INTO items (kind, original_name, stored_name, playback_name, thumb_name,
                       mime, bytes, width, height, duration, uploader, status, convert_state)
    VALUES (@kind, @originalName, @storedName, @playbackName, @thumbName,
            @mime, @bytes, @width, @height, @duration, @uploader, @status, @convertState)
  `),
  getItem: db.prepare('SELECT * FROM items WHERE id = ?'),
  deleteItem: db.prepare('DELETE FROM items WHERE id = ?'),
  setItemStatus: db.prepare('UPDATE items SET status = ? WHERE id = ?'),
  insertMessage: db.prepare(`
    INSERT INTO messages (author, body, item_id, status)
    VALUES (@author, @body, @itemId, @status)
  `),
  getMessage: db.prepare('SELECT * FROM messages WHERE id = ?'),
  deleteMessage: db.prepare('DELETE FROM messages WHERE id = ?'),
  setMessageStatus: db.prepare('UPDATE messages SET status = ? WHERE id = ?'),
  countByKind: db.prepare(`
    SELECT kind, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes
    FROM items WHERE status != 'hidden' AND deleted_at IS NULL GROUP BY kind
  `),
  // นับรวมของในถังขยะด้วย — ไฟล์ยังกินพื้นที่ดิสก์จริงจนกว่าจะถูกกวาดทิ้งถาวร
  totalBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM items'),
  countMessages: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status != 'hidden'"),
  countPending: db.prepare("SELECT COUNT(*) AS count FROM items WHERE status = 'pending' AND deleted_at IS NULL"),
  visibleSince: db.prepare(
    "SELECT COUNT(*) AS count FROM items WHERE status = 'visible' AND deleted_at IS NULL AND id > ?",
  ),

  // ── รูปของเจ้าภาพบนหน้าแรก (คนละตารางกับรูปแขกโดยตั้งใจ ดู src/db.js) ──
  insertHostMedia: db.prepare(`
    INSERT INTO host_media (slot, stored_name, display_name, thumb_name, mime,
                            bytes, width, height, caption, sort_order)
    VALUES (@slot, @storedName, @displayName, @thumbName, @mime,
            @bytes, @width, @height, @caption, @sortOrder)
  `),
  getHostMedia: db.prepare('SELECT * FROM host_media WHERE id = ?'),
  listHostSlot: db.prepare(
    'SELECT * FROM host_media WHERE slot = ? ORDER BY sort_order, id',
  ),
  listAllHostMedia: db.prepare('SELECT * FROM host_media ORDER BY slot, sort_order, id'),
  countHostSlot: db.prepare('SELECT COUNT(*) AS count FROM host_media WHERE slot = ?'),
  nextHostOrder: db.prepare(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM host_media WHERE slot = ?',
  ),
  deleteHostMedia: db.prepare('DELETE FROM host_media WHERE id = ?'),
  setHostOrder: db.prepare('UPDATE host_media SET sort_order = ? WHERE id = ?'),
  hostBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM host_media'),
};

/** ช่องที่รับได้ กับเพดานจำนวนต่อช่อง — เกินแล้วบอกตรง ๆ ไม่ใช่ตัดทิ้งเงียบ ๆ */
export const HOST_SLOTS = Object.freeze({ cover: 1, invitation: 3, photo: 12 });

export function insertItem(item) {
  const info = statements.insertItem.run({
    kind: item.kind,
    originalName: item.originalName,
    storedName: item.storedName,
    playbackName: item.playbackName ?? null,
    thumbName: item.thumbName ?? null,
    mime: item.mime,
    bytes: item.bytes,
    width: item.width ?? null,
    height: item.height ?? null,
    duration: item.duration ?? null,
    uploader: item.uploader ?? null,
    status: item.status,
    convertState: item.convertState ?? 'none',
  });
  return statements.getItem.get(info.lastInsertRowid);
}

export const getItem = (id) => statements.getItem.get(id);
export const deleteItemRow = (id) => statements.deleteItem.run(id);
export const setItemStatus = (id, status) => statements.setItemStatus.run(status, id);

/** id ที่ผู้ใช้ส่งมาเป็นสตริงจากฟอร์ม — คัดเฉพาะจำนวนเต็มบวกจริง ๆ ทิ้งของที่ไม่ใช่ */
function positiveIntIds(ids) {
  return (Array.isArray(ids) ? ids : [ids])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * ลบ = เข้าถังขยะ ไม่ใช่ลบไฟล์จริงทันที — กันพลาดกลางงานที่คนชุลมุน
 *
 * เงื่อนไข `deleted_at IS NULL` ทำให้ยิงซ้ำ id เดิมไม่มีผลอะไรเพิ่ม (idempotent)
 * และไม่ทับเวลาที่ลบไว้เดิมถ้าเผลอกดซ้ำ
 */
export function softDeleteItems(ids) {
  const wanted = positiveIntIds(ids);
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(',');
  db.prepare(`
    UPDATE items SET deleted_at = datetime('now')
    WHERE id IN (${placeholders}) AND deleted_at IS NULL
  `).run(...wanted);
  return wanted;
}

/** กู้คืนจากถังขยะ — เฉพาะแถวที่อยู่ในถังขยะจริง id ที่กู้คืนไปแล้วหรือไม่เคยลบก็แค่ไม่มีผล */
export function restoreItems(ids) {
  const wanted = positiveIntIds(ids);
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(',');
  db.prepare(`
    UPDATE items SET deleted_at = NULL
    WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL
  `).run(...wanted);
  return wanted;
}

/** ทุกอย่างที่อยู่ในถังขยะตอนนี้ — ใหม่สุดก่อน ให้เห็นของที่เพิ่งพลาดอยู่บนสุด */
export function listTrash() {
  return db.prepare("SELECT * FROM items WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC").all();
}

/** สำหรับแบนเนอร์ "เลิกทำ" — เอาเฉพาะ id ที่ยังอยู่ในถังขยะจริง ลิงก์ค้าง/กู้คืนไปแล้วก็แค่ไม่โผล่ */
export function getTrashedByIds(ids) {
  const wanted = positiveIntIds(ids);
  if (wanted.length === 0) return [];
  const placeholders = wanted.map(() => '?').join(',');
  return db.prepare(`
    SELECT * FROM items WHERE id IN (${placeholders}) AND deleted_at IS NOT NULL
  `).all(...wanted);
}

/** ของที่อยู่ในถังขยะเกินกำหนดแล้ว — เอาไปลบไฟล์จริง+แถวจริงต่อที่ผู้เรียก (ต้องมีสิทธิ์แตะดิสก์) */
export function listExpiredTrash(days) {
  return db.prepare(`
    SELECT * FROM items WHERE deleted_at IS NOT NULL AND deleted_at < datetime('now', ?)
  `).all(`-${Number(days) || 0} days`);
}

/**
 * Keyset pagination on (created_at, id) — cheap and stable even while guests
 * keep uploading underneath the reader.
 */
export function listItems({ filter = 'all', limit = 60, beforeId = null, includeHidden = false, who = null } = {}) {
  const where = [];
  const params = { limit: Math.min(Math.max(limit, 1), 200) };

  where.push(includeHidden ? "status IN ('visible', 'pending', 'hidden')" : "status = 'visible'");
  // ของในถังขยะไม่โผล่ที่นี่เลยไม่ว่า includeHidden จะเป็นอะไร — ถังขยะมีหน้าของตัวเอง
  where.push('deleted_at IS NULL');
  if (filter === 'photos') where.push("kind = 'image'");
  if (filter === 'videos') where.push("kind = 'video'");
  if (beforeId) {
    where.push('id < @beforeId');
    params.beforeId = Number(beforeId);
  }

  if (who === null) {
    return db
      .prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT @limit`)
      .all(params);
  }

  // กรองชื่อ *ก่อน* ตัดหน้า ไม่ใช่หลัง — ถ้ากรองทีหลังจะได้หน้าที่มีของไม่ครบ
  // แล้วหน้าถัดไปข้ามของหายไปเงียบ ๆ เพราะเคอร์เซอร์เดินตาม id ที่ถูกตัดทิ้งไปแล้ว
  const ids = db
    .prepare(`SELECT id, uploader FROM items WHERE ${where.join(' AND ')} ORDER BY id DESC`)
    .all(params.beforeId === undefined ? {} : { beforeId: params.beforeId })
    .filter((row) => normaliseName(row.uploader) === who)
    .slice(0, params.limit)
    .map((row) => row.id);

  if (ids.length === 0) return [];
  return db
    .prepare(`SELECT * FROM items WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id DESC`)
    .all(ids);
}

export function countItems({ filter = 'all', includeHidden = false, who = null } = {}) {
  const where = [includeHidden ? '1 = 1' : "status = 'visible'", 'deleted_at IS NULL'];
  if (filter === 'photos') where.push("kind = 'image'");
  if (filter === 'videos') where.push("kind = 'video'");
  if (who === null) {
    return db.prepare(`SELECT COUNT(*) AS count FROM items WHERE ${where.join(' AND ')}`).get().count;
  }
  // นับฝั่ง JS เพราะการจับคู่ชื่อต้อง normalise แบบ Unicode ซึ่ง SQLite ทำไม่ได้
  // (LOWER() ของมันรู้จักแต่ ASCII) จำนวนแถวมีขอบเขตชัดเจนคือรูปทั้งงาน
  return db.prepare(`SELECT uploader FROM items WHERE ${where.join(' AND ')}`)
    .all()
    .filter((row) => normaliseName(row.uploader) === who)
    .length;
}

export function newerCount(sinceId) {
  return statements.visibleSince.get(Number(sinceId) || 0).count;
}

export function insertMessage({ author, body, itemId, status }) {
  const info = statements.insertMessage.run({
    author: author ?? null,
    body,
    itemId: itemId ?? null,
    status,
  });
  return statements.getMessage.get(info.lastInsertRowid);
}

export const getMessage = (id) => statements.getMessage.get(id);
export const deleteMessageRow = (id) => statements.deleteMessage.run(id);
export const setMessageStatus = (id, status) => statements.setMessageStatus.run(status, id);

export function listMessages({ limit = 100, includeHidden = false } = {}) {
  const where = includeHidden ? '1 = 1' : "m.status = 'visible'";
  return db
    .prepare(`
      SELECT m.*,
             i.kind          AS item_kind,
             i.thumb_name    AS item_thumb,
             i.status        AS item_status,
             i.convert_state AS item_convert_state,
             i.duration      AS item_duration,
             i.width         AS item_width,
             i.height        AS item_height
      FROM messages m
      -- กรองอยู่ใน JOIN เอง ไม่ใช่ WHERE — รูปที่ถูกลบต้องหายไปเหมือนไม่เคยแนบมาเลย
      -- ไม่ใช่ทำให้ทั้งข้อความหายตามไปด้วย ข้อความยังต้องอยู่ แค่ไม่มีรูปติด
      LEFT JOIN items i ON i.id = m.item_id AND i.deleted_at IS NULL
      WHERE ${where}
      ORDER BY m.id DESC
      LIMIT ?
    `)
    .all(Math.min(Math.max(limit, 1), 500));
}

export function stats() {
  const byKind = { image: { count: 0, bytes: 0 }, video: { count: 0, bytes: 0 } };
  for (const row of statements.countByKind.all()) {
    byKind[row.kind] = { count: row.count, bytes: row.bytes };
  }
  return {
    photos: byKind.image.count,
    videos: byKind.video.count,
    messages: statements.countMessages.get().count,
    pending: statements.countPending.get().count,
    // รูปเจ้าภาพกินดิสก์จริงเหมือนรูปแขก ต้องบวกเข้ามาด้วย ไม่งั้นตัวเลขพื้นที่ใช้ไป
    // ต่ำกว่าความจริง แล้วเพดาน MAX_TOTAL_STORAGE_GB จะกันไม่ทันตอนดิสก์ใกล้เต็ม
    bytes: statements.totalBytes.get().bytes + statements.hostBytes.get().bytes + boothBytes(),
  };
}

/**
 * ทุกอย่างที่ต้องใช้ทำรายชื่อแขก — ดึงเฉพาะคอลัมน์ที่ใช้จริง
 *
 * จัดกลุ่มใน JS ไม่ใช่ `GROUP BY` ใน SQL เพราะการตัดสินว่าชื่อสองอันคือคนเดียวกัน
 * ต้อง normalise แบบ Unicode (NFC + ยุบช่องว่าง + ตัวพิมพ์เล็ก) ซึ่ง SQLite ทำไม่ได้
 * — `LOWER()` ของมันรู้จักแต่ ASCII ชื่อไทยกับอาหรับจึงหลุดทุกกรณี
 */
export function listGuests({ includeHidden = false } = {}) {
  // ถังขยะไม่นับเป็นของที่แขกคนนั้น "ส่งมา" อีกต่อไป ไม่ว่า includeHidden จะเป็นอะไร
  const itemWhere = (includeHidden ? '1 = 1' : "status = 'visible'") + ' AND deleted_at IS NULL';
  const messageWhere = includeHidden ? '1 = 1' : "status = 'visible'";

  return groupGuests({
    items: db.prepare(`SELECT id, kind, uploader, created_at FROM items WHERE ${itemWhere} ORDER BY id`).all(),
    messages: db.prepare(`SELECT id, author, created_at FROM messages WHERE ${messageWhere} ORDER BY id`).all(),
  });
}

/** คำอวยพรทั้งหมดพร้อมข้อมูลไฟล์แนบ เรียงตามเวลา — ใช้ประกอบ PDF สมุดคำอวยพร */
export function listMessagesForPaper({ includeHidden = false } = {}) {
  const where = includeHidden ? '1 = 1' : "m.status = 'visible'";
  return db.prepare(`
    SELECT m.id, m.author, m.body, m.created_at,
           i.id            AS item_id,
           i.kind          AS item_kind,
           i.stored_name   AS item_stored,
           i.playback_name AS item_playback,
           i.thumb_name    AS item_thumb,
           i.status        AS item_status
    FROM messages m
    -- เหตุผลเดียวกับ listMessages() — รูปที่ถูกลบต้องหายจากสมุดคำอวยพร PDF ด้วย
    LEFT JOIN items i ON i.id = m.item_id AND i.deleted_at IS NULL
    WHERE ${where}
    ORDER BY m.id
  `).all();
}

/** รูปและวิดีโอทั้งหมดพร้อมชื่อผู้ส่ง เรียงตามเวลา — ใช้ประกอบ PDF รายชื่อคนอัพรูป */
export function listItemsForPaper({ includeHidden = false } = {}) {
  const where = (includeHidden ? '1 = 1' : "status = 'visible'") + ' AND deleted_at IS NULL';
  return db.prepare(`
    SELECT id, kind, uploader, stored_name, thumb_name, created_at
    FROM items WHERE ${where} ORDER BY id
  `).all();
}

/*
 * ─── รูปของเจ้าภาพบนหน้าแรก ──────────────────────────────────────────────
 *
 * ทุกฟังก์ชันในบล็อกนี้แตะเฉพาะตาราง host_media · ไม่มีตัวไหนอ่านหรือเขียน items
 * และไม่มีฟังก์ชันไหนข้างบนอ่าน host_media — ความแยกขาดนี้คือทั้งหมดที่กันไม่ให้
 * การ์ดเชิญของเจ้าภาพหลุดไปอยู่ในแกลลอรี่ สไลด์โชว์ หนัง หรือไฟล์ ZIP ของแขก
 */

export const listHostMedia = (slot) => statements.listHostSlot.all(slot);
export const listAllHostMedia = () => statements.listAllHostMedia.all();
export const getHostMedia = (id) => statements.getHostMedia.get(id);
export const countHostMedia = (slot) => statements.countHostSlot.get(slot).count;

export function insertHostMedia(media) {
  const info = statements.insertHostMedia.run({
    slot: media.slot,
    storedName: media.storedName,
    displayName: media.displayName ?? null,
    thumbName: media.thumbName ?? null,
    mime: media.mime,
    bytes: media.bytes,
    width: media.width ?? null,
    height: media.height ?? null,
    caption: media.caption ?? null,
    sortOrder: statements.nextHostOrder.get(media.slot).next,
  });
  return statements.getHostMedia.get(info.lastInsertRowid);
}

export const deleteHostMediaRow = (id) => statements.deleteHostMedia.run(id);

/**
 * สลับที่กับใบที่อยู่ติดกันในช่องเดียวกัน — ปุ่มขึ้น/ลง ไม่ใช่การลากวาง
 *
 * เจ้าภาพจัดหน้านี้จากมือถือ การลากวางบนจอสัมผัสพลาดง่ายและต้องพึ่ง JavaScript
 * ส่วนปุ่มขึ้น/ลงเป็นฟอร์มธรรมดาที่ทำงานได้แม้ JS พัง — แนวเดียวกับถังขยะ
 */
export function moveHostMedia(id, direction) {
  const row = statements.getHostMedia.get(id);
  if (!row) return false;

  const siblings = statements.listHostSlot.all(row.slot);
  const at = siblings.findIndex((one) => one.id === row.id);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= siblings.length) return false;

  // เขียนลำดับใหม่ทั้งช่องในทีเดียว — ค่า sort_order ที่ค้างมาจากการลบอาจซ้ำหรือ
  // ขาดช่วง การสลับเฉพาะสองแถวจึงไม่พอ ต้องไล่ใส่ใหม่ให้เรียง 1..n เสมอ
  const order = siblings.map((one) => one.id);
  [order[at], order[to]] = [order[to], order[at]];
  db.transaction(() => {
    order.forEach((rowId, index) => statements.setHostOrder.run(index + 1, rowId));
  })();
  return true;
}


/*
 * ─── รอบถ่ายจาก photo booth ──────────────────────────────────────────────
 *
 * เหมือนบล็อกรูปเจ้าภาพข้างบน: ทุกฟังก์ชันในนี้แตะเฉพาะ booth_sessions และ
 * booth_shots · ไม่มีตัวไหนอ่านหรือเขียน items และไม่มีฟังก์ชันไหนข้างบนอ่านสองตารางนี้
 * ความแยกขาดนี้คือทั้งหมดที่กันไม่ให้รูปจากบูธหลุดไปอยู่ในแกลลอรี่ สไลด์โชว์
 * หนัง ZIP หรือรายชื่อแขก — ซึ่งเป็นของคนละงานกันคนละเรื่อง
 */

const boothStatements = {
  get: db.prepare('SELECT * FROM booth_sessions WHERE token = ?'),
  insert: db.prepare(`
    INSERT INTO booth_sessions (token, taken_at, event_title, template, effect, sheet_name, bytes)
    VALUES (@token, @takenAt, @eventTitle, @template, @effect, @sheetName, @bytes)
  `),
  insertShot: db.prepare(`
    INSERT INTO booth_shots (token, stored_name, sort_order, bytes)
    VALUES (@token, @storedName, @sortOrder, @bytes)
  `),
  shots: db.prepare('SELECT * FROM booth_shots WHERE token = ? ORDER BY sort_order, id'),
  list: db.prepare('SELECT * FROM booth_sessions ORDER BY created_at DESC LIMIT ?'),
  remove: db.prepare('DELETE FROM booth_sessions WHERE token = ?'),
  count: db.prepare('SELECT COUNT(*) AS count FROM booth_sessions'),
  bytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM booth_sessions'),
  shotBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM booth_shots'),
};

export const getBoothSession = (token) => boothStatements.get.get(token);
export const listBoothShots = (token) => boothStatements.shots.all(token);
export const listBoothSessions = (limit = 200) => boothStatements.list.all(Math.min(limit, 1000));
export const countBoothSessions = () => boothStatements.count.get().count;
export const deleteBoothSession = (token) => boothStatements.remove.run(token);

/** ไบต์ที่รูปจากบูธกินบนดิสก์ — ต้องบวกเข้าสถิติ ไม่งั้นพื้นที่ใช้ไปต่ำกว่าจริง */
export const boothBytes = () =>
  boothStatements.bytes.get().bytes + boothStatements.shotBytes.get().bytes;

/**
 * บันทึกรอบถ่ายหนึ่งรอบทั้งก้อน — แถวหลักกับรูปทุกใบต้องเข้าไปพร้อมกันหรือไม่เข้าเลย
 *
 * เน็ตหลุดกลางอัปโหลดแล้วเหลือแถวที่ไม่มีรูป คือหน้า /p/ ที่เปิดแล้วว่างเปล่า
 * ซึ่งแขกที่ถือกระดาษมาสแกนจะเจอ และเราจะไม่มีทางรู้ว่ามันเกิดขึ้น
 */
export const insertBoothSession = db.transaction((session, shots) => {
  boothStatements.insert.run(session);
  shots.forEach((shot, index) =>
    boothStatements.insertShot.run({ ...shot, token: session.token, sortOrder: index + 1 }));
  return boothStatements.get.get(session.token);
});
