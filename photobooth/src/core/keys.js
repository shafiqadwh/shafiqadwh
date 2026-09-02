/**
 * รีโมทกดชัตเตอร์ — ทั้งแบบเสียบสายและบลูทูธ
 *
 * รีโมทพวกนี้ (USB ที่เสียบแล้วใช้ได้เลย และ AB Shutter บลูทูธราคาร้อยกว่าบาท)
 * **ประกาศตัวกับระบบปฏิบัติการว่าเป็นคีย์บอร์ด** ไม่ใช่อุปกรณ์ชนิดพิเศษ กดแล้ว
 * มันส่งปุ่มเดียวออกมาเท่านั้น — จึงไม่ต้องลงไดรเวอร์ ไม่ต้องจับคู่กับโปรแกรม
 * งานทั้งหมดของไฟล์นี้คือแปลปุ่มนั้นให้เป็น "การกระทำ" ของบูธ
 *
 * ปุ่มที่รีโมทในตลาดส่งจริงมีอยู่ไม่กี่ตัว และต่างยี่ห้อต่างส่งไม่เหมือนกัน
 * (สายมักเป็น Enter/Space/PageDown ส่วนบลูทูธสลับโหมด iOS/Android แล้วเปลี่ยน
 * ระหว่าง VolumeUp กับ Enter) — รับไว้ทั้งหมดดีกว่าบังคับให้ลูกค้าหาซื้อรุ่นเดียว
 *
 * อยู่ใน core/ เพราะทั้งหน้าจอและกระบวนการหลักใช้ตารางเดียวกันนี้ · ตารางปุ่มที่มี
 * สองชุดคือตารางที่วันหนึ่งจะไม่ตรงกัน แล้วรีโมทจะทำงานที่จอหนึ่งแต่ไม่ทำที่อีกจอ
 */

/** ปุ่ม → การกระทำ · ชื่อปุ่มใช้แบบเดียวกับ accelerator ของ Electron */
export const KEY_ACTIONS = Object.freeze({
  Enter: 'shutter',
  Space: 'shutter',
  PageDown: 'shutter',
  F5: 'shutter',
  VolumeUp: 'shutter',
  Num0: 'shutter',
  PageUp: 'back',
  VolumeDown: 'back',
  Backspace: 'back',
});

/*
 * ชื่อปุ่มที่เบราว์เซอร์ส่งมา ไม่ตรงกับชื่อ accelerator เสมอไป
 * (เว้นวรรคมาเป็น " " · ปุ่มเสียงมาเป็น AudioVolumeUp) — ปรับให้ตรงกันที่เดียว
 * จะได้มีตารางเดียวไม่ว่าปุ่มจะมาทางหน้าจอหรือทาง globalShortcut
 */
const ALIASES = Object.freeze({
  ' ': 'Space',
  Spacebar: 'Space',
  AudioVolumeUp: 'VolumeUp',
  AudioVolumeDown: 'VolumeDown',
});

export function keyName(input) {
  const code = String(input?.code ?? '');
  if (code === 'Numpad0') return 'Num0';
  if (code === 'NumpadEnter') return 'Enter';
  const key = String(input?.key ?? '');
  return ALIASES[key] ?? key;
}

export const actionForKey = (input) => KEY_ACTIONS[keyName(input)] ?? null;

/**
 * ตัวรับปุ่มพร้อมกันกดรัว
 *
 * รีโมทถูก ๆ เด้งสัญญาณ (ปุ่มเดียวมาสองสามครั้งในเสี้ยววินาที) และช่างภาพเองก็กดซ้ำ
 * ตอนไม่แน่ใจว่าติดไหม · ปล่อยผ่านหมด = สั่งพิมพ์สองใบ ซึ่งย้อนไม่ได้
 * เมินปุ่มเดิมที่มาซ้ำภายในระยะสั้น ๆ แต่ **ไม่เมินปุ่มอีกตัว** — กดถ่ายแล้วรีบกด
 * ยกเลิกทันทีเป็นเจตนาจริง ไม่ใช่สัญญาณเด้ง
 */
export function createRemote(onAction, { gapMs = 350, now = Date.now } = {}) {
  let lastAction = null;
  let lastAt = 0;

  return function press(input) {
    // ค้างนิ้วไว้ไม่ใช่การกดใหม่ — คีย์บอร์ดจะยิงซ้ำให้เองเป็นสิบครั้งต่อวินาที
    if (input?.repeat) return null;

    const action = actionForKey(input);
    if (!action) return null;

    const at = now();
    if (action === lastAction && at - lastAt < gapMs) return null;
    lastAction = action;
    lastAt = at;

    onAction(action);
    return action;
  };
}
