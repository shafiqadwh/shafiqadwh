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

**สอดคล้องกับมาตรฐานเดิมอย่างไร**

- `ports: "127.0.0.1:18090:3000"` — ไม่เปิดสู่ LAN ตรง ๆ บังคับผ่าน reverse proxy + TLS
- `build: network: host` — จำเป็นเพราะ `docker0` บนเครื่องนี้ออกเน็ตไม่ได้ (landmine #2)
- โค้ด bind-mount แบบ read-only → แก้โค้ดแล้ว **Restart พอ ไม่ต้อง rebuild** (landmine #1)
- `.env` สร้างบน NAS เท่านั้น `chmod 600` ไม่เข้า git
- ข้อมูลอยู่ที่ `/volume1/wedding` (bind mount) → **Clean + Build ไม่ลบรูป**

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
| Destination hostname | `localhost` |
| Destination port | `18090` |

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
# บน NAS
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

## พอร์ตที่งานนี้จอง

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
