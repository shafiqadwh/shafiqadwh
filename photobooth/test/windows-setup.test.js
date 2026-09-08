import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

/**
 * สคริปต์ตั้งบูธบน Windows — ตรวจด้วยการ **อ่าน** ไม่ใช่รัน
 *
 * ⚠️ ข้อจำกัดที่ต้องบอกตรง ๆ: เครื่องที่รันเทสต์นี้เป็น Linux และไม่มี PowerShell
 * เลย (ตรวจแล้ว ไม่มีทั้ง `pwsh` และ `powershell`) · เทสต์นี้จึงพิสูจน์ **ไม่ได้**
 * ว่าสคริปต์รันผ่าน ตัวตัดสินนั้นยังเป็นการรันบนเครื่อง Windows จริงหนึ่งครั้ง
 *
 * สิ่งที่มันกันได้จริงคือข้อที่ **อ่านออกจากตัวอักษรและพลาดได้ง่ายที่สุด**: สองสคริปต์
 * ที่พูดถึงพาธคนละพาธกัน · ตัวถอนที่ลบรูปของลูกค้าไปด้วย · ตัววนเปิดใหม่ที่ไม่มีเพดาน
 * ทั้งสามข้อนี้แก้ทีหลังไม่ได้เมื่อเกิดแล้ว และไม่มีใครเห็นตอนอ่านผ่าน ๆ
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const scripts = path.join(here, '..', 'scripts');

const read = (name) => fs.readFile(path.join(scripts, name), 'utf8');

/** บรรทัดที่ประกาศพาธ — ตัวที่สองสคริปต์ต้องเหมือนกันทุกตัวอักษร */
const pathLines = (text) => text
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => /^\$(booth|startup|launcher|shortcut)\s*=/.test(line));

test('the setup and remove scripts talk about exactly the same paths', async () => {
  /*
   * ตัวถอนที่ลบ "พาธอื่นที่หน้าตาคล้ายกัน" คือตัวถอนที่บอกว่าเรียบร้อยแล้วโดยไม่ได้
   * ถอนอะไรเลย — ล็อกอินครั้งถัดไปบูธก็ยังเด้งขึ้นมา และเจ้าของจะหาไม่เจอว่ามันมาจากไหน
   * (ทางลัดใน Startup เป็นที่ที่ไม่มีใครนึกถึง)
   */
  const setup = pathLines(await read('windows-setup.ps1'));
  const remove = pathLines(await read('windows-remove.ps1'));

  assert.equal(setup.length, 4, 'สคริปต์ตั้งต้องประกาศพาธครบสี่ตัว');
  assert.deepEqual(remove, setup, 'สองสคริปต์ต้องคิดพาธด้วยนิพจน์เดียวกันทุกตัวอักษร');
});

test('the remove script never touches the guests photos, settings or sales book', async () => {
  /*
   * ของที่อยู่ใน `%APPDATA%\photobooth\booth\` คือรูปของแขก ค่าตั้งของงาน และสมุดบัญชี
   * — **งานของลูกค้า ไม่ใช่ของสคริปต์** · ตัวถอนมีหน้าที่เอา "การเปิดเอง" ออก
   * ไม่ใช่ล้างเครื่อง · ลบพลาดตรงนี้คือรูปของคืนนั้นที่ไม่มีวันถ่ายซ้ำได้
   */
  const remove = await read('windows-remove.ps1');

  // ดูเฉพาะ **บรรทัดที่ลบของ** · ชื่อโฟลเดอร์ข้อมูลโผล่ในข้อความที่พิมพ์บอกผู้ใช้ได้
  // (และควรโผล่ด้วย — คนอ่านต้องรู้ว่าของตัวเองยังอยู่ที่ไหน) นั่นไม่ใช่การลบ
  const deleting = remove.split('\n').filter((line) => /Remove-Item|\brm\b|\bdel\b/i.test(line));
  for (const danger of [/-Recurse/i, /APPDATA/i, /sessions/i, /sales/i]) {
    for (const line of deleting) {
      assert.doesNotMatch(line, danger, `บรรทัดที่ลบของต้องไม่มี ${danger}: ${line.trim()}`);
    }
  }

  // ลบได้แค่สองไฟล์ที่ตัวตั้งสร้างไว้ ไม่มีอย่างอื่น
  const removals = [...remove.matchAll(/Remove-Item\s+(\S+)/g)].map(([, target]) => target);
  assert.deepEqual(removals.sort(), ['$launcher', '$shortcut']);
});

test('the remove script takes the shortcut away before the launcher it points at', async () => {
  /*
   * ลำดับสำคัญ: ลบตัวเปิดก่อนแล้วสคริปต์ล้มกลางทาง (ดิสก์เต็ม ไฟล์ถูกล็อก) จะเหลือ
   * ทางลัดที่ชี้ไปที่ไฟล์ที่ไม่มีอยู่ — ล็อกอินทีหน้าต่าง error เด้งขึ้นมาทุกครั้ง
   * โดยไม่มีบูธให้ใช้ ซึ่งแย่กว่าทั้งสองสถานะที่ตั้งใจ (มีบูธ / ไม่มีบูธ)
   */
  const remove = await read('windows-remove.ps1');
  assert.ok(
    remove.indexOf('Remove-Item $shortcut') < remove.indexOf('Remove-Item $launcher'),
    'ต้องลบทางลัดก่อนลบตัวเปิดที่มันชี้ไป',
  );
});

test('the launcher restarts the booth, but not forever', async () => {
  /*
   * บูธเปิดค้างทั้งคืนโดยไม่มีใครนั่งเฝ้า ปิดไปเองเมื่อไรต้องกลับมาเอง — **แต่ต้องมี
   * เพดาน** · โปรแกรมที่ปิดทันทีทุกครั้งเพราะตั้งค่าผิด (หาไฟล์ไม่เจอ, Node หาย)
   * จะกลายเป็นเครื่องที่หมุนอยู่อย่างนั้นทั้งคืนโดยไม่มีอะไรบนจอบอกว่าเกิดอะไรขึ้น
   * ชนเพดานแล้วต้อง **หยุดพร้อมข้อความค้างไว้บนจอ** ไม่ใช่หยุดเงียบ ๆ
   */
  const setup = await read('windows-setup.ps1');

  assert.match(setup, /goto run/, 'ต้องมีการวนเปิดใหม่');
  assert.match(setup, /GEQ 10/, 'ต้องมีเพดานจำนวนครั้ง');
  assert.match(setup, /^\s*pause\s*$/m, 'ชนเพดานแล้วต้องค้างข้อความไว้ให้คนอ่าน ไม่ใช่ปิดเงียบ ๆ');
  assert.match(setup, /timeout \/t \d+/, 'ต้องรอระหว่างรอบ ไม่ใช่วนรัว ๆ');
});

test('neither script asks for administrator, and the setup checks Node before npm', async () => {
  const setup = await read('windows-setup.ps1');
  const remove = await read('windows-remove.ps1');

  /*
   * ไม่ต้องใช้สิทธิ์ผู้ดูแลเลยแม้แต่ที่เดียว — ทุกอย่างอยู่ในบัญชีผู้ใช้คนนี้
   * (โฟลเดอร์ Startup ของตัวเอง, โฟลเดอร์โปรแกรมของตัวเอง, powercfg ของ scheme
   * ที่ใช้อยู่) · สคริปต์ที่ขอสิทธิ์ผู้ดูแลคือสคริปต์ที่คนกดผ่าน ๆ โดยไม่อ่าน
   */
  for (const [name, text] of [['ตั้ง', setup], ['ถอน', remove]]) {
    assert.doesNotMatch(text, /RunAs|Administrator'\)|#Requires -RunAsAdmin/i,
      `สคริปต์${name}ต้องไม่ขอสิทธิ์ผู้ดูแล`);
  }

  // ตรวจ Node ก่อน npm install — ไม่งั้น npm install จะล้มด้วยข้อความที่อ่านไม่ออก
  // ว่าเกี่ยวกับอะไร แล้วคนที่ตั้งบูธอยู่จะไปหาสาเหตุผิดที่
  // เทียบตำแหน่งของ **คำสั่งจริง** ไม่ใช่ของคำว่า "npm install" ที่โผล่ในคอมเมนต์ก่อนด้วย
  const at = (text, pattern) => text.search(pattern);
  assert.ok(at(setup, /^\s*\$node = \(node --version\)/m) < at(setup, /^\s*npm install /m),
    'ต้องตรวจเวอร์ชัน Node ก่อนสั่ง npm install');
});
