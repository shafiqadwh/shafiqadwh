import { db } from './db.js';

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
    FROM items WHERE status != 'hidden' GROUP BY kind
  `),
  totalBytes: db.prepare('SELECT COALESCE(SUM(bytes), 0) AS bytes FROM items'),
  countMessages: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE status != 'hidden'"),
  countPending: db.prepare("SELECT COUNT(*) AS count FROM items WHERE status = 'pending'"),
  visibleSince: db.prepare(
    "SELECT COUNT(*) AS count FROM items WHERE status = 'visible' AND id > ?",
  ),
};

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

/**
 * Keyset pagination on (created_at, id) — cheap and stable even while guests
 * keep uploading underneath the reader.
 */
export function listItems({ filter = 'all', limit = 60, beforeId = null, includeHidden = false } = {}) {
  const where = [];
  const params = { limit: Math.min(Math.max(limit, 1), 200) };

  where.push(includeHidden ? "status IN ('visible', 'pending', 'hidden')" : "status = 'visible'");
  if (filter === 'photos') where.push("kind = 'image'");
  if (filter === 'videos') where.push("kind = 'video'");
  if (beforeId) {
    where.push('id < @beforeId');
    params.beforeId = Number(beforeId);
  }

  return db
    .prepare(`SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT @limit`)
    .all(params);
}

export function countItems({ filter = 'all', includeHidden = false } = {}) {
  const where = [includeHidden ? '1 = 1' : "status = 'visible'"];
  if (filter === 'photos') where.push("kind = 'image'");
  if (filter === 'videos') where.push("kind = 'video'");
  return db.prepare(`SELECT COUNT(*) AS count FROM items WHERE ${where.join(' AND ')}`).get().count;
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
      LEFT JOIN items i ON i.id = m.item_id
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
    bytes: statements.totalBytes.get().bytes,
  };
}
