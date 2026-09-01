import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';
import { themeStyle } from '../src/lib/theme.js';

/**
 * สีต่องานมาจาก .env ไม่ใช่จากการแก้ไฟล์ CSS
 *
 * สองข้อที่เทสต์ชุดนี้กันไว้
 * 1. **งานที่ไม่ตั้งสีต้องได้หน้าเดิมทุกไบต์** ไม่ใช่ "เหมือนเดิมเพราะบังเอิญ
 *    ค่าเริ่มต้นชุดใหม่ตรงกับของเก่า" — ถ้ามี <style> ว่างโผล่มา แปลว่ามีคนเผลอ
 *    ทำให้ทุกงานเริ่มเดินคนละเส้นทางกับที่ผ่านงานจริงมาแล้ว
 * 2. **ค่าจาก .env ถูกวางลงใน <style> ตรง ๆ** จึงเป็นช่องแทรกโค้ดถ้าไม่กรอง
 *    — กรองสองชั้น (config.js กับ theme.js) และเทสต์ที่ชั้นล่างสุด
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = useTempDataDir('theme');

let app;

before(async () => {
  app = await startTestServer();
});

after(async () => {
  await app?.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('no colours set means no style block at all', () => {
  assert.equal(themeStyle({}), '');
  assert.equal(themeStyle(), '', 'เทสต์รันโดยไม่ตั้ง THEME_* จึงต้องได้สตริงว่าง');
  assert.equal(themeStyle({ accent: '', accentDark: '', paper: '', blush: '' }), '');
});

test('each colour lands on the variable app.css actually reads', async () => {
  const css = await fs.readFile(path.join(root, 'public', 'css', 'app.css'), 'utf8');

  const cases = [
    ['accent', '--accent'],
    ['accentDark', '--accent-dark'],
    ['paper', '--paper'],
    ['blush', '--blush'],
  ];

  for (const [key, variable] of cases) {
    assert.equal(themeStyle({ [key]: '#123456' }), `:root { ${variable}: #123456; }`);
    // ตัวแปรที่ฉีดไปต้องมีคนใช้จริงในไฟล์ CSS ไม่งั้นตั้งสีแล้วหน้าไม่เปลี่ยน
    assert.ok(css.includes(`var(${variable})`), `ไม่มีใครใช้ ${variable} ใน app.css`);
  }

  assert.equal(
    themeStyle({ accent: '#0b5d3b', paper: '#fff' }),
    ':root { --accent: #0b5d3b; --paper: #fff; }',
  );
});

test('anything that is not a plain hex colour is dropped, not escaped', () => {
  // ค่าเหล่านี้มาจากไฟล์ .env ที่คนพิมพ์เอง · ทิ้งทั้งค่าปลอดภัยกว่าพยายาม escape
  for (const junk of [
    'red',
    'rgb(1,2,3)',
    '#12345',
    '#fff; } body { display: none',
    '#fff</style><script>alert(1)</script>',
    'var(--ink)',
    '#ggg',
    123,
    null,
  ]) {
    assert.equal(themeStyle({ accent: junk }), '', `รับค่าที่ไม่ควรรับ: ${junk}`);
  }

  // ค่าดีปนค่าเสีย — ต้องเหลือเฉพาะตัวที่ดี ไม่ใช่ทิ้งทั้งชุดหรือรับทั้งชุด
  assert.equal(themeStyle({ accent: '#0b5d3b', paper: 'chartreuse' }), ':root { --accent: #0b5d3b; }');
});

test('a page with no theme carries no extra byte in its head', async () => {
  const html = await (await fetch(`${app.baseUrl}/`)).text();

  // ไม่ได้เช็คแค่ว่า "ไม่มีคำว่า themeStyle" แต่เช็คว่าสองบรรทัดที่เคยติดกัน
  // ยังติดกันอยู่เป๊ะ — ถ้ามีบรรทัดว่างแทรก แปลว่า EJS ไม่ได้ตัดช่องว่างให้จริง
  assert.match(html, /app\.css\?v=[a-f0-9]+">\n {2}<link rel="icon"/);
  assert.ok(!html.includes('<style>'), 'หน้าที่ไม่ตั้งสีต้องไม่มี <style> เลย');
});

test('colours from the environment reach the page the guests open', () => {
  // config อ่าน .env ครั้งเดียวตอนโหลดโมดูล เปลี่ยนกลางคันไม่ได้ — ต้องยกโปรเซส
  // ใหม่ทั้งตัวถึงจะพิสูจน์ได้ว่าเส้นทางจาก .env ถึงหน้าเว็บต่อกันจริง
  const script = `
    const { createApp } = await import('${path.join(root, 'src', 'server.js')}');
    const { ensureDirs } = await import('${path.join(root, 'src', 'lib', 'media.js')}');
    await ensureDirs();
    const server = createApp().listen(0);
    await new Promise((done) => server.once('listening', done));
    const url = 'http://127.0.0.1:' + server.address().port;

    // การ์ด QR อยู่หลังล็อกอิน · ไม่ล็อกอินจะได้หน้าล็อกอินซึ่งใช้ head.ejs
    // แล้วเทสต์จะผ่านทั้งที่ไม่เคยแตะ qr-card.ejs เลย
    const auth = await fetch(url + '/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: 'test-password' }),
      redirect: 'manual',
    });
    const cookie = auth.headers.getSetCookie()
      .find((value) => value.startsWith('admin_session=')).split(';')[0];

    for (const page of ['/', '/slideshow', '/admin/qr']) {
      const response = await fetch(url + page, { headers: { cookie }, redirect: 'manual' });
      if (response.status !== 200) throw new Error(page + ' ตอบ ' + response.status);
      const html = await response.text();
      const found = html.match(/<style>:root \\{[^<]*<\\/style>/);
      console.log(page + ' ' + (found ? found[0] : 'NONE'));
    }
    server.close();
  `;

  const workDir = path.join(os.tmpdir(), `wedding-theme-child-${process.pid}`);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DATA_DIR: workDir,
      ADMIN_PASSWORD: 'test-password',
      NODE_ENV: 'test',
      THEME_ACCENT: '#0b5d3b',
      THEME_ACCENT_DARK: '#073f28',
      // ตัวนี้ผิดรูปแบบ ต้องถูกทิ้งไปโดยที่อีกสามตัวยังทำงาน
      THEME_PAPER: 'ivory',
      THEME_BLUSH: '#e8f3ec',
    },
  });

  const lines = output.trim().split('\n');
  assert.equal(lines.length, 3, `คาดว่าได้สามหน้า ได้: ${output}`);

  for (const line of lines) {
    const [page, ...rest] = line.split(' ');
    const style = rest.join(' ');
    assert.equal(
      style,
      '<style>:root { --accent: #0b5d3b; --accent-dark: #073f28; --blush: #e8f3ec; }</style>',
      `${page} ไม่ได้รับสีของงานมาถูกต้อง`,
    );
    assert.ok(!style.includes('ivory'), `${page} รับค่าสีที่ผิดรูปแบบเข้ามาด้วย`);
  }

  fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
});
