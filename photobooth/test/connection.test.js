import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../src/main/connection.js';
const input = { baseUrl: 'https://photos.example.com', uploadKey: 'test-only-key-123456' };

test('pairing validates the protocol and never uploads photos or follows redirects', async () => {
  const result = await checkConnection(input, async (url, options) => {
    assert.equal(String(url), 'https://photos.example.com/api/booth/status');
    assert.equal(options.redirect, 'error');
    assert.equal(options.body, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ ok: true, service: 'wedding-share-booth', protocol: 1 });
  });
  assert.deepEqual(result, { ok: true });
});
test('invalid destinations and keys fail before any request', async () => {
  let requests = 0;
  for (const baseUrl of ['file:///tmp/data', 'https://u:p@photos.example.com', 'https://photos.example.com/other', 'https://photos.example.com/?event=b', 'not-a-url']) {
    await assert.rejects(checkConnection({ ...input, baseUrl }, () => { requests++; }));
  }
  await assert.rejects(checkConnection({ ...input, uploadKey: 'short' }, () => { requests++; }));
  assert.equal(requests, 0);
});
test('wrong keys, old servers and captive portals cannot appear connected', async () => {
  for (const response of [new Response('', { status: 401 }), new Response('', { status: 404 }),
    new Response('<html>login</html>'), Response.json({ ok: true }),
    Response.json({ ok: true, service: 'wedding-share-booth', protocol: 2 })]) {
    await assert.rejects(checkConnection(input, async () => response));
  }
});
test('network errors show recovery text without echoing the secret', async () => {
  await assert.rejects(checkConnection(input, async () => { throw new Error(input.uploadKey); }),
    error => !error.message.includes(input.uploadKey) && error.message.includes('ลองอีกครั้ง'));
});
