#!/bin/sh
# รวมไฟล์งานแต่งเป็น ZIP แยกตามประเภท เพื่อเก็บถาวรหรือส่งต่อให้คู่บ่าวสาว
#
#   ./scripts/backup-zip.sh [โฟลเดอร์ข้อมูล] [โฟลเดอร์ปลายทาง]
#
# ค่าเริ่มต้น: /volume1/wedding → /volume1/backup
#
# แยก 3 ไฟล์เพราะรูปมักถูกส่งต่อให้ญาติ ส่วนวิดีโอใหญ่เกินกว่าจะแชร์ทางแชต

set -eu

DATA_DIR="${1:-/volume1/wedding}"
OUT_DIR="${2:-/volume1/backup}"
STAMP="$(date +%Y-%m-%d)"

UPLOADS="$DATA_DIR/uploads"
DB_DIR="$DATA_DIR/db"

if [ ! -d "$UPLOADS" ]; then
  echo "ไม่พบโฟลเดอร์ $UPLOADS — ตรวจ path อีกครั้ง" >&2
  exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
  echo "ไม่มีคำสั่ง zip บนเครื่องนี้ — ใช้ปุ่มดาวน์โหลดในหน้า /admin แทนได้" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

photos_zip="$OUT_DIR/wedding-photos-$STAMP.zip"
videos_zip="$OUT_DIR/wedding-videos-$STAMP.zip"
db_zip="$OUT_DIR/wedding-db-$STAMP.zip"

echo "กำลังรวมรูป..."
find "$UPLOADS" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
  -o -iname '*.webp' -o -iname '*.heic' \) -print \
  | zip -q -0 -@ "$photos_zip" || true

echo "กำลังรวมวิดีโอ..."
find "$UPLOADS" -type f \( -iname '*.mp4' -o -iname '*.mov' -o -iname '*.m4v' \
  -o -iname '*.webm' \) -print \
  | zip -q -0 -@ "$videos_zip" || true

echo "กำลังสำรองฐานข้อมูลและคำอวยพร..."
# -1 เพราะ SQLite บีบได้ดี ต่างจากไฟล์รูปที่บีบแล้วไม่เล็กลง
zip -q -1 -r "$db_zip" "$DB_DIR" || true

echo
echo "เสร็จแล้ว:"
for file in "$photos_zip" "$videos_zip" "$db_zip"; do
  [ -f "$file" ] && echo "  $(du -h "$file" | cut -f1)\t$file"
done

echo
echo "อย่าลืมคัดลอกไฟล์เหล่านี้ออกไปเก็บนอก NAS ด้วย —"
echo "สำเนาที่อยู่บนดิสก์ก้อนเดียวกันไม่ถือว่าเป็นการสำรองข้อมูล"

# งานอื่นในเครื่องเดียวกัน — สคริปต์นี้สำรองได้ทีละงาน
#
# เครื่องหนึ่งเครื่องรับได้หลายงาน แต่ละงานมีโฟลเดอร์ของตัวเองใต้ events/
# ถ้าไม่บอกตรงนี้ เจ้าของจะรันคำสั่งเดียวแล้วคิดว่าสำรองครบทั้งเครื่องแล้ว
# ทั้งที่ได้มาแค่งานเดียว — ซึ่งจะรู้ตัวก็ตอนที่ต้องใช้สำเนาจริงเท่านั้น
if [ -d "$DATA_DIR/events" ]; then
  found=""
  for dir in "$DATA_DIR"/events/*/; do
    [ -d "$dir/uploads" ] || continue
    if [ -z "$found" ]; then
      echo
      echo "ยังมีงานอื่นในเครื่องนี้ที่ยังไม่ได้สำรอง — สั่งทีละงานตามนี้:"
      found="yes"
    fi
    echo "  $0 ${dir%/} $OUT_DIR"
  done
fi
