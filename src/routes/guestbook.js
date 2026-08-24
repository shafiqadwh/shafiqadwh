import express from 'express';
import { config } from '../config.js';
import { getFlag } from '../db.js';
import { insertMessage, listMessages } from '../repo.js';
import { createLimiter } from '../lib/ratelimit.js';
import { byDevice, byIp } from '../lib/device.js';
import { ingestFile, singleAttachment } from './upload.js';
import { uploadsOpen } from './gallery.js';

export const guestbookRouter = express.Router();

const messageLimiter = createLimiter({
  name: 'message-device',
  limit: config.limits.messagesPerHourPerDevice,
  windowMs: 60 * 60 * 1000,
  key: byDevice,
});

const messageCeiling = createLimiter({
  name: 'message-ip',
  limit: config.limits.messagesPerHourPerIp,
  windowMs: 60 * 60 * 1000,
  key: byIp,
});

function toPublicMessage(row) {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.created_at,
    // row.item_id คือคอลัมน์ item_id ของตาราง messages เอง (FK ดิบ) ไม่ใช่ผลจาก JOIN
    // จึงยังไม่หายไปเองแม้รูปที่แนบจะถูกลบ/ซ่อนแล้ว — ต้องเช็ค item_status ที่มาจาก
    // การ JOIN ด้วย (เหมือนที่ attachedMedia() ของสไลด์โชว์ทำอยู่แล้ว) ไม่งั้นคำอวยพร
    // ที่แนบรูปซึ่งถูกลบเข้าถังขยะไปแล้ว จะยังส่ง mediaUrl ของรูปนั้นออกไปให้แขกอยู่ดี
    item: row.item_id && row.item_status === 'visible'
      ? {
          id: row.item_id,
          kind: row.item_kind,
          thumbUrl: row.item_thumb ? `/thumb/${row.item_id}` : null,
          mediaUrl: `/media/${row.item_id}`,
        }
      : null,
  };
}

guestbookRouter.get('/guestbook', (req, res) => {
  res.render('guestbook', { page: 'guestbook', uploadsOpen: uploadsOpen() });
});

guestbookRouter.get('/api/messages', (req, res) => {
  res.json({ messages: listMessages({ limit: Number(req.query.limit) || 100 }).map(toPublicMessage) });
});

guestbookRouter.post('/api/messages', messageCeiling, messageLimiter, (req, res) => {
  singleAttachment(req, res, async (uploadError) => {
    if (uploadError) {
      const tooLarge = uploadError.code === 'LIMIT_FILE_SIZE';
      return res.status(tooLarge ? 413 : 400).json({
        error: req.t(tooLarge ? 'errors.too_large_request' : 'errors.server_error'),
      });
    }

    const body = String(req.body?.body ?? '').trim().slice(0, 2000);
    if (!body) {
      return res.status(400).json({ error: req.t('guestbook.required') });
    }

    const author = String(req.body?.author ?? '').trim().slice(0, 60) || null;
    const status = getFlag('require_review', false) ? 'pending' : 'visible';
    let itemId = null;
    const errors = [];

    if (req.file) {
      if (!uploadsOpen()) {
        errors.push(req.t('errors.upload_closed'));
      } else {
        const result = await ingestFile(req.file, { uploader: author, t: req.t, status });
        if (result.error) errors.push(result.error);
        else itemId = result.row.id;
      }
    }

    const message = insertMessage({ author, body, itemId, status });
    res.status(201).json({ id: message.id, pending: status === 'pending', errors });
  });
});
