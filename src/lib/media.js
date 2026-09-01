import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import { config } from '../config.js';
import { createGate } from './gate.js';

const run = promisify(execFile);

// ffmpeg/ffprobe เป็นโปรเซสแยก แขกหลายคนกดส่งพร้อมกัน = ffmpeg หลายตัวรุมเครื่อง
// จำกัดจำนวนที่ทำพร้อมกัน ให้คนมาทีหลังต่อคิวสั้น ๆ แทนที่จะช้าพร้อมกันทั้งงาน
// การแปลงวิดีโอเบื้องหลังมีคิวของตัวเองอยู่แล้ว (lib/queue.js) ตัวนี้คุมเฉพาะ
// งานที่แขกยืนรออยู่ — อ่านข้อมูลวิดีโอกับดึงภาพปก
const mediaGate = createGate(config.media.concurrency);

export const mediaQueueDepth = () => mediaGate.depth;

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
/**
 * ตัวเข้ารหัสที่ "ใช้ได้จริงตอนนี้" ไม่ใช่ที่เขียนไว้ใน .env
 *
 * `.env` เก็บค่าไว้ถาวร ส่วน GPU ต่อเข้าคอนเทนเนอร์หรือเปล่าเป็นเรื่องที่เปลี่ยนได้
 * ทุกครั้งที่ยกคอนเทนเนอร์ (ดู docker-compose.gpu.yml) สองอย่างนี้จึงไม่ตรงกันได้
 * และเมื่อไม่ตรง ffmpeg จะล้มด้วย "Cannot load libnvidia-encode.so.1" — เกิดขึ้น
 * จริงมาแล้ว: เว็บยังปกติดีทุกอย่าง แต่คลิปที่แขกส่งมาแปลงไม่ผ่านสักไฟล์
 * โดยไม่มีอะไรบอกจนกว่าจะมีคนไปเปิดวิดีโอบน Android แล้วเล่นไม่ได้
 *
 * จึงตรวจด้วยการ **เข้ารหัสจริงหนึ่งเฟรม** ครั้งเดียวตอนใช้ครั้งแรก แล้วจำผลไว้
 * ถ้าใช้ไม่ได้ก็ถอยไป libx264 ซึ่งมีติดมากับ ffmpeg ทุกตัว — หนังช้าลง แต่ได้หนัง
 */
const CPU_ENCODER = Object.freeze({
  videoEncoder: 'libx264',
  encoderArgs: ['-preset', 'veryfast', '-crf', '24', '-profile:v', 'high'],
  filmEncoderArgs: ['-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.1'],
  // -hwaccel cuda ก็พังด้วยเหตุผลเดียวกัน ต้องทิ้งไปพร้อมกัน ไม่ใช่ทิ้งแค่ฝั่งเข้ารหัส
  decoderArgs: [],
});

let encoderPromise = null;

/** เข้ารหัสจริงหนึ่งเฟรมด้วยชุดอาร์กิวเมนต์ที่จะใช้จริง */
async function canEncode(videoEncoder, args) {
  await run(FFMPEG, [
    '-v', 'error',
    '-f', 'lavfi', '-i', 'color=c=black:s=128x128:d=0.1',
    '-c:v', videoEncoder,
    ...args,
    '-f', 'null', '-',
  ], { timeout: 30000 });
}

async function probeEncoder() {
  const configured = {
    videoEncoder: config.media.videoEncoder,
    encoderArgs: config.media.encoderArgs,
    filmEncoderArgs: config.media.filmEncoderArgs,
    decoderArgs: config.media.decoderArgs,
  };

  // ไม่ได้ตั้งอะไรเองเลย = เป็นค่าเริ่มต้นที่ ffmpeg ทุกตัวทำได้อยู่แล้ว ไม่ต้องเสียเวลาตรวจ
  const untouched = configured.videoEncoder === CPU_ENCODER.videoEncoder
    && configured.encoderArgs.join(' ') === CPU_ENCODER.encoderArgs.join(' ')
    && configured.filmEncoderArgs.join(' ') === CPU_ENCODER.filmEncoderArgs.join(' ')
    && configured.decoderArgs.length === 0;
  if (untouched) return configured;

  // ต้องตรวจ **ทั้งสองชุด** — คิวแปลงวิดีโอใช้ encoderArgs ส่วนหนังใช้ filmEncoderArgs
  // ตรวจแค่ชุดเดียวแล้วผ่านคือช่องโหว่จริง: ตั้ง VIDEO_ENCODER_ARGS ถูกแต่ลืมแก้
  // FILM_ENCODER_ARGS ให้เข้าคู่กัน (เช่น libx264 ที่ยังค้าง `-cq 20` ของ nvenc อยู่)
  // จะผ่านการตรวจไปทั้งที่หนังจะล้มทุกคลิปด้วย "Unrecognized option 'cq'"
  for (const [label, args] of [['VIDEO_ENCODER_ARGS', configured.encoderArgs],
    ['FILM_ENCODER_ARGS', configured.filmEncoderArgs]]) {
    try {
      await canEncode(configured.videoEncoder, args);
    } catch (error) {
      const why = String(error.stderr || error.message).trim().split('\n').slice(-2).join(' ');
      console.error(
        `[media] ${configured.videoEncoder} + ${label} ใช้งานไม่ได้ — ถอยไปใช้ ${CPU_ENCODER.videoEncoder} ทั้งชุด (${why})`,
      );
      // ถอยทั้งชุด ไม่ใช่เฉพาะชุดที่ล้ม — ตัวเข้ารหัสกับอาร์กิวเมนต์ต้องเข้าคู่กันเสมอ
      return CPU_ENCODER;
    }
  }

  return configured;
}

/** ผลการตรวจถูกจำไว้ ตรวจครั้งเดียวต่อการรันหนึ่งครั้งของโปรเซส */
export function activeEncoder() {
  if (!encoderPromise) encoderPromise = probeEncoder();
  return encoderPromise;
}

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

/**
 * Move a file, coping with the destination living on another mount.
 *
 * On the NAS each data directory is its own bind mount, so uploads/ and tmp/
 * are separate mount points even though they sit on the same volume — and
 * rename(2) refuses to cross a mount boundary with EXDEV. Copy and delete is
 * the only way across; it is slower, so it stays the fallback rather than the
 * default.
 */
export async function moveFile(from, to) {
  try {
    await fs.rename(from, to);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

export async function ensureDirs() {
  await Promise.all([
    fs.mkdir(config.paths.uploads, { recursive: true }),
    fs.mkdir(config.paths.derived, { recursive: true }),
    fs.mkdir(config.paths.tmp, { recursive: true }),
    fs.mkdir(config.paths.export, { recursive: true }),
    fs.mkdir(config.paths.films, { recursive: true }),
    fs.mkdir(config.paths.papers, { recursive: true }),
    fs.mkdir(config.paths.music, { recursive: true }),
  ]);

  await warnIfTmpIsOnAnotherDevice();
}

/**
 * ถ้า tmp กับ uploads อยู่คนละ mount point ทุกไฟล์ที่แขกอัพโหลดจะถูก copy
 * ทั้งก้อนแทนที่จะ rename เฉย ๆ — วิดีโอ 200 MB คือการอ่านและเขียนดิสก์เพิ่ม
 * อีก 400 MB ต่อคลิป โดยแขกยืนรออยู่
 *
 * ไม่ใช่ข้อผิดพลาดถึงขั้นหยุดทำงาน (moveFile รับมือได้) แต่ต้องบอกออกมาให้เห็น
 * ไม่งั้นจะไม่มีใครรู้ว่าช้าเพราะอะไร
 */
async function warnIfTmpIsOnAnotherDevice() {
  try {
    const [tmpStat, uploadsStat] = await Promise.all([
      fs.stat(config.paths.tmp),
      fs.stat(config.paths.uploads),
    ]);

    if (tmpStat.dev !== uploadsStat.dev) {
      console.warn(
        '[media] tmp และ uploads อยู่คนละ mount point — ทุกไฟล์จะถูก copy ทั้งก้อน\n' +
          '        แทนที่จะ rename ทำให้อัพโหลดช้าลงอย่างเห็นได้ชัด\n' +
          '        แก้ที่ docker-compose.yml: mount /volume1/wedding:/app/data ครั้งเดียว\n' +
          '        แทนการแยก uploads/derived/db/tmp เป็นสี่บรรทัด',
      );
    }
  } catch {
    // ตรวจไม่ได้ก็ไม่เป็นไร ไม่ควรทำให้แอปบูตไม่ขึ้นเพราะเรื่องนี้
  }
}

/**
 * สร้างสำเนาขนาดพอดีจอไว้ใช้กับสไลด์โชว์ แล้วเก็บไว้ใช้ซ้ำ
 *
 * รูปจากมือถือสมัยนี้ 12 ล้านพิกเซลขึ้นไป การส่งไฟล์เต็มไปให้กล่อง Google TV
 * ถอดรหัสทุกสไลด์คือสาเหตุที่จอกระตุกและบางครั้งขึ้นดำ (หน่วยความจำไม่พอ)
 * ย่อเหลือกว้างสุด 1920 ก่อน แล้วทีวีจะเบาลงหลายเท่าโดยตาคนดูไม่เห็นความต่าง
 *
 * ทำแบบ lazy ตอนมีคนขอครั้งแรก ไม่ทำตอนอัพโหลด เพราะตอนอัพโหลดแขกยืนรออยู่
 */
export async function ensureDisplayCopy(row) {
  if (row.kind !== 'image') return null;

  const displayName = `${path.parse(row.stored_name).name}-display.jpg`;
  const displayPath = path.join(config.paths.derived, displayName);

  try {
    await fs.access(displayPath);
    return displayName;
  } catch {
    // ยังไม่เคยสร้าง — สร้างเดี๋ยวนี้
  }

  // ถ้าเคยแปลง HEIC ไว้แล้ว ใช้ตัวที่แปลงแล้วเป็นต้นทาง sharp อ่าน HEIC ไม่ได้ทุกเครื่อง
  const source = row.playback_name
    ? path.join(config.paths.derived, row.playback_name)
    : path.join(config.paths.uploads, row.stored_name);

  // ชื่อชั่วคราวต้องไม่ซ้ำกันต่อคำขอ — จอสไลด์โชว์กับมือถือแขกอาจขอรูปเดียวกัน
  // วินาทีเดียวกัน ถ้าใช้ชื่อ .part เดียวกัน คนแรก rename สำเร็จแล้วไฟล์หาย
  // คนที่สอง rename เจอ ENOENT ทั้งที่งานสำเร็จดี
  const partial = `${displayPath}.${crypto.randomBytes(4).toString('hex')}.part.jpg`;
  try {
    await sharp(source, { failOn: 'none' })
      .rotate()
      .resize(config.media.displaySize, config.media.displaySize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 86, mozjpeg: true })
      .toFile(partial);

    // rename ทับกันเองได้อย่างปลอดภัย — เนื้อไฟล์เหมือนกันทุกสำเนาอยู่แล้ว
    await fs.rename(partial, displayPath);
  } finally {
    await fs.rm(partial, { force: true });
  }
  return displayName;
}

/**
 * Turn an uploaded image into { storedName, playbackName, thumbName, ... }.
 * HEIC from iPhones is converted to JPEG so non-Apple browsers can display it;
 * the original is always kept for the download-everything ZIP.
 */
export async function processImage(tmpPath, sniffed) {
  const storedName = randomName(sniffed.ext);
  const storedPath = path.join(config.paths.uploads, storedName);
  await moveFile(tmpPath, storedPath);

  // ถ้าประมวลผลล้มหลังย้ายไฟล์แล้ว ต้องเก็บกวาดเองก่อนโยน error ต่อ
  // เพราะตัว catch ข้างนอกรู้จักแต่ tmpPath ซึ่งย้ายไปแล้ว — ไม่งั้นทุกไฟล์เสีย
  // ที่แขกส่งมาจะค้างเป็นไฟล์กำพร้าใน uploads/ มองไม่เห็นและกินดิสก์ไปเรื่อย ๆ
  try {
    return await deriveImage(storedName, storedPath, sniffed);
  } catch (error) {
    await fs.rm(storedPath, { force: true });
    await fs.rm(path.join(config.paths.derived, `${path.parse(storedName).name}.jpg`), { force: true });
    await fs.rm(path.join(config.paths.derived, `${path.parse(storedName).name}-thumb.jpg`), { force: true });
    throw error;
  }
}

async function deriveImage(storedName, storedPath, sniffed) {
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
  const { stdout } = await mediaGate.run(() => run(FFPROBE, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], { maxBuffer: 4 * 1024 * 1024 }));

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
  await mediaGate.run(() => run(FFMPEG, [
    '-y',
    '-ss', seek,
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', `scale='min(${config.media.thumbnailSize},iw)':-2`,
    '-q:v', '4',
    outputPath,
  ], { maxBuffer: 4 * 1024 * 1024 }));
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
  await moveFile(tmpPath, storedPath);

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

/**
 * เลือกวิธีจัดการวิดีโอตามสิ่งที่อยู่ในไฟล์จริง ไม่ใช่ตามนามสกุล
 *
 * iPhone ส่ง .mov มาเสมอ แต่ข้างในเป็น H.264 หรือ HEVC ก็ได้ ขึ้นกับการตั้งค่า
 * ของเครื่องแขก ถ้าเป็น H.264 อยู่แล้ว เบราว์เซอร์เล่นได้หมด สิ่งที่ต้องทำมีแค่
 * เปลี่ยนกล่องจาก .mov เป็น .mp4 ซึ่ง ffmpeg ทำได้ด้วยการ "คัดลอกสตรีม" ตรง ๆ
 * — ใช้เวลาไม่กี่วินาที ไม่เสียคุณภาพ และไม่กิน CPU
 *
 * ของเดิมบีบอัดใหม่ทุกไฟล์ที่ไม่ใช่ .mp4 รวมถึงพวกที่เป็น H.264 อยู่แล้ว
 * เท่ากับเผา CPU ของ NAS ทิ้งเพื่อให้ได้ภาพที่แย่ลงกว่าเดิม
 */
function encodePlan(probed, encoder) {
  const videoCopy = probed.codec === 'h264';
  // aac คือของที่เบราว์เซอร์ทุกตัวเล่นได้ ส่วน .mov จากกล้องบางรุ่นเป็น pcm
  const audioCopy = !probed.audioCodec || probed.audioCodec === 'aac';

  return {
    remux: videoCopy && audioCopy,
    video: videoCopy
      ? ['-c:v', 'copy']
      : [
          '-c:v', encoder.videoEncoder,
          ...encoder.encoderArgs,
          '-pix_fmt', 'yuv420p',
          '-vf', "scale='min(1920,iw)':-2",
        ],
    audio: audioCopy ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '128k'],
  };
}

/** Run the actual transcode. Called by the background queue, never inline. */
export async function transcodeVideo(storedName) {
  const input = path.join(config.paths.uploads, storedName);
  const playbackName = `${path.parse(storedName).name}-web.mp4`;
  const output = path.join(config.paths.derived, playbackName);
  const partial = `${output}.part.mp4`;

  const encoder = await activeEncoder();
  const plan = encodePlan(await probeVideo(input), encoder);

  await run(FFMPEG, [
    '-y',
    ...encoder.decoderArgs,
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    ...plan.video,
    ...plan.audio,
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

/**
 * รูปที่เจ้าภาพอัพเองสำหรับหน้าแรก — ภาพปก การ์ดเชิญ รูปงาน
 *
 * ใช้ท่อเดียวกับรูปของแขกทั้งหมด (แปลง HEIC จาก iPhone ซึ่งเป็นกรณีที่จะเจอบ่อยที่สุด
 * กับการ์ดเชิญที่ถ่ายมา · หมุนภาพตาม EXIF · ทำรูปย่อ) แล้วเติมสำเนาขนาดพอดีหน้าเว็บ
 * ให้อีกหนึ่งใบ
 *
 * ต่างจากรูปแขกตรงที่ **สร้างสำเนาหน้าเว็บทันทีตอนอัพ ไม่ใช่ตอนมีคนขอครั้งแรก**
 * เพราะคนที่รออยู่คือเจ้าภาพคนเดียวที่กำลังจัดหน้า ไม่ใช่แขกพันคน — และแขกคนแรก
 * ที่เปิดเว็บในงานไม่ควรต้องเป็นคนจ่ายเวลาย่อรูปให้คนอื่น
 */
export async function processHostImage(tmpPath, sniffed) {
  const base = await processImage(tmpPath, sniffed);

  const displayName = `${path.parse(base.storedName).name}-host.jpg`;
  const source = base.playbackName
    ? path.join(config.paths.derived, base.playbackName)
    : path.join(config.paths.uploads, base.storedName);

  try {
    await sharp(source, { failOn: 'none' })
      .rotate()
      .resize(config.media.hostImageSize, config.media.hostImageSize, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, mozjpeg: true })
      .toFile(path.join(config.paths.derived, displayName));
  } catch (error) {
    await removeHostFiles({ stored_name: base.storedName, thumb_name: base.thumbName });
    throw error;
  }

  return {
    storedName: base.storedName,
    displayName,
    thumbName: base.thumbName,
    mime: base.mime,
    bytes: base.bytes,
    width: base.width,
    height: base.height,
  };
}

/** ลบไฟล์ทุกใบที่รูปเจ้าภาพหนึ่งแถวสร้างไว้ — ต้นฉบับ สำเนาหน้าเว็บ รูปย่อ และไฟล์แปลง HEIC */
export async function removeHostFiles(row) {
  const stem = path.parse(row.stored_name).name;
  const targets = [
    path.join(config.paths.uploads, row.stored_name),
    path.join(config.paths.derived, `${stem}.jpg`),
    path.join(config.paths.derived, `${stem}-thumb.jpg`),
    path.join(config.paths.derived, `${stem}-host.jpg`),
  ];
  await Promise.all(targets.map((target) => fs.rm(target, { force: true })));
}
