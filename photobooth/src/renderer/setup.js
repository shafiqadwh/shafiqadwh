/*
 * หน้าตั้งค่า — อ่านค่าปัจจุบัน แก้ แล้วบันทึก
 *
 * **ฝั่งหลักเป็นคนตัดสินว่าค่าไหนใช้ได้เสมอ ไม่ใช่หน้านี้** (`normaliseSettings`)
 * หน้านี้จึงไม่ตรวจอะไรซ้ำ แต่ทำสิ่งที่สำคัญกว่า: เอาค่าที่ **บันทึกจริง** กลับมา
 * วาดทับสิ่งที่พิมพ์ไป · ตั้งเบอร์พร้อมเพย์ผิดแล้วการขายถูกปิดให้เงียบ ๆ คือ
 * บูธที่เปิดมาทั้งวันโดยไม่มีหน้าจ่ายเงินเลย ซึ่งเจ้าของจะรู้ตอนนับเงินตอนเก็บบูธ
 */

const el = (id) => document.getElementById(id);

// ส่งรูปขึ้นเว็บได้ไหม — ตอบจากฝั่งหลักตอนเปิดหน้า · ค่านี้เปลี่ยนไม่ได้จากหน้านี้
// (ที่อยู่เว็บกับกุญแจอยู่ใน settings.json) จึงอ่านครั้งเดียวแล้วถือไว้
let canPublish = false;

function status(text, kind = '') {
  const box = el('status');
  box.textContent = text;
  box.className = `foot__status${kind ? ` is-${kind}` : ''}`;
}

function fillOptions(select, items) {
  select.textContent = '';
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.shots > 1 ? `${item.name} · ${item.shots} รูป` : item.name;
    select.append(option);
  }
}

/** วาดฟอร์มจากค่าตั้งชุดหนึ่ง — ใช้ทั้งตอนเปิดหน้าและตอนบันทึกเสร็จ */
function paint(settings) {
  el('eventTitle').value = settings.eventTitle;
  el('eventSubtitle').value = settings.eventSubtitle;
  el('theme').value = settings.theme;
  el('template').value = settings.template;
  el('countdownSeconds').value = settings.countdownSeconds;
  el('copies').value = settings.copies;
  el('deliver').value = settings.deliver;
  el('cameraSource').value = settings.camera.source;
  el('cameraKeepOnCard').checked = settings.camera.keepOnCard;
  el('printerDriver').value = settings.printer.driver;
  /*
   * ชื่อเครื่องพิมพ์ที่ตั้งไว้อาจไม่อยู่ในรายการที่ระบบเห็นตอนนี้ (ยังไม่ได้เสียบ
   * หรือย้ายมาอีกเครื่อง) — ต้องคงค่าเดิมไว้ ไม่ใช่เงียบ ๆ เปลี่ยนเป็นค่าเริ่มต้น
   * แล้วให้เจ้าของมารู้ตอนกระดาษออกมาจากเครื่องผิดตัว
   */
  const pick = el('printerPick');
  if (settings.printer.name && !pick.querySelector(`option[value="${CSS.escape(settings.printer.name)}"]`)) {
    const missing = document.createElement('option');
    missing.value = settings.printer.name;
    missing.textContent = `${settings.printer.name} (ยังไม่เจอในระบบตอนนี้)`;
    pick.append(missing);
  }
  pick.value = settings.printer.name;

  el('saleEnabled').checked = settings.sale.enabled;
  el('saleTarget').value = settings.sale.target;
  el('salePrice').value = settings.sale.price || '';
  el('salePayWhen').value = settings.sale.payWhen;

  // โหมดจอกับโหมดทั้งสองอย่างต้องส่งรูปขึ้นเว็บได้ — เลือกไม่ได้ก็ต้องบอกว่าทำไม
  // ไม่ใช่ให้เลือกแล้วโดนบีบกลับเป็น "พิมพ์" ตอนบันทึกโดยไม่มีอะไรอธิบาย
  for (const option of el('deliver').options) {
    option.disabled = option.value !== 'print' && !canPublish;
  }
  el('deliver-hint').hidden = canPublish;
}

const patchFromForm = () => ({
  eventTitle: el('eventTitle').value,
  eventSubtitle: el('eventSubtitle').value,
  theme: el('theme').value,
  template: el('template').value,
  countdownSeconds: Number(el('countdownSeconds').value),
  copies: Number(el('copies').value),
  deliver: el('deliver').value,
  camera: {
    source: el('cameraSource').value,
    keepOnCard: el('cameraKeepOnCard').checked,
  },
  printer: { driver: el('printerDriver').value, name: el('printerPick').value },
  sale: {
    enabled: el('saleEnabled').checked,
    target: el('saleTarget').value,
    price: Number(el('salePrice').value),
    payWhen: el('salePayWhen').value,
  },
});

async function save() {
  const wanted = patchFromForm();
  el('save').disabled = true;
  status('กำลังบันทึก…');

  try {
    const saved = await window.booth.save(wanted);
    paint(saved);

    /*
     * บอกตรง ๆ เมื่อสิ่งที่บันทึกได้ไม่ตรงกับสิ่งที่ขอ
     *
     * `normaliseSettings` ปิดการขายให้เองเมื่อเบอร์หรือราคาใช้ไม่ได้ — ซึ่งถูกแล้ว
     * (หน้าจ่ายเงินที่ไม่มี QR ให้สแกนคือบูธที่ค้างคาแถว) แต่ถ้าไม่บอก เจ้าของจะ
     * เดินออกไปโดยเชื่อว่าตั้งขายไว้แล้ว แล้วมารู้ตอนนับเงินว่าไม่ได้เก็บใครเลยทั้งวัน
     */
    if (wanted.sale.enabled && !saved.sale.enabled) {
      status('บันทึกแล้ว แต่ยังไม่ได้เปิดขาย — เบอร์พร้อมเพย์หรือราคายังใช้ไม่ได้', 'bad');
    } else if (wanted.deliver !== saved.deliver) {
      status(`บันทึกแล้ว แต่โหมดส่งมอบถูกเปลี่ยนเป็น "${saved.deliver}" เพราะยังส่งรูปขึ้นเว็บไม่ได้`, 'bad');
    } else {
      status('บันทึกแล้ว · จอบูธโหลดค่าใหม่ให้เรียบร้อย', 'good');
    }
  } catch (error) {
    status(`บันทึกไม่สำเร็จ: ${error.message}`, 'bad');
  } finally {
    el('save').disabled = false;
  }
}

/** สร้าง QR จากค่าที่กำลังพิมพ์อยู่ ยังไม่ต้องบันทึก — จะได้แก้เบอร์ต่อได้ทันทีถ้าผิด */
async function checkPay() {
  const image = el('check-qr');
  try {
    const result = await window.booth.checkPay({
      target: el('saleTarget').value,
      price: Number(el('salePrice').value),
    });
    if (!result.ok) {
      image.hidden = true;
      status('สร้าง QR ไม่ได้ — เบอร์/เลขบัตร หรือราคายังไม่ถูกต้อง', 'bad');
      return;
    }
    image.src = result.qr;
    image.hidden = false;
    status('สแกนใบนี้ด้วยแอปธนาคารจริง แล้วดูว่าขึ้นชื่อบัญชีของคุณกับยอดที่ตั้งไว้');
  } catch (error) {
    image.hidden = true;
    status(`สร้าง QR ไม่ได้: ${error.message}`, 'bad');
  }
}

/**
 * ทดสอบกล้องด้วยการ **ถ่ายจริงหนึ่งรูป** — ทำตอนตั้งบูธ ไม่ใช่ตอนแขกคนแรกยืนอยู่
 *
 * "เจอกล้อง" กับ "สั่งกล้องถ่ายได้" เป็นคนละคำถาม · มีกล้องจริงที่ตอบข้อแรกว่าใช่
 * แต่ข้อสองว่าไม่ — ถ้าปุ่มนี้ตรวจแค่ว่าเจอ มันจะขึ้นชื่อรุ่นให้เจ้าของบูธเชื่อใจ
 * แล้วไปพังตอนแขกคนแรกยืนอยู่หน้ากล้อง
 *
 * ตอบด้วยชื่อรุ่นที่เจอจริงเสมอ ไม่ใช่แค่ผ่าน/ไม่ผ่าน — บูธที่วางกล้องไว้สองตัว
 * ต้องรู้ว่าเสียบสายถูกตัวหรือเปล่า และเมื่อล้มก็ต้องบอกวิธีแก้ ไม่ใช่บอกแค่ว่าล้ม
 */
async function checkCamera() {
  const note = el('camera-note');
  const button = el('check-camera');
  button.disabled = true;
  note.textContent = 'กำลังสั่งกล้องถ่าย…';

  try {
    const found = await window.booth.camera();
    note.textContent = found.ok
      ? `ถ่ายได้จริง: ${found.model} — พร้อมใช้งาน`
      : found.reason;
    status(found.ok ? `พร้อมถ่ายด้วย ${found.model}` : 'ยังใช้กล้องใหญ่ไม่ได้',
      found.ok ? 'good' : 'bad');
  } catch (error) {
    note.textContent = `ทดสอบไม่สำเร็จ: ${error.message}`;
    status('ทดสอบกล้องไม่สำเร็จ', 'bad');
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  try {
    const setup = await window.booth.settings();
    canPublish = setup.canPublish;
    fillOptions(el('theme'), setup.themes);
    fillOptions(el('template'), setup.templates);

    /*
     * รายชื่อเครื่องพิมพ์จริงของเครื่องนี้ — เลือกจากรายการ ไม่ใช่พิมพ์ชื่อเอง
     *
     * บน Windows ชื่อเครื่องพิมพ์หน้าตาแบบ "Canon SELPHY CP1500 (Copy 1)"
     * ซึ่งพิมพ์ผิดได้ง่ายมากและผิดแล้วเงียบ — งานสั่งไปแล้วแต่ไม่มีอะไรออกมา
     */
    const printers = await window.booth.printers().catch(() => []);
    for (const one of printers) {
      const option = document.createElement('option');
      option.value = one.name;
      option.textContent = one.isDefault ? `${one.display} (ค่าเริ่มต้น)` : one.display;
      el('printerPick').append(option);
    }
    el('printer-note').textContent = printers.length > 0
      ? `ระบบเห็นเครื่องพิมพ์ ${printers.length} เครื่อง`
      : 'ยังไม่เจอเครื่องพิมพ์ในระบบ — ติดตั้งไดรเวอร์แล้วเปิดหน้านี้ใหม่';

    paint(setup.settings);
  } catch (error) {
    status(`อ่านค่าตั้งไม่ได้: ${error.message}`, 'bad');
    el('save').disabled = true;
    return;
  }

  el('save').addEventListener('click', save);
  el('cancel').addEventListener('click', () => window.booth.closeSettings());
  el('check').addEventListener('click', checkPay);
  el('check-camera').addEventListener('click', checkCamera);
  // เปลี่ยนเบอร์หรือราคาแล้ว QR ใบเก่ายังค้างอยู่ = สแกนใบที่ไม่ตรงกับที่กำลังจะบันทึก
  for (const id of ['saleTarget', 'salePrice']) {
    el(id).addEventListener('input', () => { el('check-qr').hidden = true; });
  }
  document.body.dataset.ready = '1';
}

boot();
