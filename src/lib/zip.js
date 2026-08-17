import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import { config } from '../config.js';
import { db } from '../db.js';
import { safeOriginalName } from './media.js';

const selectAll = db.prepare(`
  SELECT id, kind, original_name, stored_name, uploader, created_at
  FROM items
  WHERE status != 'hidden'
  ORDER BY created_at, id
`);

/**
 * Stream every original file into a ZIP. Streaming matters: a wedding's worth
 * of video is far larger than the RAM of a NAS.
 */
export function streamArchive(res, { includeVideos = true, filenamePrefix = 'wedding' } = {}) {
  const rows = selectAll.all().filter((row) => includeVideos || row.kind === 'image');
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${filenamePrefix}-${includeVideos ? 'all' : 'photos'}-${stamp}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const archive = archiver('zip', { store: true }); // media is already compressed
  archive.on('warning', (error) => console.warn('[zip]', error.message));
  archive.on('error', (error) => {
    console.error('[zip]', error);
    res.destroy(error);
  });
  archive.pipe(res);

  const used = new Set();
  for (const row of rows) {
    const source = path.join(config.paths.uploads, row.stored_name);
    if (!fs.existsSync(source)) continue;

    const folder = row.kind === 'video' ? 'videos' : 'photos';
    const who = row.uploader ? `-${safeOriginalName(row.uploader)}` : '';
    const ext = path.extname(row.stored_name);
    let name = `${folder}/${row.created_at.replaceAll(':', '').replace(' ', '-')}${who}-${row.id}${ext}`;
    while (used.has(name)) name = name.replace(ext, `-x${ext}`);
    used.add(name);

    archive.file(source, { name });
  }

  const messages = db
    .prepare("SELECT author, body, created_at FROM messages WHERE status != 'hidden' ORDER BY created_at")
    .all();
  if (messages.length > 0) {
    const text = messages
      .map((m) => `[${m.created_at}] ${m.author || '-'}\n${m.body}\n`)
      .join('\n----------------------------------------\n\n');
    archive.append(`﻿${text}`, { name: 'guestbook.txt' });
  }

  return archive.finalize();
}
