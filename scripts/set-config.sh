#!/bin/sh
# แก้ค่าใน .env อย่างปลอดภัย
#
#   sudo ./scripts/set-config.sh MAX_VIDEO_SECONDS=60
#   sudo ./scripts/set-config.sh MAX_VIDEO_SECONDS=60 MAX_TOTAL_STORAGE_GB=100
#   sudo ./scripts/set-config.sh --show            ดูค่าปัจจุบันทั้งหมด
#
# มีสคริปต์นี้เพราะพิมพ์ NAME=value ลงเชลล์ตรง ๆ "ดูเหมือนได้ผล" แต่ไม่ได้แก้
# ไฟล์อะไรเลย — มันตั้งตัวแปรของเชลล์ที่หายไปทันทีที่ปิดหน้าต่าง
# (INFRASTANDARDS §8.4 ข้อ 3: อย่าให้คำสั่งที่ต้องแทนค่าเอง)
#
# สคริปต์จะปฏิเสธชื่อค่าที่ไม่มีใน .env.example เพื่อกันพิมพ์ผิดแล้วได้ค่าที่
# ไม่มีผลอะไร โดยที่ไม่มีอะไรเตือน

set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "ไม่พบไฟล์ .env ในโฟลเดอร์นี้ — รัน ./scripts/deploy-nas.sh ก่อน" >&2
  exit 1
fi

if [ "$#" -eq 0 ] || [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
fi

if [ "${1:-}" = "--show" ]; then
  echo "── ค่าที่ตั้งไว้ใน .env ─────────────────────────────────────────"
  # ไม่แสดงรหัสผ่านหรือโทเคน แม้จะเป็นเจ้าของเครื่องเอง — สกรีนช็อต/แชทหลุดง่ายกว่าที่คิด
  # (เจอมาแล้วจริง: CLOUDFLARE_API_TOKEN โผล่เต็มค่าในแชทตอนก็อปผล --show ไปถาม)
  grep -v '^#' .env | grep -v '^$' \
    | sed -E 's/^(ADMIN_PASSWORD|CLOUDFLARE_API_TOKEN)=.*/\1=********/'

  # .env ถูกสร้างครั้งเดียวตอนติดตั้ง แล้วไม่ได้ตามการอัปเดตโค้ด ค่าใหม่ที่เพิ่ม
  # มาทีหลังจึงไม่มีในไฟล์ ซึ่งไม่ได้พังอะไร (โค้ดมีค่าเริ่มต้นให้ทุกตัว) แต่ถ้า
  # ไม่บอกไว้ เปิดไฟล์มาแล้วไม่เห็นชื่อค่าที่อ่านเจอในคู่มือ จะนึกว่าระบบเสีย
  missing=""
  for key in $(grep -o '^[A-Z_][A-Z0-9_]*=' .env.example | tr -d '='); do
    grep -q "^${key}=" .env || missing="$missing $key"
  done

  if [ -n "$missing" ]; then
    echo ""
    echo "── ไม่ได้ตั้งไว้ ใช้ค่าเริ่มต้นของโปรแกรม (ปกติ ไม่ต้องแก้) ──────"
    for key in $missing; do
      printf '  %s\n' "$(grep "^${key}=" .env.example)"
    done
  fi
  exit 0
fi

changed=0

for pair in "$@"; do
  case "$pair" in
    *=*) ;;
    *) echo "รูปแบบต้องเป็น ชื่อค่า=ค่าใหม่ เช่น MAX_VIDEO_SECONDS=60 (ได้มา: $pair)" >&2; exit 1 ;;
  esac

  key="${pair%%=*}"
  value="${pair#*=}"

  if ! grep -q "^${key}=" .env.example; then
    echo "ไม่รู้จักค่าชื่อ \"$key\" — ดูรายชื่อทั้งหมดได้ใน .env.example" >&2
    exit 1
  fi

  # ใช้ awk ไม่ใช่ sed เพราะค่าอาจมี & หรือ | ซึ่ง sed ตีความเป็นอักขระพิเศษ
  awk -v k="$key" -v v="$value" '
    $0 ~ "^" k "=" { print k "=" v; found = 1; next }
    { print }
    END { if (!found) print k "=" v }
  ' .env > .env.new

  mv .env.new .env
  echo "  $key = $value"
  changed=$((changed + 1))
done

chmod 600 .env

cat <<EOT

แก้ไป $changed ค่า — ต้องสร้างคอนเทนเนอร์ใหม่ให้อ่านค่าใหม่:

  sudo docker compose up -d

(restart อย่างเดียวไม่พอ มันไม่โหลด .env ใหม่)

หมายเหตุ: คำสั่งข้างบนยกขึ้นในโหมด CPU เสมอ ซึ่งเป็นโหมดที่ขึ้นได้แน่นอน
ถ้าเครื่องนี้ใช้ GPU อยู่และอยากให้กลับมาด้วย ใช้  sudo ./scripts/update.sh --env
แทน (มันตรวจ GPU ให้เองแล้วเปิดให้ถ้าใช้ได้)

ยืนยันว่าได้ผลจริงด้วย:  sudo ./scripts/set-config.sh --show
EOT
