import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from '../config.js';

const run = promisify(execFile);

/**
 * ffmpeg comes from one of three places, in order of preference:
 *   1. FFMPEG_PATH / FFPROBE_PATH — what the Docker image sets (system ffmpeg)
 *   2. the optional ffmpeg-static packages — handy for local development
 *   3. whatever is on PATH
 * Keeping the npm packages optional means a blocked download during
 * `npm ci` on the NAS cannot break the build.
 */
async function resolveBinary(configured, packageName, pick) {
  if (configured) return configured;
  try {
    const module = await import(packageName);
    const resolved = pick(module.default ?? module);
    if (resolved) return resolved;
  } catch {
    // Package not installed — fall through to PATH.
  }
  return packageName === 'ffmpeg-static' ? 'ffmpeg' : 'ffprobe';
}

export const FFMPEG = await resolveBinary(config.media.ffmpegPath, 'ffmpeg-static', (m) => m);
export const FFPROBE = await resolveBinary(config.media.ffprobePath, 'ffprobe-static', (m) => m.path);

const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'msnv', 'm4v ']);
const MOV_BRANDS = new Set(['qt  ']);

/**
 * Identify a file from its leading bytes. Extensions are attacker-controlled,
 * so nothing downstream is allowed to trust them.
 */
export function sniffType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  }
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  }
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  }
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString('ascii').toLowerCase();
    if (HEIF_BRANDS.has(brand)) return { kind: 'image', mime: 'image/heic', ext: 'heic', heif: true };
    if (MOV_BRANDS.has(brand)) return { kind: 'video', mime: 'video/quicktime', ext: 'mov' };
    if (MP4_BRANDS.has(brand)) return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
    // Unknown ISO-BMFF brand: treat as mp4, ffprobe is the final judge.
    return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  }
  return null;
}

export function randomName(ext) {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  return `${stamp}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
}

/** Keep something human-readable for the ZIP, without trusting the input. */
export function safeOriginalName(name) {
  const base = path.basename(String(name ?? '')).replace(/[\u0000-\u001f\u007f]/g, '');
  const cleaned = base.replace(/[\\/:*?"<>|]/g, '_').trim();
  return cleaned.slice(0, 120) || 'file';
}

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(config.paths.uploads, { recursive: true }),
    fs.mkdir(config.paths.derived, { recursive: true }),
    fs.mkdir(config.paths.tmp, { recursive: true }),
  ]);
}

/**
 * Turn an uploaded image into { storedName, playbackName, thumbName, ... }.
 * HEIC from iPhones is converted to JPEG so non-Apple browsers can display it;
 * the original is always kept for the download-everything ZIP.
 */
export async function processImage(tmpPath, sniffed) {
  const storedName = randomName(sniffed.ext);
  const storedPath = path.join(config.paths.uploads, storedName);
  await fs.rename(tmpPath, storedPath);

  let sourceForSharp = storedPath;
  let playbackName = null;

  if (sniffed.heif) {
    const heicConvert = (await import('heic-convert')).default;
    const jpeg = await heicConvert({
      buffer: await fs.readFile(storedPath),
      format: 'JPEG',
      quality: 0.92,
    });
    playbackName = `${path.parse(storedName).name}.jpg`;
    const playbackPath = path.join(config.paths.derived, playbackName);
    await fs.writeFile(playbackPath, Buffer.from(jpeg));
    sourceForSharp = playbackPath;
  }

  const image = sharp(sourceForSharp, { failOn: 'none' }).rotate();
  const meta = await image.metadata();
  const thumbName = `${path.parse(storedName).name}-thumb.jpg`;

  await image
    .resize(config.media.thumbnailSize, config.media.thumbnailSize, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 82, mozjpeg: true })
    .toFile(path.join(config.paths.derived, thumbName));

  const { size } = await fs.stat(storedPath);
  const rotated = meta.orientation && meta.orientation >= 5;

  return {
    kind: 'image',
    storedName,
    playbackName,
    thumbName,
    mime: sniffed.mime,
    bytes: size,
    width: rotated ? meta.height : meta.width,
    height: rotated ? meta.width : meta.height,
    duration: null,
    convertState: 'none',
  };
}

export async function probeVideo(filePath) {
  const { stdout } = await run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { maxBuffer: 4 * 1024 * 1024 });

  const probed = JSON.parse(stdout);
  const video = (probed.streams ?? []).find((s) => s.codec_type === 'video');
  if (!video) throw new Error('no video stream');

  const rotation = Math.abs(Number(video.side_data_list?.[0]?.rotation ?? video.tags?.rotate ?? 0)) % 180;
  const swap = rotation === 90;

  return {
    duration: Number(probed.format?.duration ?? video.duration ?? 0) || 0,
    width: swap ? Number(video.height) : Number(video.width),
    height: swap ? Number(video.width) : Number(video.height),
    codec: video.codec_name ?? '',
    audioCodec: (probed.streams ?? []).find((s) => s.codec_type === 'audio')?.codec_name ?? null,
  };
}

async function extractPoster(videoPath, outputPath, duration) {
  // A frame a second in is far more likely to be a real picture than frame zero.
  const seek = duration > 2 ? '1' : '0';
  await run(FFMPEG, [
    '-y',
    '-ss', seek,
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale='min(${config.media.thumbnailSize},iw)':-2`,
    '-q:v', '4',
    outputPath,
  ], { maxBuffer: 4 * 1024 * 1024 });
}

/**
 * iPhone .mov files are usually HEVC, which Chrome on Android will not play.
 * Anything that is not already H.264 in an MP4 gets a web-playable sibling.
 */
export function needsConversion(probed, sniffed) {
  if (!config.media.convertVideos) return false;
  if (sniffed.ext === 'webm') return false;
  return probed.codec !== 'h264' || sniffed.ext !== 'mp4';
}

export async function processVideo(tmpPath, sniffed) {
  const probed = await probeVideo(tmpPath);

  if (config.limits.videoSeconds > 0 && probed.duration > config.limits.videoSeconds + 1) {
    await fs.rm(tmpPath, { force: true });
    const error = new Error('video too long');
    error.code = 'VIDEO_TOO_LONG';
    error.seconds = Math.round(probed.duration);
    throw error;
  }

  const storedName = randomName(sniffed.ext);
  const storedPath = path.join(config.paths.uploads, storedName);
  await fs.rename(tmpPath, storedPath);

  const thumbName = `${path.parse(storedName).name}-poster.jpg`;
  try {
    await extractPoster(storedPath, path.join(config.paths.derived, thumbName), probed.duration);
  } catch {
    // A missing poster is cosmetic — the gallery falls back to a placeholder.
  }

  const { size } = await fs.stat(storedPath);

  return {
    kind: 'video',
    storedName,
    playbackName: null,
    thumbName,
    mime: sniffed.mime,
    bytes: size,
    width: probed.width,
    height: probed.height,
    duration: probed.duration,
    convertState: needsConversion(probed, sniffed) ? 'queued' : 'none',
  };
}

/** Run the actual transcode. Called by the background queue, never inline. */
export async function transcodeVideo(storedName) {
  const input = path.join(config.paths.uploads, storedName);
  const playbackName = `${path.parse(storedName).name}-web.mp4`;
  const output = path.join(config.paths.derived, playbackName);
  const partial = `${output}.part.mp4`;

  await run(FFMPEG, [
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '24',
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-vf', "scale='min(1920,iw)':-2",
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    '-threads', String(config.media.ffmpegThreads),
    partial,
  ], { maxBuffer: 8 * 1024 * 1024, timeout: 1000 * 60 * 30 });

  await fs.rename(partial, output);
  return playbackName;
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}
