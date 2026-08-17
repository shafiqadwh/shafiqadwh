#!/bin/sh
# ส่งโค้ดขึ้น NAS ที่ไม่มี git และ sshd ไม่มี SFTP subsystem
#
#   ./scripts/push-to-nas.sh shafiqadwh@192.168.2.2
#   ./scripts/push-to-nas.sh shafiqadwh@192.168.2.2 --restart
#   ./scripts/push-to-nas.sh shafiqadwh@192.168.2.2 --dest /volume1/docker/wedding-share
#   ./scripts/push-to-nas.sh shafiqadwh@192.168.2.2 -i ~/.ssh/nas_ed25519
#
# รันจากเครื่อง PC ของคุณ ไม่ใช่บน NAS
# ใช้ `scp -O` (legacy protocol) เพราะ sshd ของ DSM ไม่มี SFTP subsystem
#
# --restart จะสั่ง docker compose restart ให้ด้วย — พอสำหรับการแก้โค้ด
# เพราะ src/ views/ public/ locales/ ถูก bind-mount ไว้ ไม่ต้อง rebuild image
# (ถ้าแก้ package.json หรือ Dockerfile ต้อง Clean + Build เอง)

set -eu

TARGET=""
DEST="/volume1/docker/wedding-share"
SSH_KEY=""
RESTART="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="$2"; shift 2 ;;
    -i) SSH_KEY="$2"; shift 2 ;;
    --restart) RESTART="1"; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done

if [ -z "$TARGET" ]; then
  echo "ต้องระบุปลายทาง เช่น: $0 shafiqadwh@192.168.2.2" >&2
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ -n "$SSH_KEY" ]; then
  SSH="ssh -i $SSH_KEY"
  SCP="scp -O -i $SSH_KEY"
else
  SSH="ssh"
  SCP="scp -O"
fi

ARCHIVE="$(mktemp -t wedding-share-XXXXXX.tar.gz)"
trap 'rm -f "$ARCHIVE"' EXIT

printf '\n▸ รวมไฟล์\n'
# ตัดของที่ไม่ควรส่ง: git history, node_modules (build ใหม่บน NAS),
# รูปที่อัพโหลดไว้ และ .env ซึ่งต้องอยู่บน NAS เท่านั้น
tar --exclude='./.git' \
    --exclude='./node_modules' \
    --exclude='./data' \
    --exclude='./.env' \
    --exclude='./test-output' \
    --exclude='*.log' \
    -czf "$ARCHIVE" .
printf '  %s\n' "$(du -h "$ARCHIVE" | cut -f1)"

printf '\n▸ ส่งขึ้น %s\n' "$TARGET"
$SSH "$TARGET" "mkdir -p '$DEST'"
$SCP "$ARCHIVE" "$TARGET:$DEST/.push.tar.gz"

printf '\n▸ แตกไฟล์บน NAS\n'
# ไม่ลบโฟลเดอร์เดิมทิ้ง เพราะ .env และไฟล์ข้อมูลอยู่ในนั้น — tar จะเขียนทับเฉพาะไฟล์ที่ส่งไป
$SSH "$TARGET" "cd '$DEST' && tar -xzf .push.tar.gz && rm -f .push.tar.gz && ls -1 | head -20"

if [ "$RESTART" = "1" ]; then
  printf '\n▸ รีสตาร์ทคอนเทนเนอร์\n'
  $SSH "$TARGET" "cd '$DEST' && sudo docker compose restart"
fi

cat <<EOF

═══════════════════════════════════════════════════════════
 ส่งขึ้น NAS เรียบร้อย: $DEST

 ขั้นถัดไปบน NAS:
   แก้แค่โค้ด/คำแปล   sudo docker compose restart
   แก้ package.json   sudo docker compose up -d --build
   ติดตั้งครั้งแรก      sudo ./scripts/deploy-nas.sh --lan

 ดูขั้นตอนเต็ม: docs/07-shafiq-nas.md
═══════════════════════════════════════════════════════════
EOF
