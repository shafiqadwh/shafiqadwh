import { paperSize } from './paper.js';

/**
 * ผังของแผ่นที่จะพิมพ์ — ช่องรูปอยู่ตรงไหน ชื่องานกับ QR อยู่ตรงไหน
 *
 * ทุกตัวเลขคำนวณจากขนาดกระดาษเป็นสัดส่วน ไม่ได้ฝัง 1200×1800 ไว้ตรง ๆ
 * เปลี่ยนไป 5×7 หรือ 6×8 แล้วขอบยังได้สัดส่วนเดิม ไม่ใช่ขอบขาวบวมข้างเดียว
 *
 * `slots[].shot` คือ "รูปใบที่เท่าไรของรอบถ่าย" ไม่ใช่ลำดับช่อง — แบบแถบมีสอง
 * สำเนาบนแผ่นเดียว รูปชุดเดียวกันจึงลงสองที่ (ตัดครึ่งแล้วได้สองแถบ: แถบหนึ่ง
 * แปะสมุดอวยพรของเจ้าภาพ อีกแถบแขกเอากลับบ้าน — คือวิธีใช้จริงที่ออกแบบไว้)
 */

const round = Math.round;

const TEMPLATES = {
  classic: {
    id: 'classic',
    shots: 1,
    name: { th: 'เต็มใบ', ms: 'Penuh', en: 'Classic', ar: 'كلاسيكي' },
    build(page) {
      const m = round(page.width * 0.05);
      const footerH = round(page.height * 0.15);
      const gap = round(m * 0.6);
      return {
        ...page,
        slots: [{ shot: 0, left: m, top: m, width: page.width - m * 2, height: page.height - footerH - m * 2 }],
        footers: [{
          left: m,
          top: page.height - footerH - round(m * 0.4),
          width: page.width - m * 2,
          height: footerH,
        }],
        cuts: [],
        gap,
      };
    },
  },

  grid: {
    id: 'grid',
    shots: 4,
    name: { th: 'สี่ช่อง', ms: 'Empat kotak', en: 'Grid of four', ar: 'أربع صور' },
    build(page) {
      const m = round(page.width * 0.05);
      const gap = round(page.width * 0.02);
      const footerH = round(page.height * 0.15);
      const cellW = round((page.width - m * 2 - gap) / 2);
      const cellH = round((page.height - footerH - m * 2 - gap) / 2);

      const slots = [];
      for (let i = 0; i < 4; i += 1) {
        slots.push({
          shot: i,
          left: m + (i % 2) * (cellW + gap),
          top: m + Math.floor(i / 2) * (cellH + gap),
          width: cellW,
          height: cellH,
        });
      }

      return {
        ...page,
        slots,
        footers: [{
          left: m,
          top: page.height - footerH - round(m * 0.4),
          width: page.width - m * 2,
          height: footerH,
        }],
        cuts: [],
        gap,
      };
    },
  },

  strip: {
    id: 'strip',
    shots: 3,
    name: { th: 'แถบยาว (ได้สองแถบ)', ms: 'Jalur (dua helai)', en: 'Strip (two copies)', ar: 'شريط (نسختان)' },
    build(page) {
      const panelW = round(page.width / 2);
      const m = round(panelW * 0.06);
      const gap = round(panelW * 0.04);
      const footerH = round(page.height * 0.16);
      const photoW = panelW - m * 2;
      const photoH = round((page.height - footerH - m * 2 - gap * 2) / 3);

      const slots = [];
      const footers = [];
      for (let copy = 0; copy < 2; copy += 1) {
        const originX = copy * panelW;
        for (let shot = 0; shot < 3; shot += 1) {
          slots.push({
            shot,
            left: originX + m,
            top: m + shot * (photoH + gap),
            width: photoW,
            height: photoH,
          });
        }
        footers.push({
          left: originX + m,
          top: m + 3 * photoH + 2 * gap + gap,
          width: photoW,
          height: footerH - gap,
        });
      }

      // เส้นตัดกลางแผ่น — ไม่มีเส้นแล้วคนถือกรรไกรต้องกะเอง แล้วแถบหนึ่งจะแหว่ง
      return { ...page, slots, footers, cuts: [{ x: panelW }], gap };
    },
  },

  polaroid: {
    id: 'polaroid',
    shots: 1,
    name: { th: 'โพลารอยด์', ms: 'Polaroid', en: 'Polaroid', ar: 'بولارويد' },
    build(page) {
      // ทรงโพลารอยด์จริง: ขอบบนกับข้างเท่ากัน ขอบล่างหนากว่ามาก รูปเป็นสี่เหลี่ยมจัตุรัส
      const m = round(page.width * 0.08);
      const photo = page.width - m * 2;
      const chinTop = m + photo + round(m * 0.45);
      return {
        ...page,
        slots: [{ shot: 0, left: m, top: m, width: photo, height: photo }],
        footers: [{
          left: m,
          top: chinTop,
          width: photo,
          height: page.height - chinTop - m,
        }],
        cuts: [],
        gap: round(m * 0.45),
      };
    },
  },
};

export const TEMPLATE_IDS = Object.freeze(Object.keys(TEMPLATES));
export const DEFAULT_TEMPLATE = 'classic';

export function templateById(id) {
  return TEMPLATES[id] ?? TEMPLATES[DEFAULT_TEMPLATE];
}

export function templateName(id, lang) {
  const template = templateById(id);
  return template.name[lang] ?? template.name.en;
}

/** จำนวนรูปที่ต้องถ่ายสำหรับแบบนี้ — หน้าจอนับถอยหลังใช้ค่านี้ ไม่ได้ฝังเลขไว้เอง */
export function shotsFor(id) {
  return templateById(id).shots;
}

export function listTemplates(lang = 'th') {
  return TEMPLATE_IDS.map((id) => ({
    id,
    name: templateName(id, lang),
    shots: templateById(id).shots,
  }));
}

/** ผังเต็มพร้อมพิกัดจริงเป็นพิกเซลบนกระดาษที่เลือก */
export function layoutFor(templateId, paperId, { landscape = false } = {}) {
  return templateById(templateId).build(paperSize(paperId, { landscape }));
}
