/* global window, document, fetch, FormData, localStorage */
(function () {
  const strings = window.I18N ?? {};

  function t(path, vars) {
    const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings);
    if (typeof value !== 'string') return path;
    return vars ? value.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : value;
  }

  const form = document.getElementById('message-form');
  if (!form) return;

  const list = document.getElementById('messages');
  const emptyLine = document.getElementById('messages-empty');
  const statusLine = document.getElementById('message-status');
  const submitButton = document.getElementById('message-submit');
  const authorInput = document.getElementById('message-author');
  const bodyInput = document.getElementById('message-body');
  const fileInput = document.getElementById('message-file');

  const NAME_KEY = 'wedding-share.name';
  const saved = localStorage.getItem(NAME_KEY);
  if (saved && authorInput) authorInput.value = saved;

  function setStatus(text, isError) {
    statusLine.textContent = text;
    statusLine.hidden = !text;
    statusLine.classList.toggle('notice--error', Boolean(isError));
  }

  function card(message) {
    const article = document.createElement('article');
    article.className = 'message';

    const author = document.createElement('span');
    author.className = 'message__author';
    author.textContent = message.author || t('gallery.anonymous');

    const body = document.createElement('p');
    body.className = 'message__body';
    body.textContent = message.body;

    article.append(author, body);

    if (message.item?.thumbUrl) {
      const media = document.createElement('a');
      media.className = 'message__media';
      media.href = message.item.mediaUrl;
      media.target = '_blank';
      media.rel = 'noopener';

      const img = document.createElement('img');
      img.loading = 'lazy';
      img.src = message.item.thumbUrl;
      img.alt = '';
      media.appendChild(img);
      article.appendChild(media);
    }

    return article;
  }

  async function load() {
    try {
      const response = await fetch('/api/messages');
      const payload = await response.json();
      list.innerHTML = '';
      payload.messages.forEach((message) => list.appendChild(card(message)));
      emptyLine.hidden = payload.messages.length > 0;
    } catch {
      /* leave whatever is on screen */
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const body = bodyInput.value.trim();
    if (!body) {
      setStatus(t('guestbook.required'), true);
      bodyInput.focus();
      return;
    }

    const data = new FormData();
    data.append('body', body);
    const author = authorInput.value.trim();
    if (author) {
      data.append('author', author);
      localStorage.setItem(NAME_KEY, author);
    }
    if (fileInput?.files?.[0]) data.append('attachment', fileInput.files[0]);

    submitButton.disabled = true;
    setStatus(t('guestbook.submitting'));

    try {
      const response = await fetch('/api/messages', { method: 'POST', body: data });
      const payload = await response.json();

      if (!response.ok) {
        setStatus(payload.error || t('upload.failed'), true);
      } else {
        const warnings = payload.errors?.length ? ` · ${payload.errors[0]}` : '';
        setStatus((payload.pending ? t('upload.success_pending') : t('guestbook.success')) + warnings, Boolean(warnings));
        bodyInput.value = '';
        if (fileInput) fileInput.value = '';
        await load();
      }
    } catch {
      setStatus(t('upload.failed'), true);
    } finally {
      submitButton.disabled = false;
    }
  });

  load();
})();
