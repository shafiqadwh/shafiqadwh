import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_PASSWORD ??= 'test-password';
process.env.DATA_DIR ??= 'data/test-media';

const { safeOriginalName, sniffType, formatBytes } = await import('../src/lib/media.js');

function ftyp(brand) {
  const buffer = Buffer.alloc(32);
  buffer.write('ftyp', 4, 'ascii');
  buffer.write(brand, 8, 'ascii');
  return buffer;
}

test('recognises the formats guests actually upload', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(28)]);
  assert.deepEqual(sniffType(jpeg), { kind: 'image', mime: 'image/jpeg', ext: 'jpg' });

  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(24),
  ]);
  assert.deepEqual(sniffType(png), { kind: 'image', mime: 'image/png', ext: 'png' });

  const webp = Buffer.alloc(32);
  webp.write('RIFF', 0, 'ascii');
  webp.write('WEBP', 8, 'ascii');
  assert.equal(sniffType(webp).mime, 'image/webp');

  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(28)]);
  assert.deepEqual(sniffType(webm), { kind: 'video', mime: 'video/webm', ext: 'webm' });
});

test('separates iPhone HEIC photos from iPhone MOV videos', () => {
  const heic = sniffType(ftyp('heic'));
  assert.equal(heic.kind, 'image');
  assert.equal(heic.heif, true);

  const mov = sniffType(ftyp('qt  '));
  assert.deepEqual(mov, { kind: 'video', mime: 'video/quicktime', ext: 'mov' });

  const mp4 = sniffType(ftyp('isom'));
  assert.deepEqual(mp4, { kind: 'video', mime: 'video/mp4', ext: 'mp4' });
});

test('rejects files that are not media at all', () => {
  assert.equal(sniffType(Buffer.from('#!/bin/sh\nrm -rf /\n')), null);
  assert.equal(sniffType(Buffer.from('<?php system($_GET[0]); ?>')), null);
  assert.equal(sniffType(Buffer.alloc(4)), null, 'a truncated file is not a media file');
  assert.equal(sniffType('not a buffer'), null);
});

test('a .mp4 extension does not make a script into a video', () => {
  // The uploader names the file; only the bytes decide what it is.
  const disguised = Buffer.from('<?php echo 1; ?>'.padEnd(32, ' '));
  assert.equal(sniffType(disguised), null);
});

test('original names are stripped of anything path-like', () => {
  assert.equal(safeOriginalName('../../etc/passwd'), 'passwd');
  assert.equal(safeOriginalName('/absolute/path/photo.jpg'), 'photo.jpg');
  assert.equal(safeOriginalName('a:b*c?.jpg'), 'a_b_c_.jpg');
  assert.equal(safeOriginalName(''), 'file');
  assert.equal(safeOriginalName(null), 'file');
  assert.equal(safeOriginalName('x'.repeat(400)).length, 120);
  assert.equal(safeOriginalName('bad\u0000name.jpg'), 'badname.jpg');
});

test('byte sizes read the way a person would say them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(21 * 1024 * 1024 * 1024), '21 GB');
});

test('moveFile survives a destination on a different mount', async (t) => {
  // Regression: uploads/ and tmp/ are separate bind mounts on the NAS, so
  // rename(2) fails with EXDEV and every single upload was rejected.
  const fsp = (await import('node:fs/promises')).default;
  const os = await import('node:os');
  const nodePath = await import('node:path');

  const dir = await fsp.mkdtemp(nodePath.join(os.tmpdir(), 'movefile-'));
  const from = nodePath.join(dir, 'source.bin');
  const to = nodePath.join(dir, 'destination.bin');
  await fsp.writeFile(from, 'wedding photo bytes');

  const rename = t.mock.method(fsp, 'rename', async () => {
    const error = new Error('cross-device link not permitted');
    error.code = 'EXDEV';
    throw error;
  });

  const { moveFile } = await import('../src/lib/media.js');
  await moveFile(from, to);

  assert.equal(rename.mock.callCount(), 1, 'rename is still tried first');
  assert.equal(await fsp.readFile(to, 'utf8'), 'wedding photo bytes');
  await assert.rejects(fsp.access(from), 'the temporary file is cleaned up');

  await fsp.rm(dir, { recursive: true, force: true });
});

test('moveFile still reports failures that are not about mounts', async (t) => {
  const fsp = (await import('node:fs/promises')).default;
  t.mock.method(fsp, 'rename', async () => {
    const error = new Error('permission denied');
    error.code = 'EACCES';
    throw error;
  });

  const { moveFile } = await import('../src/lib/media.js');
  await assert.rejects(() => moveFile('/nowhere/a', '/nowhere/b'), { code: 'EACCES' });
});
