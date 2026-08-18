#!/bin/sh
# ตรวจทุกชั้นของเส้นทาง  เบราว์เซอร์ → nginx (DSM) → คอนเทนเนอร์  ในคำสั่งเดียว
#
#   sudo ./scripts/diagnose-nas.sh
#   sudo ./scripts/diagnose-nas.sh --host wedding.shafiq-lap.com --port 18090
#
# สคริปต์นี้ "อ่านอย่างเดียว" ไม่แก้อะไรทั้งสิ้น รันซ้ำได้ปลอดภัย
# ทุกหัวข้อบอกผลเป็น ✓ / ✗ พร้อมบอกว่าถ้าไม่ผ่านต้องไปแก้ตรงไหน

set -u

HOSTNAME_TO_TEST="wedding.shafiq-lap.com"
PORT=""
NAS_IP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOSTNAME_TO_TEST="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --ip) NAS_IP="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
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
info() { printf '    %s\n' "$*"; }

printf 'ตรวจ %s  ·  พอร์ตแอป %s  ·  ไอพี NAS %s\n' "$HOSTNAME_TO_TEST" "$PORT" "$NAS_IP"

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

# ── 4. nginx ของ DSM ยังขึ้นอยู่ไหม ─────────────────────────────────────────
step "4. nginx ของ DSM"

if netstat -tln 2>/dev/null | grep -q '[:.]443 '; then
  ok "มีบริการ listen ที่พอร์ต 443"
else
  bad "ไม่มีอะไร listen ที่พอร์ต 443 — nginx ไม่ได้รัน"
  info "เกือบทุกครั้งคือ config ผิดจนสตาร์ทไม่ขึ้น ดูข้อ 5 ต่อ"
fi

# ── 5. ไฟล์ config ที่เราเพิ่มเข้าไปเอง ─────────────────────────────────────
step "5. ไฟล์ปรับลิมิตอัพโหลดใน /usr/local/etc/nginx/conf.d"

CONF_DIR="/usr/local/etc/nginx/conf.d"
if [ -d "$CONF_DIR" ]; then
  FILES="$(ls -1 "$CONF_DIR" 2>/dev/null)"
  if [ -z "$FILES" ]; then
    info "โฟลเดอร์ว่าง — ยังไม่ได้ใส่ลิมิต (อัพวิดีโอใหญ่จะติด 413)"
  else
    printf '%s\n' "$FILES" | while read -r f; do
      case "$f" in
        *[\[\]\(\)]*)
          printf '  ✗ ชื่อไฟล์ผิด: %s\n' "$f"
          printf '    ตอนวางคำสั่ง ชื่อไฟล์โดนแปลงเป็นลิงก์ ต้องลบทิ้งแล้วสร้างใหม่:\n'
          printf '      sudo rm -f "%s/%s"\n' "$CONF_DIR" "$f"
          ;;
        *.conf) printf '  ✓ %s\n' "$f" ;;
        *)
          printf '  ✗ %s — นามสกุลไม่ใช่ .conf nginx จะไม่อ่านไฟล์นี้\n' "$f"
          ;;
      esac
    done
    # ไฟล์ชื่อผิดไม่ถูกนับใน FAILED เพราะอยู่ใน subshell ของ while — เช็คซ้ำตรงนี้
    if ls -1 "$CONF_DIR" 2>/dev/null | grep -q '[][()]'; then
      FAILED=$((FAILED + 1))
    fi
    for f in "$CONF_DIR"/*.conf; do
      [ -f "$f" ] || continue
      info "── เนื้อไฟล์ $(basename "$f") ──"
      sed 's/^/    /' "$f"
    done
  fi
else
  info "ยังไม่มีโฟลเดอร์นี้ — ยังไม่ได้ใส่ลิมิต"
fi

# ── 6. ไวยากรณ์ config ของ nginx ───────────────────────────────────────────
step "6. ตรวจไวยากรณ์ config ของ nginx"

NGINX_BIN=""
for candidate in /usr/bin/nginx /usr/sbin/nginx /bin/nginx; do
  [ -x "$candidate" ] && NGINX_BIN="$candidate" && break
done

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

# ── 7. ยิงผ่าน nginx ด้วยชื่อโดเมนจริง (ชี้ IP เอง ไม่พึ่ง DNS) ──────────────
step "7. ยิงผ่าน nginx ด้วยชื่อ $HOSTNAME_TO_TEST"

PROXY_CODE="$(curl -sS -o /dev/null -m 10 -w '%{http_code}' \
  --noproxy "*" --resolve "$HOSTNAME_TO_TEST:443:$NAS_IP" \
  "https://$HOSTNAME_TO_TEST/healthz" 2>/dev/null)"

case "$PROXY_CODE" in
  200) ok "HTTP 200 — เส้นทางครบวงจรใช้ได้" ;;
  502|503)
    bad "HTTP $PROXY_CODE — nginx รับสายได้ แต่ต่อไปหาแอปไม่ติด"
    info "ไล่ตามลำดับ:"
    info "  ก) ข้อ 2 ได้ 200 ไหม — ถ้าไม่ แอปนั่นแหละที่ล่ม"
    info "  ข) Reverse Proxy → Destination hostname เปลี่ยนจาก localhost เป็น 127.0.0.1"
    info "  ค) Destination port ต้องเป็น $PORT พอดี (เคยพิมพ์ตกเลขมาแล้ว)"
    ;;
  000|"")
    bad "ต่อไม่ติดเลย — nginx ไม่ได้รับสายที่พอร์ต 443 (ดูข้อ 4 กับ 6)"
    ;;
  *)
    bad "HTTP $PROXY_CODE — ไม่ใช่ค่าที่คาดไว้"
    info "ถ้าได้ 200 แต่หน้าเป็นหน้า DSM แปลว่ากฎ reverse proxy ยังไม่ match ชื่อโดเมนนี้"
    ;;
esac

# ── 8. เนื้อหาที่ได้กลับมาใช่ของแอปจริงไหม ──────────────────────────────────
if [ "$PROXY_CODE" = "200" ]; then
  step "8. ตรวจว่าเนื้อหาที่ได้เป็นของแอปจริง ไม่ใช่หน้าเริ่มต้นของ DSM"
  BODY="$(curl -sS -m 10 --noproxy "*" --resolve "$HOSTNAME_TO_TEST:443:$NAS_IP" \
    "https://$HOSTNAME_TO_TEST/healthz" 2>/dev/null)"
  case "$BODY" in
    *'"ok"'*) ok "ได้ $BODY จากแอปจริง" ;;
    *) bad "เนื้อหาไม่ใช่ของแอป: $(printf '%s' "$BODY" | head -c 120)" ;;
  esac
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
