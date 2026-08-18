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
  # ไม่แสดงรหัสผ่าน แม้จะเป็นเจ้าของเครื่องเอง — สกรีนช็อตหลุดง่ายกว่าที่คิด
  grep -v '^#' .env | grep -v '^$' | sed 's/^\(ADMIN_PASSWORD=\).*/\1********/'
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
ยืนยันว่าได้ผลจริงด้วย:  sudo ./scripts/set-config.sh --show
EOT
