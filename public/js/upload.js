/* global window, document, XMLHttpRequest, FormData, localStorage */
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

  fileInput?.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  cameraInputs.forEach((input) => {
    input.addEventListener('change', () => {
      handleFiles(input.files);
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
    if (event.dataTransfer?.files?.length) handleFiles(event.dataTransfer.files);
  });
})();
