#!/bin/sh
# อัปเดตระเบียน A บน Cloudflare ให้ตรงกับไอพีบ้านปัจจุบันโดยอัตโนมัติ
#
#   sudo ./scripts/cloudflare-ddns.sh --setup    ตั้งค่าโทเคนครั้งแรก (ถามทีละบรรทัด)
#   sudo ./scripts/cloudflare-ddns.sh --setup-from FILE   อ่านโทเคนจากไฟล์ แล้วลบไฟล์ทิ้งเอง
#   sudo ./scripts/cloudflare-ddns.sh            อัปเดตถ้าจำเป็น — ใช้ตัวนี้กับตัวตั้งเวลา
#   sudo ./scripts/cloudflare-ddns.sh --check    ตรวจอย่างเดียว ไม่แก้อะไรเลย
#   sudo ./scripts/cloudflare-ddns.sh --quiet    พูดเฉพาะตอนเปลี่ยนจริงหรือมีปัญหา
#   sudo ./scripts/cloudflare-ddns.sh --ip 1.2.3.4   บอกไอพีเอง (เมื่อ NAS ถามเว็บข้างนอกไม่ได้)
#
# มีสคริปต์นี้เพราะระเบียน A ของ wedding ถูกกรอกเป็นไอพีคงที่ด้วยมือ และไม่มีอะไร
# คอยอัปเดตให้ พอ 3BB จ่ายไอพีใหม่ ระเบียนก็ค้างที่เลขเก่า → ในบ้านยังเข้าได้
# (AdGuard rewrite ชี้ 192.168.2.2 ตรง ๆ) แต่แขกที่ใช้ 4G/5G เข้าไม่ได้ทั้งงาน
#
# ความปลอดภัยของโทเคน (INFRASTANDARDS §8.4):
#   · โทเคนอยู่ใน .env เท่านั้น ซึ่ง .gitignore ครอบไว้แล้ว — ไม่มีวันติดไปกับ git
#   · ไม่ส่งโทเคนผ่าน argument ของ curl เพราะคนอื่นบนเครื่องเห็นได้ด้วย ps
#     ส่งผ่าน config ทาง stdin แทน (curl -K -)
#   · โหมด --setup ถามทีละบรรทัด ไม่พิมพ์โทเคนกลับออกจอ และในเอกสารทั้งหมด
#     ไม่มีบรรทัดตัวอย่างที่เว้นช่องให้แทนค่าเอง — เพราะเคยมีคนวางบรรทัดตัวอย่าง
#     ลงไปตรง ๆ จนค่าจริงกลายเป็นข้อความในวงเล็บนั้น
#
# รันซ้ำได้ปลอดภัย — ถ้าระเบียนตรงอยู่แล้วจะไม่ยิงอะไรไปที่ Cloudflare เลย

set -u

# CLOUDFLARE_API มีไว้ให้เทสต์ชี้ไปที่เซิร์ฟเวอร์จำลอง — ใช้งานจริงไม่ต้องตั้ง
API="${CLOUDFLARE_API:-https://api.cloudflare.com/client/v4}"
HOST=""
FORCED_IP=""
TOKEN_FILE=""
ZONE=""
ZONE_ID_ARG=""
TTL=""
MODE="update"
QUIET="0"

while [ $# -gt 0 ]; do
  case "$1" in
    --setup) MODE="setup"; shift ;;
    --setup-from) MODE="setup"; TOKEN_FILE="$2"; shift 2 ;;
    --check) MODE="check"; shift ;;
    --quiet) QUIET="1"; shift ;;
    --host)  HOST="$2"; shift 2 ;;
    --zone)  ZONE="$2"; shift 2 ;;
    --zone-id) ZONE_ID_ARG="$2"; shift 2 ;;
    --ttl)   TTL="$2"; shift 2 ;;
    --ip)    FORCED_IP="$2"; shift 2 ;;
    -h|--help) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ไม่รู้จักตัวเลือก: $1" >&2; exit 1 ;;
  esac
done

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

say()  { [ "$QUIET" = "1" ] || printf '\033[1m▸ %s\033[0m\n' "$*"; }
ok()   { [ "$QUIET" = "1" ] || printf '  ✓ %s\n' "$*"; }
info() { [ "$QUIET" = "1" ] || printf '    %s\n' "$*"; }
# โหมด --quiet มีไว้ให้ตัวตั้งเวลาเก็บลงไฟล์ log — บรรทัดที่หลุดออกมาจึงต้องมีเวลากำกับ
# ไม่งั้นอ่านย้อนหลังแล้วไม่รู้ว่าไอพีเปลี่ยนตอนไหน
stamp() { [ "$QUIET" = "1" ] && printf '[%s] ' "$(date '+%Y-%m-%d %H:%M')"; }
loud() { stamp; printf '  ✓ %s\n' "$*"; }
die()  { stamp >&2; printf '  ✗ %s\n' "$*" >&2; exit 1; }

# ── อ่านค่าจาก .env ────────────────────────────────────────────────────────
# cut -d= -f2- เพราะโทเคนของ Cloudflare มี _ และ - ได้ และค่าอื่นอาจมี = อยู่ข้างใน
env_value() {
  [ -f .env ] || return 0
  grep "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- \
    | sed 's/^"\(.*\)"$/\1/; s/^'"'"'\(.*\)'"'"'$/\1/'
}

env_put() {
  # เขียนด้วย awk ไม่ใช่ sed เพราะค่าอาจมี & หรือ | ซึ่ง sed ตีความเป็นอักขระพิเศษ
  [ -f .env ] || die "ไม่พบไฟล์ .env — รัน ./scripts/deploy-nas.sh ก่อน"
  awk -v k="$1" -v v="$2" '
    index($0, k "=") == 1 { print k "=" v; found = 1; next }
    { print }
    END { if (!found) print k "=" v }
  ' .env > .env.ddns.new || die "เขียน .env ไม่สำเร็จ"
  mv .env.ddns.new .env
  chmod 600 .env
}

# ── โหมดตั้งค่าครั้งแรก ────────────────────────────────────────────────────
if [ "$MODE" = "setup" ]; then
  cat <<'EOF'
สร้างโทเคนที่ Cloudflare ก่อน — My Profile → API Tokens → Create Token
  · Template: Edit zone DNS
  · Permissions: Zone → DNS → Edit   (สคริปต์นี้ต้องการเท่านี้ ไม่ต้องให้มากกว่านี้)
  · Zone Resources: Include → Specific zone → shafiq-lap.com

EOF
  if [ -n "$TOKEN_FILE" ]; then
    [ -f "$TOKEN_FILE" ] || die "ไม่พบไฟล์ $TOKEN_FILE"
    RAW="$(cat "$TOKEN_FILE")"
  else
    printf 'วางโทเคนแล้วกด Enter (ไม่แสดงบนจอ): '
    stty -echo 2>/dev/null || true
    read -r RAW

    # กวาดสิ่งที่ยังค้างในบัฟเฟอร์ทิ้ง — ถ้าวางมาเกินหนึ่งบรรทัด ส่วนที่เหลือจะตกไป
    # เป็นคำสั่งของ shell หลังสคริปต์จบ แล้วโทเคนจะโผล่บนจอและลงไปอยู่ใน history
    if stty -icanon min 0 time 0 2>/dev/null; then
      while IFS= read -r LEFTOVER; do
        [ -n "$LEFTOVER" ] && LEAKED="yes"
      done
      stty icanon 2>/dev/null || true
    fi

    stty echo 2>/dev/null || true
    echo
  fi

  # PowerShell/PuTTY ส่งท้ายบรรทัดมาเป็น CRLF — \r ที่ติดมาทำให้ header ของ curl พัง
  # แล้ว Cloudflare ตอบ "Invalid format for Authorization header" ทั้งที่โทเคนถูกต้อง
  NEW_TOKEN="$(printf '%s' "$RAW" | tr -d '\r\n\t ')"
  RAW=""

  [ -n "$NEW_TOKEN" ] || die "ไม่ได้ใส่อะไรมา — ไม่ได้แก้ .env"

  case "$NEW_TOKEN" in
    *[!A-Za-z0-9_-]*) die "โทเคนมีอักขระที่ไม่ควรมี — ไม่ได้แก้ .env
    โทเคนของ Cloudflare มีแต่ A-Z a-z 0-9 _ และ - เท่านั้น" ;;
  esac

  printf 'ตรวจโทเคนกับ Cloudflare... '
  VERIFY="$(printf 'header = "Authorization: Bearer %s"\n' "$NEW_TOKEN" \
    | curl -sS -m 20 -K - "$API/user/tokens/verify" 2>/dev/null)"
  case "$VERIFY" in
    *'"success":true'*) echo "ใช้ได้" ;;
    *) echo; die "Cloudflare ไม่รับโทเคนนี้ — ไม่ได้แก้ .env
    คำตอบที่ได้: $(printf '%s' "$VERIFY" | head -c 200)" ;;
  esac

  env_put CLOUDFLARE_API_TOKEN "$NEW_TOKEN"
  NEW_TOKEN=""
  [ -n "$TOKEN_FILE" ] && rm -f "$TOKEN_FILE"
  echo
  loud "เก็บโทเคนลง .env แล้ว (สิทธิ์ไฟล์ 600)"
  info ".env อยู่ใน .gitignore — โทเคนจะไม่ติดไปกับ git"
  [ -n "$TOKEN_FILE" ] && info "ลบไฟล์ $TOKEN_FILE ทิ้งให้แล้ว"

  if [ -n "${LEAKED:-}" ]; then
    echo
    echo "  ⚠ มีข้อความที่วางมาเกินหนึ่งบรรทัด ส่วนที่เกินถูกกวาดทิ้งแล้ว"
    echo "    ถ้าเห็นโทเคนโผล่บนจอตอนใดตอนหนึ่ง ให้ถือว่าหลุดแล้ว — เพิกถอนที่ Cloudflare"
    echo "    แล้วล้างประวัติคำสั่ง:  cat /dev/null > ~/.bash_history && history -c"
  fi

  info "ขั้นต่อไป: sudo ./scripts/cloudflare-ddns.sh"
  exit 0
fi

TOKEN="$(env_value CLOUDFLARE_API_TOKEN)"
[ -n "$TOKEN" ] || die "ยังไม่มี CLOUDFLARE_API_TOKEN ใน .env — รัน: sudo ./scripts/cloudflare-ddns.sh --setup"

if [ -z "$HOST" ]; then
  BASE="$(env_value BASE_URL)"
  HOST="$(printf '%s' "${BASE:-}" | sed 's|^https\{0,1\}://||; s|[:/].*$||')"
fi
[ -n "$HOST" ] || die "หาชื่อโฮสต์ไม่ได้ — ใส่เองด้วย --host wedding.shafiq-lap.com"

# ── ยิง API โดยไม่ให้โทเคนโผล่ใน ps ────────────────────────────────────────
# ต่อท้ายด้วยรหัส HTTP บนบรรทัดสุดท้าย จะได้แยกคำตอบจริงกับความล้มเหลวออกจากกันได้
cf() {
  METHOD="$1"; URL="$2"; BODY="${3:-}"
  if [ -n "$BODY" ]; then
    printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$TOKEN" \
      | curl -sS -m 25 -K - -X "$METHOD" --data "$BODY" -w '\n%{http_code}' "$URL" 2>/dev/null
  else
    printf 'header = "Authorization: Bearer %s"\n' "$TOKEN" \
      | curl -sS -m 25 -K - -X "$METHOD" -w '\n%{http_code}' "$URL" 2>/dev/null
  fi
}

http_code() { printf '%s' "$1" | tail -1; }
payload()   { printf '%s' "$1" | sed '$d'; }

# ดึงค่าของคีย์แรกที่เจอในก้อน JSON — "zone_id" ไม่ชนกับ "id" เพราะรูปแบบที่หาคือ "id":"
json_str() { printf '%s' "$2" | grep -o "\"$1\":\"[^\"]*\"" | head -1 | sed "s/^\"$1\":\"//; s/\"$//"; }
json_num() { printf '%s' "$2" | grep -o "\"$1\":[0-9]*" | head -1 | sed "s/^\"$1\"://"; }

pick_ipv4() { grep -Eo '([0-9]{1,3}\.){3}[0-9]{1,3}' | head -1; }

# ── 1. ไอพีบ้านตอนนี้ — ต้องได้ตรงกันจากสองแหล่ง ────────────────────────────
say "1. ไอพีสาธารณะของบ้านตอนนี้"

A=""; B=""; C=""
if [ -n "$FORCED_IP" ]; then
  A="$FORCED_IP"; B="$FORCED_IP"
else
  A="$(curl -sS -m 10 https://api.ipify.org 2>/dev/null | pick_ipv4)"
  B="$(curl -sS -m 10 https://checkip.amazonaws.com 2>/dev/null | pick_ipv4)"
  if [ -z "$A" ] || [ -z "$B" ] || [ "$A" != "$B" ]; then
    C="$(curl -sS -m 10 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' | pick_ipv4)"
  fi
fi

WAN=""
for X in "$A" "$B" "$C"; do
  [ -n "$X" ] || continue
  N=0
  for Y in "$A" "$B" "$C"; do [ "$X" = "$Y" ] && N=$((N + 1)); done
  [ "$N" -ge 2 ] && { WAN="$X"; break; }
done

if [ -z "$WAN" ]; then
  die "สองแหล่งขึ้นไปตอบไม่ตรงกัน — ไม่แตะระเบียน DNS
    ipify=[${A:-ไม่ตอบ}] amazon=[${B:-ไม่ตอบ}] cloudflare=[${C:-ไม่ตอบ}]
    ถ้าเน็ตบ้านล่มอยู่ ให้รอแล้วรันใหม่"
fi

# ไอพีที่ใช้ไม่ได้ — เขียนลง DNS ไปก็ไม่มีใครเข้าถึงได้ ยิ่งทำให้กู้ยาก
case "$WAN" in
  10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*)
    die "ได้ไอพีวงใน ($WAN) — แปลว่ายังไม่ได้ออกอินเทอร์เน็ตจริง ไม่แตะระเบียน DNS" ;;
  100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    die "ไอพีที่ได้ ($WAN) อยู่ในช่วง CG-NAT ของผู้ให้บริการ
    แก้ DNS ไม่ช่วย เพราะพอร์ต 443 จากข้างนอกวิ่งเข้าบ้านไม่ได้ตั้งแต่ต้นทาง
    ต้องโทรหา 3BB ขอไอพีสาธารณะจริง (real public IP) ก่อน" ;;
esac
ok "$WAN"

# ── 2. หาโซนบน Cloudflare ──────────────────────────────────────────────────
say "2. โซนบน Cloudflare ของ $HOST"

ZONE_ID=""

# ระบุ zone id มาเองได้ — ทางลัดเมื่อโทเคนแก้ DNS ได้แต่ "ลิสต์โซน" ไม่ได้
# (เลข zone id อยู่ที่มุมขวาล่างของหน้า Overview ของโดเมนบน Cloudflare)
if [ -n "$ZONE_ID_ARG" ]; then
  ZONE_ID="$ZONE_ID_ARG"
  ZONE="${ZONE:-$HOST}"
  CANDIDATES=""
elif [ -n "$ZONE" ]; then
  CANDIDATES="$ZONE"
else
  # ไล่จากชื่อยาวสุดไปสั้นสุด กันเคสโดเมนแบบ .co.th ที่เดาจากสองพยางค์ท้ายไม่ได้
  CANDIDATES=""
  REST="$HOST"
  while [ -n "$REST" ]; do
    case "$REST" in *.*) ;; *) break ;; esac
    CANDIDATES="$CANDIDATES $REST"
    REST="${REST#*.}"
  done
fi

LAST_CODE=""
LAST_BODY=""
for CAND in $CANDIDATES; do
  RESP="$(cf GET "$API/zones?name=$CAND")"
  LAST_CODE="$(http_code "$RESP")"
  LAST_BODY="$(payload "$RESP")"
  [ "$LAST_CODE" = "200" ] || continue
  case "$LAST_BODY" in *'"result":[]'*) continue ;; esac
  ZONE_ID="$(json_str id "$LAST_BODY")"
  [ -n "$ZONE_ID" ] && { ZONE="$CAND"; break; }
done

# แยกให้ออกว่า "โทเคนใช้ไม่ได้" กับ "ไม่มีโซนนั้นจริง ๆ" — เดิมสองกรณีนี้ให้ข้อความ
# เดียวกันเป๊ะ เพราะลูปข้างบน continue เงียบ ๆ ทุกครั้งที่ไม่ใช่ 200 คนอ่านจึงไล่ผิดทาง
# ทั้งที่สาเหตุที่พบบ่อยที่สุดคือโทเคนถูกเพิกถอนไปแล้วแต่ .env ยังเก็บตัวเก่าไว้
if [ -z "$ZONE_ID" ]; then
  VERIFY="$(cf GET "$API/user/tokens/verify")"
  case "$(payload "$VERIFY")" in
    *'"success":true'*)
      die "โทเคนใช้ได้ แต่มองไม่เห็นโซนของ $HOST
    Cloudflare ตอบ HTTP ${LAST_CODE:-?} ตอนขอรายชื่อโซน
    $(printf '%s' "$LAST_BODY" | head -c 200)
    ถ้าโทเคนมีสิทธิ์แก้ DNS แต่ไม่มีสิทธิ์ลิสต์โซน ให้ใส่เลขโซนเอง:
      sudo ./scripts/cloudflare-ddns.sh --zone-id ZONE_ID_จากหน้า_Overview" ;;
    *)
      die "Cloudflare ไม่รับโทเคนใน .env แล้ว (HTTP $(http_code "$VERIFY"))
    เกือบทุกครั้งแปลว่าโทเคนถูกเพิกถอนหรือหมดอายุ แต่ .env ยังเก็บตัวเก่าไว้
    สร้างโทเคนใหม่แล้วบันทึกด้วย: sudo ./scripts/cloudflare-ddns.sh --setup
    ต้องแก้เดี๋ยวนี้โดยไม่รอโทเคน: เข้าหน้าเว็บ Cloudflare แล้วแก้ระเบียน A ของ
    $HOST ให้เป็น $WAN ด้วยมือ ได้ผลเหมือนกันทุกประการ" ;;
  esac
fi
ok "$ZONE"

# ── 3. ระเบียน A ตอนนี้ ────────────────────────────────────────────────────
say "3. ระเบียน A ของ $HOST"

RESP="$(cf GET "$API/zones/$ZONE_ID/dns_records?type=A&name=$HOST")"
CODE="$(http_code "$RESP")"
[ "$CODE" = "200" ] || die "Cloudflare ตอบ HTTP $CODE ตอนอ่านระเบียน
    $(payload "$RESP" | head -c 200)"
BODY="$(payload "$RESP")"

REC_ID=""
case "$BODY" in
  *'"result":[]'*) ;;
  *) REC_ID="$(json_str id "$BODY")"
     CURRENT="$(json_str content "$BODY")"
     REC_TTL="$(json_num ttl "$BODY")" ;;
esac

if [ -z "$REC_ID" ]; then
  info "ยังไม่มีระเบียน A ของชื่อนี้เลย"
  if [ "$MODE" = "check" ]; then
    die "ขาดระเบียน A — แขกที่ใช้ 4G/5G จะได้ NXDOMAIN (โหมด --check ไม่แก้ให้)"
  fi
  # proxied=false = เมฆเทา — ห้ามเป็นเมฆส้ม ไม่งั้นติดลิมิตอัพโหลด 100 MB ของ Cloudflare
  # แล้ววิดีโอที่แขกส่งจะไม่ผ่านทันที
  RESP="$(cf POST "$API/zones/$ZONE_ID/dns_records" \
    "{\"type\":\"A\",\"name\":\"$HOST\",\"content\":\"$WAN\",\"ttl\":${TTL:-60},\"proxied\":false}")"
  case "$(payload "$RESP")" in
    *'"success":true'*) ;;
    *) die "สร้างระเบียนไม่สำเร็จ (HTTP $(http_code "$RESP"))
    $(payload "$RESP" | head -c 200)" ;;
  esac
  loud "สร้างระเบียน A → $WAN (DNS only, TTL ${TTL:-60})"
  REC_ID="$(json_str id "$(payload "$RESP")")"
  CURRENT="$WAN"
else
  ok "ตอนนี้ชี้ที่ $CURRENT (TTL ${REC_TTL:-?})"
fi

# ── 4. ตรงกันแล้วหรือยัง ───────────────────────────────────────────────────
NEED_IP="0"; NEED_TTL="0"
[ "$CURRENT" = "$WAN" ] || NEED_IP="1"
[ -n "$TTL" ] && [ "${REC_TTL:-}" != "$TTL" ] && NEED_TTL="1"

say "4. ต้องแก้อะไรไหม"

if [ "$NEED_IP" = "0" ] && [ "$NEED_TTL" = "0" ]; then
  ok "ไม่ต้องแก้ — ระเบียนตรงกับไอพีบ้านอยู่แล้ว"
  if [ "${REC_TTL:-0}" -gt 300 ] 2>/dev/null; then
    info "TTL ${REC_TTL} วินาทีถือว่านาน — วันงานถ้าไอพีเปลี่ยนจะกู้ช้า"
    info "ลดลงด้วย: sudo ./scripts/cloudflare-ddns.sh --ttl 60"
  fi
  exit 0
fi

if [ "$MODE" = "check" ]; then
  printf '  ✗ ระเบียนชี้ %s แต่ไอพีบ้านคือ %s — แขกที่ใช้ 4G/5G เข้าไม่ได้\n' "$CURRENT" "$WAN" >&2
  printf '    แก้ด้วย: sudo ./scripts/cloudflare-ddns.sh\n' >&2
  exit 1
fi

# ── 5. แก้ระเบียน ──────────────────────────────────────────────────────────
if [ "$NEED_IP" = "1" ]; then
  info "ไอพีไม่ตรง: $CURRENT → $WAN"
else
  info "ไอพีตรงอยู่แล้ว เหลือแค่ TTL: ${REC_TTL:-?} → $TTL"
fi

say "5. ส่งคำสั่งแก้ไปที่ Cloudflare"

# PATCH แก้เฉพาะฟิลด์ที่ส่งไป — ค่าที่เหลือ (proxied, comment) คงเดิม ไม่ถูกล้าง
PATCH="{\"content\":\"$WAN\""
[ -n "$TTL" ] && PATCH="$PATCH,\"ttl\":$TTL"
PATCH="$PATCH}"

RESP="$(cf PATCH "$API/zones/$ZONE_ID/dns_records/$REC_ID" "$PATCH")"
case "$(payload "$RESP")" in
  *'"success":true'*) ;;
  *) die "แก้ระเบียนไม่สำเร็จ (HTTP $(http_code "$RESP"))
    $(payload "$RESP" | head -c 200)" ;;
esac

# ── 6. ยืนยันด้วยผลลัพธ์ ไม่ใช่แค่ไม่มี error ────────────────────────────────
say "6. อ่านกลับมาดูว่าเปลี่ยนจริง"

RESP="$(cf GET "$API/zones/$ZONE_ID/dns_records/$REC_ID")"
AFTER_BODY="$(payload "$RESP")"
AFTER="$(json_str content "$AFTER_BODY")"
[ "$AFTER" = "$WAN" ] || die "Cloudflare บอกว่าสำเร็จ แต่อ่านกลับมาได้ ${AFTER:-ว่างเปล่า}
    ยังไม่จบ — เข้าไปดูด้วยตาที่หน้า Cloudflare → DNS"

if [ "$NEED_TTL" = "1" ]; then
  AFTER_TTL="$(json_num ttl "$AFTER_BODY")"
  [ "$AFTER_TTL" = "$TTL" ] || die "ไอพีเปลี่ยนแล้ว แต่ TTL ยังเป็น ${AFTER_TTL:-?} ไม่ใช่ $TTL"
fi

if [ "$NEED_IP" = "1" ]; then
  loud "$HOST : $CURRENT → $WAN$([ "$NEED_TTL" = "1" ] && printf ' (TTL %s)' "$TTL")"
else
  loud "$HOST : TTL ${REC_TTL:-?} → $TTL (ไอพีเดิม $WAN)"
fi

RESOLVED=""
if command -v nslookup >/dev/null 2>&1; then
  RESOLVED="$(nslookup "$HOST" 1.1.1.1 2>/dev/null \
    | awk '/^Name:/ {seen=1} seen && /Address/ {print}' | pick_ipv4)"
fi

if [ "$RESOLVED" = "$WAN" ]; then
  ok "DNS สาธารณะตอบ $RESOLVED แล้ว — ใช้ได้จาก 4G/5G ทันที"
elif [ -n "$RESOLVED" ]; then
  info "DNS สาธารณะยังตอบ $RESOLVED อยู่ — ปกติ ต้องรอ TTL เดิมหมดอายุก่อน"
  info "ตรวจซ้ำด้วย: sudo ./scripts/diagnose-nas.sh   (ดูข้อ 9)"
fi
