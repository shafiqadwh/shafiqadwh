/*
 * หน้าจอบูธ — กล้อง นับถอยหลัง ดูแผ่น พิมพ์
 *
 * ไฟล์นี้ไม่แตะดิสก์ ไม่รู้จัก sharp ไม่รู้จักเครื่องพิมพ์ · หน้าที่เดียวคือเก็บ
 * รูปจากกล้องแล้วส่งให้ฝั่งหลักทำต่อ (ดู preload.cjs ว่ายื่นอะไรให้บ้าง)
 *
 * ข้อจำกัดที่ออกแบบตามตั้งแต่แรก: **ไม่มีคีย์บอร์ด ไม่มีเมาส์** มีแต่นิ้วบนจอสัมผัส
 * ทุกปุ่มจึงใหญ่ ทุกสถานะมีทางกลับ และไม่มีจุดไหนที่กดแล้วค้างโดยไม่บอกอะไร
 */

const el = (id) => document.getElementById(id);
const body = document.body;

const state = {
  setup: null,
  effect: null,
  shots: [],
  token: null,
  busy: false,
  stream: null,
};

const stage = (name) => { body.dataset.stage = name; };

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
    box.classList.remove('is-tick');
    // บังคับให้เบราว์เซอร์เริ่มอนิเมชันใหม่ทุกวินาที ไม่ใช่เล่นครั้งเดียวแล้วนิ่ง
    void box.offsetWidth;
    box.classList.add('is-tick');
    await wait(1000);
  }
  box.textContent = '';
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
  try {
    for (let i = 1; i <= needed; i += 1) {
      el('progress').textContent = needed > 1 ? `รูปที่ ${i} จาก ${needed}` : '';
      await countdown(settings.countdownSeconds);
      flash();
      state.shots.push(grabFrame());
      // เว้นจังหวะให้แขกเปลี่ยนท่า ไม่ใช่รัวติดกันจนได้สามรูปท่าเดียวกัน
      if (i < needed) await wait(900);
    }
  } finally {
    closeCamera();
  }
  el('progress').textContent = 'กำลังประกอบแผ่น…';

  const result = await guard(() =>
    window.booth.compose({ shots: state.shots, effect: state.effect }));

  if (!result) {
    stage('ready');
    return;
  }

  state.token = result.token;
  el('sheet').src = result.preview;
  el('token').textContent = result.qrUrl ? `รหัส ${result.token}` : '';
  if (result.qrTooSmall) {
    fail(`QR เล็กกว่าที่ควร (โมดูล ${result.qrModuleMm} มม.) — ลองใช้ที่อยู่เว็บที่สั้นลง`);
  }
  stage('review');
}

async function print() {
  const result = await guard(() => window.booth.print({ token: state.token }));
  if (!result) return;
  el('done-text').textContent = result.driver === 'cups'
    ? 'ส่งไปเครื่องพิมพ์แล้ว รอสักครู่'
    : 'บันทึกแผ่นไว้ในโฟลเดอร์ขาออกแล้ว';
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
  stage('ready');

  // ลบทีหลังหน้าจอเปลี่ยนแล้ว — แขกไม่ต้องยืนรอการลบไฟล์
  if (discard && token) {
    window.booth.discard({ token }).catch((error) =>
      console.warn('ลบรอบที่ไม่เอาไม่สำเร็จ:', error?.message));
  }
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
  paintEffects(effects);

  for (const [name, value] of Object.entries(theme.colours)) {
    document.documentElement.style.setProperty(`--${name}`, value);
  }

  el('start').addEventListener('click', () => shoot());
  el('print').addEventListener('click', () => print());
  el('again').addEventListener('click', () => reset({ discard: true }));
  el('restart').addEventListener('click', () => reset());

  stage('ready');
  document.body.dataset.ready = '1';
}

boot();
