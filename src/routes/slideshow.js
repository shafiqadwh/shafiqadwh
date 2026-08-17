import express from 'express';
import { config } from '../config.js';
import { listItems, listMessages } from '../repo.js';
import { qrDataUrl, shareUrl } from '../lib/qr.js';
import { toPublicItem } from './gallery.js';

export const slideshowRouter = express.Router();

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

  // First load fills the deck; later polls only ask for what is new.
  const rows = since
    ? listItems({ limit: 60 }).filter((row) => row.id > since)
    : listItems({ limit: 200 });

  const items = rows
    .filter((row) => !(row.kind === 'video' && ['queued', 'running'].includes(row.convert_state)))
    .map(toPublicItem);

  const messages = listMessages({ limit: 40 })
    .filter((row) => row.id > (Number(req.query.sinceMessage) || 0))
    .map((row) => ({ id: row.id, author: row.author, body: row.body }));

  res.json({
    items,
    messages,
    maxId: rows.length ? Math.max(...rows.map((row) => row.id)) : since,
    maxMessageId: messages.length ? Math.max(...messages.map((m) => m.id)) : Number(req.query.sinceMessage) || 0,
  });
});
