import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'cloudflare-ddns.sh');
const TOKEN = 'test-token-do-not-use-anywhere';
const HOST = 'wedding.shafiq-lap.com';

// เซิร์ฟเวอร์จำลองของ Cloudflare — จำทุกคำขอไว้ จะได้ยืนยันได้ว่า
// "ไม่ได้แก้อะไร" หมายถึงไม่ได้ยิง PATCH จริง ๆ ไม่ใช่แค่ข้อความบนจอ
function mockCloudflare({ record }) {
  const calls = [];
  const state = { record: record ? { ...record } : null };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      calls.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        auth: req.headers.authorization || '',
        body,
      });

      const send = (payload) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const wrap = (result) => ({ result, success: true, errors: [], messages: [] });

      if (url.pathname === '/user/tokens/verify') {
        if (req.headers.authorization === `Bearer ${TOKEN}`) return send(wrap({ status: 'active' }));
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: false, errors: [{ code: 6111, message: 'Invalid format for Authorization header' }] }));
      }
      if (url.pathname === '/zones') {
        const name = url.searchParams.get('name');
        return send(wrap(name === 'shafiq-lap.com'
          ? [{ id: 'ZONE123', name: 'shafiq-lap.com' }]
          : []));
      }
      if (url.pathname === '/zones/ZONE123/dns_records' && req.method === 'GET') {
        return send(wrap(state.record ? [state.record] : []));
      }
      if (url.pathname === '/zones/ZONE123/dns_records' && req.method === 'POST') {
        const wanted = JSON.parse(body);
        state.record = { id: 'REC-NEW', zone_id: 'ZONE123', type: 'A', name: HOST, ...wanted };
        return send(wrap(state.record));
      }
      if (url.pathname.startsWith('/zones/ZONE123/dns_records/')) {
        if (req.method === 'PATCH') {
          Object.assign(state.record, JSON.parse(body));
          return send(wrap(state.record));
        }
        return send(wrap(state.record));
      }
      res.writeHead(404).end('{}');
    });
  });

  return { server, calls, state };
}

async function withMock(options, run) {
  const mock = mockCloudflare(options);
  await new Promise((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${mock.server.address().port}`;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddns-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'cloudflare-ddns.sh'));
  fs.writeFileSync(path.join(dir, '.env'),
    `BASE_URL=https://${HOST}\nCLOUDFLARE_API_TOKEN=${TOKEN}\nADMIN_PASSWORD=keepme\n`);

  // ต้องเรียกแบบไม่บล็อก — execFileSync จะแช่ event loop ไว้
  // แล้วเซิร์ฟเวอร์จำลองจะไม่มีโอกาสตอบ กลายเป็นค้างกันทั้งคู่
  const call = (args, stdin) => new Promise((resolve) => {
    const child = execFile('sh', [path.join(dir, 'scripts', 'cloudflare-ddns.sh'), ...args], {
      env: {
        ...process.env,
        CLOUDFLARE_API: api,
        // สภาพแวดล้อมของเทสต์มี proxy ขวางอยู่ ถ้าไม่ยกเว้น curl จะวิ่งออกไปหา proxy
        // แทนที่จะคุยกับเซิร์ฟเวอร์จำลองบนเครื่อง
        no_proxy: '127.0.0.1,localhost',
        NO_PROXY: '127.0.0.1,localhost',
      },
      encoding: 'utf8',
      timeout: 30000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
    child.stdin.end(stdin || '');
  });

  try {
    await run({ call, mock, dir });
  } finally {
    mock.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const RECORD = { id: 'REC1', zone_id: 'ZONE123', type: 'A', name: HOST, content: '49.49.211.220', ttl: 300, proxied: false };

test('leaves the record alone when it already points at the current IP', async () => {
  await withMock({ record: { ...RECORD, content: '203.0.113.7' } }, async ({ call, mock }) => {
    const run = await call(['--ip', '203.0.113.7']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /ไม่ต้องแก้/);
    assert.equal(mock.calls.filter((c) => c.method === 'PATCH').length, 0);
  });
});

test('rewrites a stale record and confirms by reading it back', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    const run = await call(['--ip', '203.0.113.7']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(mock.state.record.content, '203.0.113.7');
    assert.match(run.stdout, /49\.49\.211\.220 → 203\.0\.113\.7/);

    const patch = mock.calls.find((c) => c.method === 'PATCH');
    assert.ok(patch, 'ต้องมีคำขอ PATCH');
    // ส่งเฉพาะ content — proxied กับ comment ที่ตั้งไว้ต้องไม่ถูกล้างทิ้ง
    assert.deepEqual(JSON.parse(patch.body), { content: '203.0.113.7' });
    assert.equal(mock.state.record.proxied, false);
    // ยืนยันด้วยการอ่านกลับ ไม่ใช่เชื่อคำตอบของ PATCH
    assert.ok(mock.calls.some((c) => c.method === 'GET' && c.path === '/zones/ZONE123/dns_records/REC1'));
  });
});

test('rerunning right after an update changes nothing more', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    assert.equal((await call(['--ip', '203.0.113.7'])).code, 0);
    const first = mock.calls.filter((c) => c.method === 'PATCH').length;
    assert.equal((await call(['--ip', '203.0.113.7'])).code, 0);
    assert.equal(mock.calls.filter((c) => c.method === 'PATCH').length, first);
  });
});

test('--check reports a stale record but never writes', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    const run = await call(['--check', '--ip', '203.0.113.7']);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /4G\/5G/);
    assert.equal(mock.calls.filter((c) => c.method !== 'GET').length, 0);
    assert.equal(mock.state.record.content, '49.49.211.220');
  });
});

test('refuses to publish a LAN address', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    const run = await call(['--ip', '192.168.2.2']);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /ไอพีวงใน/);
    assert.equal(mock.calls.length, 0, 'ต้องหยุดก่อนแตะ Cloudflare เลย');
  });
});

test('refuses to publish a CG-NAT address and says why DNS cannot help', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    const run = await call(['--ip', '100.100.5.9']);
    assert.equal(run.code, 1);
    assert.match(run.stderr, /CG-NAT/);
    assert.equal(mock.calls.length, 0);
  });
});

test('creates the record as DNS-only when the zone has none', async () => {
  await withMock({ record: null }, async ({ call, mock }) => {
    const run = await call(['--ip', '203.0.113.7']);
    assert.equal(run.code, 0, run.stderr);
    const post = mock.calls.find((c) => c.method === 'POST');
    const sent = JSON.parse(post.body);
    // เมฆเทาเท่านั้น — เมฆส้มจะติดลิมิตอัพโหลด 100 MB แล้ววิดีโอของแขกจะไม่ผ่าน
    assert.equal(sent.proxied, false);
    assert.equal(sent.content, '203.0.113.7');
    assert.equal(sent.type, 'A');
  });
});

test('--check refuses to invent a missing record', async () => {
  await withMock({ record: null }, async ({ call, mock }) => {
    assert.equal((await call(['--check', '--ip', '203.0.113.7'])).code, 1);
    assert.equal(mock.calls.filter((c) => c.method === 'POST').length, 0);
  });
});

test('walks up the name to find the zone instead of guessing two labels', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    await call(['--ip', '203.0.113.7']);
    const zoneLookups = mock.calls.filter((c) => c.path === '/zones').map((c) => c.query);
    assert.ok(zoneLookups[0].includes('wedding.shafiq-lap.com'), 'ต้องลองชื่อเต็มก่อน');
    assert.ok(zoneLookups.some((q) => q.includes('name=shafiq-lap.com')));
  });
});

test('sends the token as a bearer header and never as a curl argument', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, mock }) => {
    const run = await call(['--ip', '203.0.113.7']);
    assert.equal(mock.calls[0].auth, `Bearer ${TOKEN}`);
    // โทเคนต้องไม่โผล่บนจอ (log ของตัวตั้งเวลาเก็บ stdout ไว้)
    assert.ok(!run.stdout.includes(TOKEN));
    assert.ok(!run.stderr.includes(TOKEN));
  });
});

test('the token never reaches the process arguments, where ps would expose it', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  // ต้องส่งผ่าน config ทาง stdin เท่านั้น
  assert.match(source, /curl[^\n]*-K -/);
  assert.ok(!/-H\s+["']?Authorization/.test(source), 'ห้ามใส่ header ที่มีโทเคนเป็น argument');
  const leaks = source.split('\n').filter((line) => line.includes('$TOKEN') && line.includes('curl'));
  assert.deepEqual(leaks, [], 'ห้ามมีบรรทัดที่โทเคนกับ curl อยู่ด้วยกัน — argument โผล่ใน ps');
});

test('carries no placeholder for the operator to paste over', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.ok(!/CLOUDFLARE_API_TOKEN=<|CLOUDFLARE_API_TOKEN=your|CLOUDFLARE_API_TOKEN=xxx/i.test(source));
  assert.match(source, /--setup/);
});

test('leaves the rest of .env untouched when storing a token', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, dir }) => {
    await call(['--ip', '203.0.113.7']);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, /ADMIN_PASSWORD=keepme/);
    assert.match(env, new RegExp(`CLOUDFLARE_API_TOKEN=${TOKEN}`));
  });
});

// PowerShell กับ PuTTY ส่งท้ายบรรทัดมาเป็น CRLF — \r ที่ติดมากับโทเคนทำให้ header
// ของ curl พัง แล้ว Cloudflare ตอบ "Invalid format for Authorization header"
// ทั้งที่โทเคนถูกต้องทุกตัวอักษร เกิดขึ้นจริงมาแล้วบน NAS
test('accepts a token pasted from Windows with a trailing carriage return', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, dir }) => {
    const run = await call(['--setup'], `${TOKEN}\r\n`);
    assert.equal(run.code, 0, run.stderr);
    const env = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    assert.match(env, new RegExp(`CLOUDFLARE_API_TOKEN=${TOKEN}$`, 'm'));
  });
});

test('refuses a token carrying anything but token characters', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, '.env'), `BASE_URL=https://${HOST}\nADMIN_PASSWORD=keepme\n`);
    const run = await call(['--setup'], 'abc123; rm -rf /\n');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /อักขระที่ไม่ควรมี/);
    assert.ok(!fs.readFileSync(path.join(dir, '.env'), 'utf8').includes('CLOUDFLARE_API_TOKEN'));
  });
});

test('a rejected token leaves .env exactly as it was', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, dir }) => {
    fs.writeFileSync(path.join(dir, '.env'), `BASE_URL=https://${HOST}\nADMIN_PASSWORD=keepme\n`);
    const before = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const run = await call(['--setup'], 'wrongtoken\n');
    assert.equal(run.code, 1);
    assert.match(run.stderr, /ไม่ได้แก้ \.env/);
    assert.equal(fs.readFileSync(path.join(dir, '.env'), 'utf8'), before);
  });
});

test('--setup-from deletes the token file once it is stored', async () => {
  await withMock({ record: { ...RECORD } }, async ({ call, dir }) => {
    const file = path.join(dir, 'token.txt');
    fs.writeFileSync(file, `${TOKEN}\r\n`);
    const run = await call(['--setup-from', file]);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(fs.existsSync(file), false, 'ไฟล์โทเคนต้องถูกลบทิ้ง');
    assert.match(fs.readFileSync(path.join(dir, '.env'), 'utf8'),
      new RegExp(`CLOUDFLARE_API_TOKEN=${TOKEN}$`, 'm'));
  });
});
