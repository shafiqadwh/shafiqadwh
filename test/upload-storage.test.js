import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('blocked browser storage does not prevent upload controls from binding', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value: 'Guest', events: {},
      addEventListener(name, handler) { this.events[name] = handler; } });
    return elements.get(id);
  };
  const code = await fs.readFile(new URL('../public/js/upload.js', import.meta.url), 'utf8');
  vm.runInNewContext(code, { window: {}, document: { getElementById: get },
    localStorage: { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } },
    URL, Set, Array, console });
  assert.equal(typeof get('file-input').events.change, 'function');
  assert.equal(typeof get('upload-confirm').events.click, 'function');
  assert.doesNotThrow(() => get('uploader-name').events.change());
});

test('a wish can be submitted even when saving its author name is blocked', async () => {
  const elements = new Map();
  const get = id => {
    if (!elements.has(id)) elements.set(id, { value:'Guest message', events:{}, files:[],
      classList:{ toggle() {} }, addEventListener(name, fn) { this.events[name]=fn; } });
    return elements.get(id);
  };
  let posts=0;
  const code=await fs.readFile(new URL('../public/js/guestbook.js', import.meta.url),'utf8');
  vm.runInNewContext(code, { window:{}, document:{getElementById:get}, FormData,
    localStorage:{getItem(){throw new Error('SecurityError');},setItem(){throw new Error('SecurityError');}},
    fetch:async (url,options)=>{ if(options?.method==='POST') posts++; return {ok:true,json:async()=>({messages:[]})}; } });
  await get('message-form').events.submit({preventDefault(){}});
  assert.equal(posts,1);
  assert.equal(get('message-body').value,'');
  assert.equal(get('message-submit').disabled,false);
});
