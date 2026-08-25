#!/bin/sh
# ตรวจทุกชั้นของเส้นทาง  เบราว์เซอร์ → nginx (DSM) → คอนเทนเนอร์  ในคำสั่งเดียว
#
#   sudo ./scripts/diagnose-nas.sh
#   sudo ./scripts/diagnose-nas.sh --host wedding.shafiq-lap.com --port 18090
#   sudo ./scripts/diagnose-nas.sh --public-port 8443   ถ้า reverse proxy ไม่ได้อยู่ที่ 443
#
# สคริปต์นี้ "อ่านอย่างเดียว" ไม่แก้อะไรทั้งสิ้น รันซ้ำได้ปลอดภัย
# ทุกหัวข้อบอกผลเป็น ✓ / ✗ พร้อมบอกว่าถ้าไม่ผ่านต้องไปแก้ตรงไหน

set -u

HOSTNAME_TO_TEST="wedding.shafiq-lap.com"
PORT=""
NAS_IP=""
# พอร์ตที่เบราว์เซอร์ยิงเข้า ไม่ใช่พอร์ตของแอป — ขั้นที่ 5 ของเอกสารอนุญาตให้ถอยไป 8443
# ถ้า DSM ไม่ยอมปล่อย 443 การฝังเลข 443 ไว้ตายตัวจะทำให้สคริปต์ตรวจผิดพอร์ตบนเครื่องแบบนั้น
PUBLIC_PORT="443"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOSTNAME_TO_TEST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --public-port) PUBLIC_PORT="$2"; shift 2 ;;
    --ip) NAS_IP="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ -z "$PORT" ]; then
  if [ -f .env ] && grep -q '^HTTP_PORT=' .env; then
    PORT="$(grep '^HTTP_PORT=' .env | head -1 | cut -d= -f2)"
  else
    PORT="18090"
  fi
fi

if [ -z "$NAS_IP" ]; then
  NAS_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}')"
  [ -n "${NAS_IP:-}" ] || NAS_IP="127.0.0.1"
fi

FAILED=0
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
bad()  { printf '  ✗ %s\n' "$*"; FAILED=$((FAILED + 1)); }
# ⚠ = ของที่ต้องรู้ แต่ไม่ใช่ความผิดพลาดของเครื่อง (เช่น พอร์ต 80 เป็นของ DSM ตามปกติ)
# แยกจาก ✗ เพราะถ้านับรวมเป็น "ไม่ผ่าน" คนอ่านจะไล่แก้ของที่ไม่ได้พัง
warn() { printf '  ⚠ %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }

printf 'ตรวจ %s  ·  พอร์ตแอป %s  ·  พอร์ตสาธารณะ %s  ·  ไอพี NAS %s\n' \
  "$HOSTNAME_TO_TEST" "$PORT" "$PUBLIC_PORT" "$NAS_IP"

# ── 1. คอนเทนเนอร์ยังรันอยู่ไหม ─────────────────────────────────────────────
step "1. คอนเทนเนอร์ wedding-share"

STATE="$(docker inspect -f '{{.State.Status}}' wedding-share 2>/dev/null)"
if [ "$STATE" = "running" ]; then
  HEALTH="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}ไม่มี healthcheck{{end}}' wedding-share 2>/dev/null)"
  ok "running (health: $HEALTH)"
else
  bad "สถานะ: ${STATE:-ไม่พบคอนเทนเนอร์}"
  info "แก้: sudo docker compose up -d"
  info "ดูสาเหตุ: sudo docker compose logs --tail 50"
fi

# ── 2. แอปตอบที่ loopback ไหม (ข้าม nginx ไปเลย) ────────────────────────────
step "2. แอปตอบตรง ๆ ที่ 127.0.0.1:$PORT"

APP_CODE="$(curl -sS -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$PORT/healthz" 2>/dev/null)"
if [ "$APP_CODE" = "200" ]; then
  ok "HTTP 200 — ตัวแอปทำงานปกติ ปัญหา (ถ้ามี) อยู่ชั้น nginx ขึ้นไป"
else
  bad "ได้ ${APP_CODE:-ไม่ตอบ} — แอปไม่ตอบที่ loopback"
  info "แก้: sudo docker compose up -d  แล้วรันสคริปต์นี้ใหม่"
fi

# ── 3. แอปผูกกับอินเทอร์เฟซไหน (loopback หรือทั้งวง) ────────────────────────
step "3. แอปผูกพอร์ตไว้ที่ไหน"

BINDINGS="$(netstat -tln 2>/dev/null | grep "[:.]$PORT " | awk '{print $4}')"
if [ -n "$BINDINGS" ]; then
  printf '%s\n' "$BINDINGS" | while read -r b; do info "$b"; done
  if printf '%s' "$BINDINGS" | grep -q '^127\.0\.0\.1'; then
    ok "ผูกกับ IPv4 loopback (ตรงมาตรฐาน)"
    info "⚠ ถ้า reverse proxy ตั้ง Destination hostname เป็น 'localhost'"
    info "  nginx อาจ resolve เป็น IPv6 ::1 แล้วต่อไม่ติด → 502"
    info "  ให้เปลี่ยนเป็น 127.0.0.1 ตรง ๆ"
  fi
else
  bad "ไม่มีอะไร listen ที่พอร์ต $PORT"
fi

# ── 3.5 ไฟล์อัพโหลดถูก copy ทั้งก้อนหรือแค่ rename ───────────────────────────
step "3.5 ทางเดินของไฟล์ตอนอัพโหลด"

# ถ้า tmp กับ uploads เป็นคนละ mount point ในคอนเทนเนอร์ rename() จะล้ม (EXDEV)
# โค้ดต้องตกไปใช้ copy ทั้งไฟล์ — วิดีโอ 200 MB คือดิสก์ทำงานเพิ่ม 400 MB ต่อคลิป
# โดยแขกยืนรออยู่ ตรวจด้วยเลข device ของ inode ไม่ใช่ด้วยชื่อ path
MOUNT_CHECK="$(docker exec wedding-share node -e '
  const fs = require("fs");
  const a = fs.statSync("/app/data/tmp").dev;
  const b = fs.statSync("/app/data/uploads").dev;
  console.log(a === b ? "same" : "split");
' 2>/dev/null)"

case "$MOUNT_CHECK" in
  same)
    ok "tmp กับ uploads อยู่ mount เดียวกัน — ย้ายไฟล์ด้วย rename (เร็ว)"
    ;;
  split)
    bad "tmp กับ uploads คนละ mount — ทุกไฟล์ถูก copy ทั้งก้อน อัพโหลดช้ากว่าที่ควร"
    info "แก้ที่ docker-compose.yml ให้ mount โฟลเดอร์แม่ครั้งเดียว:"
    info "    - /volume1/wedding:/app/data"
    info "  แทนการแยก uploads/derived/db/tmp เป็นสี่บรรทัด แล้ว sudo docker compose up -d"
    ;;
  *)
    info "ตรวจไม่ได้ (คอนเทนเนอร์ไม่ได้รันอยู่?)"
    ;;
esac

# ── 3.6 คลังเพลงอ่านได้จากในคอนเทนเนอร์ไหม ──────────────────────────────────
step "3.6 คลังเพลง (/app/data/music/library) อ่านได้จากในคอนเทนเนอร์ไหม"

# fetch-music.sh ต้องรันด้วย sudo (เขียนลงโฟลเดอร์ที่เจ้าของเป็น PUID:PGID ของ
# คอนเทนเนอร์ ไม่ใช่ root) ถ้าลืม chown ให้ตรงกัน ไฟล์จะเป็นของ root:root และ
# fs.readdir() ในคอนเทนเนอร์ (ซึ่งรันเป็น PUID:PGID ไม่ใช่ root) จะเจอ EACCES
# แล้วคืนคลังเพลงว่างเปล่าในหน้าเว็บ ทั้งที่ไฟล์อยู่ครบบนดิสก์จริง — เจอเคสนี้มาแล้ว
MUSIC_CHECK="$(docker exec wedding-share node -e '
  const fs = require("fs");
  try {
    const themes = fs.readdirSync("/app/data/music/library", { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."));
    console.log("OK " + themes.length);
  } catch (e) {
    console.log("ERR " + e.code);
  }
' 2>/dev/null)"

MUSIC_PUID=""
MUSIC_PGID=""
if [ -f .env ]; then
  MUSIC_PUID="$(grep '^PUID=' .env | head -1 | cut -d= -f2)"
  MUSIC_PGID="$(grep '^PGID=' .env | head -1 | cut -d= -f2)"
fi

case "$MUSIC_CHECK" in
  "OK "*)
    ok "อ่านได้ — เจอ $(printf '%s' "$MUSIC_CHECK" | cut -d' ' -f2) กลุ่มเพลง"
    ;;
  "ERR ENOENT")
    info "ยังไม่มีโฟลเดอร์คลังเพลง — ยังไม่ได้รัน sudo ./scripts/fetch-music.sh (ปกติ)"
    ;;
  ERR*)
    bad "อ่านคลังเพลงไม่ได้: $(printf '%s' "$MUSIC_CHECK" | cut -d' ' -f2) — คลังเพลงจะว่างเปล่าในหน้าเว็บ"
    info "มักเกิดจากไฟล์เป็นของ root (รัน fetch-music.sh ด้วย sudo แต่ยังไม่ chown)"
    info "แก้: sudo chown -R ${MUSIC_PUID:-1026}:${MUSIC_PGID:-100} /volume1/wedding/music"
    ;;
  *)
    info "ตรวจไม่ได้ (คอนเทนเนอร์ไม่ได้รันอยู่?)"
    ;;
esac

# ── 4. nginx ของ DSM ยังขึ้นอยู่ไหม ─────────────────────────────────────────
step "4. nginx ของ DSM"

if netstat -tln 2>/dev/null | grep -q "[:.]$PUBLIC_PORT "; then
  ok "มีบริการ listen ที่พอร์ต $PUBLIC_PORT"
else
  bad "ไม่มีอะไร listen ที่พอร์ต $PUBLIC_PORT — nginx ไม่ได้รัน"
  info "เกือบทุกครั้งคือ config ผิดจนสตาร์ทไม่ขึ้น ดูข้อ 5 ต่อ"
fi

# พอร์ต 80 เป็นของเว็บเริ่มต้นของ DSM ไม่ใช่ของกฎ reverse proxy (ซึ่งผูกกับ 443)
# ใครเปิดเว็บโดยไม่พิมพ์ https:// นำหน้าจะมาโผล่ที่นั่นแล้วได้หน้า "page not found"
# ของ Synology โดยที่แอปไม่ได้พังเลย — เกิดขึ้นจริงมาแล้ว
if netstat -tln 2>/dev/null | grep -q '[:.]80 '; then
  info "พอร์ต 80 มีคนฟังอยู่ (ปกติคือเว็บเริ่มต้นของ DSM) — ดูข้อ 8 ว่าเปิดด้วย http:// แล้วได้อะไร"
else
  info "ไม่มีอะไร listen ที่พอร์ต 80"
fi

# ── 5. ไฟล์ config ที่เราเพิ่มเข้าไปเอง ─────────────────────────────────────
step "5. ไฟล์ปรับลิมิตอัพโหลดใน /usr/local/etc/nginx/conf.d"

# โฟลเดอร์นี้มีไฟล์ของ DSM เองหลายสิบไฟล์ — สนใจเฉพาะไฟล์ที่ตั้งลิมิตขนาด body
# ไม่ต้องพ่นเนื้อไฟล์ทั้งหมดออกมา
CONF_DIR="/usr/local/etc/nginx/conf.d"
LIMIT_FILE=""

if [ -d "$CONF_DIR" ]; then
  LIMIT_FILE="$(grep -l 'client_max_body_size' "$CONF_DIR"/*.conf 2>/dev/null | head -1)"
fi

if [ -z "$LIMIT_FILE" ]; then
  bad "ไม่พบไฟล์ที่ตั้ง client_max_body_size — แขกจะอัพวิดีโอใหญ่ไม่ได้ (413)"
  info "แก้: ทำขั้นที่ 7 ใน docs/07-shafiq-nas.md แล้ว sudo synosystemctl restart nginx"
else
  ok "$(basename "$LIMIT_FILE")"
  sed 's/^/    /' "$LIMIT_FILE"

  # ลิมิตของ nginx ต้องมากกว่าลิมิตของแอป ไม่งั้นแขกจะเจอ 413 ของ nginx
  # ก่อนที่แอปจะได้อธิบายเป็นภาษาที่แขกอ่านออก
  NGINX_MB="$(sed -n 's/.*client_max_body_size[[:space:]]*\([0-9]*\)[mM].*/\1/p' "$LIMIT_FILE" | head -1)"
  APP_MB=""
  [ -f .env ] && APP_MB="$(sed -n 's/^MAX_VIDEO_MB=\([0-9]*\).*/\1/p' .env | head -1)"
  [ -n "$APP_MB" ] || APP_MB="300"

  if [ -n "$NGINX_MB" ] && [ "$NGINX_MB" -gt "$APP_MB" ] 2>/dev/null; then
    ok "ลิมิต nginx ${NGINX_MB}m > MAX_VIDEO_MB ของแอป ${APP_MB}m"
  else
    bad "ลิมิต nginx ${NGINX_MB:-?}m ไม่มากกว่า MAX_VIDEO_MB ${APP_MB}m"
    info "แขกจะโดน 413 ของ nginx ก่อนที่แอปจะบอกเหตุผลเป็นภาษาที่อ่านออก"
  fi
fi

# ── 6. ไวยากรณ์ config ของ nginx ───────────────────────────────────────────
step "6. ตรวจไวยากรณ์ config ของ nginx"

NGINX_BIN="$(command -v nginx 2>/dev/null || true)"
if [ -z "$NGINX_BIN" ]; then
  for candidate in /usr/bin/nginx /usr/sbin/nginx /bin/nginx; do
    [ -x "$candidate" ] && NGINX_BIN="$candidate" && break
  done
fi

if [ -n "$NGINX_BIN" ]; then
  if NGINX_OUT="$("$NGINX_BIN" -t 2>&1)"; then
    ok "config ผ่าน"
  else
    bad "config ไม่ผ่าน — nginx จะสตาร์ทไม่ขึ้น"
    printf '%s\n' "$NGINX_OUT" | sed 's/^/    /'
  fi
else
  info "หา nginx binary ไม่เจอ ข้ามข้อนี้"
fi

# ── 6.5 มีกฎ reverse proxy ของโฮสต์นี้อยู่จริงไหม ───────────────────────────
step "6.5 กฎ reverse proxy ของ $HOSTNAME_TO_TEST"

# ถาม nginx ตรง ๆ ว่า "ตอนนี้โหลดอะไรอยู่" ด้วย -T แทนการเดาว่า DSM เก็บไฟล์กฎไว้ที่ไหน
# (คนละที่กันตามเวอร์ชัน DSM) คำตอบจาก -T คือของที่มีผลจริง ไม่ว่าไฟล์จะวางอยู่ตรงไหน
if [ -z "$NGINX_BIN" ]; then
  info "ไม่มี nginx ให้ถาม ข้ามข้อนี้"
elif ! NGINX_DUMP="$("$NGINX_BIN" -T 2>/dev/null)"; then
  bad "สั่ง nginx -T ไม่สำเร็จ — ยังสรุปข้อนี้ไม่ได้ (ห้ามถือว่าผ่าน)"
  info "ลองเอง: sudo $NGINX_BIN -T | grep -n $HOSTNAME_TO_TEST"
else
  # ตัดเอาเฉพาะ server block ที่ server_name ตรงกับโฮสต์นี้ นับวงเล็บปีกกาเพื่อไม่ให้
  # location ข้างในทำให้หลุดบล็อกก่อนเวลา · รับ wildcard (*.shafiq-lap.com) ด้วย
  # ไม่งั้นจะรายงานว่า "ไม่มีกฎ" ทั้งที่ nginx เสิร์ฟอยู่จริง แล้วส่งคนไปสร้างกฎซ้ำ
  RULE="$(printf '%s\n' "$NGINX_DUMP" | awk -v host="$HOSTNAME_TO_TEST" '
    /^[ \t]*server[ \t]*\{/ && !inblock { inblock = 1; depth = 0; n = 0; hit = 0 }
    inblock {
      buf[++n] = $0
      for (i = 1; i <= length($0); i++) {
        c = substr($0, i, 1)
        if (c == "{") depth++
        else if (c == "}") depth--
      }
      if ($0 ~ /^[ \t]*server_name/) {
        line = $0
        gsub(/;/, " ", line)
        m = split(line, tok, /[ \t]+/)
        for (j = 1; j <= m; j++) {
          t = tok[j]
          if (t == host) hit = 1
          else if (substr(t, 1, 2) == "*.") {
            suf = substr(t, 2)
            if (length(host) > length(suf) &&
                substr(host, length(host) - length(suf) + 1) == suf) hit = 1
          }
        }
      }
      if (depth <= 0) {
        if (hit) for (i = 1; i <= n; i++) if (buf[i] ~ /listen|server_name|proxy_pass/) print buf[i]
        inblock = 0
      }
    }
  ')"

  if [ -z "$RULE" ]; then
    bad "ไม่มีกฎ reverse proxy สำหรับ $HOSTNAME_TO_TEST ในคอนฟิกที่ nginx โหลดอยู่จริง"
    info "นี่คือเหตุที่เบราว์เซอร์ได้หน้าเริ่มต้นของ DSM แทนเว็บงานแต่ง"
    info "สร้างตามตารางขั้นที่ 5 ของ docs/07-shafiq-nas.md:"
    info "  Control Panel → Login Portal → Advanced → Reverse Proxy → Create"
    info "  Source       HTTPS · $HOSTNAME_TO_TEST · $PUBLIC_PORT"
    info "  Destination  HTTP  · 127.0.0.1 · $PORT"
  else
    ok "เจอกฎที่ตรงกับชื่อนี้"
    printf '%s\n' "$RULE" | sed 's/^[[:space:]]*/    /'

    case "$RULE" in
      *proxy_pass*localhost*)
        bad "ปลายทางเป็น localhost — เครื่องที่เปิด IPv6 จะ resolve เป็น ::1 แล้วได้ 502"
        info "แก้ Destination hostname เป็น 127.0.0.1"
        ;;
    esac

    if printf '%s\n' "$RULE" | grep -q "proxy_pass.*:$PORT"; then
      ok "ปลายทางชี้ไปพอร์ต $PORT ตรงกับพอร์ตของแอป"
    else
      bad "ไม่เห็น proxy_pass ที่ชี้ไปพอร์ต $PORT — ตรวจ Destination port ให้ครบทุกหลัก"
    fi
  fi
fi

# ── 7. ยิงผ่าน nginx ด้วยชื่อโดเมนจริง (ชี้ IP เอง ไม่พึ่ง DNS) ──────────────
step "7. ยิงผ่าน nginx ด้วยชื่อ $HOSTNAME_TO_TEST"

# เก็บทั้งรหัสและเนื้อหาจากการยิง "ครั้งเดียว" — ข้อ 8 ต้องใช้เนื้อหา และการยิงซ้ำ
# เพื่อเอาเนื้อหาทีหลังอาจได้คนละคำตอบกับรหัสที่เพิ่งรายงานไป
# ใส่เลขพอร์ตใน URL ด้วยเสมอ เพราะ --resolve ผูกกับพอร์ต ถ้า URL ไม่มีพอร์ตมันจะไป 443
probe() {
  PROBE_TMP="$(mktemp)"
  PROBE_CODE="$(curl -sS -o "$PROBE_TMP" -m 10 -w '%{http_code}' --noproxy "*" \
    --resolve "$HOSTNAME_TO_TEST:$2:$NAS_IP" \
    "$1://$HOSTNAME_TO_TEST:$2/healthz" 2>/dev/null)"
  PROBE_BODY="$(head -c 400 "$PROBE_TMP" | tr -d '\r' | tr '\n' ' ')"
  rm -f "$PROBE_TMP"
}

probe https "$PUBLIC_PORT"
HTTPS_CODE="$PROBE_CODE"
HTTPS_BODY="$PROBE_BODY"

case "$HTTPS_CODE" in
  200) ok "https พอร์ต $PUBLIC_PORT → HTTP 200" ;;
  502|503)
    bad "https พอร์ต $PUBLIC_PORT → HTTP $HTTPS_CODE — nginx รับสายได้ แต่ต่อไปหาแอปไม่ติด"
    info "ไล่ตามลำดับ:"
    info "  ก) ข้อ 2 ได้ 200 ไหม — ถ้าไม่ แอปนั่นแหละที่ล่ม"
    info "  ข) Reverse Proxy → Destination hostname เปลี่ยนจาก localhost เป็น 127.0.0.1"
    info "  ค) Destination port ต้องเป็น $PORT พอดี (เคยพิมพ์ตกเลขมาแล้ว)"
    ;;
  000|"")
    bad "https พอร์ต $PUBLIC_PORT → ต่อไม่ติดเลย (ดูข้อ 4 กับ 6)"
    ;;
  *)
    bad "https พอร์ต $PUBLIC_PORT → HTTP $HTTPS_CODE — ข้อ 8 จะบอกว่าใครเป็นคนตอบ"
    ;;
esac

# ยิงพอร์ต 80 ด้วย ไม่ใช่เพื่อหาความผิด แต่เพื่อแยก "แอปพัง" ออกจาก "เปิดผิด scheme"
probe http 80
HTTP_CODE="$PROBE_CODE"
HTTP_BODY="$PROBE_BODY"

case "$HTTP_CODE" in
  000|"") info "http พอร์ต 80 → ไม่มีใครรับสาย" ;;
  *)      info "http พอร์ต 80 → HTTP $HTTP_CODE" ;;
esac

# ── 8. เนื้อหาที่ได้กลับมาใช่ของแอปจริงไหม ──────────────────────────────────
step "8. ใครเป็นคนตอบ — แอปจริง หรือหน้าเริ่มต้นของ DSM"

# ต้องดูเนื้อหา "ทุกกรณี" ไม่ใช่เฉพาะตอนได้ 200 แบบเดิม — อาการที่เจอจริงเมื่อ 21 ส.ค.
# คือ HTTP 404 พร้อมหน้า HTML ของ Synology ซึ่งเป็นกรณีที่โค้ดเดิมไม่เคยดูเนื้อหาเลย
judge() {
  case "$2" in
    *'"ok"'*) JUDGE_KIND="app" ;;
    *Synology*|*'page you are looking for'*) JUDGE_KIND="dsm" ;;
    '') JUDGE_KIND="empty" ;;
    *) JUDGE_KIND="other" ;;
  esac
}

judge "$HTTPS_CODE" "$HTTPS_BODY"
case "$JUDGE_KIND" in
  app) ok "https → แอปจริงตอบ: $HTTPS_BODY" ;;
  dsm)
    bad "https → หน้าเริ่มต้นของ DSM — nginx ตอบเอง ไม่ได้ส่งต่อไปหาแอป"
    info "กฎ reverse proxy ไม่ match ชื่อนี้ที่พอร์ต $PUBLIC_PORT (ดูข้อ 6.5 ประกอบ)"
    info "เช็คทีละช่อง: Source protocol ต้องเป็น HTTPS · Source hostname ต้องสะกดตรงเป๊ะ"
    ;;
  empty) info "https → ไม่มีเนื้อหากลับมา (HTTP $HTTPS_CODE) — นับไปแล้วในข้อ 7" ;;
  *) bad "https → เนื้อหาไม่ใช่ของแอป: $(printf '%s' "$HTTPS_BODY" | head -c 120)" ;;
esac

judge "$HTTP_CODE" "$HTTP_BODY"
case "$JUDGE_KIND" in
  app) ok "http → แอปจริงตอบเหมือนกัน" ;;
  dsm)
    warn "http → หน้าเริ่มต้นของ DSM · อันนี้ปกติ กฎผูกไว้กับพอร์ต $PUBLIC_PORT เท่านั้น"
    info "แปลว่า เปิดเว็บโดยไม่พิมพ์ https:// นำหน้า จะได้หน้านี้ทั้งที่แอปไม่ได้พังเลย"
    info "การ์ด QR ใช้ BASE_URL ซึ่งเป็น https อยู่แล้ว แขกที่สแกนจึงไม่เจอกรณีนี้"
    ;;
  empty) info "http → ไม่มีเนื้อหา (HTTP $HTTP_CODE)" ;;
  *) info "http → $(printf '%s' "$HTTP_BODY" | head -c 80)" ;;
esac

# ── 9. DNS สาธารณะยังชี้มาที่ไอพีบ้านตอนนี้ไหม (ข้อนี้คือตัวที่ทำให้ 5G เข้าไม่ได้) ──
step "9. DNS สาธารณะของ $HOSTNAME_TO_TEST เทียบกับไอพี WAN ตอนนี้"

pick_ipv4() { grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1; }

PUBLIC_DNS=""
if command -v nslookup >/dev/null 2>&1; then
  PUBLIC_DNS="$(nslookup "$HOSTNAME_TO_TEST" 1.1.1.1 2>/dev/null \
    | awk '/^Name:/ {seen=1} seen && /Address/ {print}' | pick_ipv4)"
fi
[ -n "$PUBLIC_DNS" ] || PUBLIC_DNS="$(getent hosts "$HOSTNAME_TO_TEST" 2>/dev/null | pick_ipv4)"

WAN_IP=""
for URL in https://api.ipify.org https://ifconfig.me/ip https://1.1.1.1/cdn-cgi/trace; do
  WAN_IP="$(curl -sS -m 8 --noproxy "*" "$URL" 2>/dev/null | pick_ipv4)"
  [ -n "$WAN_IP" ] && break
done

if [ -z "$PUBLIC_DNS" ]; then
  bad "ถาม DNS สาธารณะไม่ได้เลย — ยังสรุปข้อนี้ไม่ได้"
  info "ลองเองจากมือถือ: nslookup $HOSTNAME_TO_TEST 1.1.1.1"
elif [ -z "$WAN_IP" ]; then
  bad "หาไอพี WAN ตอนนี้ไม่ได้ — DNS สาธารณะตอบ $PUBLIC_DNS แต่ไม่มีอะไรให้เทียบ"
  info "ดูไอพีจริงที่ MikroTik: IP → Addresses (อินเทอร์เฟซ WAN)"
elif [ "$PUBLIC_DNS" = "$WAN_IP" ]; then
  ok "ตรงกันที่ $WAN_IP — แขกที่ใช้ 4G/5G จะวิ่งมาถูกบ้าน"
else
  bad "ไม่ตรงกัน — DNS ตอบ $PUBLIC_DNS แต่ไอพีบ้านตอนนี้คือ $WAN_IP"
  info "นี่คือสาเหตุที่ในบ้านเข้าได้ (AdGuard rewrite ชี้ 192.168.2.2 ตรง ๆ)"
  info "แต่จาก 4G/5G เข้าไม่ได้ — ระเบียนวิ่งไปหาไอพีของคนอื่นไปแล้ว"
  info "แก้ให้อัตโนมัติ: sudo ./scripts/cloudflare-ddns.sh"
  info "หรือแก้เอง: Cloudflare → DNS → ระเบียน A ของ $HOSTNAME_TO_TEST เป็น $WAN_IP (เมฆเทา)"
  info "แล้วรอ TTL หมดอายุ ค่อยตรวจซ้ำด้วยสคริปต์นี้"
fi

# ── สรุป ────────────────────────────────────────────────────────────────────
printf '\n═══════════════════════════════════════════════════════════\n'
if [ "$FAILED" -eq 0 ]; then
  printf ' ผ่านทุกข้อ\n'
else
  printf ' ไม่ผ่าน %d ข้อ — ดูบรรทัดที่ขึ้น ✗ ด้านบน\n' "$FAILED"
fi
printf '═══════════════════════════════════════════════════════════\n'

exit 0
