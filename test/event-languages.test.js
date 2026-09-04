import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, test } from 'node:test';
import { startTestServer, useTempDataDir } from './helpers/app.js';

/**
 * ชุดภาษาเป็นของ **งาน** ไม่ใช่ของเครื่อง
 *
 * ตอนที่ระบบรับงานเดียว การตั้งภาษาไว้ใน `.env` ก็พอ · พอเครื่องเดียวรับงานของ
 * ลูกค้าหลายรายพร้อมกัน มันกลายเป็นค่าที่ผิดสำหรับทุกงานพร้อมกัน — งานปัจฉิม
 * โรงเรียนในยะลาไม่ต้องมีปุ่มภาษาอาหรับให้นักเรียนกดพลาดแล้วอ่านไม่ออก
 * ส่วนงานแต่งฝั่งมาเลย์ต้องขึ้นภาษามลายูก่อน ไม่ใช่ไทย
 *
 * ข้อที่ตรึงไว้แน่นที่สุดคือข้อสุดท้าย: **คุกกี้ภาษาจากงานก่อนหน้าต้องไม่ตามมา**
 * แขกคนเดียวไปหลายงานที่เราจัดให้ในเดือนเดียวกันเป็นเรื่องปกติ ถ้าคุกกี้ตามมา
 * เขาจะเจอหน้าเว็บในภาษาที่งานนี้ไม่มีปุ่มให้กดสลับกลับ
 */

const dataDir = useTempDataDir('event-languages');
const app = await startTestServer();

const { createEvent, setEventPassword, updateEvent } = await import('../src/lib/tenancy.js');

createEvent({ slug: 'school', title: 'ปัจฉิม ม.6', languages: ['th'] });
createEvent({ slug: 'kahwin', title: 'Majlis Kahwin', languages: ['ms', 'en'] });

const SCHOOL_PASSWORD = 'school-admin-password';
setEventPassword('school', SCHOOL_PASSWORD);

const login = async (slug) => {
  const response = await fetch(`${app.baseUrl}/admin/login?event=${slug}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: SCHOOL_PASSWORD }),
    redirect: 'manual',
  });
  const jar = response.headers.getSetCookie().find((one) => one.startsWith('admin_session='));
  return { cookie: jar ? jar.split(';')[0] : null };
};

after(async () => {
  await app.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

const visit = async (slug, { headers = {} } = {}) => {
  const response = await fetch(`${app.baseUrl}/?event=${slug}`, { headers });
  return { status: response.status, html: await response.text(), headers: response.headers };
};

/** รหัสภาษาที่มีปุ่มให้กดบนหน้านั้นจริง ๆ */
const buttons = (html) => [...html.matchAll(/[?&]lang=([a-z]{2})\b/g)].map((one) => one[1])
  .filter((code, index, all) => all.indexOf(code) === index);

const pageLang = (html) => html.match(/<html[^>]*\blang="([^"]+)"/)?.[1] ?? null;

test('an event that names no languages keeps every one of them, exactly as before', async () => {
  // งานทุกงานที่มีอยู่วันนี้เป็นแบบนี้ — การอัปเดตขึ้นเวอร์ชันนี้ต้องไม่เปลี่ยนอะไรเลย
  const { html } = await visit('main');
  assert.deepEqual(buttons(html).sort(), ['ar', 'en', 'ms', 'th']);
});

test('an event that names its languages shows only those', async () => {
  assert.deepEqual(buttons((await visit('school')).html), ['th']);
  assert.deepEqual(buttons((await visit('kahwin')).html), ['ms', 'en']);
});

test('the first language on the list is the one a new guest lands on', async () => {
  // แขกที่เครื่องตั้งภาษาที่งานนี้ไม่มี ต้องได้ภาษาหลักของงาน ไม่ใช่ค่าของทั้งเครื่อง
  const { html } = await visit('kahwin', { headers: { 'accept-language': 'ja,ko;q=0.9' } });
  assert.equal(pageLang(html), 'ms');
});

test('a guest gets their own next choice when the first one is not on offer', async () => {
  /*
   * เบราว์เซอร์ส่ง "ไทยก่อน อังกฤษรอง" มาที่งานที่เปิดมลายูกับอังกฤษ
   * ต้องได้ **อังกฤษ** ซึ่งเป็นตัวเลือกถัดไปของแขกเอง ไม่ใช่มลายูซึ่งเป็นภาษาหลัก
   * ของงาน — ตกไปที่ภาษาหลักทันทีที่ตัวเลือกแรกไม่ผ่าน คือการทิ้งข้อมูลที่แขกบอกมาแล้ว
   */
  const { html } = await visit('kahwin', { headers: { 'accept-language': 'th,en;q=0.8' } });
  assert.equal(pageLang(html), 'en');
});

test('asking for a language the event does not offer does not force it on', async () => {
  // ลิงก์เก่าหรือคนพิมพ์เอง — ต้องได้ภาษาของงาน ไม่ใช่หน้าที่ไม่มีปุ่มกดกลับ
  const { html } = await visit('school', { headers: {} });
  assert.equal(pageLang(html), 'th');

  const forced = await fetch(`${app.baseUrl}/?event=school&lang=ar`);
  assert.equal(pageLang(await forced.text()), 'th');
  // และต้องไม่ตั้งคุกกี้ให้ภาษาที่งานนี้ไม่ได้เปิดด้วย
  assert.equal(
    forced.headers.getSetCookie().some((one) => one.startsWith('lang=ar')),
    false,
  );
});

test('a language cookie from another event does not follow the guest', async () => {
  /*
   * แขกคนเดียวไปงานที่เราจัดให้หลายงานในเดือนเดียวกัน — คุกกี้ `lang` เป็นของ
   * โดเมนกลาง ไม่ใช่ของงาน · ถ้ามันตามมา แขกจะเปิดหน้างานที่สองแล้วเจอภาษาที่
   * งานนั้นไม่มีปุ่มให้กดสลับกลับเลย ซึ่งคือทางตันที่ไม่มีใครแก้ให้ได้หน้างาน
   */
  const { html } = await visit('school', { headers: { cookie: 'lang=ar' } });
  assert.equal(pageLang(html), 'th');
  assert.deepEqual(buttons(html), ['th']);
});

test('a language set that is nonsense falls back to everything, not to nothing', async () => {
  // พิมพ์ผิดหนึ่งตัวแล้วปุ่มภาษาหายทั้งแถบ แย่กว่ามีปุ่มเกินมาหนึ่งปุ่ม
  updateEvent('school', { languages: ['zz', 'klingon'] });
  assert.deepEqual(buttons((await visit('school')).html).sort(), ['ar', 'en', 'ms', 'th']);

  updateEvent('school', { languages: ['th'] });
  assert.deepEqual(buttons((await visit('school')).html), ['th']);
});

test('the printed QR card carries this event\'s languages, not all of them', async () => {
  /*
   * การ์ด QR พิมพ์ทุกภาษาพร้อมกันโดยตั้งใจ — แขกยังไม่ได้สแกน จึงยังเลือกภาษาไม่ได้
   * แต่ "ทุกภาษา" ต้องหมายถึงทุกภาษา **ของงานนี้** · งานที่ตั้งไว้ภาษาเดียวแล้วยัง
   * พิมพ์สี่ภาษา คือกระดาษที่เสียไปสามในสี่ และ QR ที่เล็กลงในแบบ 4 ใบต่อแผ่น
   */
  const { cookie } = await login('school');
  const response = await fetch(`${app.baseUrl}/admin/qr?event=school`, { headers: { cookie } });
  const html = await response.text();
  assert.equal(response.status, 200);

  const blocks = [...html.matchAll(/class="qr-card__block"[^>]*\blang="([a-z]{2})"/g)]
    .map((one) => one[1]);
  assert.deepEqual([...new Set(blocks)], ['th']);
});

test('what gets stored is only what was picked, so a new language reaches old events', async () => {
  /*
   * "ไม่ระบุ" กับ "ระบุครบทุกภาษา" ต้องเก็บต่างกัน — วันที่ระบบเพิ่มภาษาที่ห้า
   * งานที่ไม่ได้ระบุจะได้เอง ส่วนงานที่ระบุไว้สี่ภาษาจะไม่ได้ ซึ่งถูกทั้งคู่
   * ถ้าเก็บเหมือนกันก็ตอบคำถามนี้ไม่ได้อีกเลย
   */
  const { registry } = await import('../src/lib/tenancy.js');
  const stored = (slug) => registry().prepare('SELECT languages FROM events WHERE slug = ?').get(slug);

  assert.equal(stored('main').languages, null, 'งานที่ไม่ได้ระบุต้องเก็บเป็นค่าว่าง');
  assert.equal(stored('kahwin').languages, 'ms,en', 'ลำดับที่เลือกไว้คือลำดับที่แสดง');

  updateEvent('kahwin', { languages: [] });
  assert.equal(stored('kahwin').languages, null);
  updateEvent('kahwin', { languages: ['ms', 'en'] });
});
