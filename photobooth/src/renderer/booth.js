/*
 * หน้าจอบูธ — กล้อง นับถอยหลัง ดูแผ่น พิมพ์
 *
 * ไฟล์นี้ไม่แตะดิสก์ ไม่รู้จัก sharp ไม่รู้จักเครื่องพิมพ์ · หน้าที่เดียวคือเก็บ
 * รูปจากกล้องแล้วส่งให้ฝั่งหลักทำต่อ (ดู preload.cjs ว่ายื่นอะไรให้บ้าง)
 *
 * ข้อจำกัดที่ออกแบบตามตั้งแต่แรก: **ไม่มีคีย์บอร์ด ไม่มีเมาส์** มีแต่นิ้วบนจอสัมผัส
 * ทุกปุ่มจึงใหญ่ ทุกสถานะมีทางกลับ และไม่มีจุดไหนที่กดแล้วค้างโดยไม่บอกอะไร
 */

import { createRemote } from '../core/keys.js';

const el = (id) => document.getElementById(id);
const body = document.body;

const state = {
  setup: null,
  effect: null,
  shots: [],
  token: null,
  // ยอดกับ QR ของรอบที่กำลังเก็บเงิน — เก็บไว้ส่งซ้ำให้จอช่างภาพที่เพิ่งรีเฟรช
  pay: null,
  busy: false,
  stream: null,
  relay: null,
};

/**
 * บอกจอช่างภาพว่าเกิดอะไรขึ้น
 *
 * จอหลังไม่มีกล้องของตัวเอง (กล้องตัวหนึ่งเปิดได้ทีละที่เดียว) และไม่รู้จัก
 * ขั้นตอนอะไรเลย — ทุกอย่างที่มันเห็นมาจากท่อนี้ · ไม่มีจอที่สองก็ไม่เป็นไร
 * ข้อความจะไม่ถูกส่งต่อไปไหน แต่จอหน้าต้องทำงานเหมือนเดิมทุกประการ
 */
const say = (message) => {
  try {
    window.booth.broadcast(message);
  } catch (error) {
    console.warn('ส่งให้จอช่างภาพไม่ได้:', error?.message);
  }
};

const stage = (name) => {
  body.dataset.stage = name;
  say({ type: 'stage', stage: name });
};

function setProgress(text) {
  el('progress').textContent = text;
  say({ type: 'progress', text });
}

function fail(message) {
  const box = el('error');
  box.textContent = message;
  box.hidden = false;
  // ข้อความผิดพลาดหายเองหลังพอสมควร — บูธไม่มีใครนั่งเฝ้าคอยกดปิด
  clearTimeout(fail.timer);
  fail.timer = setTimeout(() => { box.hidden = true; }, 8000);
}

/** ปุ่มที่กดซ้ำระหว่างทำงานอยู่ = สั่งพิมพ์สองครั้ง = กระดาษเสียหนึ่งใบ */
async function guard(work) {
  if (state.busy) return undefined;
  state.busy = true;
  body.dataset.busy = '1';
  try {
    return await work();
  } catch (error) {
    fail(error?.message ?? 'เกิดข้อผิดพลาด');
    return undefined;
  } finally {
    state.busy = false;
    delete body.dataset.busy;
  }
}

// ── กล้อง ────────────────────────────────────────────────────────────────

async function openCamera() {
  if (state.stream) return state.stream;
  state.stream = await navigator.mediaDevices.getUserMedia({
    // ขอความละเอียดสูงไว้ก่อน เบราว์เซอร์จะลดให้เองถ้ากล้องทำไม่ได้ · รูปที่ไป
    // พิมพ์ที่ 300 dpi ต้องการพิกเซลจริง ย่อจากกล้องเล็กแล้วขยายไม่ได้
    video: { width: { ideal: 1920 }, height: { ideal: 1440 }, facingMode: 'user' },
    audio: false,
  });
  const video = el('preview');
  video.srcObject = state.stream;
  await video.play();
  return state.stream;
}

function closeCamera() {
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  el('preview').srcObject = null;
}

/*
 * ส่งภาพจากกล้องไปให้จอช่างภาพ — เล็กและช้าโดยตั้งใจ
 *
 * ช่างภาพต้องการเห็นว่า "แขกอยู่ในกรอบไหม ตาปิดหรือเปล่า" ซึ่ง 4 ภาพต่อวินาที
 * ที่กว้าง 480 พิกเซลก็พอแล้ว · ส่งภาพเต็มความละเอียดทุกเฟรมคือการเอาแรงเครื่อง
 * ไปแย่งกับงานที่สำคัญกว่า (การถ่ายกับการประกอบแผ่น) เพื่อความคมที่ไม่มีใครดู
 */
const RELAY_WIDTH = 480;
const RELAY_INTERVAL_MS = 250;

function startRelay() {
  stopRelay();
  const video = el('preview');
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  state.relay = setInterval(() => {
    if (!video.videoWidth) return;
    canvas.width = RELAY_WIDTH;
    canvas.height = Math.round((RELAY_WIDTH * video.videoHeight) / video.videoWidth);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    // ไม่พลิกภาพตรงนี้ — จอช่างภาพพลิกด้วย CSS เหมือนที่จอหน้าทำกับวิดีโอ
    say({ type: 'frame', data: canvas.toDataURL('image/jpeg', 0.6) });
  }, RELAY_INTERVAL_MS);
}

function stopRelay() {
  clearInterval(state.relay);
  state.relay = null;
}

/**
 * เก็บเฟรมปัจจุบันเป็น JPEG
 *
 * พลิกซ้ายขวาให้ตรงกับที่แขกเห็นในจอ — จอบูธทำตัวเหมือนกระจก (คนยกมือขวา
 * เงาในกระจกยกมือที่อยู่ฝั่งเดียวกัน) ถ้ารูปที่พิมพ์ออกมาไม่พลิกตาม ตัวหนังสือ
 * บนเสื้อจะกลับด้านจากที่เห็นตอนถ่าย ซึ่งคนทักทุกครั้ง
 */
function grabFrame() {
  const video = el('preview');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.95);
}

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function countdown(seconds) {
  const box = el('count');
  for (let n = seconds; n > 0; n -= 1) {
    box.textContent = String(n);
    say({ type: 'count', n });
    box.classList.remove('is-tick');
    // บังคับให้เบราว์เซอร์เริ่มอนิเมชันใหม่ทุกวินาที ไม่ใช่เล่นครั้งเดียวแล้วนิ่ง
    void box.offsetWidth;
    box.classList.add('is-tick');
    await wait(1000);
  }
  box.textContent = '';
  say({ type: 'count', n: 0 });
}

function flash() {
  const light = el('flash');
  light.classList.remove('is-on');
  void light.offsetWidth;
  light.classList.add('is-on');
}

// ── ขั้นตอนหลัก ──────────────────────────────────────────────────────────

async function shoot() {
  const { shots: needed, settings } = state.setup;
  state.shots = [];
  stage('shoot');

  try {
    await openCamera();
  } catch (error) {
    stage('ready');
    fail(`เปิดกล้องไม่ได้: ${error.message}`);
    return;
  }

  // ปิดกล้องให้ได้ทุกทางออก — หลุดไปทางไหนก็ตามแล้วไฟกล้องยังติดค้าง แขกคนถัดไป
  // จะเห็นว่ากล้องเปิดอยู่ทั้งที่หน้าจอกลับไปหน้าเริ่มแล้ว
  startRelay();
  try {
    for (let i = 1; i <= needed; i += 1) {
      setProgress(needed > 1 ? `รูปที่ ${i} จาก ${needed}` : '');
      await countdown(settings.countdownSeconds);
      flash();
      state.shots.push(grabFrame());
      // เว้นจังหวะให้แขกเปลี่ยนท่า ไม่ใช่รัวติดกันจนได้สามรูปท่าเดียวกัน
      if (i < needed) await wait(900);
    }
  } finally {
    stopRelay();
    closeCamera();
  }
  setProgress('กำลังประกอบแผ่น…');

  const result = await guard(() =>
    window.booth.compose({ shots: state.shots, effect: state.effect }));

  // เก็บข้อความ "กำลังประกอบแผ่น" ทันทีที่ประกอบเสร็จ · จอหน้าซ่อนมันเองตอนเปลี่ยนฉาก
  // แต่จอช่างภาพโชว์แถบนี้ตลอด ข้อความค้างจึงกลายเป็นคำโกหกอยู่บนจอนั้น
  setProgress('');

  if (!result) {
    stage('ready');
    return;
  }

  state.token = result.token;
  el('sheet').src = result.preview;
  el('token').textContent = result.qrUrl ? `รหัส ${result.token}` : '';
  say({ type: 'sheet', preview: result.preview, code: result.token });
  if (result.qrTooSmall) {
    fail(`QR เล็กกว่าที่ควร (โมดูล ${result.qrModuleMm} มม.) — ลองใช้ที่อยู่เว็บที่สั้นลง`);
  }
  stage('review');
}

/**
 * ขอ QR พร้อมเพย์แล้วขึ้นหน้าจ่ายเงิน
 *
 * คั่นตรงนี้ — ระหว่าง "แขกเห็นแผ่นแล้ว" กับ "สั่งพิมพ์" — โดยตั้งใจ
 * แขกเห็นของก่อนจ่าย จึงไม่มีเรื่องขอเงินคืนเพราะรูปไม่ถูกใจ และถ้ากล้องหรือการ
 * ประกอบแผ่นล้มก่อนหน้านี้ ก็ยังไม่มีใครจ่ายอะไรไปเลย · กระดาษยังไม่ถูกใช้ด้วย
 *
 * บูธที่ไม่ได้ตั้งขาย (รับจ้างงาน เจ้าภาพจ่ายมาแล้ว) ข้ามขั้นนี้ไปทั้งขั้น
 */
async function askPayment() {
  const sale = await guard(() => window.booth.sale());
  if (!sale) return;
  if (!sale.enabled) return deliver();

  /*
   * ปุ่มยืนยันรับเงินอยู่จอไหน — ตัดสินตอนนี้ ไม่ใช่ตอนบูต
   *
   * มีจอช่างภาพ = ปุ่มอยู่จอหลังที่เดียว **แขกกดยืนยันให้ตัวเองไม่ได้**
   * ไม่มีจอหลัง (บูธจอเดียวกางหน้าบ้าน) = ปุ่มต้องอยู่จอนี้ ไม่งั้นบูธค้างคาแถว
   * โดยที่เจ้าของยืนอยู่ตรงนั้นแต่ไม่มีอะไรให้กด · เจ้าของกดจากรีโมทได้ทั้งสองแบบ
   */
  el('pay-buttons').hidden = sale.hasOperator === true;
  el('pay-wait').hidden = sale.hasOperator !== true;

  state.pay = { type: 'pay', price: sale.price, qr: sale.qr, takings: sale.takings };
  el('pay-price').textContent = `${sale.price.toLocaleString('th-TH')} บาท`;
  el('pay-qr').src = sale.qr;
  say(state.pay);
  stage('pay');
  return undefined;
}

/**
 * มีคนกดยืนยันว่าได้รับเงินแล้ว — จดลงสมุดบัญชี แล้วค่อยส่งมอบ
 *
 * จดก่อนพิมพ์ ไม่ใช่หลังพิมพ์ · เครื่องพิมพ์กระดาษหมดกลางทางแล้วรอบนั้นหายจาก
 * สมุดบัญชี = ยอดเงินที่ได้รับจริงไม่ตรงกับที่จดไว้ ซึ่งแก้ทีหลังไม่ได้เพราะไม่มีใครจำ
 */
async function confirmPaid({ free = false } = {}) {
  const result = await guard(() => window.booth.paid({ token: state.token, free }));
  if (!result) return;
  say({ type: 'takings', takings: result.takings, free });
  await deliver();
}

/** ป้ายบนปุ่มหลัก และข้อความตอนเสร็จ — ผูกกับโหมดส่งมอบที่ตั้งไว้ */
const DELIVERY = {
  print: { button: 'พิมพ์', done: 'พิมพ์ให้แล้ว รอรับได้เลย' },
  screen: { button: 'รับรูป', done: 'สแกนเพื่อรับรูปของคุณ' },
  both: { button: 'พิมพ์และรับรูป', done: 'พิมพ์ให้แล้ว · สแกนเพื่อรับไฟล์ด้วย' },
};

async function deliver() {
  const result = await guard(() => window.booth.deliver({ token: state.token }));
  if (!result) return;

  const mode = DELIVERY[state.setup.settings.deliver] ?? DELIVERY.print;
  const qr = el('done-qr');

  if (result.qr) {
    qr.src = result.qr;
    qr.hidden = false;
    el('done-mark').hidden = true;
    el('done-code').textContent = `รหัส ${result.token}`;
  } else {
    qr.hidden = true;
    el('done-mark').hidden = false;
    el('done-code').textContent = '';
  }

  // ส่งขึ้นเว็บไม่สำเร็จก็ยังให้ QR ไป — ลิงก์ถูกต้องตั้งแต่แรก รูปตามไปทีหลัง
  el('done-text').textContent = result.qr && !result.published
    ? 'สแกนเก็บลิงก์ไว้ก่อน — รูปจะขึ้นระบบให้ภายหลัง'
    : mode.done;

  // ช่างภาพต้องรู้ว่าสั่งพิมพ์ไปแล้วจริงหรือแค่ขึ้น QR — เขาคือคนที่ต้องตอบแขก
  // เวลาแผ่นไม่ออกมาจากเครื่อง
  say({
    type: 'done',
    printed: result.printed,
    published: result.published,
    code: result.qr ? result.token : '',
    text: el('done-text').textContent,
  });

  stage('done');
}

/**
 * กลับไปหน้าเริ่ม · `discard` = แขกกด "ถ่ายใหม่" คือไม่เอารอบนี้แล้ว
 *
 * ไม่ลบทิ้งจะเหลือรูปกับแผ่นของรอบที่ไม่มีใครเอาค้างบนดิสก์ทุกครั้ง แล้วตอน
 * อัปโหลดหลังงาน รอบที่แขกตั้งใจทิ้งจะขึ้นไปปนกับรอบที่เขาเลือกเอา
 */
async function reset({ discard = false } = {}) {
  const token = state.token;
  state.shots = [];
  state.token = null;
  el('sheet').removeAttribute('src');
  el('token').textContent = '';
  // QR ของคนก่อนค้างอยู่ = คนถัดไปสแกนแล้วได้รูปของคนอื่น
  el('done-qr').removeAttribute('src');
  el('done-qr').hidden = true;
  el('done-code').textContent = '';
  // QR จ่ายเงินของรอบก่อนค้างอยู่ = คนถัดไปเห็นยอดเก่าตอนหน้าจอเปลี่ยนไม่ทัน
  el('pay-qr').removeAttribute('src');
  el('pay-price').textContent = '';
  state.pay = null;
  el('progress').textContent = '';
  say({ type: 'reset' });
  stage('ready');

  // ลบทีหลังหน้าจอเปลี่ยนแล้ว — แขกไม่ต้องยืนรอการลบไฟล์
  if (discard && token) {
    window.booth.discard({ token }).catch((error) =>
      console.warn('ลบรอบที่ไม่เอาไม่สำเร็จ:', error?.message));
  }
}

// ── คำสั่งจากรีโมทและจอช่างภาพ ─────────────────────────────────────────────

/**
 * ปุ่มเดียวทำงานต่างกันตามขั้นตอน — เหมือนปุ่มใหญ่บนจอตรงหน้าแขก ณ ตอนนั้น
 *
 * รีโมทกดถ่ายมีปุ่มเดียว (นั่นคือทั้งหมดที่มันมี) ถ้าปุ่มนั้นหมายถึง "เริ่มถ่าย"
 * อย่างเดียว ช่างภาพจะต้องเดินอ้อมไปกดจอทุกครั้งที่ต้องสั่งพิมพ์ ซึ่งทำให้รีโมท
 * แทบไม่ช่วยอะไรเลย · ให้มันหมายถึง "ทำขั้นต่อไป" แทน
 *
 * ขั้น shoot ไม่รับคำสั่งใด ๆ — ระหว่างนับถอยหลังไม่มีอะไรให้เร่งหรือย้อน
 */
const ACTIONS = {
  shutter: {
    ready: () => shoot(),
    review: () => askPayment(),
    // รีโมทอยู่ในมือเจ้าของบูธ ซึ่งเป็นคนเดียวที่เห็นแอปธนาคาร — ปุ่มถ่ายบนรีโมท
    // จึงหมายถึง "ได้รับเงินแล้ว" ตอนอยู่ขั้นนี้ เหมือนที่มันหมายถึง "ทำขั้นต่อไป" เสมอ
    pay: () => confirmPaid(),
    done: () => reset(),
  },
  back: {
    review: () => reset({ discard: true }),
    pay: () => reset({ discard: true }),
    done: () => reset(),
  },
  /*
   * รอบที่ไม่คิดเงิน — ถ่ายซ้อม เพื่อน หรือถ่ายชดเชยให้ลูกค้าที่รูปไม่สวย
   *
   * **ไม่มีปุ่มบนรีโมทโดยตั้งใจ** (ไม่มีคีย์ไหนแมปมาที่ action นี้) การยกเว้นค่าถ่าย
   * ต้องเป็นการกดปุ่มที่ตั้งใจกด ไม่ใช่ผลของการกดรีโมทพลาดตอนแขกยืนรอ
   */
  free: { pay: () => confirmPaid({ free: true }) },
};

function act(action) {
  // ระหว่างกำลังพิมพ์/ประกอบแผ่น ปุ่มบนจอก็ตายอยู่แล้ว รีโมทต้องตายด้วย
  // ไม่งั้นรีโมทกลายเป็นทางลัดสั่งพิมพ์ซ้ำที่จอไม่มี
  if (state.busy) return;
  ACTIONS[action]?.[body.dataset.stage]?.();
}

// ── ตั้งค่าเริ่มต้น ────────────────────────────────────────────────────────

function paintEffects(effects) {
  const box = el('effects');
  box.textContent = '';
  state.effect = effects[0]?.id ?? 'clean';

  for (const effect of effects) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = effect.name;
    button.dataset.effect = effect.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(effect.id === state.effect));
    button.addEventListener('click', () => {
      state.effect = effect.id;
      for (const other of box.children) {
        other.setAttribute('aria-checked', String(other.dataset.effect === effect.id));
      }
    });
    box.append(button);
  }
  // เอฟเฟคเดียวไม่ต้องให้เลือก — ปุ่มที่กดแล้วไม่มีอะไรเปลี่ยนคือปุ่มที่ทำให้สับสน
  box.hidden = effects.length < 2;
}

async function boot() {
  try {
    state.setup = await window.booth.setup();
  } catch (error) {
    fail(`อ่านค่าตั้งไม่ได้: ${error.message}`);
    return;
  }

  const { settings, theme, shots, effects } = state.setup;

  document.documentElement.lang = settings.lang;
  el('event-title').textContent = settings.eventTitle;
  el('event-subtitle').textContent = settings.eventSubtitle;
  el('shot-count').textContent = shots > 1 ? `${shots} รูป` : '';
  el('deliver').textContent = (DELIVERY[settings.deliver] ?? DELIVERY.print).button;
  paintEffects(effects);

  for (const [name, value] of Object.entries(theme.colours)) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }

  el('start').addEventListener('click', () => shoot());
  el('deliver').addEventListener('click', () => askPayment());
  el('pay-done').addEventListener('click', () => confirmPaid());
  el('pay-cancel').addEventListener('click', () => reset({ discard: true }));

  el('again').addEventListener('click', () => reset({ discard: true }));
  el('restart').addEventListener('click', () => reset());

  /*
   * รีโมทกดถ่าย — หน้าจอรับปุ่มเอง
   *
   * รีโมทเป็นคีย์บอร์ดในสายตาระบบ ปุ่มจึงมาถึงหน้าเว็บตามเส้นทางปกติเหมือนคน
   * กดคีย์บอร์ด · รับตรงนี้แทนที่จะไปดักในกระบวนการหลัก เพราะเป็นเส้นทางเดียว
   * ที่ทดสอบได้จริงทั้งเส้น และไม่ต้องยึดปุ่มไปจากทั้งเครื่อง
   */
  if (settings.remote.enabled) {
    const press = createRemote(act);
    window.addEventListener('keydown', (event) => {
      if (press(event)) event.preventDefault();
    });
  }

  window.booth.onMessage((message) => {
    if (message?.type === 'action') act(message.action);
    // จอช่างภาพเพิ่งเปิด/รีเฟรช — บอกให้มันรู้ว่าตอนนี้อยู่ขั้นไหน ไม่ใช่ปล่อยให้
    // นั่งดูจอเปล่าจนกว่าแขกคนถัดไปจะมา
    if (message?.type === 'hello') {
      say({ type: 'stage', stage: body.dataset.stage });
      // จอช่างภาพที่รีเฟรชกลางขั้นเก็บเงิน ต้องได้ยอดกับ QR กลับไปด้วย ไม่ใช่แผงเปล่า
      // ที่มีปุ่ม "ได้รับเงินแล้ว" ให้กดโดยไม่รู้ว่ากำลังเก็บเท่าไร
      if (state.pay) say(state.pay);
    }
  });

  stage('ready');
  document.body.dataset.ready = '1';
}

boot();
