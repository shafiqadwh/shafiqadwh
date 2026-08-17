#!/bin/sh
# ติดตั้งหรืออัปเดต wedding-share บน Synology / Xpenology (DSM 7)
#
#   sudo ./scripts/deploy-nas.sh
#   sudo ./scripts/deploy-nas.sh --port 8181 --data /volume2/wedding
#   sudo ./scripts/deploy-nas.sh --dry-run       ดูว่าจะทำอะไรบ้างโดยยังไม่ลงมือ
#
# สคริปต์นี้จะ: ตรวจ docker → สร้างโฟลเดอร์ข้อมูล → ตั้งสิทธิ์ให้ถูก →
# สร้างไฟล์ .env พร้อมรหัสแอดมินแบบสุ่ม (ถ้ายังไม่มี) → build → รัน →
# รอจนเว็บตอบ แล้วบอก URL ที่เปิดได้

set -eu

DATA_ROOT="/volume1/wedding"
PORT="8080"
DRY_RUN="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --data) DATA_ROOT="$2"; shift 2 ;;
    --dry-run) DRY_RUN="1"; shift ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

say() { printf '%s\n' "$*"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    "$@"
  fi
}

# ── 1. หา docker compose ────────────────────────────────────────────────────
step "ตรวจ Docker"

if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif docker-compose version >/dev/null 2>&1; then
  COMPOSE="docker-compose"
elif [ "$DRY_RUN" = "1" ]; then
  COMPOSE="docker compose"
  say "  (dry-run) ข้ามการตรวจ docker"
else
  cat >&2 <<'EOF'
ไม่พบคำสั่ง docker

ถ้าใช้ DSM 7: ติดตั้ง "Container Manager" จาก Package Center ก่อน
แล้วรันสคริปต์นี้ด้วย sudo อีกครั้ง
EOF
  exit 1
fi
say "  ใช้: $COMPOSE"

# ── 2. เช็คว่าพอร์ตว่างไหม ──────────────────────────────────────────────────
step "ตรวจพอร์ต $PORT"

if command -v netstat >/dev/null 2>&1 && netstat -tln 2>/dev/null | grep -q "[:.]$PORT "; then
  say "  ⚠ พอร์ต $PORT ถูกใช้อยู่แล้ว — สิ่งที่รันอยู่ตอนนี้:"
  docker ps --format '     {{.Names}}  {{.Ports}}' 2>/dev/null || true
  say ""
  say "  เลือกพอร์ตอื่นแล้วรันใหม่ เช่น:  sudo $0 --port 8181"
  [ "$DRY_RUN" = "1" ] || exit 1
else
  say "  พอร์ต $PORT ว่าง"
fi

# ── 3. เตรียมโฟลเดอร์เก็บไฟล์ ───────────────────────────────────────────────
step "เตรียมโฟลเดอร์ที่ $DATA_ROOT"

for sub in uploads derived db tmp; do
  run mkdir -p "$DATA_ROOT/$sub"
  say "  $DATA_ROOT/$sub"
done

# เจ้าของโฟลเดอร์ต้องตรงกับ user ในคอนเทนเนอร์ ไม่งั้นอัพโหลดจะ error ทุกครั้ง
if [ -n "${SUDO_UID:-}" ]; then
  PUID="$SUDO_UID"
  PGID="${SUDO_GID:-100}"
else
  PUID="$(id -u)"
  PGID="$(id -g)"
fi
say "  ตั้งเจ้าของเป็น $PUID:$PGID"
run chown -R "$PUID:$PGID" "$DATA_ROOT"

# ── 4. สร้างไฟล์ .env ───────────────────────────────────────────────────────
step "ตั้งค่า .env"

# หา IP ในวง LAN ของ NAS — ลองหลายวิธีเพราะ DSM แต่ละรุ่นมีคำสั่งไม่เหมือนกัน
LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}')"
[ -n "${LAN_IP:-}" ] || LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${LAN_IP:-}" ] || LAN_IP="$(ifconfig 2>/dev/null | awk '/inet addr:/ {sub(/addr:/,"",$2); print $2}' | grep -v '^127\.' | head -1)"
[ -n "${LAN_IP:-}" ] || LAN_IP="$(ip -4 addr show scope global 2>/dev/null | awk '/inet / {sub(/\/.*/,"",$2); print $2; exit}')"
[ -n "${LAN_IP:-}" ] || LAN_IP="ไอพีของ-nas"

if [ -f .env ]; then
  say "  มี .env อยู่แล้ว — ไม่แก้ทับ"
else
  ADMIN_PW="$(head -c 12 /dev/urandom | base64 | tr -d '/+=' | cut -c1-12)"
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] จะสร้าง .env ใหม่ พร้อมรหัสแอดมินแบบสุ่ม"
  else
    cp .env.example .env
    sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$ADMIN_PW|" .env
    sed -i "s|^BASE_URL=.*|BASE_URL=http://$LAN_IP:$PORT|" .env
    printf '\nPUID=%s\nPGID=%s\nHTTP_PORT=%s\n' "$PUID" "$PGID" "$PORT" >> .env
    say "  สร้าง .env แล้ว"
    say ""
    say "  ┌──────────────────────────────────────────────┐"
    printf '  │ รหัสผ่านแอดมิน: %-28s │\n' "$ADMIN_PW"
    say "  └──────────────────────────────────────────────┘"
    say "  จดไว้ให้ดี (แก้ทีหลังได้ในไฟล์ .env)"
  fi
fi

say ""
say "  ⚠ อย่าลืมแก้ COUPLE_NAMES, EVENT_DATE และ BASE_URL ใน .env"
say "    ให้เป็นค่าจริงก่อนสั่งพิมพ์การ์ด QR (ดู docs/03-qr-cards.md)"

# ── 5. build และรัน ─────────────────────────────────────────────────────────
step "Build และรันคอนเทนเนอร์ (ครั้งแรกใช้เวลา 3-5 นาที)"

run $COMPOSE up -d --build

# ── 6. รอให้เว็บตอบ ─────────────────────────────────────────────────────────
step "รอให้เว็บพร้อมใช้งาน"

if [ "$DRY_RUN" = "1" ]; then
  say "  [dry-run] ข้ามการรอ"
else
  i=0
  until curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      say "  ✗ ยังไม่ตอบหลังรอ 60 วินาที — ดู log ด้วย:"
      say "      $COMPOSE logs --tail 50"
      exit 1
    fi
    sleep 1
  done
  say "  ✓ เว็บตอบแล้ว"
fi

cat <<EOF

═══════════════════════════════════════════════════════════
 เสร็จแล้ว เปิดจากมือถือที่ต่อ Wi-Fi เดียวกับ NAS:

   เว็บแขก      http://$LAN_IP:$PORT
   หน้าแอดมิน   http://$LAN_IP:$PORT/admin
   สไลด์โชว์    http://$LAN_IP:$PORT/slideshow

 คำสั่งที่ใช้บ่อย:
   $COMPOSE logs -f          ดู log
   $COMPOSE restart          รีสตาร์ท
   $COMPOSE down             หยุด

 ขั้นถัดไป: เปิดให้เข้าจากอินเทอร์เน็ต → docs/02-ddns-reverse-proxy.md
═══════════════════════════════════════════════════════════
EOF
