import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';

const run = promisify(execFile);

export async function makeJpeg(filePath, { width = 1200, height = 800, colour = '#c8a27a' } = {}) {
  await sharp({
    create: { width, height, channels: 3, background: colour },
  })
    .jpeg()
    .toFile(filePath);
  return filePath;
}

/** A real, tiny H.264 clip — good enough to exercise probe + poster + queue. */
export async function makeMp4(filePath, { seconds = 2, ffmpeg } = {}) {
  await run(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-t', String(seconds),
    filePath,
  ]);
  return filePath;
}

/**
 * QuickTime wrapper around plain H.264 — what an iPhone set to "Most Compatible"
 * sends. The codec is already web-playable; only the container needs changing.
 */
export async function makeMovH264(filePath, { seconds = 2, ffmpeg } = {}) {
  await run(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    '-f', 'lavfi',
    '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-t', String(seconds),
    '-f', 'mov',
    filePath,
  ]);
  return filePath;
}

/** Same footage wrapped as QuickTime/HEVC, which is what iPhones actually send. */
export async function makeMovHevc(filePath, { seconds = 2, ffmpeg } = {}) {
  await run(ffmpeg, [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc=size=320x240:rate=15:duration=${seconds}`,
    '-c:v', 'libx265',
    '-tag:v', 'hvc1',
    '-pix_fmt', 'yuv420p',
    '-t', String(seconds),
    '-f', 'mov',
    filePath,
  ]);
  return filePath;
}

export async function uploadFiles(baseUrl, files, { uploader, lang = 'th' } = {}) {
  const form = new FormData();
  for (const filePath of files) {
    const data = await fs.readFile(filePath);
    form.append('files', new Blob([data]), path.basename(filePath));
  }
  if (uploader) form.append('uploader', uploader);

  const response = await fetch(`${baseUrl}/api/upload?lang=${lang}`, { method: 'POST', body: form });
  return { status: response.status, body: await response.json() };
}
