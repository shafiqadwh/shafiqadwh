/**
 * ตัวจำกัดจำนวนงานหนักที่ทำพร้อมกัน
 *
 * ffmpeg/ffprobe เป็นโปรเซสแยก ไม่ได้อยู่ใน event loop ของ Node ถ้าแขก 20 คน
 * กดส่งวิดีโอพร้อมกัน NAS จะได้ ffmpeg 20 ตัวรุมกันแย่ง CPU กับดิสก์ ผลคือ
 * ทุกคนช้าพร้อมกันหมด และช้ากว่าตอนต่อคิวกันเสียอีก
 *
 * จำกัดไว้ให้ทำทีละไม่กี่งาน คนที่มาทีหลังรอคิวสั้น ๆ แทนที่จะพากันล่มทั้งเครื่อง
 */
export function createGate(limit) {
  const max = Math.max(1, Number(limit) || 1);
  const waiting = [];
  let active = 0;

  function release() {
    active -= 1;
    const nextInLine = waiting.shift();
    if (nextInLine) {
      active += 1;
      nextInLine();
    }
  }

  return {
    /** รันงานเมื่อมีช่องว่าง แล้วคืนช่องให้คิวถัดไปเสมอ แม้งานจะ throw */
    async run(task) {
      if (active >= max) {
        await new Promise((resolve) => waiting.push(resolve));
      } else {
        active += 1;
      }

      try {
        return await task();
      } finally {
        release();
      }
    },

    get depth() {
      return active + waiting.length;
    },
  };
}
