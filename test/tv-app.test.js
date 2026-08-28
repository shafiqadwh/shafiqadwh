/**
 * แอปสไลด์โชว์บน Google TV — เทสต์นี้รัน `SlideshowActivity.java` ตัวจริง
 *
 * ทำไมต้องคอมไพล์ Java จริงแทนที่จะ grep หาข้อความในซอร์ส: อาการที่เจ้าของเจอ
 * ("ต่อ 5G แล้วแอปใช้ไม่ได้") ไม่ได้อยู่ในบรรทัดไหนบรรทัดเดียว มันอยู่ใน
 * **ลำดับของเหตุการณ์** — WebView เรียก `onPageFinished` ให้หน้า error ของตัวเองด้วย
 * แล้วธงที่ตั้งจากตรงนั้นทำให้แอปเลิกสลับที่อยู่ตลอดกาล เทสต์แบบ grep จับไม่ได้เลย
 *
 * เครื่องที่รันเทสต์ไม่มี Android SDK จึงใช้คลาสปลอมใน `test/helpers/android-stub/`
 * แทนของ Android (ดู README ในโฟลเดอร์นั้น) — ตัวแอปเองไม่ถูกแก้แม้แต่ตัวอักษรเดียว
 *
 * ไม่มี `javac` ก็ข้ามไป **แต่ต้องบอกว่าข้าม** ไม่ใช่เงียบ ๆ แล้วนับว่าผ่าน
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubDir = path.join(root, 'test/helpers/android-stub');
const appDir = path.join(root, 'tv/app/src/main');
const activityPath = path.join(appDir, 'java/com/shafiqadwh/weddingslideshow/SlideshowActivity.java');
const stringsPath = path.join(appDir, 'res/values/strings.xml');

const hasJavac = spawnSync('javac', ['-version']).status === 0;

/** ชื่อ→ค่า ของ res/values/strings.xml เรียงตามลำดับที่ปรากฏในไฟล์ */
function readStrings() {
  const xml = fs.readFileSync(stringsPath, 'utf8');
  const found = [];
  const pattern = /<string name="([a-z_]+)">([\s\S]*?)<\/string>/g;
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    found.push([match[1], match[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')]);
  }
  return found;
}

/**
 * คอมไพล์แอปตัวจริงกับคลาสปลอม แล้วคืนฟังก์ชันที่รันสถานการณ์หนึ่งชุด
 *
 * `R.java` ถูกสร้างจาก strings.xml ตัวจริง — ถ้าโค้ดอ้างถึงสตริงที่ไม่มีอยู่
 * (เช่นลืมเพิ่มคำแปลใหม่) จะล้มตั้งแต่ตอนคอมไพล์ที่นี่ ไม่ต้องรอไปเจอบนทีวี
 */
function build() {
  const strings = readStrings();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-app-'));
  const src = path.join(work, 'src');
  const out = path.join(work, 'out');
  fs.cpSync(stubDir, src, { recursive: true });

  const pkgDir = path.join(src, 'com/shafiqadwh/weddingslideshow');
  fs.copyFileSync(activityPath, path.join(pkgDir, 'SlideshowActivity.java'));
  fs.writeFileSync(
    path.join(pkgDir, 'R.java'),
    'package com.shafiqadwh.weddingslideshow;\n'
      + 'public final class R { public static final class string {\n'
      + strings.map(([name], index) => `  public static final int ${name} = ${index};`).join('\n')
      + '\n} }\n',
  );

  const sources = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) sources.push(full);
    }
  };
  walk(src);

  execFileSync('javac', ['-nowarn', '-d', out, ...sources], { stdio: 'pipe' });

  return (scenario, rounds = 12) => {
    const stdout = execFileSync(
      'java',
      ['-cp', out, 'com.shafiqadwh.weddingslideshow.Driver', scenario, String(rounds),
        ...strings.map(([, value]) => value)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const lines = stdout.split('\n').filter(Boolean);
    return {
      lines,
      served: lines.filter((line) => line.startsWith('serve:')),
      loaded: lines.filter((line) => line.startsWith('load:')).map((line) => line.slice(5)),
    };
  };
}

const HTTPS = 'https://wedding.shafiq-lap.com/slideshow/menu?lite=1&tv=1';
const LAN = 'http://192.168.2.2:18090/slideshow/menu?lite=1&tv=1';

test('the TV app', { skip: hasJavac ? false : 'ไม่มี javac บนเครื่องนี้ — ข้ามเทสต์แอปทีวี' }, async (t) => {
  const run = build();

  await t.test('finds its way back to the public address after one hiccup on mobile data', () => {
    const result = run('fiveg');

    // ที่อยู่แรกล้มชั่วคราว → สลับไปไอพีในวง LAN ซึ่งบนเน็ตมือถือไม่มีทางถึง
    // ตัวตัดสินคือ **ต้องกลับมาลองโดเมนสาธารณะอีกครั้ง** ไม่ใช่ติดแหง็กอยู่กับ LAN
    assert.ok(
      result.served.includes(`serve:ok:${HTTPS}`),
      `แอปไม่เคยกลับมาลองโดเมนสาธารณะอีกเลย — ติดแหง็กอยู่กับที่อยู่สำรอง\n${result.lines.join('\n')}`,
    );

    // และเมื่อขึ้นได้แล้วต้องหยุดอยู่ตรงนั้น ไม่ใช่วนหาที่อยู่ต่อไปเรื่อย ๆ
    assert.equal(result.loaded.at(-1), HTTPS);
  });

  await t.test('does not run away from a working address over one blip', () => {
    const result = run('blip');

    // เน็ตสะดุดหนึ่งครั้งกลางงานต้องไม่พาแอปหนีไปไอพีในวง LAN
    // (ซึ่งถ้าทีวีต่อ 5G อยู่ = จอดับทั้งงาน) — ต้องลองที่อยู่เดิมซ้ำก่อน
    assert.deepEqual(
      result.served,
      [`serve:ok:${HTTPS}`, `serve:fail:${HTTPS}`, `serve:ok:${HTTPS}`],
      result.lines.join('\n'),
    );
    assert.ok(!result.loaded.includes(LAN), 'ไม่ควรแตะที่อยู่สำรองเลยเพราะโดเมนหลักยังใช้ได้');
  });

  await t.test('escapes an address the host saved by hand when the TV moves off the LAN', () => {
    const result = run('saved-lan');

    assert.equal(result.served[0], `serve:fail:${LAN}`, 'ต้องลองที่อยู่ที่ตั้งไว้เองก่อน');
    assert.ok(
      result.served.includes(`serve:ok:${HTTPS}`),
      `ที่อยู่ที่ตั้งไว้เองใช้ไม่ได้แล้ว ต้องไล่ต่อไปหาตัวถัดไป\n${result.lines.join('\n')}`,
    );
  });

  await t.test('refuses a bad certificate but keeps trying instead of hanging on a black screen', () => {
    const result = run('ssl', 4);

    // ไม่มี onReceivedSslError = WebView ยกเลิกการโหลดเงียบ ๆ โดยไม่เรียก onReceivedError
    // แอปจะค้างจอดำโดยไม่ลองใหม่และไม่บอกอะไรเลย
    assert.ok(result.lines.includes('ssl-cancelled:true'), 'ต้องปฏิเสธใบรับรองที่มีปัญหา');
    assert.ok(
      !result.lines.includes('ssl-proceeded:true'),
      'ห้าม proceed() ผ่านใบรับรองที่มีปัญหาเด็ดขาด — เปิดช่องให้คนกลางยัดอะไรลงจอกลางงานได้',
    );
    assert.ok(result.loaded.length > 1, 'ต้องลองใหม่ ไม่ใช่ค้างอยู่เฉย ๆ');
  });

  await t.test('treats a 502 from the proxy as a failure worth retrying', () => {
    const result = run('http-error');

    // คอนเทนเนอร์รีสตาร์ทแล้ว nginx ตอบ 502 — หน้าเว็บก็ไม่ขึ้นอยู่ดี
    // ถ้าไม่นับเป็นล้ม ทีวีจะค้างอยู่กับหน้า error ของ nginx ทั้งงาน
    assert.ok(
      result.served.includes(`serve:ok:${HTTPS}`),
      `ตอบ 502 แล้วต้องลองใหม่จนขึ้นได้\n${result.lines.join('\n')}`,
    );
  });

  await t.test('never bypasses certificate checks anywhere in the source', () => {
    // กันคนแก้ทีหลัง (หรือคำแนะนำจากอินเทอร์เน็ต) เปลี่ยน cancel() เป็น proceed()
    // เพื่อ "ให้มันขึ้นไว ๆ" ซึ่งเปลี่ยนจอกลางงานให้ใครก็ตามบนเส้นทางเน็ตยัดของได้
    // ตัดคอมเมนต์ออกก่อน — ในไฟล์มีคอมเมนต์อธิบายว่า "ห้ามเรียก proceed()"
    // ซึ่งต้องไม่ถูกนับว่าเป็นการเรียกจริง
    const source = fs.readFileSync(activityPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(!/\.proceed\s*\(/.test(source), 'ห้ามมี proceed() ในไฟล์นี้');
  });
});
