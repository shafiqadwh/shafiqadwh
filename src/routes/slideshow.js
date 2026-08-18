import express from 'express';
import { config } from '../config.js';
import { listItems, listMessages } from '../repo.js';
import { qrDataUrl, shareUrl } from '../lib/qr.js';
import { toPublicItem } from './gallery.js';

export const slideshowRouter = express.Router();

// คำอวยพรที่แนบไฟล์ไว้จะโชว์รูปเป็นพื้นหลังพร้อมข้อความทับ ส่วนที่ไม่แนบก็ยังขึ้น
// เป็นการ์ดข้อความล้วน — แต่ต้องกันสองกรณีนี้ ไม่งั้นจอจะขึ้นของที่ไม่ควรขึ้น
//   1. แอดมินซ่อนรูปนั้นไปแล้ว (status ไม่ใช่ visible) — ข้อความยังโชว์ได้ รูปห้ามโชว์
//   2. วิดีโอที่ยังแปลงไม่เสร็จ — เล่นแล้วจะค้างหรือขึ้นจอดำ
function attachedMedia(row) {
  if (!row.item_id || !row.item_kind) return null;
  if (row.item_status !== 'visible') return null;
  if (row.item_kind === 'video' && ['queued', 'running'].includes(row.item_convert_state)) return null;

  return {
    id: row.item_id,
    kind: row.item_kind,
    mediaUrl: `/media/${row.item_id}`,
    displayUrl: row.item_kind === 'image' ? `/display/${row.item_id}` : `/media/${row.item_id}`,
    thumbUrl: row.item_thumb ? `/thumb/${row.item_id}` : null,
    duration: row.item_duration,
    width: row.item_width,
    height: row.item_height,
  };
}

slideshowRouter.get('/slideshow', async (req, res) => {
  const url = shareUrl(req);
  res.render('slideshow', {
    page: 'slideshow',
    shareUrl: url,
    qrImage: await qrDataUrl(url, { width: 640 }),
    settings: config.slideshow,
  });
});

slideshowRouter.get('/api/slideshow', (req, res) => {
  const since = Number(req.query.since) || 0;
  const sinceMessage = Number(req.query.sinceMessage) || 0;

  // First load fills the deck; later polls only ask for what is new.
  const rows = since
    ? listItems({ limit: 60 }).filter((row) => row.id > since)
    : listItems({ limit: 200 });

  const items = rows
    .filter((row) => !(row.kind === 'video' && ['queued', 'running'].includes(row.convert_state)))
    .map(toPublicItem);

  const messages = listMessages({ limit: 60 })
    .filter((row) => row.id > sinceMessage)
    .map((row) => ({
      id: row.id,
      author: row.author,
      body: row.body,
      createdAt: row.created_at,
      media: attachedMedia(row),
    }));

  res.json({
    items,
    messages,
    maxId: rows.length ? Math.max(...rows.map((row) => row.id)) : since,
    maxMessageId: messages.length ? Math.max(...messages.map((m) => m.id)) : sinceMessage,
  });
});
