import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS } from '../src/main/settings.js';

async function harness() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, textContent: '', children: [], events: {},
      classList: { add() {}, remove() {} },
      addEventListener(name, fn) { this.events[name] = fn; },
      removeAttribute() {}, setAttribute() {}, append() {},
      videoWidth: 1920, videoHeight: 1080, readyState: 4, async play() {},
    });
    return elements.get(id);
  };
  let now = 0, nextId = 0, opens = 0, stops = 0;
  const timers = new Map(), captures = [], tracks = [], listeners = {};
  const schedule = (fn, ms, repeat = false) => {
    const id = ++nextId;
    timers.set(id, { fn, ms, at: now + ms, repeat });
    return id;
  };
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const body = { dataset: {} };
  const setup = { settings: DEFAULTS, shots: 2, frameSeconds: DEFAULTS.frameSeconds,
    theme: { colours: {} }, effects: [], idle: {} };
  const context = vm.createContext({ console,
    createRemote: () => () => false,
    setTimeout: (fn, ms) => schedule(fn, ms), clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => timers.delete(id),
    document: { body, getElementById: get, documentElement: { style: { setProperty() {} } },
      createElement: () => ({ getContext: () => ({ drawImage() {}, translate() {}, scale() {} }),
        toDataURL: (_type, quality) => { if (quality === 0.95) captures.push(now); return 'image'; } }) },
    navigator: { mediaDevices: { async getUserMedia() {
      opens++;
      const track = { readyState: 'live', stop() { stops++; this.readyState = 'ended'; } };
      tracks.push(track);
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    } } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn; }, booth: {
      setup: async () => setup, broadcast() {}, onMessage() {},
      compose: async () => ({ token: 'ticket', preview: 'sheet' }),
      discard: async () => {}, retake: async () => true,
    } },
  });
  const source = (await fs.readFile(new URL('../src/renderer/booth.js', import.meta.url), 'utf8'))
    .replace(/^import .*;$/m, '');
  vm.runInContext(source, context);
  await flush();
  return { get, body, captures, tracks, listeners,
    opens: () => opens, stops: () => stops,
    async run(code) { const result = vm.runInContext(code, context); await flush(); return result; },
    async tick(ms) {
      const end = now + ms;
      while (true) {
        const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        const [id, timer] = entry;
        now = timer.at;
        if (timer.repeat) timer.at += timer.ms; else timers.delete(id);
        timer.fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

/*
 * เวลาคิดจากค่าตั้ง ไม่ใช่เลขที่พิมพ์ทิ้งไว้
 *
 * ข้อนี้ถามว่า **จัดท่ามาก่อน แล้วค่อยนับถอยหลัง แล้วจึงลั่นชัตเตอร์** ซึ่งเป็น
 * ลำดับที่ต้องจริงไม่ว่าจะตั้งกี่วินาที · ฝังเลข 15 กับ 18 ไว้แล้ววันหนึ่งมีคน
 * เปลี่ยนค่าเริ่มต้น เทสต์จะล้มพร้อมตัวเลขที่ไม่มีอะไรบอกว่าผิดตรงไหน
 */
const FRAME_MS = DEFAULTS.frameSeconds * 1000;
const COUNT_MS = DEFAULTS.countdownSeconds * 1000;
// เว้นจังหวะให้แขกเปลี่ยนท่าระหว่างรูป — ค่าเดียวกับใน shoot()
const BETWEEN_MS = 900;

test('framing comes first, the countdown second; the stream survives review and the next round', async () => {
  const app = await harness();
  await app.run('startRound()');
  await app.tick(FRAME_MS - 1);
  assert.equal(app.body.dataset.stage, 'frame');
  assert.deepEqual(app.captures, [], 'ยังไม่ครบเวลาจัดท่า ต้องยังไม่ลั่นชัตเตอร์');
  await app.tick(COUNT_MS + 1);
  assert.deepEqual(app.captures, [FRAME_MS + COUNT_MS]);
  await app.tick(COUNT_MS + BETWEEN_MS);
  assert.deepEqual(app.captures,
    [FRAME_MS + COUNT_MS, FRAME_MS + COUNT_MS * 2 + BETWEEN_MS]);
  assert.equal(app.body.dataset.stage, 'review');
  assert.equal(app.stops(), 0);
  await app.run('reset()');
  await app.run('startRound()');
  assert.equal(app.opens(), 1);
  app.listeners.beforeunload();
  assert.equal(app.stops(), 1);
});

test('cancel stops framing timer; disconnected stream reconnects on next attempt', async () => {
  const app = await harness();
  await app.run('startRound()');
  await app.run("act('back')");
  await app.tick(FRAME_MS + COUNT_MS + 2000);
  assert.equal(app.body.dataset.stage, 'ready');
  assert.deepEqual(app.captures, []);
  assert.equal(app.stops(), 0);
  app.tracks[0].readyState = 'ended';
  await app.run('startRound()');
  assert.equal(app.opens(), 2);
});

test('signal loss during countdown returns safely; paid retake includes framing', async () => {
  const app = await harness();
  await app.run('startRound()');
  await app.run("act('shutter')");
  app.tracks[0].readyState = 'ended';
  await app.tick(COUNT_MS);
  assert.equal(app.body.dataset.stage, 'ready');
  assert.deepEqual(app.captures, []);
  await app.run("state.token = 'paid'; state.paidFor = 'paid'; stage('review'); retake()");
  assert.equal(app.body.dataset.stage, 'frame');
  assert.equal(await app.run('holdingPaid()'), true);
});
