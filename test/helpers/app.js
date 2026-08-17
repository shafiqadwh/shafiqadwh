import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Every test file gets its own data directory and its own SQLite file, so tests
 * can run in parallel without fighting over the database.
 */
export function useTempDataDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wedding-${label}-`));
  process.env.DATA_DIR = dir;
  process.env.ADMIN_PASSWORD = 'test-password';
  process.env.NODE_ENV = 'test';
  process.env.TRUST_PROXY = 'false';
  return dir;
}

export async function startTestServer() {
  const { createApp } = await import('../../src/server.js');
  const { ensureDirs } = await import('../../src/lib/media.js');
  await ensureDirs();

  const app = createApp();
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function login(baseUrl) {
  const response = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: 'test-password' }),
    redirect: 'manual',
  });
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('admin_session='));
  return cookie.split(';')[0];
}
