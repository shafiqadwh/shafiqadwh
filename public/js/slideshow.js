/* global window, document, fetch */
(function () {
  const strings = window.I18N ?? {};
  const settings = window.SLIDESHOW ?? {};
  const event = settings.event ?? {};

  function t(path) {
    const value = path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), strings);
    return typeof value === 'string' ? value : path;
  }

  const stage = document.getElementById('stage');
  const caption = document.getElementById('caption');
  const captionName = document.getElementById('caption-name');
  const qrBadge = document.getElementById('qr-badge');
  const progress = document.getElementById('progress');

  const deck = { items: [], messages: [], maxId: 0, maxMessageId: 0 };
  const seenItems = new Set();
  const seenMessages = new Set();

  let itemCursor = 0;
  let messageCursor = 0;
  let slideCount = 0;
  let advanceTimer = null;
  let current = null;
  let kenBurnsFlip = false;

  const SECONDS = Number(settings.seconds) || 8;
  const VIDEO_MAX = Number(settings.videoMaxSeconds) || 30;
  const MESSAGE_SECONDS = Number(settings.messageSeconds) || 11;
  const QR_EVERY = Number(settings.qrEvery) || 0;
  const MESSAGE_EVERY = Number(settings.messageEvery) || 0;
  const TITLE_EVERY = Number(settings.titleEvery) || 0;
  // โหมดเบาสำหรับกล่องทีวีที่แรงน้อย — ปิดพื้นหลังเบลอ เกรนฟิล์ม และการซูม
  // ทั้งสามอย่างเป็นงานที่ GPU ต้องวาดใหม่ทั้งจอทุกเฟรม ซึ่งกล่องราคาถูกไม่ไหว
  const LITE = new URLSearchParams(window.location.search).get('lite') === '1'
    || settings.lite === true;
  const KEN_BURNS = settings.kenBurns !== false && !LITE;

  if (LITE) document.body.classList.add('is-lite');

  // ── การประกอบสไลด์ ────────────────────────────────────────────────────────

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function flourish() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 240 24');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#flourish');
    svg.appendChild(use);
    return svg;
  }

  // รูปจากมือถือส่วนใหญ่เป็นแนวตั้ง วางบนจอ 16:9 แล้วเหลือแถบดำสองข้าง
  // เอารูปเดิมมาเบลอเต็มจอเป็นพื้นหลัง จอจะเต็มโดยไม่ต้อง crop รูปของแขกทิ้ง
  function backdrop(item) {
    if (LITE) return null;
    // เบลอรูปย่อ 720px ไม่ใช่รูปเต็ม — ได้ผลตาเหมือนกันเป๊ะเพราะมันเบลออยู่แล้ว
    // แต่เบากว่ามาก เบลอรูป 12 ล้านพิกเซลคือสาเหตุที่จอทีวีกระตุก
    const url = item.thumbUrl || item.displayUrl || item.mediaUrl;
    if (!url) return null;
    const node = el('div', 'slide__backdrop');
    node.style.backgroundImage = `url("${String(url).replace(/"/g, '%22')}")`;
    return node;
  }

  function addBackdrop(slide, item) {
    const node = backdrop(item);
    if (node) slide.appendChild(node);
  }

  function kenBurnsClass() {
    if (!KEN_BURNS) return '';
    kenBurnsFlip = !kenBurnsFlip;
    return kenBurnsFlip ? ' kb kb--a' : ' kb kb--b';
  }

  /**
   * ตาข่ายกันตกชั้นสุดท้าย — วัดขนาดจริงหลังภาพโหลดเสร็จ ถ้าล้นจอก็สั่งขนาด
   * เป็นพิกเซลตรง ๆ ไปเลย
   *
   * มีชั้นนี้เพราะพลาดมาแล้วสองรอบด้วยเหตุคนละอย่าง (max-height เปอร์เซ็นต์
   * ถูกทิ้ง, WebView ทีวีไม่รู้จัก inset) ทั้งสองรอบ CSS ดูถูกต้องบนเดสก์ท็อป
   * แต่พังบนเครื่องจริง โค้ดตรงนี้ไม่พึ่ง CSS เลย จึงพังตามกันไม่ได้
   */
  function clampToScreen(node, heightRatio) {
    const naturalW = node.naturalWidth || node.videoWidth;
    const naturalH = node.naturalHeight || node.videoHeight;
    if (!naturalW || !naturalH) return;

    const boxW = window.innerWidth * 0.92;
    const boxH = window.innerHeight * heightRatio;
    const scale = Math.min(boxW / naturalW, boxH / naturalH, 1);

    node.style.width = `${Math.round(naturalW * scale)}px`;
    node.style.height = `${Math.round(naturalH * scale)}px`;
  }

  // การ์ดคำอวยพรเว้นแถบล่างไว้ให้ข้อความ รูปจึงเตี้ยกว่าสไลด์รูปธรรมดา
  // ส่งค่ามาเป็นพารามิเตอร์ ไม่ไปไล่หาจาก DOM เพราะตอนรูปในแคชโหลดเสร็จ
  // node อาจยังไม่ได้ถูกใส่ลงหน้าเลย closest() จะคืน null
  function mediaNode(item, onDone, heightRatio = 0.92) {
    const wrap = el('div', 'slide__media');

    if (item.kind === 'video') {
      const video = el('video', 'slide__video');
      video.src = item.mediaUrl;
      video.autoplay = true;
      video.muted = settings.muted !== false;
      video.playsInline = true;
      video.controls = false;
      video.addEventListener('loadedmetadata', () => clampToScreen(video, heightRatio));
      video.addEventListener('ended', onDone);
      video.addEventListener('error', onDone);
      wrap.appendChild(video);
    } else {
      const img = el('img', `slide__image${kenBurnsClass()}`);
      // รูปขนาดพอดีจอ ไม่ใช่ต้นฉบับหลายสิบเมกะพิกเซล
      img.src = item.displayUrl || item.mediaUrl;
      img.alt = '';
      img.decoding = 'async';
      if (img.complete) clampToScreen(img, heightRatio);
      img.addEventListener('load', () => clampToScreen(img, heightRatio));
      img.addEventListener('error', onDone);
      wrap.appendChild(img);
    }

    return wrap;
  }

  // ขนาดตัวอักษรของคำอวยพรต้องแปรผกผันกับความยาว ไม่งั้นข้อความยาวจะล้นจอ
  // ส่วนข้อความสั้นอย่าง "ขอให้มีความสุข" จะเล็กจนคนท้ายห้องอ่านไม่ออก
  function bodySizeClass(text) {
    const length = (text || '').length;
    if (length <= 40) return 'is-xs';
    if (length <= 110) return 'is-sm';
    if (length <= 260) return 'is-md';
    return 'is-lg';
  }

  function wishBlock(message, variant) {
    const wish = el('div', `wish wish--${variant}`);

    if (variant === 'center') {
      const ornament = el('div', 'wish__ornament');
      ornament.appendChild(flourish());
      wish.appendChild(ornament);
    } else {
      wish.appendChild(el('span', 'wish__mark', '“'));
    }

    const body = el('p', `wish__body ${bodySizeClass(message.body)}`, message.body);
    wish.appendChild(body);

    const by = el('div', 'wish__by');
    by.appendChild(el('span', 'wish__rule'));
    by.appendChild(el('span', null, message.author || t('slideshow.anonymous')));
    wish.appendChild(by);

    return wish;
  }

  // ── การวาดลงจอ ────────────────────────────────────────────────────────────

  function paint(slide) {
    stage.appendChild(slide);
    // บังคับให้เบราว์เซอร์คำนวณ layout ก่อนติดคลาส ไม่งั้น transition ไม่ทำงาน
    void slide.offsetWidth;
    slide.classList.add('is-visible');

    const previous = current;
    current = slide;
    if (previous) {
      previous.classList.remove('is-visible');
      setTimeout(() => {
        releaseMedia(previous);
        previous.remove();
      }, 1300);
    }
  }

  /**
   * ปล่อยภาพที่ถอดรหัสไว้ในหน่วยความจำก่อนทิ้งสไลด์
   *
   * การลบ node ออกจาก DOM เฉย ๆ ไม่ได้แปลว่าเบราว์เซอร์คืนบัฟเฟอร์ภาพทันที
   * กล่องทีวีมีแรมน้อย เปิดทิ้งไว้เป็นชั่วโมงแล้วจะเริ่มขึ้นจอดำเพราะโหลดรูป
   * ใหม่ไม่ไหว — เคลียร์ src ทิ้งเองจึงจำเป็น ไม่ใช่การปรับแต่งเล็กน้อย
   */
  function releaseMedia(slide) {
    slide.querySelectorAll('img').forEach((img) => {
      img.removeAttribute('src');
    });
    slide.querySelectorAll('video').forEach((video) => {
      video.pause();
      video.removeAttribute('src');
      video.load();
    });
  }

  function setCaption(text) {
    if (text) {
      captionName.textContent = text;
      caption.classList.add('is-on');
    } else {
      caption.classList.remove('is-on');
    }
  }

  function showQrBadge(on) {
    qrBadge.classList.toggle('is-off', !on);
  }

  // ── สไลด์แต่ละชนิด ────────────────────────────────────────────────────────

  function showMedia(item) {
    const slide = el('div', 'slide slide--photo');
    if (item.kind === 'image') addBackdrop(slide, item);
    slide.appendChild(mediaNode(item, next));
    paint(slide);

    setCaption(item.uploader || '');
    showQrBadge(true);

    if (item.kind === 'video') {
      const cap = Math.min(item.duration || VIDEO_MAX, VIDEO_MAX);
      schedule((cap + 1) * 1000);
    } else {
      schedule(SECONDS * 1000);
    }
  }

  // คำอวยพรที่แนบไฟล์มา — โชว์รูปเต็มจอแล้ววางข้อความทับ ผูกคำกับภาพไว้ด้วยกัน
  function showWishWithMedia(message) {
    const slide = el('div', 'slide slide--wish slide--wish-media');
    addBackdrop(slide, message.media);
    slide.appendChild(mediaNode(message.media, next, 0.7));
    slide.appendChild(wishBlock(message, 'overlay'));
    paint(slide);

    setCaption('');
    showQrBadge(true);
    schedule(readingTime(message) * 1000);
  }

  // ไม่ได้แนบไฟล์ก็ยังต้องขึ้นจอ — จัดเป็นการ์ดข้อความให้ดูตั้งใจ ไม่ใช่ที่ว่าง
  function showWishPlain(message) {
    const slide = el('div', 'slide slide--wish slide--wish-plain');
    slide.appendChild(wishBlock(message, 'center'));
    paint(slide);

    setCaption('');
    showQrBadge(true);
    schedule(readingTime(message) * 1000);
  }

  // ให้เวลาอ่านตามความยาวจริง ประมาณ 11 ตัวอักษรต่อวินาที บวกเวลาตั้งตัว
  function readingTime(message) {
    const length = (message.body || '').length;
    return Math.min(Math.max(MESSAGE_SECONDS, length / 11 + 4), 26);
  }

  function showTitle() {
    const slide = el('div', 'slide slide--title');
    const title = el('div', 'title');

    if (event.monogram) title.appendChild(el('div', 'title__monogram', event.monogram));

    const art = el('div', 'title__flourish');
    art.appendChild(flourish());
    title.appendChild(art);

    title.appendChild(el('h1', 'title__names', event.coupleNames || event.title));

    const meta = [event.date, event.venue].filter(Boolean).join('  ·  ');
    if (meta) title.appendChild(el('p', 'title__meta', meta));

    slide.appendChild(title);
    paint(slide);

    setCaption('');
    showQrBadge(false);
    schedule(Math.max(SECONDS, 7) * 1000);
  }

  function showQr() {
    const slide = el('div', 'slide slide--qr');
    const share = el('div', 'share');

    share.appendChild(el('h2', 'share__title', t('slideshow.scan_title')));

    const art = el('div', 'title__flourish');
    art.appendChild(flourish());
    share.appendChild(art);

    const img = el('img', 'share__qr');
    img.src = settings.qrImage;
    img.alt = 'QR';
    share.appendChild(img);

    share.appendChild(el('p', 'share__body', t('slideshow.scan_body')));
    share.appendChild(el('div', 'share__url', String(settings.shareUrl || '').replace(/^https?:\/\//, '')));

    slide.appendChild(share);
    paint(slide);

    setCaption('');
    showQrBadge(false);
    schedule(Math.max(SECONDS, 9) * 1000);
  }

  function showWaiting() {
    const slide = el('div', 'slide slide--waiting');
    const share = el('div', 'share');

    if (event.monogram) share.appendChild(el('div', 'title__monogram', event.monogram));
    share.appendChild(el('h2', 'share__title', event.coupleNames || event.title));

    const art = el('div', 'title__flourish');
    art.appendChild(flourish());
    share.appendChild(art);

    const img = el('img', 'share__qr');
    img.src = settings.qrImage;
    img.alt = 'QR';
    share.appendChild(img);

    share.appendChild(el('p', 'share__body', t('slideshow.waiting')));

    slide.appendChild(share);
    paint(slide);

    setCaption('');
    showQrBadge(false);
    schedule(6000);
  }

  // ── ตัวจับเวลา + แถบความคืบหน้า ───────────────────────────────────────────

  function schedule(ms) {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(next, ms);

    // รีเซ็ตแถบให้กว้าง 0 ทันที แล้วค่อยวิ่งไป 100% ตลอดช่วงเวลาของสไลด์นี้
    progress.style.transition = 'none';
    progress.style.width = '0%';
    void progress.offsetWidth;
    progress.style.transition = `width ${ms}ms linear`;
    progress.style.width = '100%';
  }

  // ── ลำดับการเล่น ──────────────────────────────────────────────────────────
  //
  // รูปเป็นแกนหลัก แล้วสอดคำอวยพร การ์ดชื่อ และ QR แทรกเป็นระยะ
  // คำอวยพรวนเป็นคิว ไม่สุ่ม — ทุกคนที่เขียนมาต้องได้ขึ้นจอ ไม่ใช่คนเดิมซ้ำ

  function nextMessage() {
    if (deck.messages.length === 0) return null;
    const message = deck.messages[messageCursor % deck.messages.length];
    messageCursor = (messageCursor + 1) % deck.messages.length;
    return message;
  }

  function next() {
    clearTimeout(advanceTimer);

    if (deck.items.length === 0 && deck.messages.length === 0) {
      showWaiting();
      return;
    }

    slideCount += 1;

    if (TITLE_EVERY > 0 && slideCount % TITLE_EVERY === 1 && slideCount > 1) {
      showTitle();
      return;
    }

    if (QR_EVERY > 0 && slideCount % QR_EVERY === 0) {
      showQr();
      return;
    }

    // ยังไม่มีรูปเลยแต่มีคำอวยพรแล้ว — ช่วงต้นงานเป็นแบบนี้บ่อย ให้ฉายคำอวยพรไปก่อน
    const messageTurn = MESSAGE_EVERY > 0 && slideCount % MESSAGE_EVERY === 0;
    if (deck.items.length === 0 || (messageTurn && deck.messages.length > 0)) {
      const message = nextMessage();
      if (message) {
        if (message.media) showWishWithMedia(message);
        else showWishPlain(message);
        return;
      }
    }

    const item = deck.items[itemCursor % deck.items.length];
    itemCursor = (itemCursor + 1) % deck.items.length;
    showMedia(item);
  }

  // ── ดึงของใหม่ ────────────────────────────────────────────────────────────

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
      const freshItems = payload.items.filter((item) => !seenItems.has(item.id));
      freshItems.forEach((item) => seenItems.add(item.id));
      deck.items = freshItems.concat(deck.items);

      // คำอวยพรใหม่ก็เช่นกัน — แทรกไว้หัวคิวให้ขึ้นจอรอบถัดไป
      const freshMessages = payload.messages.filter((message) => !seenMessages.has(message.id));
      freshMessages.forEach((message) => seenMessages.add(message.id));
      if (freshMessages.length > 0) {
        deck.messages = freshMessages.concat(deck.messages).slice(0, 120);
        messageCursor = 0;
      }

      deck.maxId = Math.max(deck.maxId, payload.maxId || 0);
      deck.maxMessageId = Math.max(deck.maxMessageId, payload.maxMessageId || 0);
    } catch {
      // Venue wifi hiccup — keep showing the deck we already hold.
    }
  }

  refresh().then(() => {
    if (deck.items.length > 0 || deck.messages.length > 0) showTitle();
    else next();
    setInterval(refresh, 15_000);
  });

  // Wall displays are left alone for hours: reload nightly-ish to shed any leak.
  setTimeout(() => window.location.reload(), 6 * 60 * 60 * 1000);

  document.addEventListener('keydown', (keyEvent) => {
    if (keyEvent.key === 'ArrowRight' || keyEvent.key === ' ') next();
  });
})();
