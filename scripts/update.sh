#!/bin/sh
# ดึงโค้ดล่าสุดลง NAS แล้วรีสตาร์ทให้ ในคำสั่งเดียว
#
#   sudo ./scripts/update.sh
#   sudo ./scripts/update.sh --env      ใช้เมื่อแก้ .env ด้วย (สร้างคอนเทนเนอร์ใหม่)
#
# มีสคริปต์นี้เพราะขั้นตอนอัปเดตเดิมเป็นบล็อกหลายบรรทัดที่ต้องวางพร้อมกัน
# ถ้า sudo เด้งถามรหัสตรงกลาง บรรทัดที่วางตามมาจะถูกดูดไปเป็นคำตอบของช่องรหัส
# แล้ว "แสดงรหัสออกมาเป็นข้อความธรรมดา" — เกิดขึ้นจริงมาแล้วสองครั้งในโปรเจกต์นี้
#
# คำสั่งเดียวจบ = ไม่มีบรรทัดค้างในบัฟเฟอร์ให้ sudo ดูดไปได้

set -eu

BRANCH="claude/wedding-photo-sharing-qr-j1oxn8"
REPO="shafiqadwh/shafiqadwh"
RECREATE="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --env) RECREATE="1"; shift ;;
    --branch) BRANCH="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

say "ดึงโค้ดล่าสุดจาก GitHub"
# โหลดลงไฟล์ชั่วคราวก่อนแตก ถ้าเน็ตสะดุดกลางทางจะได้ไม่แตกทับของเดิมครึ่ง ๆ กลาง ๆ
TARBALL="$(mktemp)"
trap 'rm -f "$TARBALL"' EXIT

curl -fsSL -o "$TARBALL" \
  "https://codeload.github.com/${REPO}/tar.gz/refs/heads/${BRANCH}"

# ตรวจว่าเป็นไฟล์ gzip จริง ไม่ใช่หน้า error ที่เซิร์ฟเวอร์ส่งมาเป็น 200
if ! gzip -t "$TARBALL" 2>/dev/null; then
  echo "ไฟล์ที่โหลดมาไม่ใช่ tarball — ไม่แตะโค้ดเดิม" >&2
  exit 1
fi

tar xzf "$TARBALL" --strip-components=1
chmod +x scripts/*.sh
say "แตกไฟล์เรียบร้อย"

if [ "$RECREATE" = "1" ]; then
  say "สร้างคอนเทนเนอร์ใหม่ (อ่าน .env ใหม่)"
  docker compose up -d
else
  # โค้ด bind-mount ไว้ รีสตาร์ทก็พอ ไม่ต้องสร้างคอนเทนเนอร์ใหม่
  say "รีสตาร์ทให้โหลดโค้ดใหม่"
  docker compose restart
fi

say "รอให้เว็บตอบ"
PORT="$(grep '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-18090}"

i=0
until curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "  ✗ ยังไม่ตอบหลังรอ 60 วินาที — ดู log: sudo docker compose logs --tail 50" >&2
    exit 1
  fi
  sleep 1
done

VERSION="$(curl -s "http://127.0.0.1:${PORT}/" | grep -o 'app\.css?v=[a-f0-9]*' | head -1)"
printf '  ✓ เว็บตอบแล้ว  ·  %s\n\n' "${VERSION:-ไม่พบเลขเวอร์ชันไฟล์}"

# ── เส้นทางที่คนใช้จริง ─────────────────────────────────────────────────────
# 127.0.0.1 ตอบแล้วไม่ได้แปลว่าเบราว์เซอร์เข้าได้ — ระหว่างสองจุดนั้นมี nginx ของ DSM คั่นอยู่
# เกิดขึ้นจริงมาแล้ว: สคริปต์นี้ขึ้น ✓ ตอนตี 6 แต่พอเปิด /admin ได้หน้า "page not found"
# ของ Synology เพราะกฎ reverse proxy ไม่ได้ส่งต่อมาที่แอป การตรวจแค่ loopback มองไม่เห็นชั้นนั้น
#
# ข้อนี้เป็น "คำเตือน" ไม่ใช่ความล้มเหลว — โค้ดถูกอัปเดตและแอปทำงานแล้วจริง ๆ
# การทำให้สคริปต์ออกด้วยรหัสผิดพลาดตรงนี้จะกลายเป็นการรายงานผิดอีกทางหนึ่ง
BASE="$(grep '^BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2- | tr -d '\r')"
if [ -n "${BASE:-}" ]; then
  SCHEME="${BASE%%://*}"
  HOST_PORT="${BASE#*://}"
  HOST_PORT="${HOST_PORT%%/*}"
  HOST="${HOST_PORT%%:*}"
  PUBLIC_PORT="${HOST_PORT#*:}"
  if [ "$PUBLIC_PORT" = "$HOST" ]; then
    [ "$SCHEME" = "http" ] && PUBLIC_PORT="80" || PUBLIC_PORT="443"
  fi

  # ชี้ไอพีเองไปที่ NAS เครื่องนี้ ไม่พึ่ง DNS — ระเบียนสาธารณะค้างอยู่ก็ยังตรวจได้
  LAN_IP="$(ip route get 1.1.1.1 2>/dev/null | awk '/src/ {print $7; exit}')"
  [ -n "${LAN_IP:-}" ] || LAN_IP="127.0.0.1"

  if curl -fsS -m 10 --noproxy '*' --resolve "$HOST:$PUBLIC_PORT:$LAN_IP" \
      "$SCHEME://$HOST:$PUBLIC_PORT/healthz" 2>/dev/null | grep -q '"ok"'; then
    printf '  ✓ เส้นทางจากเบราว์เซอร์ก็ถึงแอป  ·  %s://%s\n\n' "$SCHEME" "$HOST"
  else
    printf '  ⚠ แอปทำงานปกติ แต่ยิงผ่าน %s://%s แล้วไม่ถึงแอป\n' "$SCHEME" "$HOST"
    printf '    เบราว์เซอร์จะได้หน้าของ DSM แทนเว็บงานแต่ง — ตรวจต่อด้วย\n'
    printf '    sudo ./scripts/diagnose-nas.sh\n\n'
  fi
fi
