import sharp from 'sharp';

/**
 * เอฟเฟคแต่งภาพ — ไม่ใช่สติกเกอร์ ไม่ใช่กรอบ PNG
 *
 * เจ้าของชี้ตัวอย่างเป็นบูธเกาหลี ซึ่งเสน่ห์อยู่ที่ "โทนภาพ" ไม่ใช่ของที่แปะทับ:
 * ภาพสว่าง คอนทราสต์ต่ำ ผิวนวล สีจาง ๆ · ทำด้วยการปรับค่าสีล้วน จึงใช้ได้กับ
 * ทุกหน้าทุกองค์ประกอบ ไม่ต้องรู้ว่าคนยืนตรงไหนในเฟรมเหมือนสติกเกอร์
 *
 * ⚠️ เหตุผลที่ต้องสร้างเองทั้งหมด: ไฟล์กรอบบูธถ่ายรูปที่แจกกันบน Instagram/X
 * เขียนกำกับไว้ว่า **ห้ามใช้เชิงพาณิชย์** งานนี้ตั้งใจขาย จึงเอามาใช้ไม่ได้เลย
 * ทุกเอฟเฟคในไฟล์นี้ประกอบจากการปรับค่าสีของ sharp ล้วน ไม่มีไฟล์ภาพของใคร
 *
 * แต่ละตัวคืน sharp pipeline · `grain` บอกว่าต้องโปรยเกรนทับทีหลังไหม เพราะ
 * เกรนต้อง composite ไม่ใช่ปรับค่าสี — ทำในขั้นเดียวกันไม่ได้
 */

const EFFECTS = {
  clean: {
    name: { th: 'ธรรมชาติ', ms: 'Semula jadi', en: 'Natural', ar: 'طبيعي' },
    grain: 0,
    // คมขึ้นนิดเดียวชดเชยกล้องเว็บแคมที่ภาพนุ่มกว่ากล้องจริง ไม่ได้แต่งสีอะไรเลย
    apply: (img) => img.sharpen({ sigma: 0.6 }),
  },

  soft: {
    name: { th: 'นวล', ms: 'Lembut', en: 'Soft', ar: 'ناعم' },
    grain: 0,
    /*
     * โทนบูธเกาหลี: สว่าง คอนทราสต์ต่ำ ผิวเนียน
     *
     * `linear(0.82, 30)` คือหัวใจ — คูณ 0.82 ลดคอนทราสต์ บวก 30 ยกดำให้ลอย
     * ได้ภาพ "จาง" แบบที่คนชอบ · ทำด้วย brightness เฉย ๆ ไม่ได้ผลแบบนี้
     * เพราะ brightness ดันทั้งภาพขึ้นรวมทั้งไฮไลท์ที่จะไหม้ก่อน
     */
    apply: (img) => img.linear(0.82, 30).modulate({ saturation: 0.88 }).sharpen({ sigma: 0.4 }),
  },

  warm: {
    name: { th: 'อบอุ่น', ms: 'Suam', en: 'Warm', ar: 'دافئ' },
    grain: 0,
    // เกลี่ยแดงขึ้น น้ำเงินลง — ไม่ใช้ .tint() เพราะมันเป็น duotone ที่กลืนสีเดิมทิ้งหมด
    // (ทดสอบแล้ว: พิกเซลฟ้า 120,150,200 กลายเป็นน้ำตาล 175,143,99 — เสื้อสีฟ้าหายไปเลย)
    apply: (img) => img.linear([1.07, 1.01, 0.93], [4, 2, -3]).modulate({ brightness: 1.03, saturation: 1.04 }),
  },

  film: {
    name: { th: 'ฟิล์ม', ms: 'Filem', en: 'Film', ar: 'فيلم' },
    grain: 14,
    // ยกดำให้ลอย + อุ่นที่เงา คือลักษณะของฟิล์มจริง ไม่ใช่การย้อมทั้งภาพเป็นสีน้ำตาล
    apply: (img) => img.linear([0.90, 0.88, 0.84], [20, 17, 14]).modulate({ saturation: 0.95 }),
  },

  mono: {
    name: { th: 'ขาวดำ', ms: 'Hitam putih', en: 'Black & white', ar: 'أبيض وأسود' },
    grain: 8,
    apply: (img) => img.greyscale().linear(1.12, -10).sharpen({ sigma: 0.7 }),
  },

  pop: {
    name: { th: 'สดใส', ms: 'Cerah', en: 'Vivid', ar: 'زاهي' },
    grain: 0,
    apply: (img) => img.modulate({ saturation: 1.35, brightness: 1.03 }).linear(1.08, -8).sharpen({ sigma: 0.8 }),
  },

  festive: {
    name: { th: 'เทศกาล', ms: 'Perayaan', en: 'Festive', ar: 'احتفالي' },
    grain: 0,
    // ทองอ่อน ๆ อมเขียวนิดหน่อย เข้ากับจานสีฮารีรายอโดยไม่กลบสีผ้าที่แขกใส่มา
    apply: (img) => img.linear([1.06, 1.03, 0.94], [6, 5, 1]).modulate({ brightness: 1.03, saturation: 1.10 }),
  },
};

export const EFFECT_IDS = Object.freeze(Object.keys(EFFECTS));
export const DEFAULT_EFFECT = 'clean';

export function effectById(id) {
  return EFFECTS[id] ?? EFFECTS[DEFAULT_EFFECT];
}

export function effectName(id, lang) {
  const effect = effectById(id);
  return effect.name[lang] ?? effect.name.en;
}

/** รายการเอฟเฟคพร้อมชื่อ — ให้หน้าจอวนแสดงได้โดยไม่ต้องรู้จักโครงข้างใน */
export function listEffects(lang = 'th') {
  return EFFECT_IDS.map((id) => ({ id, name: effectName(id, lang) }));
}

/*
 * เกรนสร้างครั้งเดียวแล้วใช้ซ้ำ
 *
 * แขกยืนรออยู่หน้าบูธ การสุ่มจุดรบกวนใหม่ทุกใบคือเวลาที่เสียไปเปล่า ๆ ต่อแผ่น
 * ตาคนแยกไม่ออกอยู่แล้วว่าเกรนสองใบเป็นลายเดียวกัน — คนละใบ คนละมือ คนละเวลา
 */
const grainCache = new Map();

async function grainTile(width, height, strength) {
  const key = `${width}x${height}:${strength}`;
  if (grainCache.has(key)) return grainCache.get(key);

  const pixels = Buffer.allocUnsafe(width * height);
  for (let i = 0; i < pixels.length; i += 1) {
    // จุดรบกวนรอบค่ากลาง แล้วเอาไป overlay — ค่ากลางจึงไม่เปลี่ยนความสว่างรวม
    pixels[i] = Math.max(0, Math.min(255, 128 + Math.round((Math.random() - 0.5) * strength * 2)));
  }

  const tile = await sharp(pixels, { raw: { width, height, channels: 1 } })
    .toColourspace('b-w')
    .png()
    .toBuffer();

  grainCache.set(key, tile);
  return tile;
}

/**
 * ใส่เอฟเฟคให้ภาพหนึ่งใบ พร้อมย่อ/ครอบให้พอดีช่องที่จะไปวาง
 *
 * ครอบ (`cover`) ไม่ใช่ยืด — หน้าคนที่ถูกยืดให้พอดีกรอบคือของเสียที่พิมพ์ออกมาแล้ว
 * แก้ไม่ได้ · ตัดขอบทิ้งบ้างยอมรับได้ ยืดหน้าไม่ได้
 */
export async function applyEffect(input, effectId, { width, height }) {
  const effect = effectById(effectId);

  const base = effect.apply(
    sharp(input, { failOn: 'none' })
      .rotate()
      .resize(width, height, { fit: 'cover', position: 'attention' }),
  );

  if (!effect.grain) return base.jpeg({ quality: 95, mozjpeg: true }).toBuffer();

  return base
    .composite([{ input: await grainTile(width, height, effect.grain), blend: 'overlay' }])
    .jpeg({ quality: 95, mozjpeg: true })
    .toBuffer();
}
