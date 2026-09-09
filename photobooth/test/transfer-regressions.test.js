import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import test from 'node:test';
import { clearSession, reserveSession, saveSession, readSession } from '../src/main/session.js';
import { uploadSession } from '../src/main/upload.js';

test('redirects cannot forward a guests photos or the booth key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-redirect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let forwarded = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    if (req.url === '/api/booth/upload') {
      res.writeHead(307, { Location: '/other-event' });
      res.end();
    } else { forwarded++; res.end('{}'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const { token } = await reserveSession(root);
  await saveSession(root, { token, photos: [Buffer.from('photo')],
    sheet: { data: Buffer.from('sheet'), width: 1, height: 1, dpi: 300 },
    settings: { baseUrl }, effect: 'clean', template: 'single' });
  await assert.rejects(uploadSession(root, token, { baseUrl, key: 'test-key' }));
  assert.equal(forwarded, 0);
  assert.equal((await readSession(root, token)).uploaded, false);
});

test('retake keeps the reservation directory and clears only its contents', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'booth-retake-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { token, dir } = await reserveSession(root);
  const before = await fs.stat(dir, { bigint: true });
  await fs.mkdir(path.join(dir, 'shots'));
  await fs.writeFile(path.join(dir, 'shots', 'one.jpg'), 'photo');
  await clearSession(root, token);
  assert.deepEqual(await fs.readdir(dir), []);
  const after = await fs.stat(dir, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.birthtimeNs, before.birthtimeNs);
  await assert.rejects(fs.mkdir(dir), { code: 'EEXIST' });
});
