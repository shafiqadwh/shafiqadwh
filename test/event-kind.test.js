import assert from 'node:assert/strict';
import test from 'node:test';
import { EVENT_KINDS, config } from '../src/config.js';
import { translator } from '../src/i18n.js';

/**
 * งานนี้ไม่ได้เป็นงานแต่งเสมอไป
 *
 * `translator()` ประกอบคีย์เป็น `<คีย์>_<ประเภทงาน>` ให้เอง จุดที่เรียก `t()`
 * กว่ายี่สิบแห่งจึงไม่ต้องรู้เลยว่างานนี้เป็นงานอะไร · เทสต์ชุดนี้กันสองอย่าง
 * ที่พังเงียบได้: (1) งานแต่งซึ่งเป็นค่าเริ่มต้นต้องได้คำเดิมเป๊ะ ไม่ใช่คำกลาง ๆ
 * ชุดใหม่ (2) ประเภทงานที่ยังไม่ได้แปลคำไหน ต้องตกกลับไปคำกลาง ไม่ใช่ขึ้นชื่อคีย์ดิบ
 */

test('a wedding reads exactly as it did before event kinds existed', () => {
  const t = translator('th', 'wedding');
  assert.equal(t('site.welcome'), 'ยินดีต้อนรับสู่งานแต่งงานของเรา');

  // ค่าเริ่มต้นของระบบต้องเป็นงานแต่ง — .env ที่ใช้อยู่จริงไม่มี EVENT_KIND
  assert.equal(EVENT_KINDS[0], 'wedding');
  assert.equal(config.event.kind, 'wedding');
  assert.equal(translator('th')('site.welcome'), t('site.welcome'));
});

test('another kind of event picks up its own wording', () => {
  assert.equal(translator('th', 'birthday')('site.welcome'), 'ยินดีต้อนรับสู่งานวันเกิด');
  assert.equal(translator('th', 'graduation')('site.welcome'), 'ยินดีต้อนรับสู่งานฉลองรับปริญญา');
  assert.equal(translator('th', 'engagement')('site.welcome'), 'ยินดีต้อนรับสู่งานหมั้นของเรา');

  // ทุกภาษาต้องเปลี่ยนตาม ไม่ใช่แค่ภาษาไทย
  for (const code of ['ms', 'en', 'ar']) {
    const wedding = translator(code, 'wedding')('site.welcome');
    const birthday = translator(code, 'birthday')('site.welcome');
    assert.notEqual(birthday, wedding, `${code} ยังใช้คำของงานแต่งอยู่`);
    assert.notEqual(birthday.trim(), '');
  }
});

test('a word with no version for this kind falls back to the plain one', () => {
  // `site.share_hint` มีเฉพาะของวันเกิดกับรับปริญญา · งานหมั้นต้องได้คำกลาง
  const plain = translator('th', 'wedding')('site.share_hint');
  assert.equal(translator('th', 'engagement')('site.share_hint'), plain);
  assert.notEqual(translator('th', 'birthday')('site.share_hint'), plain);
});

test('no kind ever leaves a raw key on the page', () => {
  // ถ้าคีย์หาไม่เจอเลย `t()` คืนชื่อคีย์ ซึ่งขึ้นหน้าเว็บเป็น "site.welcome"
  // ให้แขกอ่าน — ไล่ทุกประเภทงาน × ทุกภาษาให้แน่ใจว่าไม่มีช่องไหนหลุด
  for (const kind of EVENT_KINDS) {
    for (const code of ['th', 'ms', 'en', 'ar']) {
      for (const key of ['site.welcome', 'site.share_hint']) {
        const value = translator(code, kind)(key);
        assert.notEqual(value, key, `${code}/${kind} ไม่มีคำแปลของ ${key}`);
      }
    }
  }
});

test('an unknown kind is ignored rather than trusted', () => {
  // ค่าใน .env พิมพ์ผิดได้ · ต้องได้คำของงานแต่งกลับมา ไม่ใช่คีย์ดิบ
  const plain = translator('th', 'wedding')('site.welcome');
  assert.equal(translator('th', 'birthdya')('site.welcome'), plain);
  assert.equal(translator('th', '')('site.welcome'), plain);
});
