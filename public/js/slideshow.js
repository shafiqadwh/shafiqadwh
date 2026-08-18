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

  // โหมดการแสดงผล: cinema = ทีละรูปเต็มจอ, wall = กระจายทั้งจอแล้ววนไฮไลท์
  const MODE = new URLSearchParams(window.location.search).get('mode')
    || settings.mode
    || 'cinema';

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


  // ══ โหมดกำแพงรูป ═══════════════════════════════════════════════════════
  //
  // รูปทั้งหมดวางกระจายเต็มจอเหมือนรูปโพลารอยด์วางบนโต๊ะ ทีละใบถูกยกขึ้นมาเป็น
  // ไฮไลท์ แล้วสลับไปเรื่อย ๆ รูปใหม่เข้ามาแทนใบที่อยู่มานานที่สุด
  //
  // ต่างจากโหมดโรงหนังตรงที่จอไม่เคยว่าง แขกเห็นรูปของตัวเองค้างอยู่บนจอได้นาน
  // ไม่ใช่ผ่านไปแล้วผ่านเลย

  function startWall() {
    document.body.classList.add('is-wall');

    const wall = el('div', 'wall');
    stage.parentNode.insertBefore(wall, stage);
    stage.remove();
    caption.remove();

    const slots = [];
    const cards = [];
    // การ์ดที่ถูกจองไว้แล้วว่ากำลังจะถูกสลับ กันไม่ให้ถูกเลือกซ้ำ
    const reserved = new Set();
    let hotIndex = -1;
    let placedSerial = 0;

    // ── ตำแหน่งของแต่ละใบ ────────────────────────────────────────────────
    //
    // วางบนตารางก่อน แล้วค่อยเขย่าตำแหน่งกับหมุนเอียงทีละใบ ได้ผลดูสุ่มแต่
    // ไม่มีทางซ้อนทับกันจนบังหน้าคน ซึ่งเป็นสิ่งที่การสุ่มล้วน ๆ คุมไม่ได้
    function buildSlots() {
      slots.length = 0;

      const ratio = window.innerWidth / Math.max(window.innerHeight, 1);
      const cols = ratio > 1.6 ? 5 : 4;
      const rows = ratio > 1.6 ? 3 : 4;

      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          // ค่าเขย่าคงที่ต่อช่อง ไม่สุ่มใหม่ทุกครั้ง ไม่งั้นรูปจะกระโดดตอนสลับ
          const noise = Math.sin((row * 7 + col * 13 + 1) * 12.9898) * 43758.5453;
          const jitterX = ((noise % 1) + 1) % 1 - 0.5;
          const jitterY = ((noise * 1.7 % 1) + 1) % 1 - 0.5;

          slots.push({
            x: (col + 0.5) / cols + jitterX * 0.06,
            y: (row + 0.5) / rows + jitterY * 0.07,
            rotate: jitterX * 17,
            boxW: window.innerWidth / cols,
            boxH: window.innerHeight / rows,
            // ย่อขนาดต่างกันทีละใบ ไม่งั้นดูเป็นตารางแทนที่จะเป็นกองรูป
            shrink: 0.82 + Math.abs(jitterY) * 0.32,
          });
        }
      }
    }

    function place(card) {
      const slot = slots[card.slotIndex];
      if (!slot) return;
      const hot = card.slotIndex === hotIndex;

      // ไฮไลท์ต้องใหญ่พอให้คนท้ายห้องเห็นหน้าชัด แต่ห้ามหลุดขอบจอ
      const scale = hot
        ? Math.min(
          (window.innerHeight * 0.72) / Math.max(card.node.offsetHeight, 1),
          (window.innerWidth * 0.46) / Math.max(card.node.offsetWidth, 1),
        )
        : 1;

      const halfW = (card.node.offsetWidth * scale) / 2;
      const halfH = (card.node.offsetHeight * scale) / 2;

      // ดึงเข้ามาในจอเท่าที่จำเป็น ใบที่อยู่ริมจอจะได้ไม่โดนตัดตอนขยาย
      const margin = 12;
      const centreX = clamp(slot.x * window.innerWidth, halfW + margin, window.innerWidth - halfW - margin);
      const centreY = clamp(slot.y * window.innerHeight, halfH + margin, window.innerHeight - halfH - margin);

      card.node.style.transform =
        `translate(${Math.round(centreX - card.node.offsetWidth / 2)}px, ${Math.round(centreY - card.node.offsetHeight / 2)}px)`
        + ` rotate(${hot ? 0 : slot.rotate.toFixed(2)}deg) scale(${scale.toFixed(3)})`;

      card.node.classList.toggle('is-hot', hot);
    }

    // วางลงตำแหน่งโดยยังไม่เปิด transition แล้วค่อยเปิดทีหลัง
    // ถ้าเปิดไว้ตั้งแต่แรก การ์ดทุกใบจะพุ่งมาจากมุมซ้ายบนพร้อมกันตอนเปิดหน้า
    function settle(card) {
      requestAnimationFrame(() => {
        place(card);
        requestAnimationFrame(() => {
          card.node.classList.remove('is-placing');
          card.node.classList.remove('is-entering');
        });
      });
    }

    function clamp(value, low, high) {
      return high < low ? (low + high) / 2 : Math.min(Math.max(value, low), high);
    }

    // ── การ์ดหนึ่งใบ ──────────────────────────────────────────────────────

    /**
     * ความกว้างของการ์ดต้องคิดถอยหลังจาก "ช่องที่มี" ไม่ใช่ตั้งจากความกว้างอย่างเดียว
     *
     * กรอบโพลารอยด์สูงกว่ารูปข้างในเสมอ (ขอบบน 5% ขอบล่าง 17% บวกบรรทัดชื่อ)
     * ถ้าคิดจากความกว้างอย่างเดียว รูปแนวตั้งจะสูงล้นช่องแล้วไปทับใบข้างบนข้างล่าง
     * จนกำแพงดูรกแทนที่จะดูเป็นกองรูปวางเรียง
     */
    function cardWidthFor(slot, ratio) {
      const frameOverhead = 0.09 + 0.11 + 0.13; // ขอบบน + ขอบล่าง + บรรทัดชื่อ
      const byWidth = slot.boxW * 0.94;
      const byHeight = (slot.boxH * 0.94) / (0.9 * ratio + frameOverhead);
      return Math.max(64, Math.min(byWidth, byHeight) * slot.shrink);
    }

    function buildCard(entry, slot) {
      const node = el('div', 'wall__card is-entering is-placing');
      const card = el('div', `card${entry.note ? ' card--note' : ''}`);

      // กรอบรูปใช้สัดส่วนของรูปจริง แนวตั้งกับแนวนอนจึงหน้าตาไม่เหมือนกัน
      // เหมือนกองรูปจริงที่ปนกันอยู่ ไม่ใช่ตารางที่ทุกใบเท่ากันเป๊ะ
      const ratio = entry.note
        ? 1.15
        : clamp(entry.width && entry.height ? entry.height / entry.width : 1.2, 0.68, 1.5);
      const width = cardWidthFor(slot, ratio);
      node.style.width = `${Math.round(width)}px`;

      const media = el('div', 'card__media');

      if (entry.note) {
        // คำอวยพรที่ไม่ได้แนบรูป ขึ้นเป็นกระดาษโน้ต ยาวเกินก็ตัดท้ายด้วย …
        const text = el('p', 'card__note-text', entry.body.slice(0, 150) + (entry.body.length > 150 ? '…' : ''));
        text.style.fontSize = `${Math.max(9, width * (entry.body.length > 70 ? 0.058 : 0.082))}px`;
        media.style.height = `${Math.round(width * ratio)}px`;
        media.appendChild(text);
      } else {
        media.style.height = `${Math.round(width * 0.9 * ratio)}px`;

        const img = el('img');
        // ใช้รูปย่อ 720px — การ์ดกว้างไม่กี่ร้อยพิกเซล ต่อให้ขยายเป็นไฮไลท์ก็ยังพอ
        // ถ้าใช้รูปเต็ม จอจะมีรูปใหญ่สิบกว่าใบพร้อมกันแล้วกล่องทีวีตาย
        img.src = entry.thumbUrl || entry.displayUrl || entry.mediaUrl;
        img.alt = '';
        img.decoding = 'async';
        media.appendChild(img);

        if (entry.kind === 'video') media.appendChild(playBadge());
      }

      card.appendChild(media);

      const name = el('span', 'card__name', entry.name || t('slideshow.anonymous'));
      name.style.fontSize = `${Math.max(8, width * 0.075)}px`;
      card.appendChild(name);

      node.appendChild(card);
      wall.appendChild(node);

      return { node, entry, slotIndex: 0, serial: placedSerial += 1 };
    }

    function playBadge() {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'card__play');
      svg.setAttribute('viewBox', '0 0 40 40');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', '20');
      circle.setAttribute('cy', '20');
      circle.setAttribute('r', '19');
      circle.setAttribute('fill', 'rgba(8,6,4,0.62)');
      const tri = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      tri.setAttribute('d', 'M16 12l14 8-14 8z');
      tri.setAttribute('fill', '#fbf4e8');
      svg.appendChild(circle);
      svg.appendChild(tri);
      return svg;
    }

    // ── สิ่งที่เอาขึ้นกำแพงได้ ────────────────────────────────────────────
    //
    // รูป วิดีโอ และคำอวยพร รวมเป็นรายการเดียวกัน คำอวยพรที่แนบรูปมานับเป็นรูป
    // ที่มีข้อความกำกับ ส่วนที่ไม่แนบก็เป็นกระดาษโน้ต

    function entries() {
      const list = deck.items.map((item) => ({
        key: `i${item.id}`,
        kind: item.kind,
        thumbUrl: item.thumbUrl,
        displayUrl: item.displayUrl,
        mediaUrl: item.mediaUrl,
        width: item.width,
        height: item.height,
        duration: item.duration,
        name: item.uploader,
        note: false,
      }));

      for (const message of deck.messages) {
        if (message.media) continue; // รูปที่แนบมาอยู่ในรายการรูปแล้ว ไม่ต้องซ้ำ
        list.push({ key: `m${message.id}`, note: true, body: message.body, name: message.author });
      }

      return list;
    }

    // ── เติมกำแพง และสลับของเก่าออกเมื่อมีของใหม่ ─────────────────────────

    /**
     * กวาดการ์ดที่หลุดออกจากบัญชีแต่ยังค้างอยู่ในหน้า
     *
     * ปกติไม่ควรมี แต่จอนี้เปิดทิ้งไว้เป็นสิบชั่วโมง ถ้าหลุดมาใบเดียวมันจะค้าง
     * ทับรูปอื่นไปตลอดงานโดยไม่มีอะไรมาเก็บ ตรวจทุกรอบจึงคุ้มกว่าปล่อยเสี่ยง
     */
    function sweepOrphans() {
      const owned = new Set(cards.map((card) => card.node));
      wall.querySelectorAll('.wall__card').forEach((node) => {
        if (!owned.has(node)) node.remove();
      });
    }

    function sync() {
      const available = entries();
      if (available.length === 0) return;

      const onWall = new Set(cards.map((card) => card.entry.key));
      const waiting = available.filter((entry) => !onWall.has(entry.key));

      // ยังมีช่องว่างอยู่ — เติมให้เต็มก่อน
      while (cards.length < slots.length && available.length > 0) {
        const entry = waiting.shift() ?? available[cards.length % available.length];
        const slotIndex = cards.length;
        const card = buildCard(entry, slots[slotIndex]);
        card.slotIndex = slotIndex;
        cards.push(card);
        settle(card);
      }

      // เต็มแล้วแต่มีของใหม่รอ — เอาเข้าไปแทนใบที่อยู่บนกำแพงมานานที่สุด
      // ข้ามใบที่กำลังเป็นไฮไลท์ ไม่งั้นรูปจะหายไปต่อหน้าคนที่กำลังดูอยู่
      //
      // ไม่สลับทีเดียวหมด — สลับได้ครั้งละไม่กี่ใบ ถ้าแขกส่งรูปมาพร้อมกันสิบใบ
      // แล้วกำแพงพลิกทั้งจอในวินาทีเดียว จะดูวุ่นวายและอ่านไม่ทัน
      let swapped = 0;
      for (const entry of waiting) {
        if (swapped >= 3) break;
        const oldest = pickOldest();
        if (!oldest) break;
        // หน่วงทีละใบ ให้ทยอยเปลี่ยนแทนที่จะเปลี่ยนพร้อมกัน
        replace(oldest, entry, swapped * 700);
        swapped += 1;
      }

      sweepOrphans();
    }

    /**
     * เลือกใบที่อยู่บนกำแพงมานานที่สุด โดยข้ามใบที่กำลังเป็นไฮไลท์
     * และข้ามใบที่ถูกจองไว้แล้วว่ากำลังจะถูกสลับ
     *
     * การจองสำคัญมาก — การสลับจริงถูกหน่วงไว้ให้ภาพค่อย ๆ จางก่อน ถ้าไม่จอง
     * รูปใหม่ทุกใบในรอบเดียวกันจะเลือก "ใบที่เก่าที่สุด" ใบเดียวกันหมด แล้วสร้าง
     * การ์ดทับกันที่ช่องเดียว จนเห็นเป็นกองซ้อนอยู่มุมจอ
     */
    function pickOldest() {
      let oldest = null;
      for (const card of cards) {
        if (card.slotIndex === hotIndex) continue;
        if (reserved.has(card)) continue;
        if (!oldest || card.serial < oldest.serial) oldest = card;
      }
      if (oldest) reserved.add(oldest);
      return oldest;
    }

    function replace(card, entry, delay) {
      const index = cards.indexOf(card);
      if (index === -1) {
        reserved.delete(card);
        return;
      }

      card.node.classList.add('is-entering');

      setTimeout(() => {
        const fresh = buildCard(entry, slots[card.slotIndex]);
        fresh.slotIndex = card.slotIndex;
        // เขียนทับตำแหน่งเดิมในอาร์เรย์ ไม่ใช่หา index ใหม่ตอนนี้ — ระหว่างที่รอ
        // อาจมีการสลับใบอื่นไปแล้ว การหาใหม่จะได้ -1 แล้วการ์ดจะหลุดออกจากบัญชี
        cards[index] = fresh;
        releaseCard(card);
        reserved.delete(card);
        settle(fresh);
      }, 900 + (delay || 0));
    }

    /** ปล่อยหน่วยความจำของการ์ดที่ถูกถอดออก แล้วเอา node ออกจากหน้า */
    function releaseCard(card) {
      stopVideo(card);
      card.node.querySelectorAll('img').forEach((img) => img.removeAttribute('src'));
      card.node.remove();
    }

    // ── วนไฮไลท์ ─────────────────────────────────────────────────────────

    function highlightNext() {
      // จอนี้ถูกเปิดทิ้งไว้ทั้งงานโดยไม่มีใครดูแล ถ้า error หลุดออกมาสักครั้ง
      // แล้วไม่มีใครรับ ลูปจะหยุดถาวรและรูปแรกจะค้างอยู่บนจอจนจบงาน
      try {
        cycle();
      } catch (error) {
        console.error('[wall] highlight failed, carrying on:', error);
        setTimeout(highlightNext, SECONDS * 1000);
      }
    }

    function cycle() {
      if (cards.length === 0) {
        setTimeout(highlightNext, 2000);
        return;
      }

      const previous = cards.find((card) => card.slotIndex === hotIndex);
      hotIndex = (hotIndex + 1) % cards.length;
      const next = cards.find((card) => card.slotIndex === hotIndex);

      if (previous) {
        stopVideo(previous);
        place(previous);
      }

      let hold = SECONDS * 1000;
      if (next) {
        place(next);
        hold = playIfVideo(next) ?? hold;
        // คำอวยพรต้องมีเวลาอ่าน เหมือนโหมดโรงหนัง
        if (next.entry.note) hold = Math.max(hold, readingTime({ body: next.entry.body }) * 1000);
      }

      setTimeout(highlightNext, hold);
    }

    // วิดีโอเล่นเฉพาะตอนเป็นไฮไลท์ ถ้าเล่นทุกใบพร้อมกันกล่องทีวีตายแน่
    function playIfVideo(card) {
      if (card.entry.kind !== 'video') return null;

      const media = card.node.querySelector('.card__media');
      const video = el('video');
      video.src = card.entry.mediaUrl;
      video.autoplay = true;
      video.muted = settings.muted !== false;
      video.playsInline = true;
      video.loop = true;
      media.appendChild(video);

      return Math.min(card.entry.duration || VIDEO_MAX, VIDEO_MAX) * 1000;
    }

    function stopVideo(card) {
      card.node.querySelectorAll('video').forEach((video) => {
        video.pause();
        video.removeAttribute('src');
        video.load();
        video.remove();
      });
    }

    // ── เริ่มทำงาน ───────────────────────────────────────────────────────

    buildSlots();
    sync();
    highlightNext();
    setInterval(async () => {
      await refresh();
      sync();
    }, 15_000);

    // เปลี่ยนความละเอียดจอหรือหมุนจอ — วางใหม่ทั้งกำแพง
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        buildSlots();
        cards.forEach((card, index) => {
          card.slotIndex = index;
          place(card);
        });
      }, 400);
    });
  }

  refresh().then(() => {
    if (MODE === 'wall') {
      startWall();
      return;
    }
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
