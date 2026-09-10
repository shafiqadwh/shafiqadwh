import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { DEFAULTS, normaliseSettings } from '../src/main/settings.js';

async function form() {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value:'', checked:false, hidden:false, options:[], events:{},
      addEventListener(name, fn) { this.events[name] = fn; }, append(option) { this.options.push(option); },
      querySelector() { return null; }, focus() {} });
    return elements.get(id);
  };
  get('deliver').options = ['print','screen','both'].map(value => ({ value }));
  let stored = normaliseSettings({ ...DEFAULTS, eventTitle:'Existing event', baseUrl:'', uploadKey:'' });
  let saves = 0;
  const body = { dataset:{} };
  const source = await fs.readFile(new URL('../src/renderer/setup.js', import.meta.url), 'utf8');
  const context = vm.createContext({ URL, CSS:{ escape:x=>x }, document:{ body, getElementById:get, createElement:()=>({}) },
    window:{ booth:{ settings:async()=>({ settings:stored, canPublish:false, themes:[], templates:[] }),
      printers:async()=>[], save:async patch=>{ saves++; stored=normaliseSettings({...stored,...patch}); return stored; },
      checkConnection:async()=>({ok:true}) } } });
  vm.runInContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(body.dataset.ready, '1');
  return { get, read:()=>stored, saves:()=>saves };
}
test('connection can be configured and screen delivery saved from the form', async () => {
  const app = await form();
  assert.equal(app.get('deliver').options[1].disabled, true);
  app.get('baseUrl').value='https://photos.example.com';
  app.get('uploadKey').value='valid-demo-key-123456';
  app.get('uploadKey').events.input();
  assert.equal(app.get('deliver').options[1].disabled, false);
  app.get('deliver').value='screen';
  await app.get('check-connection').events.click();
  assert.match(app.get('connection-note').textContent,/เชื่อมต่อสำเร็จ/);
  await app.get('save').events.click();
  assert.equal(app.read().deliver,'screen');
  assert.equal(app.read().baseUrl,'https://photos.example.com');
  assert.equal(app.read().eventTitle,'Existing event');
});
test('invalid connection does not overwrite existing settings or silently enable delivery', async () => {
  const app = await form();
  app.get('baseUrl').value='https://photos.example.com/?event=other';
  app.get('uploadKey').value='valid-demo-key-123456';
  await app.get('save').events.click();
  assert.equal(app.saves(),0);
  assert.match(app.get('status').textContent,/ตรวจที่อยู่เว็บ/);
});
