/*
 * จอช่างภาพ — ดูอย่างเดียวกับจอหน้า แล้วสั่งงานกลับไป
 *
 * ไฟล์นี้ไม่แตะกล้องเลยแม้แต่บรรทัดเดียว · **กล้องหนึ่งตัวเปิดได้ทีละที่เดียว**
 * เปิดที่นี่ด้วยจะแย่งกับจอหน้าแล้วได้จอดำอย่างน้อยหนึ่งจอ · ภาพที่เห็นตรงนี้
 * จอหน้าส่งมาให้ทีละเฟรม (ดู startRelay ใน booth.js)
 *
 * และไม่มีตรรกะขั้นตอนของตัวเองด้วย — จอหน้าเป็นเจ้าของสถานะเพียงที่เดียว
 * สองจอที่ต่างคนต่างจำว่าตอนนี้ถึงไหนแล้ว คือสองจอที่พูดไม่ตรงกันเมื่อมีอะไรพลาด
 */

import { createRemote } from '../core/keys.js';

const el = (id) => document.getElementById(id);
const body = document.body;

/** ป้ายปุ่มหลักตามขั้นตอน · ขั้น review ขึ้นกับว่าตั้งโหมดส่งมอบไว้อย่างไร */
const DELIVERY = {
  print: 'พิมพ์',
  screen: 'ให้รับรูป',
  both: 'พิมพ์และให้รับรูป',
};

const STAGE_LABEL = {
  ready: 'พร้อมถ่าย',
  shoot: 'กำลังถ่าย',
  review: 'ให้แขกดูแผ่น',
  done: 'ส่งมอบแล้ว',
};

const state = { deliver: 'print', sheets: 0 };

const send = (message) => window.booth.broadcast(message);

function paintStage(stage) {
  body.dataset.stage = stage;
  el('stage-label').textContent = STAGE_LABEL[stage] ?? stage;

  el('go').textContent = {
    ready: 'เริ่มถ่าย',
    shoot: 'กำลังถ่าย…',
    review: DELIVERY[state.deliver] ?? DELIVERY.print,
    done: 'ถ่ายอีกครั้ง',
  }[stage] ?? 'เริ่มถ่าย';

  // ระหว่างนับถอยหลังไม่มีอะไรให้กด — ปุ่มที่กดแล้วไม่มีอะไรเกิดขึ้นทำให้คนกดซ้ำ
  el('go').disabled = stage === 'shoot';
  // "ถ่ายใหม่" มีความหมายเฉพาะตอนที่มีแผ่นให้ทิ้ง — ขั้นอื่นมันซ้ำกับปุ่มหลัก
  el('back').hidden = stage !== 'review';
}

function showImage(src, { mirror }) {
  const image = el('view-image');
  image.src = src;
  image.hidden = false;
  // ภาพสดพลิกซ้ายขวาเหมือนจอหน้า (จอหน้าทำตัวเป็นกระจก) ส่วนแผ่นที่ประกอบแล้ว
  // พลิกมาให้เรียบร้อยตั้งแต่ตอนถ่าย จึงต้องไม่พลิกซ้ำ
  image.classList.toggle('is-mirrored', mirror);
  el('view-idle').hidden = true;
}

function clearImage() {
  const image = el('view-image');
  image.removeAttribute('src');
  image.hidden = true;
  el('view-idle').hidden = false;
  el('count').textContent = '';
  el('progress').textContent = '';
}

/**
 * งานหลังงาน — ส่งรอบที่ยังค้างขึ้นเว็บ
 *
 * ปุ่มบอกจำนวนที่ค้างอยู่เสมอ และบอกเหตุที่กดไม่ได้แทนที่จะเป็นปุ่มเทา ๆ เฉย ๆ
 * "ส่งไม่ได้" กับ "ไม่มีอะไรให้ส่ง" คนละเรื่องกันคนละทางแก้
 */
async function refreshSend() {
  const button = el('send');
  try {
    const { pending, canPublish } = await window.booth.pending();
    button.disabled = pending === 0 || !canPublish;
    button.textContent = !canPublish ? 'ยังตั้งที่อยู่เว็บไม่ครบ'
      : pending === 0 ? 'ส่งขึ้นเว็บครบแล้ว'
        : `ส่งขึ้นเว็บ ${pending} รอบ`;
  } catch (error) {
    button.disabled = true;
    button.textContent = `อ่านรายการค้างไม่ได้: ${error.message}`;
  }
}

async function sendPending() {
  const button = el('send');
  button.disabled = true;
  try {
    const { sent, failed } = await window.booth.upload();
    el('progress').textContent = failed.length === 0
      ? `ส่งขึ้นเว็บแล้ว ${sent.length} รอบ`
      // ล้มบางรอบต้องบอกจำนวนและเหตุ ไม่ใช่ "เสร็จแล้ว" ที่ไม่จริง · กดซ้ำได้เสมอ
      // เพราะรอบที่ส่งสำเร็จถูกทำเครื่องหมายไว้แล้ว จะไม่ถูกส่งซ้ำ
      : `ส่งแล้ว ${sent.length} · ไม่สำเร็จ ${failed.length} รอบ (${failed[0].reason})`;
  } catch (error) {
    el('progress').textContent = error.message;
  }
  await refreshSend();
}

const HANDLERS = {
  stage: ({ stage }) => paintStage(stage),
  frame: ({ data }) => showImage(data, { mirror: true }),
  sheet: ({ preview, code }) => {
    showImage(preview, { mirror: false });
    el('count').textContent = '';
    el('code').textContent = code ? `รหัส ${code}` : '';
  },
  count: ({ n }) => { el('count').textContent = n > 0 ? String(n) : ''; },
  progress: ({ text }) => { el('progress').textContent = text ?? ''; },
  done: ({ printed, published, code, text }) => {
    state.sheets += printed ? 1 : 0;
    el('tally').textContent = `วันนี้ ${state.sheets} แผ่น`;
    el('code').textContent = code ? `รหัส ${code}` : '';
    // ส่งขึ้นเว็บไม่สำเร็จเป็นเรื่องที่ช่างภาพต้องรู้ทันที ไม่ใช่มารู้ตอนแขกโทรมาถาม
    el('progress').textContent = text ?? '';
    if (code && published === false) el('progress').textContent = `${text} (ยังส่งขึ้นเว็บไม่สำเร็จ)`;
    refreshSend();
  },
  upload: ({ done, total }) => {
    el('progress').textContent = `กำลังส่งขึ้นเว็บ ${done}/${total}`;
  },
  reset: () => { clearImage(); el('code').textContent = ''; },
};

async function boot() {
  let remote = true;
  try {
    const setup = await window.booth.setup();
    state.deliver = setup.settings.deliver;
    remote = setup.settings.remote.enabled;
    document.documentElement.lang = setup.settings.lang;
    el('event-title').textContent = setup.settings.eventTitle;
    for (const [name, value] of Object.entries(setup.theme.colours)) {
      document.documentElement.style.setProperty(`--${name}`, value);
    }
  } catch (error) {
    el('stage-label').textContent = `อ่านค่าตั้งไม่ได้: ${error.message}`;
  }

  window.booth.onMessage((message) => HANDLERS[message?.type]?.(message));

  el('go').addEventListener('click', () => send({ type: 'action', action: 'shutter' }));
  el('back').addEventListener('click', () => send({ type: 'action', action: 'back' }));

  // รีโมทมักอยู่ในมือช่างภาพซึ่งยืนอยู่หลังบูธ — ปุ่มที่กดตรงนี้จึงต้องได้ผลเท่ากับ
  // กดที่จอหน้า · จอนี้ไม่ตัดสินใจเอง แค่ส่งต่อให้จอหน้าซึ่งเป็นเจ้าของสถานะ
  if (remote) {
    const press = createRemote((action) => send({ type: 'action', action }));
    window.addEventListener('keydown', (event) => {
      if (press(event)) event.preventDefault();
    });
  }

  el('send').addEventListener('click', () => sendPending());
  await refreshSend();

  paintStage('ready');
  // จอหลังอาจเปิดขึ้นทีหลังจอหน้า (หรือรีเฟรชกลางงาน) — ถามสถานะปัจจุบันแทนที่จะ
  // เดาว่าเริ่มต้นที่หน้าพร้อมถ่ายเสมอ
  send({ type: 'hello' });
  body.dataset.ready = '1';
}

boot();
