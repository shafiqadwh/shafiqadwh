import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { FFMPEG, probeVideo } from './media.js';
import { FRAME_WIDTH, FRAME_HEIGHT } from './film.js';

const run = promisify(execFile);

/**
 * เข้ารหัสหนังงานแต่งทีละคลิป แล้วค่อยต่อกันตอนท้าย
 *
 * ทำไมไม่ยัด filter_complex ก้อนเดียวที่มีอินพุต 800 ไฟล์: ffmpeg จะเปิดไฟล์
 * ทั้งหมดค้างไว้พร้อมกันและกินแรมจนล้มบน NAS แถมถ้าพังกลางทางต้องเริ่มใหม่หมด
 *
 * ทำทีละคลิปแล้วต่อด้วย concat demuxer แบบ -c copy แทน — ไม่เข้ารหัสซ้ำ ไม่เสีย
 * คุณภาพ ใช้แรมเท่าเดิมไม่ว่าหนังจะยาวแค่ไหน และรันซ้ำได้โดยข้ามคลิปที่ทำเสร็จแล้ว
 *
 * ข้อแลกเปลี่ยนคือทุกคลิปต้องมีพารามิเตอร์ "เหมือนกันเป๊ะ" ไม่งั้น concat แบบ copy
 * จะได้ไฟล์ที่เล่นแล้วภาพค้างหรือเสียงหลุด ค่าทั้งหมดจึงรวมไว้ที่เดียวข้างล่างนี้
 */

const FPS = 30;
const VIDEO_ARGS = [
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '20',
  '-profile:v', 'high',
  '-level', '4.1',
  '-pix_fmt', 'yuv420p',
  '-r', String(FPS),
];
const AUDIO_ARGS = ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2'];
const SILENCE = ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000'];

const FADE = 0.45;
const BACKDROP = '#14100c';

async function ffmpeg(args) {
  return run(FFMPEG, args, { maxBuffer: 8 * 1024 * 1024, timeout: 1000 * 60 * 30 });
}

/**
 * เขียนลงชื่อชั่วคราวก่อนแล้วค่อยเปลี่ยนชื่อ
 *
 * ถ้าเครื่องดับหรือคนกด Ctrl-C กลางคลิป ไฟล์ครึ่ง ๆ กลาง ๆ จะไม่ถูกนับว่า "ทำเสร็จ
 * แล้ว" ในการรันรอบถัดไป — กฎ idempotency ของโปรเจกต์นี้คือรันซ้ำต้องปลอดภัยเสมอ
 */
async function atomically(outPath, work) {
  const partial = `${outPath}.part.mp4`;
  await fs.rm(partial, { force: true });
  await work(partial);
  await fs.rename(partial, outPath);
}

/** คลิปนี้ทำไว้แล้วและใช้ได้ไหม — ใช้ตอนรันซ้ำเพื่อข้ามงานที่เสร็จแล้ว */
export async function alreadyDone(outPath) {
  try {
    const stat = await fs.stat(outPath);
    return stat.size > 1024;
  } catch {
    return false;
  }
}

function fades(seconds) {
  const out = Math.max(seconds - FADE, 0).toFixed(2);
  return `fade=t=in:st=0:d=${FADE},fade=t=out:st=${out}:d=${FADE}`;
}

/**
 * ภาพนิ่งหนึ่งใบ → คลิปหนึ่งคลิป
 *
 * motion = ซูมช้า ๆ แบบ Ken Burns ปิดไว้เป็นค่าเริ่มต้น เพราะ zoompan ขยายภาพ
 * จากเฟรม 1920 ที่มีอยู่ ทำให้ภาพนุ่มลงนิดหน่อย และกิน CPU เพิ่มทั้งเรื่อง
 * ภาพนิ่งที่คมชัดกับการเฟดเข้าออกก็ดูดีอยู่แล้วสำหรับหนังที่มีรูปหลายร้อยใบ
 */
export async function stillClip(framePath, outPath, { seconds = 6, motion = false } = {}) {
  const frames = Math.round(seconds * FPS);
  const filters = motion
    ? [
        `scale=${FRAME_WIDTH * 2}:-1`,
        `zoompan=z='min(zoom+0.00035,1.07)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${FRAME_WIDTH}x${FRAME_HEIGHT}:fps=${FPS}`,
        fades(seconds),
      ]
    : [fades(seconds)];

  await atomically(outPath, (partial) => ffmpeg([
    '-y',
    '-loop', '1', '-i', framePath,
    ...SILENCE,
    '-t', String(seconds),
    '-vf', filters.join(','),
    ...VIDEO_ARGS,
    ...AUDIO_ARGS,
    '-shortest',
    partial,
  ]));
}

/**
 * วิดีโอของแขก → คลิปที่มีหน้าตาเข้าชุดกับเฟรมรูป
 *
 * วิดีโอแนวตั้งจากมือถือไม่ได้เอาแถบดำมาขนาบสองข้าง แต่ใช้ตัวมันเองเบลอเป็นพื้นหลัง
 * เหมือนที่เฟรมรูปทำ — ใช้ boxblur ไม่ใช่ gblur เพราะต้องเบลอทุกเฟรมตลอดคลิป
 * gblur บนภาพ 1080p กิน CPU จน NAS ทำงานทั้งเรื่องไม่ไหว
 *
 * เสียงเดิมของวิดีโอเก็บไว้ทั้งหมด ซึ่งเป็นสิ่งที่เจ้าของขอ — คลิปไหนไม่มีเสียง
 * ก็ต้องใส่เสียงเงียบให้ ไม่งั้นโครงสร้างคลิปไม่ตรงกันแล้ว concat แบบ copy จะเสียงหลุด
 */
export async function videoClip(sourcePath, outPath, { seconds = 30, captionPath = null } = {}) {
  const probed = await probeVideo(sourcePath);
  const limit = Math.min(probed.duration || seconds, seconds);
  const hasAudio = Boolean(probed.audioCodec);

  const chain = [
    `[0:v]scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=increase,`
      + `crop=${FRAME_WIDTH}:${FRAME_HEIGHT},boxblur=24:2,eq=brightness=-0.20:saturation=0.8[bg]`,
    `[0:v]scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease[fg]`,
    '[bg][fg]overlay=(W-w)/2:(H-h)/2[base]',
  ];

  let tail = '[base]';
  if (captionPath) {
    chain.push(`[base][2:v]overlay=0:0[capped]`);
    tail = '[capped]';
  }
  chain.push(`${tail}fps=${FPS},${fades(limit)},format=yuv420p[v]`);

  const inputs = ['-i', sourcePath];
  if (!hasAudio) inputs.push(...SILENCE);
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  if (captionPath) inputs.push('-i', captionPath);

  await atomically(outPath, (partial) => ffmpeg([
    '-y',
    ...inputs,
    '-t', String(limit.toFixed(2)),
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    ...VIDEO_ARGS,
    ...AUDIO_ARGS,
    '-threads', String(config.media.ffmpegThreads),
    partial,
  ]));

  return limit;
}

/**
 * วิดีโอของแขกในโหมดกำแพง — เล่นอยู่ "ในกรอบโพลารอยด์" ที่ถูกยกเป็นไฮไลท์
 *
 * เฟรมกำแพงถูกเจาะรูโปร่งใสไว้ตรงช่องรูปของใบไฮไลท์ วิดีโอถูกวางไว้ข้างหลัง
 * แล้วเอาเฟรมทับลงไป ภาพจึงทะลุขึ้นมาเฉพาะในกรอบ ส่วนกองรูปรอบ ๆ ยังนิ่งอยู่
 *
 * ทำแบบนี้แทนการเล่นวิดีโอเต็มจอ เพราะเจ้าของเลือกโหมดกำแพงไว้ หนังทั้งเรื่อง
 * จึงควรหน้าตาเป็นชุดเดียวกัน และเสียงของวิดีโอยังอยู่ครบเหมือนเดิม
 */
export async function wallVideoClip(sourcePath, outPath, { framePath, window, seconds = 30 } = {}) {
  const probed = await probeVideo(sourcePath);
  const limit = Math.min(probed.duration || seconds, seconds);
  const hasAudio = Boolean(probed.audioCodec);

  const chain = [
    `color=c=${BACKDROP}:s=${FRAME_WIDTH}x${FRAME_HEIGHT}:d=${limit.toFixed(2)}[bg]`,
    `[0:v]scale=${window.width}:${window.height}:force_original_aspect_ratio=increase,`
      + `crop=${window.width}:${window.height}[clip]`,
    `[bg][clip]overlay=${window.left}:${window.top}[under]`,
    // เฟรมกำแพงเป็นอินพุตที่ 2 เสมอ เพราะทั้งสองกรณีใส่อินพุตเสียงไว้หนึ่งตัวเท่ากัน
    // (มีเสียงอยู่แล้วก็ยังใส่ anullsrc ไว้ ให้ลำดับอินพุตคงที่ ไม่ต้องมานั่งนับใหม่)
    `[under][2:v]overlay=0:0,fps=${FPS},${fades(limit)},format=yuv420p[v]`,
  ];

  const inputs = ['-i', sourcePath];
  if (!hasAudio) inputs.push(...SILENCE);
  else inputs.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  inputs.push('-i', framePath);

  await atomically(outPath, (partial) => ffmpeg([
    '-y',
    ...inputs,
    '-t', String(limit.toFixed(2)),
    '-filter_complex', chain.join(';'),
    '-map', '[v]',
    '-map', hasAudio ? '0:a:0' : '1:a:0',
    ...VIDEO_ARGS,
    ...AUDIO_ARGS,
    '-threads', String(config.media.ffmpegThreads),
    partial,
  ]));

  return limit;
}

/** ต่อคลิปทั้งหมดเข้าด้วยกันโดยไม่เข้ารหัสซ้ำ */
export async function concatClips(clipPaths, outPath, workDir) {
  const listPath = path.join(workDir, 'parts.txt');
  // concat demuxer ตีความเครื่องหมาย ' ในชื่อไฟล์เป็นตัวปิดสตริง ต้อง escape
  const list = clipPaths.map((clip) => `file '${clip.replace(/'/g, "'\\''")}'`).join('\n');
  await fs.writeFile(listPath, `${list}\n`);

  await atomically(outPath, (partial) => ffmpeg([
    '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c', 'copy',
    '-movflags', '+faststart',
    partial,
  ]));
}

/**
 * ผสมเพลงคลอเข้าไปใต้เสียงเดิม โดยไม่แตะภาพเลย (-c:v copy)
 *
 * เพลงสั้นกว่าหนังเป็นเรื่องปกติ จึงวนซ้ำด้วย -stream_loop -1 แล้วตัดตามความยาวหนัง
 *
 * ระดับเสียงเป็นเรื่องที่วัดแล้วต้องแก้: ตอนแรกใช้ amix เฉย ๆ กับเพลงที่หรี่ไว้ 0.22
 * ผลที่วัดได้คือช่วงภาพนิ่ง (ซึ่งคือเกือบทั้งเรื่อง) เพลงลงไปอยู่ที่ -43 dB คือแทบ
 * ไม่ได้ยิน เพราะ amix หารระดับเสียงด้วยจำนวนอินพุตอีกชั้นหนึ่ง
 *
 * ตอนนี้ปิดการหารนั้น (normalize=0) แล้วให้เพลงดังพอฟังได้จริง ส่วนตอนที่วิดีโอ
 * ของแขกมีเสียงคนพูด เพลงจะหลบลงเองด้วย sidechaincompress โดยใช้เสียงในหนัง
 * เป็นตัวสั่ง — ได้ทั้งเพลงที่ได้ยินและเสียงงานที่ไม่ถูกกลบ
 */
export async function mixMusic(filmPath, musicPath, outPath, { volume = 0.6 } = {}) {
  await atomically(outPath, (partial) => ffmpeg([
    '-y',
    '-i', filmPath,
    '-stream_loop', '-1', '-i', musicPath,
    '-filter_complex',
    // เสียงเดิมของหนังถูกแยกเป็นสองทาง ทางหนึ่งไปออกจริง อีกทางไปสั่งให้เพลงหลบ
    '[0:a]asplit=2[voice][key];'
      + `[1:a]aresample=48000,volume=${volume}[music];`
      + '[music][key]sidechaincompress=threshold=0.02:ratio=12:attack=25:release=500[ducked];'
      + '[voice][ducked]amix=inputs=2:normalize=0:duration=first,alimiter=limit=0.95[a]',
    '-map', '0:v', '-map', '[a]',
    '-c:v', 'copy',
    ...AUDIO_ARGS,
    '-b:a', '160k',
    '-movflags', '+faststart',
    partial,
  ]));
}

export { BACKDROP, FPS };
