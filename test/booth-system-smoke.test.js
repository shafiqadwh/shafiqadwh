import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { reserveSession, saveSession, readSession } from '../photobooth/src/main/session.js';
import { uploadSession } from '../photobooth/src/main/upload.js';

const project = fileURLToPath(new URL('../', import.meta.url));
test('web and booth: pairing, upload, duplicate retry, QR page and exact downloads', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'photo-system-'));
  const key = 'smoke-test-key-only-123456';
  const child = spawn(process.execPath, ['src/server.js'], { cwd: project, windowsHide: true,
    env: { ...process.env, DATA_DIR: path.join(root, 'web'), HOST: '127.0.0.1', PORT: '0',
      BASE_URL: '', ADMIN_PASSWORD: 'test-password-only', BOOTH_KEY: key },
    stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const baseUrl = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server did not start: ' + output)), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    child.stderr.on('data', data => { output += data; });
    child.stdout.on('data', data => {
      output += data;
      const match = output.match(/listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  assert.equal((await fetch(`${baseUrl}/api/booth/status`)).status, 401);
  const status = await fetch(`${baseUrl}/api/booth/status`, { headers: { 'x-booth-key': key } });
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await status.json(), { ok: true, service: 'wedding-share-booth', protocol: 1 });
  const check = await promisify(execFile)(process.execPath, ['scripts/check-booth.mjs'], {
    cwd: project, windowsHide: true, env: { ...process.env, BOOTH_BASE_URL: baseUrl, BOOTH_KEY: key },
  });
  assert.match(check.stdout, /PASS:/);
  const sessions = path.join(root, 'sessions');
  const { token } = await reserveSession(sessions);
  const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#568fbd' } }).jpeg().toBuffer();
  await saveSession(sessions, { token, photos: [photo],
    sheet: { data: photo, width: 320, height: 240, dpi: 300 },
    settings: { baseUrl, eventTitle: 'Integration test' }, effect: 'clean', template: 'single' });
  assert.equal((await uploadSession(sessions, token, { baseUrl, key })).duplicate, false);
  assert.equal((await uploadSession(sessions, token, { baseUrl, key })).duplicate, true);
  assert.equal((await readSession(sessions, token)).uploaded, true);
  const page = await fetch(`${baseUrl}/p/${token}`);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes(token));
  for (const suffix of ['sheet', 'shot/1']) {
    const file = await fetch(`${baseUrl}/p/${token}/${suffix}`);
    assert.equal(file.status, 200);
    assert.deepEqual(Buffer.from(await file.arrayBuffer()), photo);
  }
});
