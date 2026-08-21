import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'diagnose-nas.sh');
const HOST = 'fake-wedding.test';

/**
 * เทสต์ชุดนี้เกิดจากของจริง: 21 ส.ค. เปิด /admin แล้วได้หน้า
 * "Sorry, the page you are looking for is not found." ของ Synology
 *
 * ตอนนั้น `diagnose-nas.sh` ตอบได้แค่ "HTTP 404 — ไม่ใช่ค่าที่คาดไว้" เพราะมันดูเนื้อหา
 * เฉพาะตอนได้ 200 เท่านั้น ทั้งที่เนื้อหาคือสิ่งเดียวที่บอกได้ว่า **ใครเป็นคนตอบ**
 * ระหว่างแอปกับ nginx ของ DSM — และคำตอบนั้นชี้ไปคนละทางแก้กันคนละเรื่อง
 *
 * ทุกข้อในไฟล์นี้จึงยิงเซิร์ฟเวอร์จริงหรือป้อนดัมป์คอนฟิกจริง ไม่ใช่แค่ grep หาข้อความในสคริปต์
 */

const DSM_PAGE = `<html><head><title>Synology</title></head><body>
<h1>Sorry, the page you are looking for is not found.</h1>
<p>&copy; 2024 Synology Inc.</p></body></html>`;

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnose-'));
const BIN = path.join(WORK, 'bin');
fs.mkdirSync(BIN);

// nginx ปลอมที่พิมพ์ดัมป์ตามไฟล์ที่ MOCK_NGINX_DUMP ชี้ · MOCK_NGINX_FAIL=1 คือสั่งให้ล้ม
fs.writeFileSync(path.join(BIN, 'nginx'), `#!/bin/sh
if [ "\${MOCK_NGINX_FAIL:-0}" = "1" ]; then
  echo "nginx: [emerg] cannot load configuration" >&2
  exit 1
fi
case "\${1:-}" in
  -T) cat "\${MOCK_NGINX_DUMP:-/dev/null}"; exit 0 ;;
esac
exit 0
`);
fs.chmodSync(path.join(BIN, 'nginx'), 0o755);

function dumpFile(name, body) {
  const file = path.join(WORK, name);
  fs.writeFileSync(file, body);
  return file;
}

const RULE_PRESENT = dumpFile('present.conf', `
http {
    server {
        listen 443 ssl;
        server_name other.shafiq-lap.com;
        location / { proxy_pass http://127.0.0.1:9999; }
    }
    server {
        listen 18443 ssl;
        server_name ${HOST};
        location / {
            proxy_pass http://127.0.0.1:18090;
        }
    }
}
`);

const RULE_MISSING = dumpFile('missing.conf', `
http {
    server {
        listen 443 ssl;
        server_name other.shafiq-lap.com;
        location / { proxy_pass http://127.0.0.1:9999; }
    }
}
`);

const RULE_WILDCARD = dumpFile('wildcard.conf', `
http {
    server {
        listen 443 ssl;
        server_name *.shafiq-lap.com;
        location / { proxy_pass http://localhost:18090; }
    }
}
`);

/** ใบรับรองที่ curl เชื่อได้จริง — ถ้าเครื่องไม่มี openssl จะคืน null แล้วข้ามข้อที่ต้องใช้ TLS */
function makeCertificate() {
  const ca = path.join(WORK, 'ca.pem');
  const caKey = path.join(WORK, 'ca.key');
  const key = path.join(WORK, 'srv.key');
  const cert = path.join(WORK, 'srv.pem');
  const csr = path.join(WORK, 'srv.csr');
  const ext = path.join(WORK, 'san.cnf');
  fs.writeFileSync(ext, `subjectAltName=DNS:${HOST}\n`);

  const openssl = (args) => {
    const { status } = spawnSync('openssl', args, { stdio: 'ignore' });
    if (status !== 0) throw new Error('openssl failed');
  };

  try {
    openssl(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca,
      '-days', '2', '-subj', '/CN=Diagnose Test CA']);
    openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr,
      '-subj', `/CN=${HOST}`]);
    openssl(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
      '-out', cert, '-days', '2', '-extfile', ext]);
  } catch {
    return null;
  }
  return { ca, key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

const TLS = makeCertificate();

/** ยกเซิร์ฟเวอร์ TLS ที่ตอบตามที่สั่ง แล้วคืนพอร์ตที่ระบบแจกให้ */
function serveTls(reply) {
  return new Promise((resolve) => {
    const server = https.createServer({ key: TLS.key, cert: TLS.cert }, (req, res) => reply(req, res));
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function diagnose({ dump, fail = false, publicPort = 1, ca = null, host = HOST }) {
  const env = {
    ...process.env,
    PATH: `${BIN}:${process.env.PATH}`,
    MOCK_NGINX_DUMP: dump || '/dev/null',
    MOCK_NGINX_FAIL: fail ? '1' : '0',
    no_proxy: '*',
  };
  if (ca) env.CURL_CA_BUNDLE = ca;

  // สคริปต์ออกด้วยรหัส 0 เสมอ (มันรายงาน ไม่ใช่ตัดสิน) แต่ดักไว้เผื่อวันหนึ่งเปลี่ยน
  const { stdout } = await run('sh', [SCRIPT,
    '--host', host,
    '--ip', '127.0.0.1',
    '--public-port', String(publicPort),
    '--port', '18090',
  ], { env, cwd: ROOT, timeout: 60000 });
  return stdout;
}

/* ---------- ข้อ 6.5 · มีกฎ reverse proxy อยู่จริงไหม ---------- */

test('the reverse proxy rule for this host is found and printed', async () => {
  const out = await diagnose({ dump: RULE_PRESENT });
  assert.match(out, /เจอกฎที่ตรงกับชื่อนี้/);
  assert.match(out, /proxy_pass http:\/\/127\.0\.0\.1:18090/);
  assert.match(out, /ปลายทางชี้ไปพอร์ต 18090/);
  // บล็อกของโฮสต์อื่นต้องไม่ถูกลากมาด้วย ไม่งั้นคนอ่านจะไล่แก้ผิดตัว
  assert.ok(!out.includes('other.shafiq-lap.com'), 'ดึงบล็อกของโฮสต์อื่นมาด้วย');
  assert.ok(!out.includes(':9999'), 'ดึง proxy_pass ของโฮสต์อื่นมาด้วย');
});

test('a missing rule is named as the reason the DSM page shows up', async () => {
  const out = await diagnose({ dump: RULE_MISSING });
  assert.match(out, /ไม่มีกฎ reverse proxy สำหรับ fake-wedding\.test/);
  // ต้องบอกทางแก้ให้ครบพอที่จะทำตามได้โดยไม่ต้องเปิดเอกสารอีกจอ
  assert.match(out, /Login Portal/);
  assert.match(out, /127\.0\.0\.1 · 18090/);
});

test('a wildcard server_name still counts as a rule', async () => {
  // *.shafiq-lap.com ครอบ wedding.shafiq-lap.com อยู่แล้ว — รายงานว่า "ไม่มีกฎ" จะส่งคน
  // ไปสร้างกฎซ้ำกับของที่ nginx เสิร์ฟอยู่จริง
  const out = await diagnose({ dump: RULE_WILDCARD, host: 'wedding.shafiq-lap.com' });
  assert.match(out, /เจอกฎที่ตรงกับชื่อนี้/);
  assert.ok(!out.includes('ไม่มีกฎ reverse proxy'), 'wildcard ถูกนับว่าไม่มีกฎ');
});

test('a destination of localhost is called out as the ::1 trap', async () => {
  const out = await diagnose({ dump: RULE_WILDCARD, host: 'wedding.shafiq-lap.com' });
  assert.match(out, /localhost/);
  assert.match(out, /::1/);
  assert.match(out, /502/);
});

test('a failing nginx -T is reported as unknown, never as a pass', async () => {
  const out = await diagnose({ dump: RULE_PRESENT, fail: true });
  // ตัดด้วยเครื่องหมาย ▸ ไม่ใช่ '7.' เปล่า ๆ — '127.0.0.1' ก็มี '7.' อยู่ข้างใน
  const section = out.slice(out.indexOf('▸ 6.5'), out.indexOf('▸ 7.'));
  assert.match(section, /ยังสรุปข้อนี้ไม่ได้/);
  assert.ok(!section.includes('✓'), 'ตรวจไม่ได้ แต่ขึ้น ✓');
});

/* ---------- ข้อ 8 · ใครเป็นคนตอบ ---------- */

test('the Synology page is named instead of being reported as an odd status code', async (t) => {
  if (!TLS) return t.skip('เครื่องนี้ไม่มี openssl');

  const { server, port } = await serveTls((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(DSM_PAGE);
  });

  try {
    const out = await diagnose({ dump: RULE_MISSING, publicPort: port, ca: TLS.ca });
    // นี่คืออาการที่เจ้าของเจอจริง — ต้องอ่านแล้วรู้เลยว่าไม่ใช่แอปพัง
    assert.match(out, /หน้าเริ่มต้นของ DSM/);
    assert.match(out, /nginx ตอบเอง ไม่ได้ส่งต่อไปหาแอป/);
    assert.match(out, /✗ https → หน้าเริ่มต้นของ DSM/);
  } finally {
    server.close();
  }
});

test('a real app answer is recognised through the same path', async (t) => {
  if (!TLS) return t.skip('เครื่องนี้ไม่มี openssl');

  const { server, port } = await serveTls((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });

  try {
    const out = await diagnose({ dump: RULE_PRESENT, publicPort: port, ca: TLS.ca });
    assert.match(out, /✓ https → แอปจริงตอบ: \{"ok":true\}/);
    assert.ok(!out.includes('✗ https'), 'แอปตอบปกติแต่ยังขึ้น ✗');
  } finally {
    server.close();
  }
});

test('port 80 answering with the DSM page is a warning, not a failure', async (t) => {
  if (!TLS) return t.skip('เครื่องนี้ไม่มี openssl');

  // พอร์ต 80 เป็นของเว็บเริ่มต้นของ DSM ตามปกติ — ไม่ใช่ความผิดพลาดที่ต้องไล่แก้
  // แต่เป็นคำอธิบายว่าทำไมคนที่ไม่พิมพ์ https:// ถึงได้หน้านั้น
  const plain = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end(DSM_PAGE);
  });

  const bound = await new Promise((resolve) => {
    plain.once('error', () => resolve(false));
    plain.listen(80, '127.0.0.1', () => resolve(true));
  });
  if (!bound) return t.skip('ผูกพอร์ต 80 ไม่ได้ (ต้องเป็น root)');

  const { server, port } = await serveTls((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });

  try {
    const out = await diagnose({ dump: RULE_PRESENT, publicPort: port, ca: TLS.ca });
    assert.match(out, /⚠ http → หน้าเริ่มต้นของ DSM/);
    assert.match(out, /อันนี้ปกติ/);
    // ✗ คือของที่ต้องไปแก้ ⚠ คือของที่ต้องรู้ — ปนกันเมื่อไหร่คนอ่านจะไล่แก้ของที่ไม่ได้พัง
    assert.ok(!out.includes('✗ http →'), 'พอร์ต 80 ปกติ แต่ถูกนับเป็นข้อผิดพลาด');
  } finally {
    server.close();
    plain.close();
  }
});

/* ---------- สัญญาที่เอกสารอ้างถึง ---------- */

test('the step numbers the docs point at are still there', async () => {
  const out = await diagnose({ dump: RULE_PRESENT });
  // docs/06-checklist.md:109 กับ docs/07-shafiq-nas.md:231,443,458 อ้าง "ข้อ 4-6" และ "ข้อ 9"
  // เลขข้อจึงเป็นสัญญาที่แก้ทิ้งไม่ได้โดยไม่แก้เอกสารพร้อมกัน
  for (const heading of ['4.', '5.', '6.', '6.5', '7.', '8.', '9.']) {
    assert.ok(out.includes(`▸ ${heading}`), `หายไปแล้ว: ข้อ ${heading}`);
  }
});

test('the script really is read-only', async () => {
  const before = await run('git', ['status', '--porcelain'], { cwd: ROOT });
  await diagnose({ dump: RULE_PRESENT });
  const after = await run('git', ['status', '--porcelain'], { cwd: ROOT });
  assert.equal(after.stdout, before.stdout, 'สคริปต์ที่โฆษณาว่าอ่านอย่างเดียวไปแก้ไฟล์');
});

test.after(() => fs.rmSync(WORK, { recursive: true, force: true }));
