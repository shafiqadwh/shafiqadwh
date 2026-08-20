# บทที่ 7 · ติดตั้งบน Shafiq-NAS (as-built)

บทนี้เขียนเจาะจงกับ infra จริงที่ใช้อยู่ ตามมาตรฐานใน `INFRA_STANDARD.md`
ถ้าเป็น NAS เครื่องอื่น ให้ใช้ [บทที่ 1](01-install-nas.md) และ [บทที่ 2](02-ddns-reverse-proxy.md) แทน

## ค่าที่ใช้กับงานนี้

| รายการ | ค่า |
|---|---|
| NAS (LAN) | `192.168.2.2` — Shafiq-NAS, DSM ที่ `nas.shafiq-lap.com:15001` |
| Router | MikroTik `192.168.2.1` |
| LAN DNS | AdGuard Home บน NAS (`192.168.2.2:3001`) |
| Public DNS | Cloudflare zone `shafiq-lap.com` — **DNS only (เมฆเทา)** |
| Public IP | `49.49.211.220` (เดียวกับ `nas` / `api` / `ha`) |
| Certificate | wildcard `*.shafiq-lap.com` ที่มีอยู่แล้ว — **ไม่ต้องออกใหม่** |
| โฮสต์ของงานนี้ | `wedding.shafiq-lap.com` |
| พอร์ตบนโฮสต์ | `18090` ผูกกับ `127.0.0.1` เท่านั้น |
| พอร์ตสาธารณะ | **`443`** (ตัดสินใจแล้ว) — ถ้า DSM ไม่ยอมให้ใช้ ถอยไป `8443` ดูขั้นที่ 5 |
| โฟลเดอร์โปรเจกต์ | `/volume1/docker/wedding-share` |
| โฟลเดอร์ข้อมูล | `/volume1/wedding` |

**เทียบกับกฎ 7 ข้อใน `INFRASTANDARDS.md` ส่วนที่ 2.1**

| กฎ | สถานะ |
|---|---|
| (1) `dns:` | ✅ ใส่ `1.1.1.1` + `192.168.2.2` แล้ว (แอปไม่ได้เรียกเน็ตออก แต่ใส่ตามมาตรฐาน) |
| (2) `build: network: host` | ✅ ขาดไม่ได้ — `npm ci` จะพังตอน build |
| (3) จำกัดขนาด log | ✅ `max-size: 10m`, `max-file: 3` |
| (4) `restart: unless-stopped` | ✅ |
| (5) `env_file:` | ✅ ใช้ `env_file` ไม่ได้ไล่ list ทีละตัว |
| (6) named volume สำหรับข้อมูลโปรแกรม | ⚠️ **จงใจไม่ทำตาม — ดูเหตุผลข้างล่าง** |
| (7) `name:` แยกโปรเจกต์ | ✅ `name: wedding-share` |

**ข้อ (6) — ทำไมถึงใช้ bind mount ทั้งที่มาตรฐานบอกให้ใช้ named volume**

มาตรฐานเตือนว่า Synology ACL บล็อกการเขียนแบบเงียบ ๆ (เจอกับ MariaDB, Postgres, syslog-ng)
แต่กรณีนี้ต่างออกไป และ **ทดสอบบนเครื่องจริงแล้วเขียนได้ปกติ** (17 ส.ค. 2569 อัพโหลดรูปและวิดีโอสำเร็จ)

| โฟลเดอร์ | จัดอยู่ในหมวดไหนของมาตรฐาน | เลือกใช้ |
|---|---|---|
| `uploads/`, `derived/` | **สื่อที่เราจัดการเอง** เหมือน `/volume1/video` | bind mount ✅ ตรงมาตรฐาน |
| `db/` (SQLite) | ฐานข้อมูล → มาตรฐานบอกให้ใช้ named volume | bind mount ⚠️ ฝืนมาตรฐาน |

เหตุผลที่ยอมฝืนสำหรับ `db/`:

1. รูปทั้งงานต้องเข้าถึงผ่าน **File Station / SMB / Synology Photos** ได้ — เป็นข้อกำหนดของงานนี้
2. ไฟล์ SQLite เก็บ**ชื่อผู้ส่งกับคำอวยพร** ถ้าแยกไปอยู่ named volume จะต้อง backup คนละวิธีกับรูป
   ทำให้ Hyper Backup job เดียวครอบไม่ครบ — เสี่ยงลืมมากกว่าเสี่ยง ACL
3. SQLite เขียนไฟล์เดียวบน ext4 ในเครื่อง ไม่ใช่ DB server ที่ init ทั้งไดเรกทอรีแบบ Postgres/MariaDB
   ซึ่งเป็นเคสที่มาตรฐานเจอปัญหา

**ถ้าเจออาการเขียน DB ไม่ได้เมื่อไหร่** ให้ย้าย `db/` ไป named volume แล้วสำรองด้วย
`docker run --rm -v wedding-share_db:/d -v /volume1/backup:/b alpine tar -czf /b/db.tar.gz -C /d .`

**ข้ออื่นที่ทำตามอยู่แล้ว**

- `ports: "127.0.0.1:18090:3000"` — ไม่เปิดสู่ LAN ตรง ๆ (§3.2 ข้อ 5)
- โค้ด bind-mount แบบ read-only → แก้โค้ดแล้ว **Restart พอ ไม่ต้อง rebuild** (landmine #1)
- `.env` `chmod 600` + อยู่ใน `.gitignore` (§7.1)
- ต้นฉบับอยู่ใน git ส่งขึ้น NAS ทั้งชุดเสมอ ไม่ patch เฉพาะบน NAS (§8.1 กฎเหล็ก)

---

## 1. เอาโค้ดขึ้น NAS

NAS ตัวนี้ไม่มี `git` และ sshd ไม่มี SFTP subsystem จึงมี 3 ทางเลือก

### วิธีที่ 1 — โหลดจาก GitHub ลง NAS ตรง ๆ ⭐ แนะนำสำหรับติดตั้งครั้งแรก

ไม่ต้องใช้เครื่อง PC เลย ไม่ต้องมี git ไม่ต้อง scp
**ssh เข้า NAS ก่อน** แล้วรันทั้งชุดนี้บน NAS

```bash
ssh shafiqadwh@192.168.2.2

sudo mkdir -p /volume1/docker/wedding-share
cd /volume1/docker/wedding-share
sudo curl -L -o code.tar.gz \
  "https://codeload.github.com/shafiqadwh/shafiqadwh/tar.gz/refs/heads/claude/wedding-photo-sharing-qr-j1oxn8"
sudo tar -xzf code.tar.gz --strip-components=1
sudo rm code.tar.gz
sudo chmod +x scripts/*.sh
ls
```

ต้องเห็น `docker-compose.yml`, `src`, `docs`, `scripts` ครบ

> ตัว NAS เองออกอินเทอร์เน็ตได้ปกติ — ที่ออกไม่ได้คือ `docker0` bridge ตอน build
> เท่านั้น จึงโหลดไฟล์ด้วย curl ได้สบาย

### วิธีที่ 2 — ส่งจาก Windows (สำหรับอัปเดตครั้งถัดไป)

รันใน **PowerShell จากในโฟลเดอร์โปรเจกต์** ที่ clone ไว้บนเครื่อง

```powershell
cd C:\path\ไปยัง\wedding-share
.\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2
```

ใช้ `tar.exe` กับ `scp.exe` ที่ติดมากับ Windows 10/11 อยู่แล้ว ไม่ต้องลง WSL
เติม `-Restart` เพื่อสั่งรีสตาร์ทคอนเทนเนอร์ต่อให้เลย

> ⚠️ ไฟล์ `.sh` รันใน PowerShell ไม่ได้ ให้ใช้ `.ps1` ตัวนี้แทน
> ส่วนคำสั่งที่ขึ้นต้นด้วย `sudo` ทุกคำสั่งในคู่มือนี้ **รันบน NAS หลัง ssh เข้าไปแล้ว**
> ไม่ใช่รันบน Windows

### วิธีที่ 3 — ส่งจาก macOS / Linux

```bash
./scripts/push-to-nas.sh shafiqadwh@192.168.2.2 --restart
```

## 2. ยกคอนเทนเนอร์ขึ้น

```bash
ssh shafiqadwh@192.168.2.2
cd /volume1/docker/wedding-share
sudo ./scripts/deploy-nas.sh --lan        # --lan = เปิดสู่ LAN ไว้ทดสอบก่อน
```

สคริปต์จะสร้างโฟลเดอร์ `/volume1/wedding/{uploads,derived,db,tmp}`,
ตั้ง `chown` ตาม uid/gid ของคุณ, สร้าง `.env` พร้อม**สุ่มรหัสแอดมิน** (chmod 600),
build แล้วรอจน `/healthz` ตอบ

ถ้า user ไม่มีสิทธิ์ docker CLI ให้ใช้ **Container Manager → Project → Create**
ชี้ไปที่ `/volume1/docker/wedding-share` (อ่าน `docker-compose.yml` เอง) แต่ต้อง
`cp .env.example .env` และแก้ค่าก่อนด้วยตัวเอง

## 3. ทดสอบใน LAN ก่อน

เปิดจากมือถือที่ต่อ Wi-Fi บ้าน `http://192.168.2.2:18090`

- [ ] อัพโหลดรูปได้
- [ ] อัพโหลดวิดีโอจาก iPhone (.mov) ได้
- [ ] เปิดวิดีโอนั้นด้วยเครื่อง Android ได้ (ระบบแปลง HEVC → H.264 ทำงาน)
- [ ] `/admin` ล็อกอินด้วยรหัสที่สคริปต์สุ่มให้

## 4. DNS — ต้องครบ **2 ระเบียน**

| # | ที่ไหน | ชื่อ | ค่า |
|---|---|---|---|
| 1 | AdGuard Home → Filters → DNS rewrites | `wedding.shafiq-lap.com` | `192.168.2.2` |
| 2 | Cloudflare → DNS → Add record (A) | `wedding` | `49.49.211.220` · **DNS only (เมฆเทา)** |

ตรวจว่าได้ค่า **ต่างกัน**

```bash
nslookup wedding.shafiq-lap.com 192.168.2.2   # ต้องได้ 192.168.2.2
nslookup wedding.shafiq-lap.com 8.8.8.8       # ต้องได้ 49.49.211.220
```

> บทเรียนจาก `jellyfin.shafiq-lap.com` ที่มีแต่ระเบียน LAN → ใช้ได้ในบ้าน
> แต่ NXDOMAIN บนเน็ตมือถือ งานแต่งนี้แขกใช้ 4G เป็นหลัก **ขาดระเบียนที่ 2 ไม่ได้**

> ✅ Cloudflare เป็น DNS only อยู่แล้ว จึง **ไม่ติดลิมิตอัพโหลด 100 MB** ของ Cloudflare proxy
> ถ้าเผลอเปิดเมฆส้ม วิดีโอเกิน 100 MB จะอัพไม่ผ่านทันที

## 5. Reverse Proxy บน DSM

**Control Panel → Login Portal → Advanced → Reverse Proxy → Create**

| ช่อง | ค่า |
|---|---|
| Description | `wedding-share` |
| Source protocol | **HTTPS** ⚠️ ค่าเริ่มต้นเป็น HTTP — ลืมแก้แล้วมันบันทึกผ่านเงียบ ๆ |
| Source hostname | `wedding.shafiq-lap.com` |
| Source port | **`443`** — ถ้าเด้ง *"This port number is used by another application"* ให้ถอยไป `8443` แล้วอย่าลืมเติม `:8443` ต่อท้าย `BASE_URL` |
| Destination protocol | HTTP |
| Destination hostname | **`127.0.0.1`** ⚠️ อย่าใช้ `localhost` — เหตุผลด้านล่าง |
| Destination port | `18090` — ตรวจให้ครบ 5 หลัก (เคยพิมพ์เป็น `1809` มาแล้ว แล้วได้ 502) |

> **ทำไมต้อง `127.0.0.1` ไม่ใช่ `localhost`**: คอนเทนเนอร์ผูกพอร์ตไว้ที่ IPv4 loopback
> อย่างเดียว (`127.0.0.1:18090`) ส่วน `localhost` บนระบบที่เปิด IPv6 จะถูก resolve เป็น
> `::1` ก่อน → nginx ต่อไม่ติด → ตอบ **502 Bad Gateway** ทั้งที่แอปทำงานปกติดี
> ใส่ IP ตรง ๆ ตัดปัญหานี้ทิ้งไปเลย

**Custom Header** → Create → **WebSocket** แล้วเพิ่มเองอีกบรรทัด

| Header | Value |
|---|---|
| `X-Forwarded-Proto` | `https` |

**ทำไมเลือก 443**: URL เป็น `https://wedding.shafiq-lap.com` สั้น พิมพ์ตามได้ง่าย
ถ้าเป็น `:8443` เลขพอร์ตจะติดอยู่บนการ์ด QR ทุกใบ (คนที่สแกนไม่กระทบ แต่คนที่พิมพ์เองพลาดง่าย)
nginx ของ DSM แยก hostname ด้วย SNI ได้ จึงมีหลาย service บนพอร์ต 443 พร้อมกันได้

จากนั้น **Security → Certificate → Settings → Configure** → ชี้ `wedding.shafiq-lap.com`
ไปที่ `*.shafiq-lap.com` (ไม่ทำขั้นนี้จะเจอ `no alternative certificate subject name matches`)

## 6. NAT บน MikroTik — เช็คก่อนว่ามี rule 443 หรือยัง

⚠️ `jellyfin.shafiq-lap.com` **ไม่มีระเบียน DNS สาธารณะ** (ตรวจแล้วเมื่อ 17 ส.ค. 2026) แปลว่า
ที่ผ่านมามันถูกใช้เฉพาะใน LAN — จึง **ยังสรุปไม่ได้ว่า WAN:443 ถูก forward ไว้แล้ว**
ต่างจาก 8443 ที่ `api` ใช้งานจากข้างนอกได้จริง

เช็คด้วย WinBox (อย่าเชื่อ filter ของ CLI — landmine #5) ที่ IP → Firewall → NAT
ถ้ายังไม่มี rule ของพอร์ต 443

```
/ip firewall nat add chain=dstnat action=dst-nat \
  to-addresses=192.168.2.2 to-ports=443 \
  protocol=tcp in-interface-list=WAN dst-port=443 \
  comment="NAS wedding 443"
```

## 7. ⚠️ ลิมิตอัพโหลดของ nginx (ห้ามข้าม — วิดีโอจะพัง)

```bash
sudo mkdir -p /usr/local/etc/nginx/conf.d
sudo tee /usr/local/etc/nginx/conf.d/www.wedding.conf > /dev/null <<'EOF'
client_max_body_size 512m;
proxy_read_timeout 900s;
proxy_send_timeout 900s;
proxy_request_buffering off;
EOF
sudo synosystemctl restart nginx
```

> 📎 ชื่อไฟล์ขึ้นต้นด้วย `www.` ตามแบบแผนของ DSM (ไฟล์ระบบก็ใช้ prefix นี้ เช่น
> `www.pkg-static.Calendar-*.conf`) prefix เป็นตัวกำหนดว่า config จะถูก include
> เข้าไปใน context ไหน — อย่าเปลี่ยนเป็นชื่ออื่น
>
> เวลาแปะผลลัพธ์ `ls` เข้าแอปแชต ชื่อพวกนี้มักถูกแปลงเป็นลิงก์อัตโนมัติจนดูเหมือน
> `[www.wedding.conf](https://www.wedding.conf)` — เป็นแค่การแสดงผล ไฟล์บนดิสก์ไม่ได้เพี้ยน

**ยืนยันว่าได้ผลจริง ไม่ใช่แค่ไม่มี error** (กฎข้อ 4 ของมาตรฐาน)

```bash
ls -l /usr/local/etc/nginx/conf.d/          # ต้องเห็นชื่อไฟล์เต็ม ๆ ไม่มี [ ] ( )
sudo nginx -t                                # ต้องขึ้น syntax is ok / test is successful
sudo ./scripts/diagnose-nas.sh               # ข้อ 4-6 ต้องผ่านหมด
```

`synosystemctl restart nginx` พิมพ์ `[nginx] restarted.` **ทุกครั้ง** แม้ config พังจน
สตาร์ทไม่ขึ้น อย่าใช้ข้อความนั้นเป็นหลักฐาน ให้ดูว่าพอร์ต 443 ยัง listen อยู่ไหมแทน

`client_max_body_size` ต้องมากกว่า `MAX_VIDEO_MB` ใน `.env` (ค่าเริ่มต้น 300 MB)
ไฟล์นี้อาจหายเมื่ออัปเดต DSM ครั้งใหญ่ — ใส่ไว้ในเช็คลิสต์ก่อนวันงาน

## 8. กลับมาผูก loopback แล้วตั้งค่าให้ครบ

```bash
cd /volume1/docker/wedding-share
sudo nano .env        # แก้ COUPLE_NAMES, EVENT_DATE, BASE_URL=https://wedding.shafiq-lap.com
sudo ./scripts/deploy-nas.sh        # ไม่ใส่ --lan = กลับไปผูก 127.0.0.1
```

> `BASE_URL` คือค่าที่ฝังใน QR code — ต้องตรงกับ URL จริงรวมพอร์ต (ถ้าใช้ 8443 ต้องใส่ `:8443`)
> **ก่อนสั่งพิมพ์การ์ด** ต้องแก้ค่านี้ให้ถูกและรีสตาร์ทแล้ว

## 9. ทดสอบขั้นสุดท้าย — จากมือถือ 4G เท่านั้น

ทดสอบจากในบ้านพิสูจน์อะไรไม่ได้ เพราะ AdGuard ชี้กลับเข้า NAS อยู่แล้ว

```bash
# ตรวจทุกชั้นในคำสั่งเดียว (อ่านอย่างเดียว รันซ้ำได้)
sudo ./scripts/diagnose-nas.sh
```

สคริปต์นี้ไล่ให้ครบ: คอนเทนเนอร์ → แอปที่ loopback → พอร์ตที่ผูกไว้ → nginx ยังขึ้นไหม →
ไฟล์ลิมิตอัพโหลดชื่อถูกไหม → ไวยากรณ์ nginx → ยิงผ่านโดเมนจริง → เนื้อหาที่ได้ใช่ของแอปไหม
พร้อมบอกวิธีแก้ของแต่ละข้อที่ไม่ผ่าน

ถ้าอยากยิงเองทีละอัน

```bash
curl http://127.0.0.1:18090/healthz            # {"ok":true}

# ผ่าน reverse proxy + TLS (ห้ามใส่ -k) — ต้องดู body ไม่ใช่แค่ status code
curl https://wedding.shafiq-lap.com/healthz
```

จากนั้น **ปิด Wi-Fi ใช้ 4G/5G** แล้วทำครบ 4 ข้อ

- [ ] เปิด `https://wedding.shafiq-lap.com` เห็นแม่กุญแจ 🔒 ไม่มีคำเตือน cert
- [ ] อัพโหลดรูปได้
- [ ] **อัพโหลดวิดีโอได้** (ถ้าพังตรงนี้ = ขั้นที่ 7 ยังไม่มีผล)
- [ ] เห็นรูปที่อัพจากเครื่องอื่น

---

## อัปเดตโค้ดล่าสุด — คำสั่งเดียว

```bash
cd /volume1/docker/wedding-share && sudo ./scripts/update.sh
```

เติม `--env` ถ้าเพิ่งแก้ `.env` ด้วย (จะสร้างคอนเทนเนอร์ใหม่แทนการรีสตาร์ท)

สคริปต์จะโหลด ตรวจว่าไฟล์ที่ได้เป็น tarball จริงก่อนแตกทับ รีสตาร์ท รอจนเว็บตอบ
แล้วบอกเลขเวอร์ชันไฟล์ static ให้ดูว่าโค้ดใหม่ถึงเบราว์เซอร์แล้วจริง

> ### ⚠️ อย่าวางคำสั่งหลายบรรทัดพร้อมกันตอนที่ sudo อาจถามรหัส
>
> ถ้า `sudo` เด้งถามรหัสขึ้นมากลางทาง **บรรทัดที่วางตามมาจะถูกดูดไปเป็นคำตอบ
> ของช่องรหัส แล้วแสดงออกมาเป็นข้อความธรรมดาบนจอ** — เกิดขึ้นจริงมาแล้ว
> สองครั้งในโปรเจกต์นี้ และทั้งสองครั้งต้องหมุนรหัส DSM ทิ้ง
>
> ถ้าจำเป็นต้องรันหลายคำสั่ง ให้พิมพ์ `sudo -v` แล้ว **กด Enter รอใส่รหัสให้เสร็จก่อน**
> ค่อยวางที่เหลือ หรือใช้สคริปต์บรรทัดเดียวแบบข้างบนซึ่งไม่มีอะไรให้แข่งกัน

## แก้ค่าใน .env

**อย่าพิมพ์ `NAME=value` ลงเชลล์ตรง ๆ** — มัน "ดูเหมือนได้ผล" เพราะไม่มี error
แต่ไม่ได้แก้ไฟล์อะไรเลย มันตั้งตัวแปรของเชลล์ที่หายไปทันทีที่ปิดหน้าต่าง

```bash
cd /volume1/docker/wedding-share
sudo ./scripts/set-config.sh MAX_VIDEO_SECONDS=60 MAX_TOTAL_STORAGE_GB=100
sudo docker compose up -d
sudo ./scripts/set-config.sh --show
```

สคริปต์ปฏิเสธชื่อค่าที่ไม่มีใน `.env.example` จึงพิมพ์ผิดแล้วรู้ทันที ไม่ใช่ไป
เจอตอนงานว่าค่าที่ตั้งไม่มีผล และ `--show` ปิดรหัสผ่านไว้ เผื่อถ่ายจอส่งให้คนอื่นดู

> `restart` ไม่โหลด `.env` ใหม่ ต้อง `up -d` เท่านั้น
> ส่วนการแก้โค้ดอย่างเดียวใช้ `restart` ได้ เพราะโค้ด bind-mount ไว้

## เปลี่ยนรหัสผ่านแอดมิน

```bash
cd /volume1/docker/wedding-share
sudo ./scripts/set-admin-password.sh          # สุ่มให้ แล้วแสดงบนจอ
sudo ./scripts/set-admin-password.sh --ask    # พิมพ์เอง ไม่แสดงบนจอ
sudo docker compose up -d                      # ต้อง up -d ไม่ใช่ restart
```

มีสคริปต์นี้เพราะ §8.4 ข้อ 3 ของมาตรฐาน — ห้ามให้คำสั่งที่มีช่องแทนค่าเอง
เซสชันที่ล็อกอินค้างไว้ในมือถือจะยังใช้ได้ต่อ ไม่หลุดกลางงาน

## แก้ปัญหาที่เจอบ่อยกับ reverse proxy

| อาการ | สาเหตุจริง |
|---|---|
| `Bad Request 400` | ต่อ https ไปยังพอร์ตที่พูด http (หรือกลับกัน) **ไม่ใช่ปัญหาใบรับรอง** — เบราว์เซอร์ไม่ auto-upgrade เป็น https บนพอร์ตที่ไม่ใช่ 443 (§6.4) |
| `no alternative certificate subject name matches` | ยังไม่ได้ map cert ที่ Security → Certificate → Settings → Configure |
| เข้าได้ในบ้าน แต่ NXDOMAIN บนมือถือ 4G | ขาดระเบียน Cloudflare (มีแต่ AdGuard rewrite) — เคสเดียวกับ `jellyfin.shafiq-lap.com` |
| หน้า DSM เด้งขึ้นมาแทนเว็บงานแต่ง | reverse proxy ไม่ match hostname → เช็คว่า Source hostname สะกดตรงและ Source protocol เป็น HTTPS |
| อัพรูปได้ แต่วิดีโอไม่ผ่าน | ลิมิต nginx ยังไม่มีผล — ทำขั้นที่ 7 ซ้ำแล้ว restart nginx |
| `502 Bad Gateway` | nginx รับสายได้แต่ต่อไปหาแอปไม่ติด — เรียงความน่าจะเป็น: คอนเทนเนอร์ไม่ได้รัน → Destination hostname เป็น `localhost` (แก้เป็น `127.0.0.1`) → Destination port พิมพ์ตกเลข |
| **5G ใช้ได้ แต่ในบ้านเข้าไม่ได้** | ดูหัวข้อถัดไป — เกือบทุกครั้งคือ DNS ของเครื่องไคลเอนต์ ไม่ใช่ปัญหาที่ NAS |

## เข้าจาก 5G ได้ แต่ในวง LAN ไม่ได้

อาการนี้ **ไม่ใช่ปัญหาของ NAS** — พิสูจน์ได้ทันทีด้วยการยิงจากข้างนอก ถ้าได้ `{"ok":true}`
แปลว่า nginx + คอนเทนเนอร์ + cert + NAT ครบดีหมดแล้ว เหลือแค่เส้นทางฝั่ง LAN

สาเหตุคือ **เครื่องในบ้าน resolve ชื่อนี้ได้ IP สาธารณะ** แล้ววิ่งออกไปหาเราเตอร์
เพื่อวกกลับเข้าบ้าน (hairpin NAT / NAT loopback) ซึ่ง MikroTik ไม่ได้เปิดให้โดยดีฟอลต์
→ ต่อไม่ติด ขึ้น `Could not connect to server`

⚠️ `nslookup` **หลอกเราตรงนี้** เพราะมันยิงถาม DNS server ตรง ๆ ส่วนเบราว์เซอร์กับ
`curl.exe` ใช้ resolver ของ Windows ซึ่งอาจไปถาม DNS ตัวสำรองในรายการแทน
ให้ใช้ `Resolve-DnsName` แทน — ตัวนี้เดินผ่าน resolver จริงของ Windows

```powershell
Resolve-DnsName wedding.shafiq-lap.com | Select-Object Name, IPAddress
Get-DnsClientServerAddress -AddressFamily IPv4 | Select-Object InterfaceAlias, ServerAddresses
```

⚠️ **ดูบรรทัด `ServerAddresses` ให้ดีกว่าดูคำตอบของ `Resolve-DnsName`** — คำตอบที่ถูก
*ครั้งเดียว* ไม่ได้พิสูจน์ว่าจะถูกทุกครั้ง ถ้ามี DNS มากกว่าหนึ่งตัวในรายการ Windows
จะสลับไปใช้ตัวสำรองเมื่อไหร่ก็ได้ (เช่น ตอน AdGuard ตอบช้า) แล้วค้างที่ตัวนั้นไปพักใหญ่
→ อาการจะ **เป็น ๆ หาย ๆ** ซึ่งหาเจอยากกว่าพังสนิท

| ผลที่ได้ | แปลว่า | วิธีแก้ |
|---|---|---|
| `ServerAddresses` มีมากกว่า 1 ตัว | ต้นตอที่พบจริงในบ้านนี้ — `{192.168.2.2, 1.1.1.1}` ตัวหลังตอบ IP สาธารณะ | **วิธี ก** ด้านล่าง |
| IP สาธารณะ (ขึ้นต้นไม่ใช่ `192.168.`) | เครื่องไม่ได้ถาม AdGuard รอบนั้น | **วิธี ก** ด้านล่าง |
| `192.168.2.2` และ `ServerAddresses` เหลือตัวเดียว | DNS ถูกแล้วจริง ปัญหาอยู่ที่อื่น (ไฟร์วอลล์เครื่อง / VPN / proxy) | ลอง `curl.exe --resolve` ชี้ IP เองเพื่อยืนยัน |

ตรวจซ้ำว่า DNS สาธารณะตอบอะไร เพื่อยืนยันว่าสองเส้นทางให้คำตอบต่างกันจริง

```powershell
Resolve-DnsName wedding.shafiq-lap.com -Server 1.1.1.1 | Select-Object Name, IPAddress
```

**วิธี ก (แนะนำ) — บังคับให้ทุกเครื่องในบ้านใช้ AdGuard ตัวเดียว**

ที่ MikroTik → IP → DHCP Server → Networks ตั้ง `dns-server=192.168.2.2` **ตัวเดียว**
ห้ามใส่ `1.1.1.1` หรือ `8.8.8.8` เป็นตัวสำรอง เพราะ Windows จะสลับไปใช้ตัวสำรอง
เมื่อไหร่ก็ได้ แล้ว rewrite ของ AdGuard ก็ไม่มีผล

```
/ip dhcp-server network set [find] dns-server=192.168.2.2
```

จากนั้นบนเครื่อง Windows ล้างแคชแล้วต่ออายุ DHCP

```powershell
ipconfig /release
ipconfig /renew
ipconfig /flushdns
```

**วิธี ข — เปิด hairpin NAT ที่ MikroTik** (ถ้าจำเป็นต้องให้ IP สาธารณะใช้ได้จากในบ้านด้วย)

ต้องมี **2 rule** ไม่ใช่แค่ rule เดียว — ขาด src-nat ปลายทางจะตอบกลับตรงไปหาไคลเอนต์
ด้วย IP ภายใน แล้วไคลเอนต์จะทิ้งแพ็กเก็ตนั้นเพราะไม่ตรงกับที่ส่งไป

```
/ip firewall nat add chain=dstnat action=dst-nat \
  protocol=tcp dst-port=443 src-address=192.168.2.0/24 \
  dst-address=<ไอพีสาธารณะ> to-addresses=192.168.2.2 to-ports=443 \
  comment="hairpin wedding 443"

/ip firewall nat add chain=srcnat action=masquerade \
  protocol=tcp dst-port=443 src-address=192.168.2.0/24 \
  dst-address=192.168.2.2 comment="hairpin wedding masq"
```

> เลือกวิธี ก ก่อนเสมอ — น้อย rule กว่า เร็วกว่า (ไม่ต้องวิ่งออกไปที่เราเตอร์)
> และไม่พังเมื่อ IP สาธารณะเปลี่ยน

**สำคัญสำหรับวันงาน**: จอสไลด์โชว์จะอยู่ในวง LAN ของสถานที่จัดงาน ไม่ใช่วงบ้าน
จึงต้องเข้าผ่านโดเมนเหมือนแขกทั่วไป → **ต้องแก้ข้อนี้ให้จบก่อนวันงาน**

ถ้าอยากมีทางสำรองแบบไม่พึ่ง DNS เลย ให้เปิดพอร์ตสู่ LAN ชั่วคราวเฉพาะวันงาน

```bash
sudo ./scripts/deploy-nas.sh --lan     # ผูก 0.0.0.0:18090 → เข้าได้ทั้งวง (ไม่มี TLS)
sudo ./scripts/deploy-nas.sh           # กลับมาผูก loopback หลังงานจบ
```

แล้วตั้งเครื่องฉายเป็น `http://192.168.2.2:18090/slideshow` — ใช้ได้เฉพาะเมื่อ
เครื่องฉายอยู่วงเดียวกับ NAS เท่านั้น (ดู [บทที่ 4](04-slideshow.md))

## เข้าในบ้านได้ แต่จาก 4G/5G เข้าไม่ได้ — ระเบียน Cloudflare ค้างที่ไอพีเก่า

อาการกลับด้านกับหัวข้อบน และ **ร้ายแรงกว่ามาก** เพราะแขกในงานใช้เน็ตมือถือกันทั้งหมด

ต้นเหตุอยู่ในตารางข้อ 4 ของบทนี้เอง: ระเบียน A ของ `wedding` ถูกกรอกเป็น
**ไอพีคงที่ด้วยมือ** และ **ไม่มีอะไรคอยอัปเดตให้เลย** — DDNS ของ DSM อัปเดตชื่อของ
Synology ไม่ได้ไปแตะโซนใน Cloudflare พอ 3BB จ่ายไอพีสาธารณะใหม่ ระเบียนก็ค้างอยู่ที่เลขเก่า

ในบ้านยังใช้ได้ตามปกติ เพราะ AdGuard rewrite ชี้ `192.168.2.2` ตรง ๆ ไม่เกี่ยวกับไอพี WAN เลย
**ฝั่ง LAN จึงไม่มีวันส่งสัญญาณเตือน** — ต้องตรวจจากข้างนอกเท่านั้น

**ตรวจ** (ทำที่ไหนก็ได้ที่ยิงเน็ตออกได้):

```bash
sudo ./scripts/diagnose-nas.sh        # ข้อ 9 เทียบ DNS สาธารณะ กับ ไอพี WAN ตอนนี้ให้
```

หรือเทียบเองสองบรรทัด — สองค่านี้ **ต้องตรงกัน**

```bash
nslookup wedding.shafiq-lap.com 1.1.1.1    # ระเบียนที่โลกภายนอกเห็น
curl -s https://api.ipify.org; echo         # ไอพีบ้านจริงตอนนี้
```

เทียบกับพี่น้องในโซนเดียวกันก็ช่วยได้ ถ้า `nas` / `api` / `ha` ย้ายไปไอพีใหม่กันหมด
แต่ `wedding` ยังอยู่เลขเก่าตัวเดียว = ระเบียนนี้ค้างแน่นอน

**แก้**: Cloudflare → DNS → แก้ค่าระเบียน A ของ `wedding` เป็นไอพีใหม่ · **DNS only (เมฆเทา)**
แล้วรอ TTL หมดอายุ (ตั้ง TTL ไว้ต่ำ ๆ เช่น 60 วินาที จะกู้ได้เร็วในวันงาน)
จากนั้นรัน `diagnose-nas.sh` ซ้ำ ต้องขึ้น ✓ ที่ข้อ 9 — **อย่าถือว่าจบเพราะคำสั่งไม่ error**

> ⚠️ ปัญหานี้จะกลับมาอีกทุกครั้งที่ไอพีเปลี่ยน — หัวข้อถัดไปคือวิธีปิดจบถาวร


## ให้ระเบียน Cloudflare ตามไอพีบ้านเองอัตโนมัติ

`scripts/cloudflare-ddns.sh` ทำหน้าที่ที่ DDNS ของ DSM ทำให้ไม่ได้ — DSM อัปเดตได้แต่ชื่อ
ของ Synology เอง ไม่ได้ไปแตะโซนใน Cloudflare สคริปต์นี้ยิง Cloudflare API ตรง ๆ

### ตั้งค่าครั้งเดียว

**1. สร้างโทเคน** ที่ Cloudflare → My Profile → **API Tokens** → Create Token

| ช่อง | ค่า |
|---|---|
| Template | Edit zone DNS |
| Permissions | **Zone → DNS → Edit** เท่านั้น — ไม่ต้องให้มากกว่านี้ |
| Zone Resources | Include → Specific zone → `shafiq-lap.com` |

**2. เก็บโทเคนลงเครื่อง** — สคริปต์จะถามทีละบรรทัด ไม่แสดงบนจอ

```bash
cd /volume1/docker/wedding-share
sudo ./scripts/cloudflare-ddns.sh --setup
```

มันจะยิงตรวจโทเคนกับ Cloudflare ก่อน **ถ้าโทเคนใช้ไม่ได้จะไม่แตะ `.env` เลย**
ผ่านแล้วค่อยเขียนลง `.env` (สิทธิ์ไฟล์ 600 · `.gitignore` ครอบอยู่แล้ว)

> ⚠️ **การวางโทเคนใน PowerShell/PuTTY เป็นจุดที่พลาดง่ายที่สุดของทั้งบทนี้**
> ท้ายบรรทัดของ Windows เป็น CRLF ตัว `\r` ที่ติดมาจะทำให้ header ของ curl พัง
> แล้ว Cloudflare ตอบ `Invalid format for Authorization header` ทั้งที่โทเคนถูกทุกตัวอักษร
> (ตอนนี้สคริปต์ตัด `\r` ให้เองแล้ว) และถ้าวางมาเกินหนึ่งบรรทัด **ส่วนที่เกินจะตกไปเป็น
> คำสั่งของ shell หลังสคริปต์จบ — โทเคนจะโผล่บนจอและลงไปอยู่ใน `~/.bash_history`**
> เกิดขึ้นจริงมาแล้ว สคริปต์จึงกวาดบัฟเฟอร์ที่ค้างทิ้งและเตือนเมื่อเจอ
>
> ทางที่ปลอดภัยกว่าถ้าต่อจาก Windows — ไม่ต้องวางลงพรอมต์เลย:
>
> ```bash
> vi /tmp/cf-token.txt                                  # วางโทเคนในไฟล์ แล้วบันทึก
> sudo ./scripts/cloudflare-ddns.sh --setup-from /tmp/cf-token.txt
> ```
>
> สคริปต์จะลบไฟล์นั้นทิ้งให้เองหลังเก็บโทเคนเรียบร้อย

**ถ้าโทเคนหลุดออกมาบนจอเมื่อไหร่ ให้ถือว่าใช้ไม่ได้แล้ว** — เพิกถอนที่ Cloudflare
สร้างใหม่ แล้วล้างประวัติคำสั่งบน NAS

```bash
cat /dev/null > ~/.bash_history && history -c
```

> ทั้งบทนี้และตัวสคริปต์**ไม่มีบรรทัดตัวอย่างที่เว้นช่องให้แทนค่าเอง** โดยตั้งใจ
> (`INFRASTANDARDS` §8.4 ข้อ 3) — เคยมีคนวางบรรทัดตัวอย่างลงไปตรง ๆ
> จนค่าจริงกลายเป็นข้อความในวงเล็บนั้น

**3. รันครั้งแรก**

```bash
sudo ./scripts/cloudflare-ddns.sh
```

### ตั้งให้วิ่งเองทุก 5 นาที (DSM Task Scheduler)

**Control Panel → Task Scheduler → Create → Scheduled Task → User-defined script**

จะมี 3 แท็บ ต้องกรอกให้ครบทั้งสาม

**แท็บ General**

| ช่อง | ค่า |
|---|---|
| Task | `cloudflare-ddns` |
| User | **`root`** ⚠️ ต้องเป็น root — ไฟล์ `.env` สิทธิ์ 600 ผู้ใช้ธรรมดาอ่านไม่ได้ แล้วงานจะล้มเงียบ ๆ |
| Enabled | ติ๊กไว้ |

**แท็บ Schedule**

| ช่อง | ค่า |
|---|---|
| Date | **Run on the following date** → Repeat: **Daily** |
| Time → First run time | `00:00` |
| Time → **Frequency** | **Every 5 minutes** ← หัวใจของข้อนี้ อยู่ในดรอปดาวน์ ไม่ต้องเขียน cron เอง |
| Time → Last run time | `23:55` |

> ถ้าไม่เห็นช่อง Frequency แปลว่ายังเลือก **Daily** ไม่ครบ — ช่องนี้จะโผล่ก็ต่อเมื่อ
> ตั้งเป็นทำซ้ำทุกวันแล้วเท่านั้น

**แท็บ Task Settings**

Run command → User-defined script — วางบรรทัดเดียวนี้

```
/volume1/docker/wedding-share/scripts/cloudflare-ddns.sh --quiet >> /volume1/docker/wedding-share/ddns.log 2>&1
```

ติ๊ก **Send run details by email** และติ๊กย่อย
**"Send run details only when the script terminates abnormally"** ด้วย

> ⚠️ เข้าใจให้ตรงกันว่าเมลจะมาเมื่อไหร่: สคริปต์ออกด้วยรหัส 0 ทั้งตอนที่แก้ระเบียนสำเร็จ
> และตอนที่ไม่มีอะไรต้องแก้ — **เมลจะมาเฉพาะตอนมีปัญหาจริง** เช่น โทเคนหมดอายุ
> เน็ตล่ม หรือเจอไอพี CG-NAT ส่วนตอนที่มันแก้ระเบียนให้เรียบร้อย **จะไม่มีเมล**
> ให้ไปดูใน `ddns.log` แทน ซึ่งเป็นพฤติกรรมที่ต้องการ — ไม่งั้นได้เมลทุก 5 นาที

**ดูว่าทำงานจริงไหม**

กด **Run** ในหน้า Task Scheduler ทันทีหนึ่งครั้ง อย่ารอถึงรอบถัดไป แล้วเช็ก

```bash
cat /volume1/docker/wedding-share/ddns.log     # ว่างเปล่า = ปกติ ไม่มีอะไรต้องแก้
sudo ./scripts/cloudflare-ddns.sh --check      # ต้องออกด้วยรหัส 0
```

`--quiet` เงียบสนิทตอนไม่มีอะไรเปลี่ยน **log ที่ว่างเปล่าคือผลลัพธ์ที่ถูกต้อง**
วันไหนไอพีเปลี่ยน จะมีบรรทัดเดียวโผล่มาพร้อมวันเวลา

```
[2026-08-29 06:35]   ✓ wedding.shafiq-lap.com : 49.49.209.227 → 49.49.212.8
```

> อยากเห็นเดี๋ยวนั้นว่ามันทำงานถูก ให้รันมือแบบไม่ใส่ `--quiet` — จะเห็นครบทั้ง 6 ขั้น

### สิ่งที่สคริปต์ยอมและไม่ยอมทำ

| กรณี | ทำอะไร |
|---|---|
| ระเบียนตรงกับไอพีอยู่แล้ว | **ไม่ยิงอะไรไปที่ Cloudflare เลย** — รันซ้ำกี่รอบก็ปลอดภัย |
| แหล่งตรวจไอพีตอบไม่ตรงกัน | **ไม่แตะระเบียน** แล้วบอกว่าแต่ละแหล่งตอบอะไร (กันเขียนค่าขยะทับของดี) |
| ได้ไอพีวงใน (`192.168.` ฯลฯ) | ปฏิเสธ — แปลว่าเน็ตยังไม่ออกจริง |
| ได้ไอพีช่วง CG-NAT (`100.64–127.`) | ปฏิเสธ พร้อมอธิบายว่าแก้ DNS ไม่ช่วย ต้องโทรขอไอพีสาธารณะจาก 3BB ก่อน |
| ยังไม่มีระเบียน A เลย | สร้างให้ · **เมฆเทาเสมอ** (เมฆส้มจะติดลิมิตอัพโหลด 100 MB วิดีโอแขกจะไม่ผ่าน) |
| แก้ระเบียนแล้ว | **อ่านกลับมาจาก Cloudflare เพื่อยืนยัน** ไม่เชื่อแค่ว่าคำสั่งไม่ error (กฎ 4) |

โหมดอื่น ๆ

```bash
sudo ./scripts/cloudflare-ddns.sh --check        # ตรวจอย่างเดียว ไม่แก้ · ออก 1 ถ้าค้าง
sudo ./scripts/cloudflare-ddns.sh --ttl 60       # ลด TTL ลง (วันงานกู้ได้ใน 1 นาที)
sudo ./scripts/cloudflare-ddns.sh --ip 1.2.3.4   # บอกไอพีเอง เมื่อ NAS ถามเว็บข้างนอกไม่ได้
```

PATCH ส่งไปเฉพาะฟิลด์ `content` — ค่า `proxied` กับ comment ที่ตั้งไว้จึงไม่ถูกล้างทิ้ง

## อัปเดตโค้ดภายหลัง

| กรณี | ต้องทำ |
|---|---|
| แก้โค้ด / ข้อความ / CSS / คำแปล | ส่งไฟล์ใหม่ (PowerShell: `.\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2 -Restart`) หรือดึงใหม่ด้วย curl ตามวิธีที่ 1 แล้ว `sudo docker compose restart` — โค้ด bind-mount ไว้ ไม่ต้อง rebuild |
| แก้ `package.json` หรือ `Dockerfile` | ต้อง rebuild image: Stop → **Clean** → **Build** ใน Container Manager หรือ `sudo docker compose up -d --build` |
| แก้ `.env` | `sudo docker compose up -d` |

> landmine #1: กด **Build** เฉย ๆ ทั้งที่ image tag เดิมยังอยู่ = ไม่ rebuild จริง
> Build จริงต้องเห็น `Step n/…` และ `Successfully built` ถ้าเห็นแค่ `Container … Created` แปลว่าใช้ image เก่า

ข้อมูลไม่หายจากการ Clean + Build เพราะรูปอยู่ที่ `/volume1/wedding` (bind mount)
ไม่ใช่ใน docker volume

## เรื่อง GPU (GTX 1050 Ti) — ทำไมยังไม่ใช้

**สรุปสั้น: การ์ดใบนี้ทำได้จริง แต่มันไปช่วยงานที่ไม่มีใครรอ และเสี่ยงเกินจะทำก่อนวันงาน**

### GPU ไปช่วยตรงไหนได้บ้าง

งาน ffmpeg ในระบบนี้มีสามอย่าง ไม่ได้หนักเท่ากัน

| งาน | แขกต้องรอไหม | GPU ช่วยได้ไหม |
|---|---|---|
| อ่านข้อมูลวิดีโอ (ffprobe) | **รอ** | ไม่ — อ่านแค่ส่วนหัวไฟล์ ไม่ได้ถอดรหัสภาพ |
| ดึงภาพปก 1 เฟรม | **รอ** | ไม่ — เปิด CUDA context ครั้งหนึ่งกินเวลาพอ ๆ กับงานทั้งงาน จะช้าลงด้วยซ้ำ |
| แปลง HEVC → H.264 | **ไม่รอ** (คิวเบื้องหลัง) | ช่วยได้จริง 5-10 เท่า |

นั่นแปลว่า **GPU ไม่ทำให้แขกอัพโหลดเสร็จเร็วขึ้นแม้แต่วินาทีเดียว** สิ่งที่มันช่วยคือ
คิวแปลงวิดีโอเบื้องหลังเดินเร็วขึ้น ซึ่งมีผลแค่ว่าวิดีโอ HEVC จะโผล่ขึ้นสไลด์โชว์
เร็วขึ้นกี่นาที

### ตัวการ์ดทำได้แค่ไหน

GTX 1050 Ti เป็นชิป GP107 มี NVENC รุ่นที่ 6 และ NVDEC

- ถอดรหัส: H.264, HEVC (8 และ 10 บิต), VP9
- เข้ารหัส: H.264 และ HEVC

พอสำหรับงานนี้ทั้งหมด ข้อจำกัดที่ต้องรู้คือการ์ด GeForce จำกัดจำนวน session
ของ NVENC ที่ทำพร้อมกัน (ไดรเวอร์เก่าคือ 2) แต่คิวแปลงวิดีโอของเราทำทีละงานอยู่แล้ว
จึงไม่ติดข้อนี้

### ทำไมถึงยังไม่ทำ

ปัญหาไม่ได้อยู่ที่การ์ด อยู่ที่ **DSM/Xpenology**

1. Synology ไม่ได้แถม `nvidia.ko` มาให้ ต้อง build เคอร์เนลโมดูลเองให้ตรงกับ
   เคอร์เนลของ DSM ซึ่งเป็นเวอร์ชันเก่าและแก้ไขมาแล้ว
2. Container Manager ไม่มี `nvidia-container-toolkit` ต่อให้ไดรเวอร์ขึ้นบนโฮสต์
   ก็ยังส่ง GPU เข้าคอนเทนเนอร์ไม่ได้
3. ffmpeg ในอิมเมจต้อง build มาพร้อม `--enable-nvenc` ซึ่งตัวมาตรฐานของ Debian ไม่มี
4. **เคอร์เนลโมดูลที่ผิดรุ่นทำให้ NAS บูตไม่ขึ้น** — บน Xpenology ที่ไม่ใช่ฮาร์ดแวร์แท้
   ยิ่งเสี่ยง และการกู้กลับไม่ตรงไปตรงมา

### ตรวจก่อนว่าเริ่มต้นจากตรงไหน

```bash
lspci | grep -i nvidia          # DSM เห็นการ์ดไหม
ls /dev/nvidia*                 # มีไดรเวอร์แล้วหรือยัง (ปกติจะไม่มี)
docker exec wedding-share ffmpeg -encoders 2>/dev/null | grep nvenc   # ffmpeg รู้จักไหม
```

ถ้า `/dev/nvidia*` ไม่มี แปลว่ายังไม่มีไดรเวอร์เลย — ระยะทางจากตรงนี้ถึงใช้งานได้จริง
คือหลายชั่วโมงและมีโอกาสพัง **หลังงานแต่งค่อยทำ**

### ถ้าวันหนึ่งทำสำเร็จแล้ว

โค้ดรองรับไว้ให้แล้วทั้งคิวแปลงวิดีโอและการ export หนัง เปลี่ยนแค่ `.env`

```env
VIDEO_ENCODER=h264_nvenc
VIDEO_ENCODER_ARGS=-preset p4 -cq 24
FILM_ENCODER_ARGS=-preset p4 -cq 20
VIDEO_DECODER_ARGS=-hwaccel cuda
```

⚠️ **ต้องเปลี่ยนอาร์กิวเมนต์คู่กับตัวเข้ารหัสเสมอ** — `libx264` ใช้ `-crf`
ส่วน `nvenc` ไม่รู้จักคำนี้ ต้องใช้ `-cq` แทน ตั้งตัวเข้ารหัสใหม่แต่ลืมอาร์กิวเมนต์
ffmpeg จะล้มทันทีตั้งแต่คลิปแรก

`FILM_ENCODER_ARGS` แยกจาก `VIDEO_ENCODER_ARGS` เพราะหนังคือของที่เก็บไว้ตลอดชีวิต
จึงตั้งคุณภาพสูงกว่าคิวแปลงวิดีโอ (20 แทน 24)

แล้ว `sudo docker compose up -d`

**ยืนยันผลด้วยตัวเลข ไม่ใช่ด้วยการที่ไม่มี error**

```bash
docker exec wedding-share ffmpeg -encoders 2>/dev/null | grep nvenc   # ต้องเจอก่อน
docker compose logs -f wedding-share | grep -i fps                     # เทียบ fps ก่อน/หลัง
```

> ตอนเปลี่ยนตัวเข้ารหัส คลิปเก่าที่ค้างอยู่ใน `export/parts/` จะถูกล้างทิ้งอัตโนมัติ
> เพราะ concat แบบ `-c copy` ต้องการคลิปที่พารามิเตอร์เหมือนกันทุกใบ
> เอาคลิปสองชนิดมาต่อกันจะได้หนังที่ภาพค้างกลางเรื่องโดยไม่มี error ให้เห็น

### สิ่งที่ทำแทนไปแล้ว และได้ผลมากกว่า

`.mov` จาก iPhone ที่ตั้งเป็น "Most Compatible" ข้างในเป็น H.264 อยู่แล้ว
เบราว์เซอร์ทุกตัวเล่นได้ ของเดิมบีบอัดใหม่ทุกไฟล์ที่ไม่ใช่ `.mp4` = เผา CPU
เพื่อให้ได้ภาพที่แย่ลง ตอนนี้ระบบดูจากตัวโคเดกจริง ถ้าเป็น H.264 อยู่แล้วจะ
**คัดลอกสตรีมตรง ๆ** เปลี่ยนแค่กล่องจาก `.mov` เป็น `.mp4`

วัดจริงบนเครื่องทดสอบ คลิป 30 วินาที 1080p

| วิธี | เวลา | ผลลัพธ์ |
|---|---|---|
| เดิม บีบอัดใหม่ | 12,692 ms | 17 MB (ภาพแย่ลง) |
| ใหม่ คัดลอกสตรีม | 75 ms | 30 MB (ภาพเท่าต้นฉบับ) |

เร็วขึ้นประมาณ **169 เท่า** และ GPU ก็ทำได้ไม่เร็วเท่านี้ เพราะการคัดลอกสตรีม
ไม่ต้องถอดรหัสภาพเลย

> ข้อแลกเปลี่ยน: ไฟล์ที่คัดลอกสตรีมจะใหญ่เท่าต้นฉบับ ไม่ได้เล็กลงเหมือนตอนบีบอัดใหม่
> กินพื้นที่ `derived/` มากขึ้น แลกกับความเร็วและคุณภาพที่ไม่เสีย — คุ้มกว่ามาก
> ในงานที่ใช้ครั้งเดียว

## พอร์ตที่งานนี้จอง

> 📌 **จดลงตารางส่วนที่ 3.1 ของ `INFRASTANDARDS.md` ด้วย** ตามกฎ §3.2 ข้อ 2
> ไม่งั้นอีกไม่กี่เดือนจะชนกันเอง (18090 ไม่ชนกับของเดิม — NetControl ใช้ 8090 คนละตัว)

| Port | อยู่ที่ | เปิดถึงใคร | ใช้ทำอะไร |
|---|---|---|---|
| `3000` | ใน container | เฉพาะใน container | Express ฟังจริง |
| `18090` | NAS **loopback เท่านั้น** | เฉพาะกระบวนการบน NAS | จุดที่ reverse proxy ยิงเข้า |
| `443` หรือ `8443` | DSM nginx | LAN + WAN | พอร์ตสาธารณะของงานนี้ |

ถ้า `18090` ชนกับอย่างอื่น ใช้ `sudo ./scripts/deploy-nas.sh --port 18091`
แล้วแก้ Destination port ใน reverse proxy ตาม

## หลังงานจบ

- [ ] ปิดสวิตช์อัพโหลดที่ `/admin`
- [ ] ดาวน์โหลด ZIP ([บทที่ 5](05-download-backup.md))
- [ ] `pg_dump` ไม่เกี่ยว — งานนี้ใช้ SQLite ที่ `/volume1/wedding/db` ใส่ใน Hyper Backup ได้เลย
- [ ] จะปิดถาวร: `sudo docker compose down` + ลบ reverse proxy rule + ลบ DNS 2 ระเบียน
