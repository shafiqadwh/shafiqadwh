/* global window, document, fetch */
(function () {
  const root = document.getElementById('paper');
  if (!root) return;

  const strings = window.I18N?.paper ?? {};
  function t(key, vars) {
    const template = typeof strings[key] === 'string' ? strings[key] : key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match);
  }

  const statusBox = document.getElementById('paper-status');
  const bar = document.getElementById('paper-bar');
  const phaseLine = document.getElementById('paper-phase');
  const list = document.getElementById('paper-list');
  const emptyLine = document.getElementById('paper-empty');
  const countTag = document.getElementById('paper-count');
  const buttons = [...root.querySelectorAll('[data-paper-kind]')];

  // ระหว่างงานเดินอยู่ถามถี่พอให้แถบขยับ ตอนว่างถามห่าง ๆ — หน้าแอดมินถูกเปิดค้าง
  // ไว้ทั้งวัน การยิงทุกสองวินาทีตลอดเวลาคือการกวน NAS เปล่า ๆ
  const FAST_MS = 2500;
  const SLOW_MS = 20000;
  let timer = null;

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  function paint(status) {
    root.dataset.state = status.state || 'idle';
    const running = status.state === 'running';

    statusBox.hidden = !running && status.state !== 'failed' && status.state !== 'stopped';
    for (const button of buttons) button.disabled = running;

    if (running) {
      const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      const parts = [t('running')];
      if (status.total > 0) parts.push(t('progress', { done: status.done, total: status.total }));
      phaseLine.textContent = parts.join(' · ');
    } else if (status.state === 'failed' || status.state === 'stopped') {
      bar.style.width = '0%';
      phaseLine.textContent = `${status.state === 'failed' ? t('failed') : t('stopped')}${status.error ? ` · ${status.error}` : ''}`;
    }

    paintGallery(status.papers ?? []);
    schedule(running ? FAST_MS : SLOW_MS);
  }

  /**
   * วาดรายการใหม่เฉพาะเมื่อรายชื่อเปลี่ยนจริง — แบบเดียวกับแผงหนัง
   * วาดใหม่ทุกรอบ poll จะทำให้ปุ่มที่กำลังจะกดกระพริบหายไปใต้นิ้ว
   */
  let painted = '';
  function paintGallery(papers) {
    const signature = papers.map((paper) => paper.id).join('|');
    if (signature === painted) return;
    painted = signature;

    countTag.textContent = String(papers.length);
    emptyLine.hidden = papers.length > 0;
    list.textContent = '';

    for (const paper of papers) {
      const item = document.createElement('li');
      item.className = 'film__item';
      item.dataset.id = paper.id;

      const meta = document.createElement('div');
      meta.className = 'film__meta';
      const tag = document.createElement('span');
      tag.className = 'film__tag';
      tag.textContent = t(paper.kind === 'uploaders' ? 'kind_uploaders' : 'kind_wishes');
      const when = document.createElement('span');
      when.className = 'film__note';
      when.textContent = `${new Date(paper.madeAt).toLocaleString()} · ${paper.size}`
        + (paper.pages ? ` · ${t('pages', { n: paper.pages })}` : '');
      meta.append(tag, when);

      const actions = document.createElement('div');
      actions.className = 'film__actions';
      const open = document.createElement('a');
      open.className = 'button button--tiny';
      open.href = `/admin/paper/${encodeURIComponent(paper.id)}/view`;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = t('open');
      const download = document.createElement('a');
      download.className = 'button button--tiny';
      download.href = `/admin/paper/${encodeURIComponent(paper.id)}/download`;
      download.setAttribute('download', '');
      download.textContent = t('download');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button--tiny button--danger paper__delete';
      remove.textContent = t('delete');
      actions.append(open, download, remove);

      item.append(meta, actions);
      list.append(item);
    }
  }

  // ลบ — ผูกไว้ที่รายการทั้งก้อน ปุ่มที่ถูกสร้างใหม่ทีหลังจึงใช้ได้ด้วย
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('.paper__delete');
    if (!button) return;

    const item = button.closest('.film__item');
    if (!item || !window.confirm(t('confirm_delete'))) return;

    button.disabled = true;
    try {
      const response = await fetch(`/admin/paper/${encodeURIComponent(item.dataset.id)}/delete`, { method: 'POST' });
      if (response.ok) {
        item.remove();
        painted = ''; // บังคับให้วาดใหม่รอบหน้า จะได้นับจำนวนถูก
      } else {
        button.disabled = false;
      }
    } catch {
      button.disabled = false;
    }
    refresh();
  });

  for (const button of buttons) {
    button.addEventListener('click', async () => {
      for (const other of buttons) other.disabled = true;
      statusBox.hidden = false;
      bar.style.width = '0%';
      phaseLine.textContent = t('running');

      try {
        const response = await fetch('/admin/paper/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({ kind: button.dataset.paperKind }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          phaseLine.textContent = payload.error || t('failed');
          for (const other of buttons) other.disabled = false;
        }
      } catch {
        phaseLine.textContent = t('failed');
        for (const other of buttons) other.disabled = false;
      }
      schedule(600);
    });
  }

  async function refresh() {
    try {
      const response = await fetch('/admin/paper/status', { headers: { accept: 'application/json' } });
      if (!response.ok) return schedule(SLOW_MS);
      paint(await response.json());
    } catch {
      // เน็ตสะดุดชั่วคราว — ลองใหม่รอบหน้า
      schedule(SLOW_MS);
    }
    return undefined;
  }

  schedule(SLOW_MS);
}());

/* ช่องค้นหาชื่อแขก — กรองแถวที่เรนเดอร์มาแล้วในหน้า ไม่ยิง API ทุกตัวอักษร */
(function () {
  const box = document.getElementById('guests-search');
  const list = document.getElementById('guests-list');
  const none = document.getElementById('guests-none');
  if (!box || !list) return;

  const rows = [...list.querySelectorAll('.guests__row')];

  box.addEventListener('input', () => {
    // เทียบแบบเดียวกับฝั่งเซิร์ฟเวอร์: ตัดหัวท้าย ยุบช่องว่าง ตัวพิมพ์เล็ก
    const needle = box.value.trim().replace(/\s+/g, ' ').toLowerCase();
    let shown = 0;
    for (const row of rows) {
      const hit = needle === '' || row.dataset.name.includes(needle);
      row.hidden = !hit;
      if (hit) shown += 1;
    }
    none.hidden = shown > 0 || rows.length === 0;
  });
}());
