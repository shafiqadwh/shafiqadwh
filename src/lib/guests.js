/**
 * จัดกลุ่ม "คนเดียวกัน" จากชื่อที่แขกพิมพ์เอง
 *
 * ชื่อผู้ส่งเป็นข้อความอิสระ ไม่มีบัญชีผู้ใช้ ไม่มี id — คนคนเดียวที่อัพรูปตอนเช้า
 * แล้วมาเขียนคำอวยพรตอนบ่าย พิมพ์ชื่อตัวเองไม่เหมือนกันเป๊ะได้ง่ายมาก
 *
 * ตอนนี้เส้นทางเขียนสองทางก็จัดชื่อไม่เหมือนกันอยู่แล้ว: หน้าอัพโหลดยุบช่องว่างซ้ำ
 * (`src/routes/upload.js`) ส่วนสมุดอวยพรไม่ยุบ (`src/routes/guestbook.js`)
 * "สม  ชาย" กับ "สม ชาย" จึงกลายเป็นคนละคน
 *
 * เลือกแก้ที่ "ตอนอ่าน" ไม่ใช่ "ตอนเขียน" โดยตั้งใจ — เส้นทางเขียนคือเส้นทางที่แขก
 * เป็นพันคนใช้จริงในวันงาน การไปแตะมันเพื่อฟีเจอร์หลังงานไม่คุ้มกับความเสี่ยง
 * และจัดกลุ่มตอนอ่านให้ผลเหมือนกันทุกประการ โดยไม่ต้องแก้ข้อมูลเก่าเลยสักแถว
 */

/**
 * คีย์สำหรับจัดกลุ่ม — ไม่ใช่ชื่อที่เอาไปแสดง
 *
 * NFC เพราะสระลอยของไทยกับอาหรับพิมพ์มาได้ทั้งแบบรวมร่างและแบบแยกตัว
 * ซึ่งหน้าตาเหมือนกันเป๊ะบนจอแต่ไบต์ไม่ตรงกัน
 * toLowerCase ไม่มีผลกับไทย/อาหรับ แต่จำเป็นกับชื่อที่พิมพ์เป็นอักษรละติน
 */
export function normaliseName(value) {
  return String(value ?? '')
    .normalize('NFC')
    // เขียนเป็นรหัสหนี ไม่ใช่อักขระจริง — อักขระควบคุมที่พิมพ์ลงไฟล์ตรง ๆ
    // มองไม่เห็นตอนอ่านโค้ดและหายไปเงียบ ๆ ตอนคัดลอกไปมา (เคยเกิดกับ film.js มาแล้ว)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/**
 * ชื่อที่จะแสดงของกลุ่มหนึ่ง — เลือกรูปแบบที่แขกพิมพ์มาบ่อยที่สุด
 *
 * ไม่ใช้คีย์ที่เป็นตัวพิมพ์เล็ก เพราะ "Fatimah" ที่พิมพ์มา 5 ครั้งไม่ควรกลายเป็น
 * "fatimah" บนหน้ากระดาษที่บ่าวสาวจะเก็บไว้ ถ้าเสมอกันเลือกตัวที่เจอก่อน
 * ซึ่งคือครั้งแรกที่คนนั้นส่งอะไรเข้ามา
 */
export function pickDisplayName(names) {
  const tally = new Map();
  for (const raw of names) {
    const text = String(raw ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    tally.set(text, (tally.get(text) ?? 0) + 1);
  }

  let best = '';
  let bestCount = 0;
  for (const [text, count] of tally) {
    if (count > bestCount) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

/**
 * รวมแถวจาก items กับ messages เป็นรายชื่อแขกหนึ่งชุด
 *
 * แขกที่ไม่ระบุชื่อรวมเป็นก้อนเดียวกันทั้งหมดตามที่เจ้าของสั่ง ใช้คีย์ว่าง `''`
 * แล้วเรียงไว้ท้ายสุดเสมอ — ไม่ใช่คนคนเดียว แต่เป็น "ส่วนที่เหลือ" ของงาน
 */
export function groupGuests({ items = [], messages = [] } = {}) {
  const guests = new Map();

  const bucket = (key) => {
    if (!guests.has(key)) {
      guests.set(key, {
        key,
        rawNames: [],
        photos: 0,
        videos: 0,
        messages: 0,
        itemIds: [],
        messageIds: [],
        firstAt: null,
        lastAt: null,
      });
    }
    return guests.get(key);
  };

  const touch = (guest, at) => {
    if (!at) return;
    if (!guest.firstAt || at < guest.firstAt) guest.firstAt = at;
    if (!guest.lastAt || at > guest.lastAt) guest.lastAt = at;
  };

  for (const row of items) {
    const guest = bucket(normaliseName(row.uploader));
    guest.rawNames.push(row.uploader);
    if (row.kind === 'video') guest.videos += 1;
    else guest.photos += 1;
    guest.itemIds.push(row.id);
    touch(guest, row.created_at);
  }

  for (const row of messages) {
    const guest = bucket(normaliseName(row.author));
    guest.rawNames.push(row.author);
    guest.messages += 1;
    guest.messageIds.push(row.id);
    touch(guest, row.created_at);
  }

  const list = [...guests.values()].map((guest) => ({
    ...guest,
    name: pickDisplayName(guest.rawNames),
    anonymous: guest.key === '',
    total: guest.photos + guest.videos + guest.messages,
  }));

  // เรียงตามชื่อด้วย Intl ไม่ใช่ localeCompare เปล่า ๆ — ลำดับอักษรไทยต่างจากลำดับ
  // จุดโค้ด Unicode และหน้ากระดาษที่เรียงผิดจะดูเหมือนพิมพ์ผิด
  const collator = new Intl.Collator(['th', 'ms', 'en', 'ar'], { sensitivity: 'base', numeric: true });
  return list.sort((a, b) => {
    if (a.anonymous !== b.anonymous) return a.anonymous ? 1 : -1;
    return collator.compare(a.name, b.name);
  });
}

/** ชื่อที่แสดงของแถวเดี่ยว ๆ — กลุ่มไม่ระบุชื่อใช้คำเดิมที่หน้าเว็บใช้อยู่แล้ว */
export function displayNameFor(name, t) {
  const text = String(name ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
  return text || t('gallery.anonymous');
}
