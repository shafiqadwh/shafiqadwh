#!/bin/sh
# เปลี่ยนรหัสผ่านแอดมินใน .env อย่างปลอดภัย
#
#   sudo ./scripts/set-admin-password.sh          สุ่มรหัสใหม่ให้ แล้วแสดงบนจอ
#   sudo ./scripts/set-admin-password.sh --ask    พิมพ์รหัสเอง (ไม่แสดงบนจอ)
#
# มีสคริปต์นี้เพราะ INFRASTANDARDS §8.4 ข้อ 3 — ห้ามให้คำสั่งที่มีช่องให้แทนค่าเอง
# แบบ ADMIN_PASSWORD=<รหัสที่ตั้งเอง> เคยมีคนวางตรง ๆ จนรหัสกลายเป็นข้อความนั้นจริง
#
# และตามข้อ 2 ของหัวข้อเดียวกัน โหมด --ask จะถามทีละบรรทัด
# ไม่รวมกับคำสั่งอื่น กันไม่ให้บรรทัดที่วางตามมากลายเป็นค่า input

set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "ไม่พบไฟล์ .env ในโฟลเดอร์นี้ — รัน ./scripts/deploy-nas.sh ก่อน" >&2
  exit 1
fi

if [ "${1:-}" = "--ask" ]; then
  printf 'พิมพ์รหัสผ่านใหม่ (อย่างน้อย 8 ตัว ไม่แสดงบนจอ): '
  stty -echo 2>/dev/null || true
  read -r NEW_PASSWORD
  stty echo 2>/dev/null || true
  echo
  if [ "${#NEW_PASSWORD}" -lt 8 ]; then
    echo "สั้นเกินไป — แอปต้องการอย่างน้อย 8 ตัวอักษร ไม่ได้เปลี่ยนอะไร" >&2
    exit 1
  fi
  SHOW=""
else
  NEW_PASSWORD="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-16)"
  SHOW="yes"
fi

# ใช้ awk แทน sed เพราะรหัสอาจมี & หรือ | ซึ่ง sed ตีความเป็นอักขระพิเศษ
awk -v pw="$NEW_PASSWORD" '
  /^ADMIN_PASSWORD=/ { print "ADMIN_PASSWORD=" pw; found = 1; next }
  { print }
  END { if (!found) print "ADMIN_PASSWORD=" pw }
' .env > .env.new

mv .env.new .env
chmod 600 .env

echo
if [ -n "$SHOW" ]; then
  echo "  ┌──────────────────────────────────────────────┐"
  printf '  │ รหัสผ่านแอดมินใหม่: %-24s │\n' "$NEW_PASSWORD"
  echo "  └──────────────────────────────────────────────┘"
  echo "  จดไว้ให้ดี"
else
  echo "  ตั้งรหัสผ่านใหม่เรียบร้อย"
fi

cat <<'EOF'

ขั้นต่อไป — ต้องสร้างคอนเทนเนอร์ใหม่ ไม่ใช่แค่ restart:

  sudo docker compose up -d

(restart ไม่โหลดค่าจาก .env ใหม่)
เซสชันที่ล็อกอินค้างไว้ในมือถือจะยังใช้ได้ต่อ ไม่หลุดกลางงาน
EOF
