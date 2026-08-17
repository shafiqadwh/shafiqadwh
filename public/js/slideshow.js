/* global window, document, fetch */
(function () {
  const strings = window.I18N ?? {};
  const settings = window.SLIDESHOW ?? {};

  function t(path) {
    const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings);
    return typeof value === 'string' ? value : path;
  }

  const stage = document.getElementById('stage');
  const waiting = document.getElementById('waiting');
  const caption = document.getElementById('caption');
  const qrBadge = document.getElementById('qr-badge');

  const deck = { items: [], messages: [], maxId: 0, maxMessageId: 0 };
  const seen = new Set();
  let cursor = 0;
  let slideCount = 0;
  let advanceTimer = null;
  let current = null;

  const SECONDS = Number(settings.seconds) || 8;
  const VIDEO_MAX = Number(settings.videoMaxSeconds) || 30;
  const QR_EVERY = Number(settings.qrEvery) || 12;

  async function refresh() {
    try {
      const params = new URLSearchParams({
        since: String(deck.maxId),
        sinceMessage: String(deck.maxMessageId),
      });
      const response = await fetch(`/api/slideshow?${params}`);
      const payload = await response.json();

      // Newly arrived pictures jump to the front of the queue: guests want to
      // see their own photo on the big screen while they are still holding the phone.
      const fresh = payload.items.filter((item) => !seen.has(item.id));
      fresh.forEach((item) => seen.add(item.id));
      deck.items = fresh.concat(deck.items);
      deck.messages = payload.messages.concat(deck.messages).slice(0, 60);
      deck.maxId = Math.max(deck.maxId, payload.maxId || 0);
      deck.maxMessageId = Math.max(deck.maxMessageId, payload.maxMessageId || 0);

      if (deck.items.length > 0 && waiting) waiting.hidden = true;
    } catch {
      // Venue wifi hiccup — keep showing the deck we already hold.
    }
  }

  function paint(node) {
    const slide = document.createElement('div');
    slide.className = 'stage__slide';
    slide.appendChild(node);
    stage.appendChild(slide);
    requestAnimationFrame(() => slide.classList.add('is-visible'));

    const previous = current;
    current = slide;
    if (previous) {
      previous.classList.remove('is-visible');
      setTimeout(() => previous.remove(), 1000);
    }
  }

  function showImage(item) {
    const img = document.createElement('img');
    img.src = item.mediaUrl;
    img.alt = '';
    img.addEventListener('error', next);
    paint(img);
    caption.textContent = item.uploader || '';
    caption.hidden = !item.uploader;
    schedule(SECONDS * 1000);
  }

  function showVideo(item) {
    const video = document.createElement('video');
    video.src = item.mediaUrl;
    video.autoplay = true;
    video.muted = settings.muted !== false;
    video.playsInline = true;
    video.controls = false;
    video.addEventListener('ended', next);
    video.addEventListener('error', next);
    paint(video);

    caption.textContent = item.uploader || '';
    caption.hidden = !item.uploader;

    const cap = Math.min(item.duration || VIDEO_MAX, VIDEO_MAX);
    schedule((cap + 1) * 1000);
  }

  function showMessage(message) {
    const block = document.createElement('div');
    block.className = 'stage__message';

    const quote = document.createElement('blockquote');
    quote.textContent = message.body;
    block.appendChild(quote);

    if (message.author) {
      const cite = document.createElement('cite');
      cite.textContent = message.author;
      block.appendChild(cite);
    }

    paint(block);
    caption.hidden = true;
    schedule(Math.max(SECONDS, 10) * 1000);
  }

  function showQr() {
    qrBadge.classList.add('is-hero');
    caption.hidden = true;
    setTimeout(() => qrBadge.classList.remove('is-hero'), SECONDS * 1000);
    schedule(SECONDS * 1000);
  }

  function schedule(ms) {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(next, ms);
  }

  function next() {
    clearTimeout(advanceTimer);

    if (deck.items.length === 0) {
      if (waiting) waiting.hidden = false;
      schedule(5000);
      return;
    }

    slideCount += 1;

    if (QR_EVERY > 0 && slideCount % QR_EVERY === 0) {
      showQr();
      return;
    }

    // Slip a guest-book message in between every handful of pictures.
    if (deck.messages.length > 0 && slideCount % 7 === 0) {
      const message = deck.messages[Math.floor(Math.random() * deck.messages.length)];
      showMessage(message);
      return;
    }

    const item = deck.items[cursor % deck.items.length];
    cursor = (cursor + 1) % Math.max(deck.items.length, 1);
    if (item.kind === 'video') showVideo(item);
    else showImage(item);
  }

  refresh().then(() => {
    next();
    setInterval(refresh, 15_000);
  });

  // Wall displays are left alone for hours: reload nightly-ish to shed any leak.
  setTimeout(() => window.location.reload(), 6 * 60 * 60 * 1000);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === ' ') next();
  });
})();
