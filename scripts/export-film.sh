#!/bin/sh
# รวมรูปและวิดีโอทั้งงานให้เป็นไฟล์หนังหนึ่งไฟล์ — รันบน NAS หลังงานจบ
#
#   sudo ./scripts/export-film.sh
#   sudo ./scripts/export-film.sh --music /volume1/wedding/song.mp3
#   sudo ./scripts/export-film.sh --limit 20        ลองดูผลสั้น ๆ ก่อนรันเต็ม
#
# ตัวเลือกทั้งหมดส่งต่อไปให้ scripts/export-film.js ดูได้ด้วย --help
#
# ทำงานด้วยคอนเทนเนอร์ชั่วคราวตัวใหม่ ไม่ได้ยุ่งกับ wedding-share ที่ให้บริการอยู่
# เว็บจึงยังเปิดรับรูปได้ตามปกติระหว่างที่หนังกำลังเรนเดอร์ และถ้าการเรนเดอร์ล้ม
# ก็ไม่มีผลกับเว็บเลยแม้แต่น้อย
#
# ไม่ต้อง build อิมเมจใหม่ ทุกอย่างที่ใช้ (node, ffmpeg, sharp) อยู่ในอิมเมจเดิมแล้ว
# ส่วนฟอนต์ไทยเดินทางมากับโค้ดในโฟลเดอร์ assets/

set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

if [ ! -f .env ]; then
  echo "ไม่พบไฟล์ .env ในโฟลเดอร์นี้ — ต้องรันจากโฟลเดอร์โปรเจกต์บน NAS" >&2
  exit 1
fi

# ที่เก็บข้อมูลจริงอ่านจาก docker-compose.yml เพื่อไม่ต้องมาแก้สองที่เวลาย้ายที่เก็บ
DATA_HOST="$(grep -o '^[[:space:]]*-[[:space:]]*[^:]*:/app/data' docker-compose.yml \
  | head -1 | sed 's|.*-[[:space:]]*||; s|:/app/data||')"
DATA_HOST="${DATA_HOST:-/volume1/wedding}"

if [ ! -d "$DATA_HOST" ]; then
  echo "ไม่พบโฟลเดอร์ข้อมูล: $DATA_HOST" >&2
  exit 1
fi

PUID="$(grep '^PUID=' .env | head -1 | cut -d= -f2)"
PGID="$(grep '^PGID=' .env | head -1 | cut -d= -f2)"

echo "ข้อมูล: $DATA_HOST"
echo "ผลลัพธ์จะอยู่ที่ $DATA_HOST/export/wedding-film.mp4"
echo

# GPU ต่อให้ก็ต่อเมื่อใช้ได้จริง — `--gpus all` บนเครื่องที่ไม่มี GPU ทำให้
# `docker run` ล้มตั้งแต่ยังไม่ได้เริ่มเรนเดอร์ ซึ่งไม่ควรเป็นเหตุให้ทำหนังไม่ได้เลย
# (แอปยังมี activeEncoder() ตรวจซ้ำอีกชั้นตอนรัน ถ้า nvenc ใช้ไม่ได้ก็ถอยไป libx264)
. ./scripts/lib-compose.sh

# ค่าตัวเข้ารหัสส่งผ่านไฟล์ ไม่ใช่ต่อสตริง -e เอง เพราะค่าอย่าง "-preset p4 -cq 24"
# มีช่องว่าง พอปล่อยให้เชลล์แยกคำมันจะกลายเป็นอาร์กิวเมนต์ของ docker คนละตัว
GPU_ENV_FILE="$(mktemp)"
trap 'rm -f "$GPU_ENV_FILE"' EXIT

if gpu_ready; then
  echo "▸ ใช้ GPU เร่งการเรนเดอร์"
  GPU_ARGS="--gpus all"
  cat > "$GPU_ENV_FILE" <<'GPUENV'
VIDEO_ENCODER=h264_nvenc
VIDEO_ENCODER_ARGS=-preset p4 -cq 24
FILM_ENCODER_ARGS=-preset p4 -cq 20
VIDEO_DECODER_ARGS=-hwaccel cuda
GPUENV
else
  echo "▸ ไม่มี GPU ที่ใช้ได้ — เรนเดอร์ด้วย CPU (ช้ากว่า แต่ได้หนังเหมือนกัน)"
  GPU_ARGS=""
  : > "$GPU_ENV_FILE"
fi

# cpu-shares ต่ำกว่าปกติ (ค่ามาตรฐานคือ 1024) เพราะงานนี้กิน CPU ยาวหลายสิบนาที
# ปล่อยไว้เฉย ๆ จะไปแย่งเครื่องจนบริการอื่นบน NAS อืดไปด้วย
#
# ไม่ใช้ exec เพราะต้องให้ trap ได้เก็บไฟล์ชั่วคราวทิ้งหลังจบ
# ตั้งใจไม่ใส่ "" ครอบ $GPU_ARGS — ต้องให้เชลล์แยกเป็นสองอาร์กิวเมนต์
# shellcheck disable=SC2086
docker run --rm -i \
  --name wedding-film \
  --cpu-shares 512 \
  $GPU_ARGS \
  --env-file .env \
  --env-file "$GPU_ENV_FILE" \
  -e DATA_DIR=/app/data \
  --user "${PUID:-1026}:${PGID:-100}" \
  -v "$DATA_HOST:/app/data" \
  -v "$PROJECT_DIR/src:/app/src:ro" \
  -v "$PROJECT_DIR/scripts:/app/scripts:ro" \
  -v "$PROJECT_DIR/assets:/app/assets:ro" \
  -v "$PROJECT_DIR/locales:/app/locales:ro" \
  wedding-share:latest \
  node /app/scripts/export-film.js "$@"
