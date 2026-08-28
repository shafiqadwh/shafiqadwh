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

  // บังคับ locale เป็น UTF-8 — เครื่องที่รันเทสต์ไม่ได้ตั้ง LANG ไว้ Java จึงอ่าน
  // อาร์กิวเมนต์และพิมพ์ออกเป็น ASCII ทำให้ข้อความไทยกลายเป็น ??? ทั้งหมด
  const utf8 = { ...process.env, LANG: 'C.utf8', LC_ALL: 'C.utf8' };

  execFileSync('javac', ['-nowarn', '-encoding', 'UTF-8', '-d', out, ...sources], { stdio: 'pipe', env: utf8 });

  return (scenario, rounds = 12) => {
    const stdout = execFileSync(
      'java',
      ['-Dfile.encoding=UTF-8', '-cp', out,
        'com.shafiqadwh.weddingslideshow.Driver', scenario, String(rounds),
        ...strings.map(([, value]) => value)],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: utf8 },
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

  await t.test('never leaves the WebView error page where a guest can see it', () => {
    const failing = run('fiveg');
    const working = run('blip');

    // ระหว่างลองใหม่ หน้าเว็บต้องถูกซ่อน เหลือแต่จอดำกับข้อความสถานะทับอยู่
    // และเมื่อขึ้นได้แล้วต้องกลับมาเห็นหน้าเว็บ
    assert.ok(working.lines.includes('web-visible:true'), 'โหลดขึ้นแล้วต้องเห็นหน้าเว็บ');

    // ⚠️ ห้ามซ่อนด้วยการสั่งโหลด about:blank ทับ — loadUrl ทุกครั้งเพิ่มรายการลง
    // ประวัติการเข้าชม ปุ่มย้อนกลับจะพาย้อนไปหน้าเปล่าทีละหน้าแทนที่จะกลับหน้าเมนู
    for (const result of [failing, working]) {
      assert.ok(
        !result.loaded.includes('about:blank'),
        `ห้ามโหลด about:blank เข้าประวัติ\n${result.lines.join('\n')}`,
      );
    }
  });

  await t.test('says which address failed, separately from the one it will try next', () => {
    const { lines } = run('keys', 4);
    const status = lines.find((line) => line.startsWith('status:')).slice('status:'.length);

    // ⚠️ บั๊กที่เจอจากสกรีนช็อตหน้างานจริง: บรรทัดสาเหตุถูกพิมพ์คู่กับที่อยู่ที่
    // **ยังไม่ได้ลอง** เพราะตอนนั้นเลื่อนไปที่อยู่ถัดไปแล้ว คนอ่านจอจึงสรุปผิดว่า
    // ที่อยู่นั้นคือตัวที่มีปัญหา — บรรทัดที่ทำไว้ช่วยหาสาเหตุกลับพาไปผิดทางเสียเอง
    const rows = status.split('|');
    const failed = rows.findIndex((row) => row === HTTPS || row === LAN);
    const reason = rows.findIndex((row) => row.includes('net::ERR_CONNECTION_TIMED_OUT'));
    const next = rows.findIndex((row) => row.startsWith('กำลังจะลอง: '));

    assert.ok(failed >= 0, `ต้องบอกที่อยู่ที่ล้มเป็นบรรทัดของตัวเอง\n${status}`);
    assert.ok(reason > failed, `สาเหตุต้องอยู่ใต้ที่อยู่ที่ล้ม\n${status}`);
    assert.ok(next > reason, `ที่อยู่ถัดไปต้องแยกบรรทัดและอยู่หลังสุด\n${status}`);

    // หัวใจของข้อนี้: สองที่อยู่นี้ต้องเป็นคนละตัวกัน ไม่งั้นก็กลับไปเป็นบั๊กเดิม
    assert.notEqual(
      rows[next].slice('กำลังจะลอง: '.length), rows[failed],
      `ที่อยู่ที่ล้มกับที่อยู่ที่จะลองต่อ ต้องไม่ใช่ตัวเดียวกัน\n${status}`,
    );
  });

  await t.test('opens settings with OK only while the status screen is up', () => {
    const stuck = run('keys', 6);
    const playing = run('keys-loaded');

    // รีโมต Google TV เกือบทุกรุ่นไม่มีปุ่ม MENU — ตอนต่อไม่ติดจึงต้องเปิดด้วยปุ่ม OK ได้
    assert.ok(stuck.lines.includes('web-visible:false'));
    assert.ok(stuck.lines.includes('dialog-after-ok:1'), 'ต่อไม่ติดแล้วกด OK ต้องเปิดหน้าตั้งค่า');

    // แต่ตอนสไลด์โชว์ทำงานปกติ OK ต้องเป็นของหน้าเว็บ (ใช้กดเลือกในหน้าเมนู)
    assert.ok(playing.lines.includes('web-visible:true'));
    assert.ok(playing.lines.includes('dialog-after-ok:0'), 'ห้ามแย่งปุ่ม OK จากหน้าเมนู');

    // ปุ่ม MENU ยังใช้ได้ทั้งสองสถานะเหมือนเดิม
    assert.ok(stuck.lines.includes('dialog-after-menu:1'));
    assert.ok(playing.lines.includes('dialog-after-menu:1'));
  });

  await t.test('adds https:// to an address typed without one', () => {
    const { lines } = run('normalise', 1);
    const map = Object.fromEntries(
      lines.filter((line) => line.startsWith('normalise:'))
        .map((line) => line.slice('normalise:'.length).split(' -> ')),
    );

    // พิมพ์ที่อยู่ด้วยรีโมตแล้วลืมใส่ https:// — WebView จะโหลดไม่ขึ้นเลย
    // และค่านั้นถูกบันทึกถาวร ทีวีเสียเที่ยวลองทุกรอบจนกว่าจะมีคนไปล้างข้อมูลแอป
    assert.equal(map['wedding.shafiq-lap.com/slideshow'], 'https://wedding.shafiq-lap.com/slideshow');
    assert.equal(map['  https://a.example/x  '], 'https://a.example/x', 'ต้องตัดช่องว่างหัวท้าย');
    assert.equal(map['http://192.168.2.2:18090/'], 'http://192.168.2.2:18090/', 'ห้ามแตะที่อยู่ที่ครบอยู่แล้ว');
    assert.equal(map['HTTPS://A.EXAMPLE/'], 'HTTPS://A.EXAMPLE/', 'ชื่อโปรโตคอลตัวพิมพ์ใหญ่ก็นับ');
    assert.equal(map['   '], 'null', 'ช่องว่างล้วน = ไม่ได้ตั้งค่า');
  });

  await t.test('does not waste a round on an address listed twice', () => {
    const { loaded, lines } = run('duplicate-saved', 6);

    // เจ้าภาพตั้งค่าเป็นที่อยู่เดียวกับค่าเริ่มต้นพอดี ถ้าไม่ตัดซ้ำ รายการจะเป็น
    // [โดเมน, โดเมน, LAN] แล้วทุกรอบวนหาที่อยู่จะเสียเที่ยวไปหนึ่งครั้งเสมอ
    assert.deepEqual(loaded.slice(0, 3), [HTTPS, LAN, HTTPS], lines.join('\n'));
  });

  await t.test('needs two quick back presses to quit, not one', () => {
    const { lines } = run('back-double-press');

    assert.ok(lines.includes('finished-after-one:false'), 'กดครั้งเดียวต้องไม่ออกจากแอป');
    assert.ok(lines.includes('finished-after-late-second:false'), 'กดห่างกันสิบวินาทีก็ยังไม่ออก');
    assert.ok(lines.includes('finished-after-quick-second:true'), 'กดซ้ำเร็ว ๆ ถึงจะออก');
  });

  await t.test('measures the back-press gap with a clock that cannot jump', () => {
    // ทีวีหลายรุ่นไม่มีนาฬิกาสำรอง เวลาโลกจึงกระโดดตอนซิงก์ NTP หลังบูตเสร็จ
    // ซึ่งเป็นจังหวะเดียวกับที่แอปนี้เพิ่งเปิดขึ้นมาพอดี ถ้าเวลากระโดด **ถอยหลัง**
    // ผลลบจะน้อยกว่า 2000 เสมอ แล้วกดย้อนกลับครั้งเดียวจะออกจากแอปทันทีกลางงาน
    // ข้อนี้ยืนยันจากซอร์สได้อย่างเดียว เพราะตัวรับประกันคือ Android ไม่ใช่โค้ดเรา
    const source = fs.readFileSync(activityPath, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    assert.ok(source.includes('SystemClock.elapsedRealtime()'), 'ต้องใช้นาฬิกาที่นับตั้งแต่บูต');
    assert.ok(!source.includes('System.currentTimeMillis()'), 'ห้ามใช้นาฬิกาโลกวัดช่วงเวลา');
  });

  await t.test('stops the page when the app leaves the screen', () => {
    // ไม่หยุด = เสียงจากคลิปที่แขกส่งมาดังต่อหลังกด Home ออกไปแล้ว
    // ทับสิ่งที่เจ้าของเปิดดูต่อ โดยไม่มีทางปิดนอกจากปิดแอปทิ้ง
    const source = fs.readFileSync(activityPath, 'utf8');
    assert.match(source, /protected void onPause\(\)[\s\S]{0,120}web\.onPause\(\)/);
    assert.match(source, /protected void onResume\(\)[\s\S]{0,120}web\.onResume\(\)/);
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
