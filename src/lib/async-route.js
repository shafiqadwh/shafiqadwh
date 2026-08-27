/**
 * ห่อ route handler แบบ async ให้ error วิ่งเข้า error middleware ของ Express
 *
 * Express 4 เรียก handler แล้ว **ไม่สนใจค่าที่คืนมา** — handler ที่เป็น async
 * คืน Promise ออกไป ถ้ามันถูก reject จะไม่มีใครรับเลย กลายเป็น unhandled rejection
 * ซึ่ง Node 22 ตั้งค่าเริ่มต้นให้ **ฆ่าทั้งโปรเซส** (ทดสอบแล้ว: เว็บดับทันที)
 *
 * บนเครื่องจริงคอนเทนเนอร์ตั้ง restart: unless-stopped ไว้ Docker จึงยกกลับมาให้
 * ในราวสิบกว่าวินาที แต่ระหว่างนั้นแขกทุกคนเข้าเว็บไม่ได้ และถ้าสาเหตุยังอยู่
 * (เช่นดิสก์เต็ม) คำขอถัดไปก็ฆ่าซ้ำได้เรื่อย ๆ ทั้งงาน
 *
 * Express 5 แก้เรื่องนี้ให้ในตัวแล้ว แต่โปรเจกต์นี้อยู่บน 4 และการอัปเมเจอร์
 * ก่อนวันงานสองวันเป็นความเสี่ยงที่ไม่คุ้มกว่าการห่อทีละตัวแบบนี้
 */
export function wrap(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
