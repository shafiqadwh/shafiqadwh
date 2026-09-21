#!/bin/sh
# ลงทั้งสองโปรแกรมบนเครื่อง Ubuntu ที่เพิ่งลงระบบเสร็จ — คำสั่งเดียวจบ
#
#   ./scripts/install-ubuntu.sh
#   ./scripts/install-ubuntu.sh --camera --printer
#
# ทำอะไรบ้าง
#   1. ตรวจว่าเป็น Ubuntu/Debian จริง และ **ห้ามรันด้วย sudo** (ดูเหตุผลข้างล่าง)
#   2. ลงของจาก apt เท่าที่จำเป็น · `--camera` เพิ่ม gphoto2 · `--printer` เพิ่มไดรเวอร์
#   3. ลง Node.js 22 จาก NodeSource **เฉพาะตอนที่ของเดิมเก่าเกินไป**
#   4. `npm ci` ทั้งสองโฟลเดอร์ แล้วโหลดตัวโปรแกรม Electron
#   5. สร้าง `.env` ให้ถ้ายังไม่มี พร้อมสุ่มกุญแจและเดาไอพีของเครื่องนี้ให้
#   6. ตรวจผลทุกข้อแล้วสรุป — ไม่ใช่จบเงียบ ๆ แล้วให้ไปเดาเองว่าสำเร็จหรือเปล่า
#
# **ห้ามรันด้วย sudo** ทั้งตัว — ถ้ารันเป็น root ไฟล์ใน node_modules กับ .env
# จะกลายเป็นของ root แล้วตอนเปิดโปรแกรมด้วยผู้ใช้ปกติจะเขียนไฟล์ไม่ได้
# สคริปต์เรียก sudo เองเฉพาะบรรทัดที่ต้องใช้จริง (แพทเทิร์นเดียวกับที่
# fetch-music.sh เจอปัญหา chown มาแล้ว — ดูบทที่ 10 ของแผนงาน)
#
# รันซ้ำได้ปลอดภัย · รอบสองจะข้ามทุกอย่างที่ทำไว้แล้ว และ **ไม่ทับ .env เดิม**

set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

WITH_CAMERA=""
WITH_PRINTER=""
for arg in "$@"; do
  case "$arg" in
    --camera) WITH_CAMERA="1" ;;
    --printer) WITH_PRINTER="1" ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m⚠\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

# ── 0. ตรวจก่อนแตะอะไร ────────────────────────────────────────────────────

if [ "$(id -u)" = "0" ]; then
  bad "ห้ามรันด้วย sudo — รันเป็นผู้ใช้ปกติ สคริปต์จะขอ sudo เองเฉพาะตอนที่ต้องใช้"
  exit 1
fi

if ! command -v apt-get >/dev/null 2>&1; then
  bad "สคริปต์นี้สำหรับ Ubuntu/Debian เท่านั้น (ไม่เจอ apt-get)"
  exit 1
fi

# ── 1. ของจาก apt ─────────────────────────────────────────────────────────
#
# ไม่มี ffmpeg ในรายการนี้โดยตั้งใจ — เว็บมี ffmpeg-static/ffprobe-static เป็น
# dependency อยู่แล้วและใช้ตัวนั้น ส่วนบูธไม่ใช้ ffmpeg เลย GIF ทำด้วย sharp

PACKAGES="git curl build-essential python3"
[ -n "$WITH_CAMERA" ] && PACKAGES="$PACKAGES gphoto2"
[ -n "$WITH_PRINTER" ] && PACKAGES="$PACKAGES printer-driver-escpr printer-driver-gutenprint"

missing=""
for pkg in $PACKAGES; do
  dpkg -s "$pkg" >/dev/null 2>&1 || missing="$missing $pkg"
done

if [ -n "$missing" ]; then
  say "ลงของจาก apt:$missing"
  sudo apt-get update
  # shellcheck disable=SC2086
  sudo apt-get install -y --no-install-recommends $missing
else
  say "ของจาก apt ครบแล้ว ข้ามไป"
fi

# ── 2. Node.js 22 ─────────────────────────────────────────────────────────
#
# ของใน apt ของ Ubuntu 24.04 เก่ากว่าที่โปรเจกต์นี้ต้องใช้ · ลงจาก NodeSource
# เฉพาะตอนที่จำเป็นจริง ไม่ใช่ทับของที่ใช้ได้อยู่แล้ว

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

if [ "$(node_major)" -lt 22 ]; then
  say "Node ที่มีอยู่เก่าเกินไป (พบ $(node --version 2>/dev/null || echo 'ไม่มีเลย')) — ลง 22 จาก NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "Node $(node --version) ใช้ได้ ข้ามไป"
fi

[ "$(node_major)" -ge 22 ] || { bad "ลง Node 22 ไม่สำเร็จ หยุดตรงนี้"; exit 1; }

# ── 3. dependencies ของทั้งสองโปรแกรม ─────────────────────────────────────
#
# `npm ci` ลบ node_modules ทิ้งแล้วลงใหม่ทุกครั้ง ซึ่งกินเวลาหลายนาที · ข้ามได้
# เมื่อของที่ลงไว้ยังตรงกับ lockfile อยู่ ไม่งั้นการรันซ้ำจะกลายเป็นการรอเปล่า
# ทุกครั้ง แล้วคนก็จะเลิกรันซ้ำ ทั้งที่การรันซ้ำคือสิ่งที่ควรทำหลัง git pull

install_deps() {
  dir="$1"
  name="$2"
  if [ -d "$dir/node_modules" ] && [ ! "$dir/package-lock.json" -nt "$dir/node_modules" ]; then
    say "dependencies ของ$name ตรงกับ lockfile อยู่แล้ว ข้ามไป"
    return 0
  fi
  say "ลง dependencies ของ$name"
  (cd "$dir" && npm ci --no-audit --no-fund)
}

install_deps . "เว็บ"
install_deps photobooth "บูธ"

# ตัวโปรแกรม Electron ~150 MB · `npm ci` ไม่โหลดให้ตั้งแต่ Electron 44 เลิกมี
# postinstall — ต้องสั่งตอนยังมีเน็ต ไม่ใช่ปล่อยให้ไปโหลดตอนเปิดบูธที่หน้างาน
say "โหลดตัวโปรแกรม Electron (ข้ามเองถ้ามีแล้ว)"
(cd photobooth && npm run --silent install:electron)

# ── 4. .env ───────────────────────────────────────────────────────────────

lan_ip() {
  # ไอพีที่ใช้ออกไปข้างนอกจริง ไม่ใช่ 127.0.0.1 และไม่ใช่ทุกใบที่เครื่องมี
  ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1
}

if [ -f .env ]; then
  say ".env มีอยู่แล้ว — ไม่แตะ"
  warn "ถ้าเพิ่งย้ายเครื่องหรือเปลี่ยนไอพี ตรวจ BASE_URL ในไฟล์นั้นเองด้วย"
else
  say "สร้าง .env ให้ใหม่"
  IP="$(lan_ip)"
  [ -n "${IP:-}" ] || IP="127.0.0.1"

  # กุญแจบูธต้องเป็น ASCII ที่พิมพ์ได้และยาวอย่างน้อย 16 ตัว (ดู boothKey() ใน
  # src/config.js) · ว่าง = ปิดรับรูปจากบูธ ซึ่งเป็นค่าปลอดภัยที่ตั้งใจ แต่ที่นี่
  # เราตั้งให้เลยเพราะเครื่องนี้จะรันบูธด้วย
  KEY="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)"
  PASS="$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 16)"

  cp .env.example .env
  # ตั้งค่าด้วยการ "แทนที่ทั้งบรรทัด" ไม่ใช่ต่อท้าย — ต่อท้ายแล้วจะมีคีย์ซ้ำสองบรรทัด
  # ซึ่งอ่านแล้วงงว่าตัวไหนมีผล
  sed -i "s|^BASE_URL=.*|BASE_URL=http://$IP:3000|" .env
  sed -i "s|^BOOTH_KEY=.*|BOOTH_KEY=$KEY|" .env
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=$PASS|" .env

  ok "BASE_URL = http://$IP:3000"
  printf '\n  \033[1mจดสองค่านี้ไว้ ขึ้นแค่ครั้งเดียว\033[0m\n'
  printf '    รหัสเข้าหน้าแอดมิน : %s\n' "$PASS"
  printf '    กุญแจบูธ           : %s\n\n' "$KEY"
  warn "ไอพีต้องเป็นค่าคงที่ ตั้ง Manual ใน Settings → Network ไม่งั้น QR ที่พิมพ์แล้วจะชี้ผิดเครื่อง"
fi

# ── 5. ตรวจผล ─────────────────────────────────────────────────────────────
#
# กฎของโปรเจกต์: ยืนยันด้วยผลลัพธ์ ไม่ใช่ด้วยการที่ไม่มี error

say "ตรวจผล"
fails=0

# `set -e` ทำให้คำสั่งตรวจที่คืนค่าไม่ใช่ศูนย์ฆ่าสคริปต์ทิ้งกลางทาง ซึ่งกลับหัว
# กับหน้าที่ของบล็อกนี้พอดี — มันมีไว้รายงาน **ทุกข้อ** ที่ไม่ผ่าน ไม่ใช่หยุดที่ข้อแรก
# เรียกผ่าน if จึงไม่โดน set -e (เจอจริงตอนเขียนเทสต์: สคริปต์เงียบหายตรง -d node_modules)
check() {
  message="$1"
  shift
  if "$@"; then ok "$message"; else bad "$message"; fails=$((fails + 1)); fi
}

node_ok() { [ "$(node_major)" -ge 22 ]; }
electron_ok() {
  name="$(cat photobooth/node_modules/electron/path.txt 2>/dev/null || echo '')"
  [ -n "$name" ] && [ -x "photobooth/node_modules/electron/dist/$name" ]
}

check "Node $(node --version 2>/dev/null || echo 'ไม่มี')" node_ok
check "dependencies ของเว็บ" test -d node_modules
check "dependencies ของบูธ" test -d photobooth/node_modules
check "ตัวโปรแกรม Electron" electron_ok
check "BASE_URL ตั้งแล้ว" grep -q '^BASE_URL=http' .env

# กุญแจบูธมีสามสถานะ ไม่ใช่สองสถานะ
#
# ว่าง = ปิดรับรูปจากบูธ ซึ่งเป็นค่าที่ **ถูกต้อง** สำหรับเครื่องที่รันแต่เว็บ
# จึงเป็นคำเตือน ไม่ใช่ความล้มเหลว · แต่ "ตั้งไว้แล้วแต่ใช้ไม่ได้" (สั้นไปหรือมี
# อักขระที่ส่งเป็น HTTP header ไม่ได้) คือกับดักจริง เพราะเจ้าของคิดว่าตั้งแล้ว
# ส่วน config จะเมินมันเงียบ ๆ แล้วบูธส่งรูปไม่ขึ้นทั้งงานโดยไม่มีใครรู้
KEY_LINE="$(grep '^BOOTH_KEY=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
if [ -z "$KEY_LINE" ]; then
  warn "BOOTH_KEY ว่าง — บูธจะส่งรูปขึ้นเว็บไม่ได้ · ถูกแล้วถ้าเครื่องนี้รันแต่เว็บ"
elif printf '%s' "$KEY_LINE" | grep -q '^[ -~]\{16,\}$'; then
  ok "BOOTH_KEY ใช้ได้"
else
  bad "BOOTH_KEY ตั้งไว้แต่ใช้ไม่ได้ — ต้องเป็น ASCII ที่พิมพ์ได้ อย่างน้อย 16 ตัว"
  fails=$((fails + 1))
fi

if [ "$fails" -gt 0 ]; then
  printf '\n\033[31mยังไม่ผ่าน %s ข้อ\033[0m — แก้ตามบรรทัดที่ขึ้น ✗ แล้วรันสคริปต์นี้ซ้ำได้เลย\n' "$fails"
  exit 1
fi

cat <<'DONE'

ลงครบแล้ว · ขั้นต่อไปตามลำดับนี้

  1. เปิดเว็บ         npm start
  2. ตรวจว่าบูธคุยกับเว็บได้   npm run check:booth
  3. เปิดบูธ          cd photobooth && npm start
  4. ให้ทุกอย่างขึ้นเองหลังไฟดับ  ดู docs/13-install-linux.md หัวข้อ 11

ข้อ 4 สำคัญที่สุดถ้าจะปล่อยบูธทำงานเองหน้างาน · ซ้อมดึงปลั๊กหนึ่งครั้งที่บ้าน
DONE
