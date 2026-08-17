import { db } from '../db.js';
import { transcodeVideo } from './media.js';

/**
 * Serial background transcoder. Guests never wait for it: an upload returns as
 * soon as the poster exists, and the web-playable copy appears a little later.
 * State lives in the database so a restart mid-party picks the queue back up.
 */
const pending = [];
let running = false;
let onIdle = null;

const markState = db.prepare('UPDATE items SET convert_state = ? WHERE id = ?');
const markDone = db.prepare('UPDATE items SET convert_state = ?, playback_name = ? WHERE id = ?');
const selectQueued = db.prepare(
  "SELECT id, stored_name FROM items WHERE convert_state IN ('queued', 'running') ORDER BY id",
);

export function enqueueConversion(itemId, storedName) {
  pending.push({ itemId, storedName });
  markState.run('queued', itemId);
  void drain();
}

export function queueLength() {
  return pending.length + (running ? 1 : 0);
}

/** Resolves when the queue has finished everything it currently holds. */
export function whenIdle() {
  if (queueLength() === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const previous = onIdle;
    onIdle = () => {
      previous?.();
      resolve();
    };
  });
}

async function drain() {
  if (running) return;
  running = true;

  while (pending.length > 0) {
    const job = pending.shift();
    try {
      markState.run('running', job.itemId);
      const playbackName = await transcodeVideo(job.storedName);
      markDone.run('done', playbackName, job.itemId);
    } catch (error) {
      // The original still plays on most devices, so a failed transcode is a
      // degraded experience rather than a lost memory.
      console.error(`[queue] conversion failed for ${job.storedName}:`, error.message);
      markState.run('failed', job.itemId);
    }
  }

  running = false;
  const callback = onIdle;
  onIdle = null;
  callback?.();
}

/** Re-queue anything left half-done by a restart. */
export function resumeQueue() {
  const rows = selectQueued.all();
  for (const row of rows) {
    pending.push({ itemId: row.id, storedName: row.stored_name });
  }
  if (rows.length > 0) {
    console.log(`[queue] resuming ${rows.length} video conversion(s)`);
    void drain();
  }
}
