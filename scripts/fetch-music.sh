#!/bin/sh
# โหลดคลังเพลงลิขสิทธิ์ฟรีลง NAS ครั้งเดียว
#
#   sudo ./scripts/fetch-music.sh                 โหลดทุกกลุ่ม (~105 MB)
#   sudo ./scripts/fetch-music.sh --theme wedding โหลดเฉพาะกลุ่มที่ต้องการ
#   sudo ./scripts/fetch-music.sh --list          ดูว่ามีเพลงอะไรบ้าง ไม่โหลด
#
# ทำไมไม่เอาไฟล์เพลงใส่ใน git: `scripts/update.sh` โหลด tarball ของโค้ดทั้งก้อน
# ใหม่ทุกครั้งที่อัปเดต ไฟล์เสียงร้อยเมกะไบต์จะถูกลากมาซ้ำทุกครั้งไปตลอด
# ทั้งที่เพลงโหลดครั้งเดียวก็พอ
#
# เพลงทั้งหมดเป็นบันทึกเสียงสาธารณสมบัติจาก Musopen บน archive.org สัญญาอนุญาต
# CC0 1.0 — ใช้ได้ทุกกรณีโดยไม่ต้องให้เครดิต รายละเอียดอยู่ใน assets/music-catalogue.json
#
# รันซ้ำได้ปลอดภัย เพลงที่โหลดครบและแฮชตรงแล้วจะถูกข้าม

set -eu

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

CATALOGUE="assets/music-catalogue.json"
ONLY=""
LIST="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --theme) ONLY="$2"; shift 2 ;;
    --list)  LIST="1"; shift ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

[ -f "$CATALOGUE" ] || { echo "ไม่พบ $CATALOGUE" >&2; exit 1; }

DATA_DIR="$(grep '^DATA_DIR=' .env 2>/dev/null | head -1 | cut -d= -f2-)"
DATA_DIR="${DATA_DIR:-$PROJECT_DIR/data}"
LIBRARY="$DATA_DIR/music/library"

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }

# node อ่าน JSON ให้ แทนที่จะงม jq ซึ่งไม่มีติดมากับ DSM
plan() {
  node -e '
    const fs = require("node:fs");
    const cat = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const only = process.argv[2];
    for (const [theme, tracks] of Object.entries(cat.themes)) {
      if (only && theme !== only) continue;
      for (const t of tracks) {
        // แท็บคั่น เพราะชื่อเพลงมีช่องว่างและจุด
        process.stdout.write([theme, t.file, t.url, t.sha256, t.seconds, t.title].join("\t") + "\n");
      }
    }
  ' "$CATALOGUE" "$ONLY"
}

if [ "$LIST" = "1" ]; then
  plan | while IFS="$(printf '\t')" read -r theme file url sha seconds title; do
    printf '  %-11s %3d:%02d  %s\n' "$theme" $((seconds / 60)) $((seconds % 60)) "$title"
  done
  exit 0
fi

TOTAL=0
GOT=0
SKIPPED=0
FAILED=0

say "โหลดเพลงลง $LIBRARY"

# ใช้ไฟล์ชั่วคราวเก็บผลนับ เพราะ while ที่อ่านจากไปป์รันใน subshell
# ตัวแปรที่บวกข้างในจะหายไปเมื่อจบลูป (กับดักคลาสสิกของ sh)
COUNTS="$(mktemp)"
trap 'rm -f "$COUNTS"' EXIT
printf '0 0 0 0\n' > "$COUNTS"

plan | while IFS="$(printf '\t')" read -r theme file url sha seconds title; do
  read -r TOTAL GOT SKIPPED FAILED < "$COUNTS"
  TOTAL=$((TOTAL + 1))

  DIR="$LIBRARY/$theme"
  DEST="$DIR/$file"
  mkdir -p "$DIR"

  if [ -f "$DEST" ]; then
    HAVE="$(sha256sum "$DEST" | cut -d' ' -f1)"
    if [ "$HAVE" = "$sha" ]; then
      SKIPPED=$((SKIPPED + 1))
      printf '  · มีแล้ว  %s\n' "$title"
      printf '%d %d %d %d\n' "$TOTAL" "$GOT" "$SKIPPED" "$FAILED" > "$COUNTS"
      continue
    fi
    printf '  ! ไฟล์เดิมแฮชไม่ตรง โหลดใหม่: %s\n' "$title"
    rm -f "$DEST"
  fi

  # โหลดลงชื่อชั่วคราวก่อน ไฟล์ครึ่ง ๆ กลาง ๆ จะได้ไม่ถูกนับว่าโหลดเสร็จแล้ว
  # ในการรันรอบถัดไป — แนวเดียวกับ atomically() ของงาน export หนัง
  if curl -fsSL -m 300 -o "$DEST.part" "$url"; then
    HAVE="$(sha256sum "$DEST.part" | cut -d' ' -f1)"
    if [ "$HAVE" = "$sha" ]; then
      mv "$DEST.part" "$DEST"
      GOT=$((GOT + 1))
      printf '  ✓ %s\n' "$title"
    else
      # แฮชไม่ตรงคือทิ้ง ไม่ใช่เตือนแล้วเก็บไว้ — ไฟล์เสียจะไปทำให้ ffmpeg ล้ม
      # ตอนนาทีที่สี่สิบของการเรนเดอร์ ไม่ใช่ตอนนี้
      rm -f "$DEST.part"
      FAILED=$((FAILED + 1))
      printf '  ✗ แฮชไม่ตรง ทิ้งไฟล์: %s\n' "$title" >&2
    fi
  else
    rm -f "$DEST.part"
    FAILED=$((FAILED + 1))
    printf '  ✗ โหลดไม่สำเร็จ: %s\n' "$title" >&2
  fi

  printf '%d %d %d %d\n' "$TOTAL" "$GOT" "$SKIPPED" "$FAILED" > "$COUNTS"
done

read -r TOTAL GOT SKIPPED FAILED < "$COUNTS"
printf '\n  รวม %d เพลง · โหลดใหม่ %d · มีอยู่แล้ว %d · ไม่สำเร็จ %d\n' \
  "$TOTAL" "$GOT" "$SKIPPED" "$FAILED"

if [ "$FAILED" -gt 0 ]; then
  echo "  ลองรันซ้ำอีกครั้ง เพลงที่โหลดสำเร็จแล้วจะถูกข้าม" >&2
  exit 1
fi

cat <<EOF

  เพลงพร้อมใช้แล้ว เปิด /admin แล้วเลือกกลุ่มเพลงตอนสร้างหนัง
  เพลงที่อัพเองจะอยู่ในกลุ่ม "ของฉัน" ปนกับกลุ่มพวกนี้ได้
EOF
