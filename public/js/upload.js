/* global window, document, XMLHttpRequest, FormData, localStorage, URL */
(function () {
  const strings = window.I18N ?? {};
  const app = window.APP ?? {};

  function t(path, vars) {
    const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings);
    if (typeof value !== 'string') return path;
    return vars ? value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : value;
  }

  const dropzone = document.getElementById('dropzone');
  if (!dropzone) return;

  const fileInput = document.getElementById('file-input');
  const cameraInputs = [
    document.getElementById('camera-photo'),
    document.getElementById('camera-video'),
  ].filter(Boolean);
  const nameInput = document.getElementById('uploader-name');
  const queueList = document.getElementById('upload-queue');
  const statusLine = document.getElementById('upload-status');

  const reviewBox = document.getElementById('upload-review');
  const reviewGrid = document.getElementById('review-grid');
  const confirmButton = document.getElementById('upload-confirm');
  const cancelButton = document.getElementById('upload-cancel');

  const NAME_KEY = 'wedding-share.name';
  const saved = localStorage.getItem(NAME_KEY);
  if (saved && nameInput) nameInput.value = saved;
  nameInput?.addEventListener('change', () => localStorage.setItem(NAME_KEY, nameInput.value.trim()));

  function setStatus(text, isError) {
    if (!statusLine) return;
    statusLine.textContent = text;
    statusLine.hidden = !text;
    statusLine.classList.toggle('notice--error', Boolean(isError));
  }

  function addRow(file) {
    const row = document.createElement('li');
    row.className = 'queue__item';

    const name = document.createElement('span');
    name.className = 'queue__name';
    name.textContent = file.name;

    const state = document.createElement('span');
    state.className = 'queue__state';
    state.textContent = '0%';

    const bar = document.createElement('span');
    bar.className = 'queue__bar';
    const fill = document.createElement('span');
    bar.appendChild(fill);

    row.append(name, state, bar);
    queueList.hidden = false;
    queueList.appendChild(row);

    return {
      progress(fraction) {
        fill.style.width = `${Math.round(fraction * 100)}%`;
        state.textContent = `${Math.round(fraction * 100)}%`;
      },
      done() {
        fill.style.width = '100%';
        state.textContent = '✓';
      },
      fail(message) {
        row.classList.add('is-error');
        state.textContent = '!';
        const detail = document.createElement('span');
        detail.className = 'queue__name';
        detail.textContent = message;
        row.appendChild(detail);
      },
    };
  }

  /** One request per file: a single huge multipart post is far easier to lose on 4G. */
  function sendOne(file, uploader, row) {
    return new Promise((resolve) => {
      const form = new FormData();
      form.append('files', file, file.name);
      if (uploader) form.append('uploader', uploader);

      const request = new XMLHttpRequest();
      request.open('POST', '/api/upload');
      request.timeout = 15 * 60 * 1000;

      request.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable) row.progress(event.loaded / event.total);
      });

      request.addEventListener('load', () => {
        let payload = {};
        try {
          payload = JSON.parse(request.responseText);
        } catch {
          /* fall through to the generic message below */
        }

        if (request.status >= 200 && request.status < 300 && payload.created > 0) {
          row.done();
          resolve({ ok: true, pending: payload.pending });
        } else {
          const message = payload.errors?.[0] || payload.error || t('upload.failed');
          row.fail(message);
          resolve({ ok: false, message });
        }
      });

      const failWith = (message) => {
        row.fail(message);
        resolve({ ok: false, message, retryable: true });
      };
      request.addEventListener('error', () => failWith(t('upload.failed')));
      request.addEventListener('timeout', () => failWith(t('upload.failed')));

      request.send(form);
    });
  }

  async function sendWithRetry(file, uploader, row, attempts = 3) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      last = await sendOne(file, uploader, row);
      if (last.ok || !last.retryable) return last;
      // Patchy venue wifi: back off briefly, then try the same file again.
      await new Promise((resolve) => setTimeout(resolve, attempt * 1500));
    }
    return last;
  }

  let busy = false;

  async function handleFiles(fileList) {
    const files = Array.from(fileList).slice(0, app.limits?.filesPerRequest ?? 20);
    if (files.length === 0 || busy) return;

    busy = true;
    queueList.innerHTML = '';
    setStatus(t('upload.sending', { done: 0, total: files.length }));

    const uploader = nameInput?.value.trim() ?? '';
    if (uploader) localStorage.setItem(NAME_KEY, uploader);

    let done = 0;
    let failed = 0;
    let pending = false;

    for (const file of files) {
      const row = addRow(file);
      const result = await sendWithRetry(file, uploader, row);
      if (result.ok) {
        done += 1;
        pending = pending || Boolean(result.pending);
      } else {
        failed += 1;
      }
      setStatus(t('upload.sending', { done: done + failed, total: files.length }));
    }

    if (done > 0 && failed === 0) {
      setStatus(pending ? t('upload.success_pending') : t('upload.success'));
    } else if (done > 0) {
      setStatus(`${t('upload.success')} · ${t('upload.failed')} (${failed})`, true);
    } else {
      setStatus(t('upload.failed'), true);
    }

    if (done > 0) window.dispatchEvent(new CustomEvent('uploads:finished'));
    busy = false;
  }

  /* ── ตรวจก่อนส่ง ──────────────────────────────────────────────────────────
     เลือกไฟล์แล้ว "ไม่ส่งอะไรทั้งสิ้น" จนกว่าจะกดยืนยัน — เดิมผูก handleFiles()
     ไว้กับ event change ตรง ๆ กดเลือกในหน้าต่างของมือถือปุ๊บ ไฟล์วิ่งขึ้น NAS ปั๊บ
     ไม่มีจังหวะให้ถอยเลยถ้าแตะพลาดไปโดนรูปข้าง ๆ ในคลังภาพ

     ตัวส่งจริงข้างบน (sendOne/sendWithRetry/handleFiles) ไม่ได้ถูกแตะเลยแม้แต่
     บรรทัดเดียว — เปลี่ยนแค่ว่าใครเป็นคนเรียกมัน */

  const MAX_FILES = app.limits?.filesPerRequest ?? 20;
  let staged = [];

  const previewUrls = new Map();

  /** object URL ที่ไม่ revoke ค้างรูปเต็มความละเอียดไว้ในแรมจนกว่าจะปิดแท็บ */
  function forget(file) {
    const url = previewUrls.get(file);
    if (url) URL.revokeObjectURL(url);
    previewUrls.delete(file);
  }

  function previewUrl(file) {
    if (!previewUrls.has(file)) previewUrls.set(file, URL.createObjectURL(file));
    return previewUrls.get(file);
  }

  function clearStaged() {
    staged.forEach(forget);
    staged = [];
    renderReview();
  }

  /**
   * เอาเฉพาะตัวรูป/วิดีโอที่เรนเดอร์ไม่ได้ออก แล้ววางกล่องชื่อไฟล์แทน
   *
   * ห้ามล้างทั้งกล่องด้วย innerHTML = '' — event error ยิงทีหลังตอนที่ปุ่ม ✕
   * ถูกใส่เข้าไปแล้ว ล้างทั้งกล่องคือลบปุ่มทิ้งไปด้วย แล้วไฟล์ใบนั้นจะเอาออกไม่ได้เลย
   * ตลอดกาล ซึ่งพังตรงจุดที่ฟีเจอร์นี้มีไว้แก้พอดี
   */
  function fallbackTile(tile, file) {
    tile.querySelectorAll('img, video').forEach((node) => node.remove());
    tile.querySelector('.review__badge')?.remove();
    if (tile.querySelector('.review__fallback')) return;

    const box = document.createElement('span');
    box.className = 'review__fallback';
    box.textContent = file.name;
    tile.prepend(box);
  }

  function tileFor(file, index) {
    const tile = document.createElement('div');
    tile.className = 'review__tile';

    // HEIC ของ iPhone เรนเดอร์ได้บน Safari (เครื่องที่ผลิตไฟล์ HEIC) แต่ Chrome
    // บน Android เรนเดอร์ไม่ได้ — ต้องตกไปเป็นกล่องชื่อไฟล์ ไม่ใช่ไอคอนรูปแตก
    if (file.type.startsWith('video/')) {
      const video = document.createElement('video');
      video.src = previewUrl(file);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.addEventListener('error', () => fallbackTile(tile, file));
      tile.appendChild(video);

      const badge = document.createElement('span');
      badge.className = 'review__badge';
      badge.textContent = '▶';
      tile.appendChild(badge);
    } else {
      const img = document.createElement('img');
      img.src = previewUrl(file);
      img.alt = file.name;
      img.addEventListener('error', () => fallbackTile(tile, file));
      tile.appendChild(img);
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'review__remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', t('upload.remove_one'));
    remove.addEventListener('click', () => {
      forget(staged[index]);
      staged.splice(index, 1);
      renderReview();
    });
    tile.appendChild(remove);

    return tile;
  }

  function renderReview() {
    if (!reviewBox || !reviewGrid || !confirmButton) return;

    reviewGrid.innerHTML = '';
    staged.forEach((file, index) => reviewGrid.appendChild(tileFor(file, index)));

    const wasHidden = reviewBox.hidden;
    reviewBox.hidden = staged.length === 0;
    confirmButton.textContent = t('upload.confirm_send', { n: staged.length });

    // เลื่อนปุ่มยืนยันเข้ามาให้เห็น "เฉพาะจังหวะที่แผงเพิ่งโผล่"
    //
    // แขกเลือกรูปเสร็จ เบราว์เซอร์เด้งกลับมาที่หน้าเว็บ ถ้าไม่เห็นปุ่ม "ส่ง N ไฟล์"
    // ก็จะเดินจากไปโดยคิดว่าส่งแล้ว — เงียบ ไม่มี error ไม่มีใครรู้ทั้งงาน
    // ซึ่งทำลายจุดประสงค์ทั้งหมดของระบบ
    //
    // ทำเฉพาะตอนเปลี่ยนจากซ่อนเป็นแสดง ไม่ใช่ทุกครั้งที่วาดใหม่ ไม่งั้นกด ✕
    // ทีหน้าจอกระโดดที ซึ่งน่ารำคาญกว่าไม่ช่วยอะไร
    if (wasHidden && !reviewBox.hidden) {
      confirmButton.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function stageFiles(fileList) {
    const incoming = Array.from(fileList ?? []);
    if (incoming.length === 0) return;

    // ต่อท้ายรายการเดิม ไม่ทับ — แขกที่เลือกรูปสองใบแล้วกด "ถ่ายรูป" เพิ่ม
    // ต้องไม่ทำให้สองใบแรกหายไปเงียบ ๆ
    const seen = new Set(staged.map((file) => `${file.name}|${file.size}|${file.lastModified}`));
    let dropped = 0;

    for (const file of incoming) {
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (seen.has(key)) continue;
      if (staged.length >= MAX_FILES) {
        dropped += 1;
        continue;
      }
      seen.add(key);
      staged.push(file);
    }

    renderReview();
    // เกินเพดานต้องบอก ไม่ใช่ตัดทิ้งเงียบ ๆ แล้วปล่อยให้แขกนึกว่าส่งครบแล้ว
    setStatus(dropped > 0 ? t('upload.too_many', { n: MAX_FILES }) : '', dropped > 0);
  }

  confirmButton?.addEventListener('click', async () => {
    if (busy || staged.length === 0) return;

    // คัดลอกออกมาก่อนล้าง — handleFiles() ถือรายการนี้ไว้ตลอดการส่ง
    const files = staged.slice();
    clearStaged();

    // ปิดปุ่มระหว่างส่ง กันกดซ้ำแล้วได้รูปสองชุด (handleFiles มี busy กันอยู่แล้ว
    // แต่ปุ่มที่กดได้ทั้งที่ไม่มีอะไรเกิดขึ้นทำให้คนกดคิดว่าเว็บค้าง)
    if (confirmButton) confirmButton.disabled = true;
    try {
      await handleFiles(files);
    } finally {
      if (confirmButton) confirmButton.disabled = false;
    }
  });

  cancelButton?.addEventListener('click', () => {
    clearStaged();
    setStatus('');
  });

  fileInput?.addEventListener('change', () => {
    stageFiles(fileInput.files);
    fileInput.value = '';
  });

  cameraInputs.forEach((input) => {
    input.addEventListener('change', () => {
      stageFiles(input.files);
      input.value = '';
    });
  });

  ['dragenter', 'dragover'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-dragging');
    });
  });

  ['dragleave', 'drop'].forEach((type) => {
    dropzone.addEventListener(type, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragging');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    if (event.dataTransfer?.files?.length) stageFiles(event.dataTransfer.files);
  });
})();
