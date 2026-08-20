/* global window, document, fetch */
(function () {
  const strings = window.I18N ?? {};

  function t(path, vars) {
    const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings);
    if (typeof value !== 'string') return path;
    return vars ? value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : value;
  }

  const grid = document.getElementById('grid');
  if (!grid) return;

  const countLine = document.getElementById('gallery-count');
  const emptyBox = document.getElementById('empty');
  const loadMore = document.getElementById('load-more');
  const newItemsButton = document.getElementById('new-items');

  const lightbox = document.getElementById('lightbox');
  const stage = document.getElementById('lightbox-stage');
  const caption = document.getElementById('lightbox-caption');
  const downloadLink = document.getElementById('lightbox-download');

  // ชื่อที่กำลังกรองอยู่มาจากเซิร์ฟเวอร์ ไม่ได้อ่านจาก URL เอง — ค่าที่เซิร์ฟเวอร์
  // normalise แล้วเท่านั้นที่ตรงกับที่ API ใช้เทียบ
  const who = document.getElementById('grid')?.dataset.who || '';
  const state = { filter: 'all', items: [], nextBefore: null, maxId: 0, index: -1, loading: false };

  function formatDuration(seconds) {
    if (!seconds) return '';
    const total = Math.round(seconds);
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }

  function tile(item, position) {
    const button = document.createElement('button');
    button.className = 'tile';
    button.type = 'button';
    button.dataset.index = String(position);

    if (item.thumbUrl) {
      const img = document.createElement('img');
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = item.thumbUrl;
      img.alt = item.uploader ? t('gallery.by', { name: item.uploader }) : t('gallery.anonymous');
      button.appendChild(img);
    }

    if (item.kind === 'video') {
      const badge = document.createElement('span');
      badge.className = 'tile__badge';
      badge.textContent = `▶ ${formatDuration(item.duration)}`.trim();
      button.appendChild(badge);
    }

    if (item.uploader) {
      const by = document.createElement('span');
      by.className = 'tile__by';
      by.textContent = item.uploader;
      button.appendChild(by);
    }

    button.addEventListener('click', () => openLightbox(Number(button.dataset.index)));
    return button;
  }

  function render(items, { append }) {
    if (!append) {
      grid.innerHTML = '';
      state.items = [];
    }
    const offset = state.items.length;
    items.forEach((item, i) => grid.appendChild(tile(item, offset + i)));
    state.items = state.items.concat(items);

    emptyBox.hidden = state.items.length > 0;
    loadMore.hidden = !state.nextBefore;
    if (state.items.length) {
      state.maxId = Math.max(state.maxId, ...state.items.map((item) => item.id));
    }
  }

  async function load({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;

    const params = new URLSearchParams({ filter: state.filter });
    if (who) params.set('who', who);
    if (append && state.nextBefore) params.set('before', String(state.nextBefore));

    try {
      const response = await fetch(`/api/items?${params}`);
      const payload = await response.json();
      state.nextBefore = payload.nextBefore;
      render(payload.items, { append });
      countLine.textContent = t('gallery.count', { n: payload.total });
    } catch {
      // Keep whatever is already on screen; the poll below will try again.
    } finally {
      state.loading = false;
    }
  }

  /* ---------- lightbox ---------- */

  function showSlide(index) {
    const item = state.items[index];
    if (!item) return;
    state.index = index;
    stage.innerHTML = '';

    if (item.kind === 'video') {
      const video = document.createElement('video');
      video.src = item.mediaUrl;
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.autoplay = true;
      stage.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.src = item.mediaUrl;
      img.alt = '';
      stage.appendChild(img);
    }

    caption.textContent = item.uploader ? t('gallery.by', { name: item.uploader }) : t('gallery.anonymous');
    downloadLink.href = item.downloadUrl;
  }

  function openLightbox(index) {
    lightbox.hidden = false;
    document.body.style.overflow = 'hidden';
    showSlide(index);
  }

  function closeLightbox() {
    lightbox.hidden = true;
    stage.innerHTML = '';
    document.body.style.overflow = '';
  }

  function step(delta) {
    const next = state.index + delta;
    if (next >= 0 && next < state.items.length) showSlide(next);
  }

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox-prev').addEventListener('click', () => step(-1));
  document.getElementById('lightbox-next').addEventListener('click', () => step(1));
  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) closeLightbox();
  });

  document.addEventListener('keydown', (event) => {
    if (lightbox.hidden) return;
    if (event.key === 'Escape') closeLightbox();
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  });

  /* ---------- filters, polling, refresh ---------- */

  document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.chip[data-filter]').forEach((other) => other.classList.remove('is-active'));
      chip.classList.add('is-active');
      state.filter = chip.dataset.filter;
      state.nextBefore = null;
      newItemsButton.hidden = true;
      load({ append: false });
    });
  });

  loadMore.addEventListener('click', () => load({ append: true }));

  newItemsButton.addEventListener('click', () => {
    newItemsButton.hidden = true;
    state.nextBefore = null;
    load({ append: false });
    window.scrollTo({ top: grid.offsetTop - 80, behavior: 'smooth' });
  });

  window.addEventListener('uploads:finished', () => {
    state.nextBefore = null;
    load({ append: false });
  });

  async function poll() {
    // ตอนกรองชื่อคนเดียวอยู่ ป้าย "มีของใหม่" จะโกหก เพราะมันนับของใหม่ทั้งงาน
    // ไม่ใช่ของคนนั้น — เงียบไว้ดีกว่าบอกเลขที่กดแล้วไม่เจอ
    if (who) return;

    try {
      const response = await fetch(`/api/updates?since=${state.maxId}`);
      const payload = await response.json();
      if (payload.newer > 0) {
        newItemsButton.hidden = false;
        newItemsButton.textContent = t('gallery.new_items', { n: payload.newer });
      }
    } catch {
      /* offline for a moment — try again on the next tick */
    }
  }

  load().then(() => setInterval(poll, 30_000));
})();
