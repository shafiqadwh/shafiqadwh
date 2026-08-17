import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import { config } from '../config.js';
import { db, getFlag, pruneExpiredSessions, setFlag } from '../db.js';
import { translator } from '../i18n.js';
import {
  deleteItemRow,
  deleteMessageRow,
  getItem,
  getMessage,
  listItems,
  listMessages,
  setItemStatus,
  setMessageStatus,
  stats,
} from '../repo.js';
import { formatBytes } from '../lib/media.js';
import { queueLength } from '../lib/queue.js';
import { qrDataUrl, qrPngBuffer, shareUrl } from '../lib/qr.js';
import { streamArchive } from '../lib/zip.js';
import { createLimiter } from '../lib/ratelimit.js';
import { uploadsOpen } from './gallery.js';

export const adminRouter = express.Router();

const COOKIE = 'admin_session';

const insertSession = db.prepare(
  "INSERT INTO admin_sessions (token, expires_at) VALUES (?, datetime('now', ?))",
);
const findSession = db.prepare(
  "SELECT token FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')",
);
const dropSession = db.prepare('DELETE FROM admin_sessions WHERE token = ?');

const loginLimiter = createLimiter({ name: 'admin-login', limit: 10, windowMs: 15 * 60 * 1000 });

function passwordMatches(candidate) {
  const expected = Buffer.from(config.admin.password);
  const given = Buffer.from(String(candidate ?? ''));
  if (expected.length !== given.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

export function isAdmin(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return false;
  return Boolean(findSession.get(token));
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.accepts('html')) return res.redirect('/admin');
  return res.status(401).json({ error: req.t('admin.wrong_password') });
}

adminRouter.get('/admin', (req, res) => {
  if (!isAdmin(req)) {
    return res.render('admin-login', { page: 'admin', error: null });
  }

  const summary = stats();
  res.render('admin', {
    page: 'admin',
    stats: { ...summary, storage: formatBytes(summary.bytes) },
    queue: queueLength(),
    uploadsEnabled: getFlag('uploads_enabled', true),
    requireReview: getFlag('require_review', false),
    uploadsOpen: uploadsOpen(),
    items: listItems({ limit: 120, includeHidden: true }),
    messages: listMessages({ limit: 60, includeHidden: true }),
  });
});

adminRouter.post('/admin/login', loginLimiter, express.urlencoded({ extended: false }), (req, res) => {
  if (!passwordMatches(req.body?.password)) {
    return res.status(401).render('admin-login', { page: 'admin', error: req.t('admin.wrong_password') });
  }

  pruneExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(token, `+${config.admin.sessionHours} hours`);

  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.protocol === 'https',
    maxAge: config.admin.sessionHours * 60 * 60 * 1000,
  });
  res.redirect('/admin');
});

adminRouter.post('/admin/logout', requireAdmin, (req, res) => {
  dropSession.run(req.cookies[COOKIE]);
  res.clearCookie(COOKIE);
  res.redirect('/');
});

adminRouter.post('/admin/settings', requireAdmin, express.urlencoded({ extended: false }), (req, res) => {
  setFlag('uploads_enabled', req.body?.uploads_enabled === 'on');
  setFlag('require_review', req.body?.require_review === 'on');
  res.redirect('/admin');
});

async function removeFiles(row) {
  const targets = [
    path.join(config.paths.uploads, row.stored_name),
    row.playback_name ? path.join(config.paths.derived, row.playback_name) : null,
    row.thumb_name ? path.join(config.paths.derived, row.thumb_name) : null,
  ].filter(Boolean);

  await Promise.all(targets.map((file) => fs.rm(file, { force: true })));
}

adminRouter.post('/admin/items/:id/:action', requireAdmin, async (req, res) => {
  const row = getItem(Number(req.params.id));
  if (!row) return res.status(404).json({ error: req.t('errors.not_found') });

  switch (req.params.action) {
    case 'approve':
      setItemStatus(row.id, 'visible');
      break;
    case 'hide':
      setItemStatus(row.id, 'hidden');
      break;
    case 'show':
      setItemStatus(row.id, 'visible');
      break;
    case 'delete':
      await removeFiles(row);
      deleteItemRow(row.id);
      break;
    default:
      return res.status(400).json({ error: 'unknown action' });
  }

  if (req.accepts('html') && !req.xhr) return res.redirect('/admin');
  return res.json({ ok: true });
});

adminRouter.post('/admin/messages/:id/:action', requireAdmin, (req, res) => {
  const row = getMessage(Number(req.params.id));
  if (!row) return res.status(404).json({ error: req.t('errors.not_found') });

  if (req.params.action === 'delete') deleteMessageRow(row.id);
  else if (req.params.action === 'hide') setMessageStatus(row.id, 'hidden');
  else if (req.params.action === 'show') setMessageStatus(row.id, 'visible');
  else if (req.params.action === 'approve') setMessageStatus(row.id, 'visible');
  else return res.status(400).json({ error: 'unknown action' });

  if (req.accepts('html') && !req.xhr) return res.redirect('/admin');
  return res.json({ ok: true });
});

adminRouter.get('/admin/zip', requireAdmin, (req, res) => {
  streamArchive(res, {
    includeVideos: req.query.videos !== '0',
    filenamePrefix: (config.event.coupleNames || 'wedding').replace(/[^\w-]+/g, '-').toLowerCase(),
  });
});

adminRouter.get('/admin/qr', requireAdmin, async (req, res) => {
  const url = shareUrl(req);
  // The printed card carries all three languages at once — guests do not get to
  // pick a language before they have scanned anything.
  const cards = config.i18n.available.map((code) => {
    const translate = translator(code);
    return {
      code,
      title: translate('qr.title'),
      step1: translate('qr.step1'),
      step2: translate('qr.step2'),
      step3: translate('qr.step3'),
    };
  });

  res.render('qr-card', {
    page: 'admin',
    shareUrl: url,
    qrImage: await qrDataUrl(url, { width: 900 }),
    cards,
  });
});

adminRouter.get('/admin/qr.png', requireAdmin, async (req, res) => {
  res.type('png').send(await qrPngBuffer(shareUrl(req), { width: 1200 }));
});
