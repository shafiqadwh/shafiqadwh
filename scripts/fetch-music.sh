#!/bin/sh
# โหลดคลังเพลงลิขสิทธิ์ฟรีลง NAS ครั้งเดียว
#
#   sudo ./scripts/fetch-music.sh                 โหลดทุกกลุ่ม (~105 MB)
#   sudo ./scripts/fetch-music.sh --theme wedding โหลดเฉพาะกลุ่มที่ต้องการ
#   sudo ./scripts/fetch-music.sh --list          ดูว่ามีเพลงอะไรบ้าง ไม่โหลด
#   sudo ./scripts/fetch-music.sh --data-dir PATH  ชี้โฟลเดอร์ข้อมูลเอง
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
DATA_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --theme) ONLY="$2"; shift 2 ;;
    --list)  LIST="1"; shift ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

[ -f "$CATALOGUE" ] || { echo "ไม่พบ $CATALOGUE" >&2; exit 1; }

# โฟลเดอร์ข้อมูลคือโฟลเดอร์ที่ bind mount เข้าไปเป็น /app/data ในคอนเทนเนอร์
#
# ⚠️ ห้ามใช้ $PROJECT_DIR/data เป็นค่าเริ่มต้น — บนเครื่องจริงนั่นคือโฟลเดอร์ที่
# **แอปไม่เคยอ่าน** ค่า DATA_DIR ที่แอปใช้ถูกตั้งไว้ใน Dockerfile ซึ่งอยู่ในอิมเมจ
# ไม่ได้อยู่ใน .env บนโฮสต์ เคยพลาดตรงนี้แล้ว: สคริปต์รายงานว่าโหลดสำเร็จครบทุกเพลง
# แต่คลังเพลงในหน้าเว็บว่างเปล่า โดยไม่มีอะไรบอกว่าทำไม
if [ -z "$DATA_DIR" ]; then
  # ถามคอนเทนเนอร์ที่รันอยู่ก่อน — เป็นคำตอบที่ถูกเสมอไม่ว่าตั้งค่าไว้ยังไง
  DATA_DIR="$(docker inspect -f \
    '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Source}}{{end}}{{end}}' \
    wedding-share 2>/dev/null || true)"
fi
if [ -z "$DATA_DIR" ]; then
  # คอนเทนเนอร์ไม่ได้รัน — ใช้ค่าเดียวกับที่ deploy-nas.sh กับ backup-zip.sh ใช้
  DATA_DIR="/volume1/wedding"
fi

if [ ! -d "$DATA_DIR" ]; then
  cat >&2 <<EOF
  ✗ ไม่พบโฟลเดอร์ข้อมูล: $DATA_DIR

    เพลงต้องอยู่ในโฟลเดอร์เดียวกับที่แอปอ่าน ไม่งั้นโหลดเสร็จแล้วคลังจะว่างเปล่า
    ถ้าโฟลเดอร์ข้อมูลของคุณอยู่ที่อื่น สั่งแบบนี้

      sudo ./scripts/fetch-music.sh --data-dir /path/ถึงโฟลเดอร์ข้อมูล
EOF
  exit 1
fi

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
  #
  # --retry: archive.org กระจายไฟล์ไว้หลายโหนด บางโหนดตอบ 500/502 เป็นพัก ๆ
  # เคยเจอจริงแล้ว 7 ใน 22 เพลงล้มด้วย 500/502 ทั้งที่ยิงซ้ำแล้วได้ 302 ทุกครั้ง
  # curl ลองใหม่เองกับ 408/429/500/502/503/504 ซึ่งครอบคลุมทั้งสองรหัสนั้น
  #
  # ไม่ใช้ --retry-all-errors เพราะ 404 (ไฟล์ถูกถอดออกจริง) ลองกี่ครั้งก็ไม่หาย
  # รอเปล่า ๆ แล้วยังกลบสาเหตุที่แท้จริงด้วย
  #
  # -m 300 เป็นเพดานต่อการลองหนึ่งครั้ง ไม่ใช่เพดานรวมทั้งสามครั้ง จึงคงไว้
  if curl -fsSL -m 300 --retry 3 --retry-delay 3 -o "$DEST.part" "$url"; then
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
