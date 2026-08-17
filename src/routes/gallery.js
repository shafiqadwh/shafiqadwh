import path from 'node:path';
import express from 'express';
import { config, withinUploadWindow } from '../config.js';
import { getFlag } from '../db.js';
import { countItems, getItem, listItems, newerCount } from '../repo.js';
import { safeOriginalName } from '../lib/media.js';

export const galleryRouter = express.Router();

/** What the browser needs to know about one item, and nothing more. */
export function toPublicItem(row) {
  return {
    id: row.id,
    kind: row.kind,
    width: row.width,
    height: row.height,
    duration: row.duration,
    uploader: row.uploader,
    createdAt: row.created_at,
    thumbUrl: row.thumb_name ? `/thumb/${row.id}` : null,
    mediaUrl: `/media/${row.id}`,
    downloadUrl: `/download/${row.id}`,
    converting: row.kind === 'video' && ['queued', 'running'].includes(row.convert_state),
  };
}

export function uploadsOpen() {
  return getFlag('uploads_enabled', true) && withinUploadWindow();
}

galleryRouter.get('/', (req, res) => {
  res.render('gallery', {
    page: 'gallery',
    uploadsOpen: uploadsOpen(),
    total: countItems({}),
  });
});

galleryRouter.get('/api/items', (req, res) => {
  const filter = ['all', 'photos', 'videos'].includes(req.query.filter) ? req.query.filter : 'all';
  const limit = Number(req.query.limit) || 60;
  const rows = listItems({ filter, limit, beforeId: req.query.before ?? null });

  res.json({
    items: rows.map(toPublicItem),
    total: countItems({ filter }),
    nextBefore: rows.length === Math.min(limit, 200) ? rows.at(-1).id : null,
  });
});

galleryRouter.get('/api/updates', (req, res) => {
  res.json({ newer: newerCount(req.query.since ?? 0), uploadsOpen: uploadsOpen() });
});

function sendMedia(res, root, filename, { download = false, downloadName = null } = {}) {
  return new Promise((resolve, reject) => {
    res.sendFile(
      filename,
      {
        root,
        dotfiles: 'deny',
        maxAge: '365d',
        immutable: true,
        headers: download
          ? { 'Content-Disposition': `attachment; filename="${downloadName}"` }
          : undefined,
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

galleryRouter.get('/thumb/:id', async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!row || row.status === 'hidden' || !row.thumb_name) return next();
  try {
    await sendMedia(res, config.paths.derived, row.thumb_name);
  } catch (error) {
    next(error);
  }
});

galleryRouter.get('/media/:id', async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!row || row.status === 'hidden') return next();

  // Prefer the web-friendly copy (converted HEIC or H.264 video) when we made one.
  const usePlayback = Boolean(row.playback_name);
  const root = usePlayback ? config.paths.derived : config.paths.uploads;
  const filename = usePlayback ? row.playback_name : row.stored_name;

  try {
    await sendMedia(res, root, filename);
  } catch (error) {
    next(error);
  }
});

galleryRouter.get('/download/:id', async (req, res, next) => {
  const row = getItem(Number(req.params.id));
  if (!row || row.status === 'hidden') return next();

  const ext = path.extname(row.stored_name);
  const base = path.parse(safeOriginalName(row.original_name)).name || `item-${row.id}`;
  try {
    await sendMedia(res, config.paths.uploads, row.stored_name, {
      download: true,
      downloadName: `${base}-${row.id}${ext}`,
    });
  } catch (error) {
    next(error);
  }
});
