import express from 'express';
import { config } from '../config.js';
import { listItems, listMessages } from '../repo.js';
import { qrDataUrl, shareUrl } from '../lib/qr.js';
import { toPublicItem } from './gallery.js';
import { wrap } from '../lib/async-route.js';

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

/**
 * หน้าเลือกรูปแบบสไลด์โชว์ — เปิดจากหน้าแอดมิน และเป็นหน้าแรกของแอปบนทีวี
 *
 * ออกแบบให้เดินด้วยรีโมตได้ ไม่ใช่แค่คลิกด้วยเมาส์ พอเลือกแล้วกดปุ่มย้อนกลับ
 * จะกลับมาหน้านี้เพราะเป็นการเดินหน้าไปอีกหน้าตามปกติ ไม่ได้เปลี่ยนเนื้อในหน้าเดิม
 */
slideshowRouter.get('/slideshow/menu', (req, res) => {
  // ค่าที่ติดมากับ URL อย่าง lite กับ lang ต้องส่งต่อไปด้วย ไม่งั้นทีวีที่ตั้ง
  // โหมดเบาไว้จะหลุดโหมดทันทีที่เลือกจากเมนู
  const carry = ['lite', 'lang', 'tv'];

  res.render('slideshow-menu', {
    page: 'slideshow',
    link(mode) {
      const params = new URLSearchParams({ mode });
      for (const key of carry) {
        const value = req.query[key];
        if (typeof value === 'string' && value !== '') params.set(key, value);
      }
      return `/slideshow?${params}`;
    },
  });
});

slideshowRouter.get('/slideshow', wrap(async (req, res) => {
  const url = shareUrl(req);
  res.render('slideshow', {
    page: 'slideshow',
    shareUrl: url,
    qrImage: await qrDataUrl(url, { width: 640 }),
    settings: config.slideshow,
  });
}));

slideshowRouter.get('/api/slideshow', (req, res) => {
  const since = Number(req.query.since) || 0;
  const sinceMessage = Number(req.query.sinceMessage) || 0;

  // First load fills the deck; later polls only ask for what is new.
  //
  // หน้าต่าง poll ต้องกว้างเท่ารอบแรก — จอ poll ทุก 15 วินาที ช่วงพีคหลังพิธี
  // แขกพันคนอัพเกิน 60 รูปใน 15 วินาทีได้จริง ถ้าหน้าต่างแคบกว่านั้น รูปที่
  // เกินมาจะไม่ขึ้นจอเลยตลอดงาน โดยไม่มีใครรู้ว่าหายไป
  const rows = since
    ? listItems({ limit: 200 }).filter((row) => row.id > since)
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
