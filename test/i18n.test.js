import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const localesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'locales');

// อ่านจากโฟลเดอร์จริง ไม่ใช่รายชื่อที่เขียนไว้ตายตัว — เพิ่มภาษาใหม่แล้วเทสต์ทั้งชุด
// จะครอบคลุมให้ทันที โดยไม่ต้องมีใครจำได้ว่าต้องมาแก้ไฟล์นี้ด้วย
const codes = fs.readdirSync(localesDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => path.basename(name, '.json'))
  .sort();

const catalogues = Object.fromEntries(
  codes.map((code) => [code, JSON.parse(fs.readFileSync(path.join(localesDir, `${code}.json`), 'utf8'))]),
);

function flatten(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'object' && value !== null ? flatten(value, full) : [[full, value]];
  });
}

const keysByCode = Object.fromEntries(
  codes.map((code) => [code, new Map(flatten(catalogues[code]))]),
);

// บล็อก lang.* เป็นข้อมูลประจำภาษา ไม่ใช่คำแปล — มีทั้งข้อความและ boolean
// เทสต์ที่ตรวจเนื้อหาคำแปลจึงต้องข้ามมัน ไม่งั้นจะไปเรียก .match บนค่าที่ไม่ใช่ข้อความ
const isMetadata = (key) => key.startsWith('lang.');

test('every language has exactly the same set of keys', () => {
  const reference = [...keysByCode.th.keys()].sort();

  for (const code of codes) {
    const actual = [...keysByCode[code].keys()].sort();
    const missing = reference.filter((key) => !keysByCode[code].has(key));
    const extra = actual.filter((key) => !keysByCode.th.has(key));

    assert.deepEqual(missing, [], `${code}.json is missing keys: ${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${code}.json has keys no other language has: ${extra.join(', ')}`);
  }
});

test('no translation is blank', () => {
  for (const code of codes) {
    for (const [key, value] of keysByCode[code]) {
      if (isMetadata(key)) continue;
      assert.equal(typeof value, 'string', `${code}.json:${key} should be a string`);
      assert.notEqual(value.trim(), '', `${code}.json:${key} is empty`);
    }
  }
});

test('placeholders match across languages', () => {
  const placeholders = (value) => (value.match(/\{(\w+)\}/g) ?? []).sort().join(',');

  for (const [key, thaiValue] of keysByCode.th) {
    if (isMetadata(key)) continue;
    for (const code of ['ms', 'en']) {
      assert.equal(
        placeholders(keysByCode[code].get(key)),
        placeholders(thaiValue),
        `${code}.json:${key} does not use the same {placeholders} as Thai`,
      );
    }
  }
});

test('translations are not copied straight from another language', () => {
  // Catches the classic "forgot to translate this one" mistake. Short shared
  // tokens like "OK" are legitimately identical, so only check longer strings.
  const suspicious = [];
  for (const [key, thaiValue] of keysByCode.th) {
    if (isMetadata(key)) continue;
    if (thaiValue.length < 8) continue;
    if (keysByCode.ms.get(key) === thaiValue) suspicious.push(`ms:${key}`);
    if (keysByCode.en.get(key) === thaiValue) suspicious.push(`en:${key}`);
    if (keysByCode.ar.get(key) === thaiValue) suspicious.push(`ar:${key}`);
  }
  assert.deepEqual(suspicious, [], `untranslated strings: ${suspicious.join(', ')}`);
});

test('Thai strings actually contain Thai script', () => {
  const thaiPattern = /[\u0e00-\u0e7f]/;
  const latinOnly = [];
  for (const [key, value] of keysByCode.th) {
    if (isMetadata(key)) continue;
    if (!thaiPattern.test(value)) latinOnly.push(key);
  }
  assert.deepEqual(latinOnly, [], `Thai catalogue has non-Thai values: ${latinOnly.join(', ')}`);
});

test('Arabic strings actually contain Arabic script', () => {
  // เหตุผลเดียวกับเทสต์ของภาษาไทย: คีย์ที่ลืมแปลจะดูเหมือนแปลแล้วถ้าไม่ตรวจอักษร
  const arabicPattern = /[\u0600-\u06ff]/;
  const notArabic = [];
  for (const [key, value] of keysByCode.ar) {
    if (isMetadata(key)) continue;
    if (!arabicPattern.test(value)) notArabic.push(key);
  }
  assert.deepEqual(notArabic, [], `Arabic catalogue has non-Arabic values: ${notArabic.join(', ')}`);
});

test('every catalogue declares which way its text runs', () => {
  // หน้าเว็บอ่านทิศทางจาก catalogue ไม่ใช่จากรายชื่อรหัสภาษาที่ hardcode ไว้
  // ภาษา RTL ภาษาถัดไปจึงเพิ่มได้โดยไม่ต้องกลับมาแก้โค้ด
  for (const [code, keys] of Object.entries(keysByCode)) {
    const dir = keys.get('lang.dir');
    assert.ok(['ltr', 'rtl'].includes(dir), `${code} must declare lang.dir, got ${dir}`);
  }
  assert.equal(keysByCode.ar.get('lang.dir'), 'rtl');
  assert.equal(keysByCode.th.get('lang.dir'), 'ltr');
});

test('every catalogue says whether it has a flag in the sprite', () => {
  // ปุ่มภาษาเลือกระหว่าง <use> ธง กับตัวอักษรจากค่านี้ ไม่ใช่เดาจาก lang.dir —
  // ทิศทางของตัวอักษรไม่ได้บอกว่าภาษานั้นมีธงหรือเปล่า
  for (const [code, keys] of Object.entries(keysByCode)) {
    assert.equal(typeof keys.get('lang.flag'), 'boolean', `${code} must declare lang.flag`);
  }
});

test('every language claiming a flag has one drawn in the sprite', () => {
  const sprite = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'partials', 'flags.ejs'),
    'utf8',
  );
  // ธงที่อ้างถึงแต่ไม่มีใน sprite จะขึ้นเป็นกล่องสี่เหลี่ยมว่าง ๆ ทั้งบนจอและบนกระดาษ
  for (const [code, keys] of Object.entries(keysByCode)) {
    if (keys.get('lang.flag') !== true) continue;
    assert.ok(sprite.includes(`id="flag-${code}"`), `sprite has no flag for ${code}`);
  }
});

test('the Arabic flag carries the real shahada, not an imitation of the script', () => {
  const sprite = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'views', 'partials', 'flags.ejs'),
    'utf8',
  );
  const symbol = sprite.slice(sprite.indexOf('id="flag-ar"'));
  // ของจริงเป็นอักษรษุลุษซึ่งวาดเป็น path ให้ถูกต้องไม่ไหว — วาดเลียนแบบผิด ๆ
  // แย่กว่าไม่วาด จึงต้องเป็นข้อความอาหรับจริงที่เบราว์เซอร์เรนเดอร์ด้วยฟอนต์
  assert.ok(symbol.includes('لا إله إلا الله محمد رسول الله'), 'the shahada must be real Arabic text');
  // textLength บีบให้พอดีกรอบ ไม่ต้องเดาความกว้างของฟอนต์ที่เครื่องปลายทางมี
  assert.match(symbol.slice(0, symbol.indexOf('</symbol>')), /textLength=/);
});
