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
  const result = document.getElementById('film-result');
  const video = document.getElementById('film-video');
  const madeLine = document.getElementById('film-made');
  const musicName = document.getElementById('film-music-name');
  const musicFile = document.getElementById('film-music-file');
  const musicRemove = document.getElementById('film-music-remove');
  const useMusic = document.getElementById('film-use-music');

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

    // หนังพร้อมแล้ว — โชว์ตัวเล่นทันทีโดยไม่ต้องให้ผู้ใช้รีเฟรชหน้าเอง
    if (status.film) {
      result.hidden = false;
      // ต่อท้ายด้วยเวลาที่ทำเสร็จ บังคับให้เบราว์เซอร์โหลดของใหม่หลังสร้างซ้ำ
      const fresh = `/admin/film/video?v=${encodeURIComponent(status.film.madeAt)}`;
      if (video.getAttribute('src') !== fresh) video.setAttribute('src', fresh);
      madeLine.textContent = `${t('made_at', { when: new Date(status.film.madeAt).toLocaleString() })} · ${status.film.size}`;
      startButton.textContent = t('rebuild');
    }

    if (status.music) {
      musicName.textContent = `${status.music.name} · ${status.music.size}`;
      musicRemove.hidden = false;
    } else {
      musicName.textContent = t('music_none');
      musicRemove.hidden = true;
      useMusic.checked = false;
      useMusic.disabled = true;
    }
    if (status.music) useMusic.disabled = false;

    schedule(running ? FAST_MS : SLOW_MS);
  }

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

  musicFile.addEventListener('change', async () => {
    const file = musicFile.files?.[0];
    if (!file) return;

    musicName.textContent = window.I18N?.common?.loading ?? '…';
    const body = new FormData();
    body.append('music', file);

    try {
      const response = await fetch('/admin/film/music', { method: 'POST', body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        musicName.textContent = payload.error || t('music_none');
        return;
      }
      useMusic.disabled = false;
      useMusic.checked = true;
    } finally {
      musicFile.value = '';
      refresh();
    }
  });

  musicRemove.addEventListener('click', async () => {
    await fetch('/admin/film/music/delete', { method: 'POST' }).catch(() => {});
    refresh();
  });

  refresh();
})();
