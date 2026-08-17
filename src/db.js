import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.paths.db), { recursive: true });

export const db = new Database(config.paths.db);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    kind           TEXT    NOT NULL CHECK (kind IN ('image', 'video')),
    original_name  TEXT    NOT NULL,
    stored_name    TEXT    NOT NULL UNIQUE,
    playback_name  TEXT,
    thumb_name     TEXT,
    mime           TEXT    NOT NULL,
    bytes          INTEGER NOT NULL,
    width          INTEGER,
    height         INTEGER,
    duration       REAL,
    uploader       TEXT,
    status         TEXT    NOT NULL DEFAULT 'visible'
                   CHECK (status IN ('visible', 'pending', 'hidden')),
    convert_state  TEXT    NOT NULL DEFAULT 'none'
                   CHECK (convert_state IN ('none', 'queued', 'running', 'done', 'failed')),
    created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_status_created ON items (status, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_items_convert_state  ON items (convert_state);

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    author     TEXT,
    body       TEXT    NOT NULL,
    item_id    INTEGER REFERENCES items (id) ON DELETE SET NULL,
    status     TEXT    NOT NULL DEFAULT 'visible'
               CHECK (status IN ('visible', 'pending', 'hidden')),
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_messages_status_created ON messages (status, created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

const readSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const writeSetting = db.prepare(`
  INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value
`);

export function getSetting(key, fallback = null) {
  const row = readSetting.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  writeSetting.run(key, String(value));
}

export function getFlag(key, fallback) {
  const value = getSetting(key);
  if (value === null) return fallback;
  return value === 'true';
}

export function setFlag(key, value) {
  setSetting(key, value ? 'true' : 'false');
}

// Seed the runtime switches from the environment on first boot only; after that
// the admin panel owns them.
if (getSetting('uploads_enabled') === null) {
  setFlag('uploads_enabled', config.uploads.defaultEnabled);
}
if (getSetting('require_review') === null) {
  setFlag('require_review', config.uploads.defaultRequireReview);
}

export function pruneExpiredSessions() {
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
}
