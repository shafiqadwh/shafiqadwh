#!/bin/sh
# กู้เว็บคืนเองถ้ามันล่ม — ตั้งใน Task Scheduler ให้รันตอนบูตและระหว่างงาน
#
#   sudo ./scripts/ensure-up.sh
#
# เว็บทำงานปกติอยู่ = ออกทันที ไม่แตะอะไรเลย (กรณีปกติ 99% ของการรัน)
# เว็บไม่ตอบ = ลองยกขึ้นด้วย GPU ก่อน ถ้าไม่ได้ให้ถอยเป็น CPU ซึ่งขึ้นได้เสมอ
#
# มีสคริปต์นี้เพราะคอนเทนเนอร์ที่ถูกสร้างมาพร้อมคำขอ GPU จะสตาร์ทไม่ขึ้นเลยถ้า
# NAS รีบูตแล้ว nvidia.ko ไม่โหลด — แล้วเจ้าภาพกำลังอยู่ในงานแต่ง ไม่ได้นั่งอยู่
# หน้าเทอร์มินัล การถอยเป็น CPU เสียแค่ความเร็วของคิวแปลงวิดีโอเบื้องหลัง
# ซึ่งไม่มีแขกคนไหนรออยู่ ดีกว่าเว็บล่มทั้งงานอย่างเทียบกันไม่ได้
#
# รันซ้ำได้ปลอดภัย

set -u

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

. ./scripts/lib-compose.sh

PORT="$(grep '^HTTP_PORT=' .env 2>/dev/null | head -1 | cut -d= -f2)"
PORT="${PORT:-18090}"

LOG_DIR="$(grep '^DATA_DIR=' .env 2>/dev/null | head -1 | cut -d= -f2)"
[ -n "${LOG_DIR:-}" ] || LOG_DIR="/volume1/wedding"
LOG="$LOG_DIR/ensure-up.log"

# เขียนล็อกเฉพาะตอนที่ต้องลงมือซ่อมจริง ๆ — รันทุก 5 นาทีแล้วเขียนทุกครั้ง
# จะได้ไฟล์ล็อกที่โตขึ้นเรื่อย ๆ โดยไม่มีข้อมูลอะไรอยู่ในนั้นเลย
note() {
  printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG" 2>/dev/null || \
    printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

healthy() {
  curl -fsS -m 5 "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1
}

# รอให้เว็บตอบ สูงสุด 60 วินาที — คอนเทนเนอร์ที่เพิ่งขึ้นใช้เวลาสักพักกว่าจะพร้อม
# (ENSURE_UP_WAIT มีไว้ให้เทสต์ย่นเวลารอ ไม่ต้องตั้งเองตอนใช้จริง)
WAIT_SECONDS="${ENSURE_UP_WAIT:-60}"

wait_healthy() {
  i=0
  while [ "$i" -lt "$WAIT_SECONDS" ]; do
    healthy && return 0
    i=$((i + 1))
    sleep 1
  done
  return 1
}

# ── ปกติดีอยู่แล้ว ออกเงียบ ๆ ────────────────────────────────────────────────
if healthy; then
  exit 0
fi

note "เว็บไม่ตอบที่ 127.0.0.1:$PORT — เริ่มกู้"

# ── ลองยกขึ้นตามปกติ (เปิด GPU ให้ถ้าใช้ได้) ────────────────────────────────
FILES="$(compose_files)"
case "$FILES" in
  *gpu*) note "ลองยกขึ้นพร้อม GPU" ;;
  *)     note "GPU ใช้ไม่ได้ตอนนี้ — ยกขึ้นด้วย CPU" ;;
esac

# shellcheck disable=SC2086
docker compose $FILES up -d >/dev/null 2>&1

if wait_healthy; then
  note "กู้สำเร็จ ($FILES)"
  exit 0
fi

# ── ถอยเป็น CPU ล้วน — เส้นทางที่ต้องขึ้นได้เสมอ ────────────────────────────
note "ยังไม่ขึ้น — ถอยเป็น CPU ล้วน"

# shellcheck disable=SC2086
docker compose $(compose_files_cpu) up -d >/dev/null 2>&1

if wait_healthy; then
  note "กู้สำเร็จด้วยโหมด CPU — GPU ถูกข้ามไป ตรวจไดรเวอร์ทีหลังได้ ไม่ต้องรีบ"
  exit 0
fi

note "กู้ไม่สำเร็จ — ต้องดูด้วยมือ: sudo docker compose logs --tail 50"
exit 1
