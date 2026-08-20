/* global window, document, fetch, FormData */
(function () {
  const root = document.getElementById('film');
  if (!root) return;

  const strings = window.I18N?.film ?? {};
  function t(key, vars) {
    const template = typeof strings[key] === 'string' ? strings[key] : key;
    if (!vars) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      Object.hasOwn(vars, name) ? String(vars[name]) : match);
  }

  const form = document.getElementById('film-form');
  const startButton = document.getElementById('film-start');
  const statusBox = document.getElementById('film-status');
  const bar = document.getElementById('film-bar');
  const phaseLine = document.getElementById('film-phase');
  const detailLine = document.getElementById('film-detail');
  const list = document.getElementById('film-list');
  const emptyLine = document.getElementById('film-empty');
  const countTag = document.getElementById('film-count');
  const musicFile = document.getElementById('film-music-file');
  const planLine = document.getElementById('film-plan');
  const themesBox = document.getElementById('film-themes');
  const pickedLine = document.getElementById('film-picked');
  const libraryEmpty = document.getElementById('film-music-empty');

  // ระหว่างงานเดินอยู่ ถามถี่หน่อยเพื่อให้แถบขยับให้เห็น ตอนว่างถามห่าง ๆ พอ
  // เพราะเปิดหน้าแอดมินค้างไว้ทั้งวันแล้วยิงทุกสองวินาทีคือการกวน NAS เปล่า ๆ
  const FAST_MS = 2500;
  const SLOW_MS = 20000;
  let timer = null;

  function schedule(ms) {
    clearTimeout(timer);
    timer = setTimeout(refresh, ms);
  }

  function phaseText(status) {
    const key = `phase_${status.phase}`;
    return typeof strings[key] === 'string' ? strings[key] : t('running');
  }

  function paint(status) {
    root.dataset.state = status.state || 'idle';
    const running = status.state === 'running';

    statusBox.hidden = !running && status.state !== 'failed' && status.state !== 'stopped';
    startButton.disabled = running || status.busyElsewhere;

    if (running) {
      const pct = status.total > 0 ? Math.round((status.done / status.total) * 100) : 0;
      bar.style.width = `${pct}%`;
      phaseLine.textContent = phaseText(status);

      const parts = [];
      if (status.total > 0) parts.push(t('progress', { done: status.done, total: status.total }));
      if (status.secondsLeft > 0) {
        parts.push(t('time_left', { minutes: Math.max(1, Math.round(status.secondsLeft / 60)) }));
      }
      if (status.counts) {
        parts.push(t('summary', {
          photos: status.counts.photos,
          videos: status.counts.videos,
          wishes: status.counts.wishes,
        }));
      }
      detailLine.textContent = parts.join(' · ');
    } else if (status.state === 'failed' || status.state === 'stopped') {
      bar.style.width = '0%';
      phaseLine.textContent = status.state === 'failed' ? t('failed') : t('stopped');
      detailLine.textContent = status.error || '';
    }

    if (status.busyElsewhere) {
      statusBox.hidden = false;
      phaseLine.textContent = t('busy_elsewhere');
      detailLine.textContent = '';
    }

    paintGallery(status.films ?? []);
    schedule(running ? FAST_MS : SLOW_MS);
  }

  /**
   * วาดรายการหนังใหม่เฉพาะเมื่อรายชื่อเปลี่ยนจริง
   *
   * ถ้าวาดใหม่ทุกครั้งที่ poll ตัวเล่นวีดีโอจะถูกสร้างใหม่ทุกไม่กี่วินาที
   * ใครที่กำลังดูหนังอยู่จะโดนดีดกลับไปเริ่มต้นใหม่ตลอดเวลา
   */
  let painted = '';
  function paintGallery(films) {
    const signature = films.map((film) => film.id).join('|');
    if (signature === painted) return;
    painted = signature;

    countTag.textContent = String(films.length);
    emptyLine.hidden = films.length > 0;
    list.textContent = '';

    for (const film of films) {
      const item = document.createElement('li');
      item.className = 'film__item';
      item.dataset.id = film.id;

      const player = document.createElement('video');
      player.className = 'film__video';
      player.controls = true;
      player.preload = 'none';
      player.playsInline = true;
      player.src = `/admin/film/${encodeURIComponent(film.id)}/video`;

      const meta = document.createElement('div');
      meta.className = 'film__meta';
      const tag = document.createElement('span');
      tag.className = 'film__tag';
      tag.textContent = t(film.style === 'wall' ? 'style_wall' : 'style_cinema');
      const when = document.createElement('span');
      when.className = 'film__note';
      when.textContent = `${new Date(film.madeAt).toLocaleString()} · ${film.size}`
        + (film.music ? ` · ${t('with_music')}` : '');
      meta.append(tag, when);

      const actions = document.createElement('div');
      actions.className = 'film__actions';
      const download = document.createElement('a');
      download.className = 'button button--tiny';
      download.href = `/admin/film/${encodeURIComponent(film.id)}/download`;
      download.setAttribute('download', '');
      download.textContent = t('download');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button--tiny button--danger film__delete';
      remove.textContent = t('delete');
      actions.append(download, remove);

      item.append(player, meta, actions);
      list.append(item);
    }
  }

  // ลบหนัง — ผูกไว้ที่รายการทั้งก้อน ปุ่มที่ถูกสร้างใหม่ทีหลังจึงใช้ได้ด้วย
  list.addEventListener('click', async (event) => {
    const button = event.target.closest('.film__delete');
    if (!button) return;

    const item = button.closest('.film__item');
    if (!item || !window.confirm(t('confirm_delete'))) return;

    button.disabled = true;
    try {
      const response = await fetch(`/admin/film/${encodeURIComponent(item.dataset.id)}/delete`, { method: 'POST' });
      if (response.ok) {
        item.remove();
        painted = '';        // บังคับให้วาดใหม่รอบหน้า จะได้นับจำนวนถูก
      } else {
        button.disabled = false;
      }
    } catch {
      button.disabled = false;
    }
    refresh();
  });

  async function refresh() {
    try {
      const response = await fetch('/admin/film/status', { headers: { accept: 'application/json' } });
      if (!response.ok) return schedule(SLOW_MS);
      paint(await response.json());
    } catch {
      // เน็ตสะดุดชั่วคราว — ลองใหม่รอบหน้า ไม่ต้องทำให้หน้าจอตกใจ
      schedule(SLOW_MS);
    }
    return undefined;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    startButton.disabled = true;

    const body = new URLSearchParams();
    for (const [key, value] of new FormData(form).entries()) body.append(key, value);

    try {
      const response = await fetch('/admin/film/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        phaseLine.textContent = payload.error || t('failed');
        statusBox.hidden = false;
        startButton.disabled = false;
        return;
      }
    } catch {
      startButton.disabled = false;
      return;
    }

    statusBox.hidden = false;
    bar.style.width = '0%';
    phaseLine.textContent = t('phase_starting');
    detailLine.textContent = '';
    schedule(800);
  });

  /* ---------- คลังเพลง กับ ตัวเลขที่โปรแกรมคิดเอง ---------- */

  const minutes = (seconds) => Math.max(1, Math.round(seconds / 60));

  function paintPicked(plan) {
    const chosen = [...themesBox.querySelectorAll('input[name="track"]:checked')];
    const have = chosen.reduce((sum, box) => sum + Number(box.dataset.seconds || 0), 0);

    if (chosen.length === 0) {
      pickedLine.textContent = t('music_none_picked');
      return;
    }
    // ขาดอยู่เท่าไรบอกไปตรง ๆ แต่ไม่ห้ามกด — ระบบวนเพลย์ลิสต์ให้เองอยู่แล้ว
    pickedLine.textContent = have >= plan.totalSeconds
      ? t('music_enough', { n: chosen.length, minutes: minutes(have) })
      : t('music_short', { n: chosen.length, minutes: minutes(have), need: minutes(plan.totalSeconds) });
  }

  let paintedLibrary = '';
  async function loadPlan() {
    let plan;
    try {
      const response = await fetch('/admin/film/plan', { headers: { accept: 'application/json' } });
      if (!response.ok) return;
      plan = await response.json();
    } catch {
      return;
    }

    planLine.textContent = t('plan_summary', {
      photos: plan.photos,
      videos: plan.videos,
      seconds: plan.secondsPerPhoto,
      minutes: minutes(plan.totalSeconds),
    });

    const signature = plan.library.map((group) => `${group.theme}:${group.tracks.length}`).join('|');
    if (signature !== paintedLibrary) {
      paintedLibrary = signature;
      themesBox.textContent = '';
      libraryEmpty.hidden = plan.library.length > 0;

      for (const group of plan.library) {
        const box = document.createElement('details');
        box.className = 'film__theme';
        const head = document.createElement('summary');
        const label = window.I18N?.film?.[`theme_${group.theme}`] ?? group.theme;
        head.textContent = `${label} · ${t('theme_summary', {
          n: group.tracks.length, minutes: minutes(group.seconds),
        })}`;
        box.append(head);

        for (const track of group.tracks) {
          const row = document.createElement('label');
          row.className = 'film__track';
          const tick = document.createElement('input');
          tick.type = 'checkbox';
          tick.name = 'track';
          tick.value = track.id;
          tick.dataset.seconds = String(track.seconds);
          const text = document.createElement('span');
          const mm = Math.floor(track.seconds / 60);
          const ss = String(track.seconds % 60).padStart(2, '0');
          text.textContent = `${track.title} · ${mm}:${ss}`;
          row.append(tick, text);
          box.append(row);
        }
        themesBox.append(box);
      }
    }

    paintPicked(plan);
    themesBox.onchange = () => paintPicked(plan);
  }

  musicFile.addEventListener('change', async () => {
    const file = musicFile.files?.[0];
    if (!file) return;

    const body = new FormData();
    body.append('music', file);
    try {
      await fetch('/admin/film/music', { method: 'POST', body });
    } finally {
      musicFile.value = '';
      paintedLibrary = '';   // บังคับให้วาดคลังใหม่ จะได้เห็นเพลงที่เพิ่งอัพ
      loadPlan();
    }
  });

  loadPlan();
  refresh();
}());
