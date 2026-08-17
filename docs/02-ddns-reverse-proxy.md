# บทที่ 2 · เปิดให้แขกเข้าจากอินเทอร์เน็ต (DDNS + Reverse Proxy + HTTPS)

บทนี้ยาวที่สุดและพลาดกันบ่อยที่สุด แนะนำให้ทำล่วงหน้า **อย่างน้อย 1 สัปดาห์**
ก่อนวันงาน จะได้มีเวลาแก้ถ้าติดปัญหา

> 📍 ถ้าติดตั้งบน **Shafiq-NAS** (มี AdGuard + Cloudflare + wildcard cert อยู่แล้ว)
> ให้ข้ามไปที่ [บทที่ 7](07-shafiq-nas.md) แทน — สั้นกว่าและใช้ค่าจริงของระบบนั้น

> ทำไมต้อง HTTPS: เบราว์เซอร์มือถือรุ่นใหม่จะ **ไม่ยอมให้เว็บที่ไม่ใช่ HTTPS
> เปิดกล้องหรืออัพโหลดไฟล์บางชนิด** และ Safari จะขึ้นคำเตือน "Not Secure"
> ซึ่งแขกในงานเห็นแล้วจะไม่กล้ากด

---

## 1. เปิด DDNS

DSM → **Control Panel → External Access → DDNS → Add**

- Service provider: `Synology`
- Hostname: เลือกชื่อที่จำง่าย เช่น `ali-nurul` → ได้ `ali-nurul.synology.me`
- External address: `Auto`
- ติ๊ก **Get a certificate from Let's Encrypt** และ **Enable Heartbeat**

กด OK แล้วรอสถานะขึ้นเป็น **Normal**

## 2. เปิดพอร์ตที่เราเตอร์

เข้าหน้าเว็บเราเตอร์ → Port Forwarding → เพิ่ม 2 รายการ ชี้ไปที่ IP ของ NAS

| พอร์ตภายนอก | พอร์ตภายใน | โปรโตคอล | ทำไมต้องเปิด |
|---|---|---|---|
| 80 | 80 | TCP | Let's Encrypt ใช้ตรวจสอบตอนออก/ต่ออายุใบรับรอง |
| 443 | 443 | TCP | ให้แขกเข้าเว็บผ่าน HTTPS |

**อย่าเปิดพอร์ต 5000 / 5001 (หน้า DSM) ออกอินเทอร์เน็ตเด็ดขาด**

> ถ้าเน็ตบ้านเป็น CG-NAT (พอร์ตฟอร์เวิร์ดแล้วไม่ทำงาน — พบบ่อยกับเน็ตมือถือ
> และแพ็กเกจบ้านราคาถูกบางเจ้า) ให้ข้ามไปใช้ **Cloudflare Tunnel** แทน
> ดูหัวข้อสุดท้ายของบทนี้

## 3. ขอใบรับรอง HTTPS

DSM → **Control Panel → Security → Certificate → Add → Add a new certificate**
→ **Get a certificate from Let's Encrypt**

- Domain name: `wedding.ali-nurul.synology.me` (ใช้ subdomain แยกจากหน้า DSM)
- Email: อีเมลของคุณ

รอสักครู่จนได้ใบรับรอง แล้วกด **Settings** เพื่อผูกใบรับรองนี้เข้ากับ
`wedding.ali-nurul.synology.me`

## 4. ตั้ง Reverse Proxy

DSM → **Control Panel → Login Portal → Advanced → Reverse Proxy → Create**

**แท็บ General**

| ช่อง | ค่า |
|---|---|
| Description | `wedding-share` |
| Source Protocol | `HTTPS` |
| Source Hostname | `wedding.ali-nurul.synology.me` |
| Source Port | `443` |
| Enable HSTS | ติ๊ก |
| Destination Protocol | `HTTP` |
| Destination Hostname | `localhost` |
| Destination Port | `18090` (ตรงกับ `HTTP_PORT` ใน `.env`) |

**แท็บ Custom Header** → กด **Create → WebSocket** (เพิ่ม 2 บรรทัดให้อัตโนมัติ)

จากนั้นกด **Create** อีกครั้งเพื่อเพิ่มเองอีก 1 บรรทัด — ให้แอปรู้ว่าลูกค้าเข้ามาทาง https

| Header name | Value |
|---|---|
| `X-Forwarded-Proto` | `https` |

กด Save

## 5. ⚠️ แก้ลิมิตขนาดอัพโหลดของ nginx (ห้ามข้าม)

nginx ที่มากับ DSM จำกัดขนาดไฟล์ที่ส่งผ่าน reverse proxy ไว้เพียงไม่กี่ MB
**ไม่แก้ข้อนี้ = แขกอัพโหลดวิดีโอไม่ได้เลย** (จะขึ้น error 413)
และวิดีโอยาว ๆ จะหลุดกลางคันเพราะ timeout

ssh เข้า NAS แล้วสร้างไฟล์ config เพิ่ม

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

คำอธิบาย

| ค่า | ทำไม |
|---|---|
| `client_max_body_size 512m` | ต้องมากกว่า `MAX_VIDEO_MB` ใน `.env` (ค่าเริ่มต้น 300 MB) |
| `proxy_read_timeout` / `proxy_send_timeout` | ให้เวลาอัพวิดีโอใหญ่บนเน็ตมือถือช้า ๆ |
| `proxy_request_buffering off` | ส่งผ่านไปเลย ไม่ต้องรอเขียนลงดิสก์ของ nginx ก่อน |

> ไฟล์นี้อาจหายเมื่ออัปเดต DSM ครั้งใหญ่ — เช็คซ้ำอีกครั้งในเช็คลิสต์ก่อนวันงาน

**ทดสอบว่าได้ผลจริง** (จากคอมพิวเตอร์เครื่องอื่น)

```bash
# สร้างไฟล์ปลอมขนาด 60MB แล้วลองยิงเข้าไป — ต้องไม่ได้ 413
head -c 60000000 /dev/urandom > /tmp/big.bin
curl -o /dev/null -s -w "%{http_code}\n" -F "files=@/tmp/big.bin" \
  https://wedding.ali-nurul.synology.me/api/upload
```

ได้ `400` = ผ่าน nginx แล้ว (แอปปฏิเสธเพราะไม่ใช่ไฟล์รูป — ถูกต้อง)
ได้ `413` = ยังแก้ไม่สำเร็จ

## 6. เปิด Firewall

DSM → **Control Panel → Security → Firewall → Edit Rules**

- Allow: พอร์ต 80, 443 (TCP) จากทุกที่
- ปิดหรือจำกัดพอร์ต 5000/5001 ให้เข้าได้เฉพาะจาก LAN

และที่ **Security → Protection** เปิด **Auto Block** (บล็อกไอพีที่ล็อกอินผิดหลายครั้ง)

## 7. ทดสอบจริง ⚠️ สำคัญที่สุด

**ปิด Wi-Fi ที่มือถือ ใช้เน็ต 4G/5G** แล้วเปิด

```
https://wedding.ali-nurul.synology.me
```

ต้องผ่านครบ 4 ข้อ

- [ ] เห็นรูปแม่กุญแจ 🔒 ไม่มีคำเตือน
- [ ] อัพโหลดรูปจากมือถือได้
- [ ] อัพโหลด **วิดีโอ** จากมือถือได้ (ข้อที่คนลืมทดสอบ)
- [ ] เห็นรูปที่คนอื่นอัพโหลดไว้

ถ้าผ่านหมดแล้ว กลับไปแก้ `BASE_URL` ใน `.env` ให้เป็นที่อยู่นี้ แล้วรีสตาร์ท

```bash
sudo docker compose up -d
```

---

## ทางเลือก: Cloudflare Tunnel (เมื่อเปิดพอร์ตไม่ได้)

เหมาะกับกรณีเน็ตเป็น CG-NAT หรือไม่อยากเปิดพอร์ตบ้านออกอินเทอร์เน็ต

1. สมัคร Cloudflare (ฟรี) และย้าย DNS ของโดเมนตัวเองมาที่ Cloudflare
   (ใช้ `xxx.synology.me` ไม่ได้ ต้องมีโดเมนของตัวเอง)
2. Zero Trust → Networks → Tunnels → Create a tunnel → Docker
3. เพิ่ม service `cloudflared` ลงใน `docker-compose.yml`

```yaml
  cloudflared:
    image: cloudflare/cloudflared:latest
    restart: always
    command: tunnel --no-autoupdate run --token ${CF_TUNNEL_TOKEN}
    depends_on:
      - wedding-share
```

4. ใน Cloudflare ตั้ง Public hostname ชี้ไปที่ `http://wedding-share:3000`

> ⚠️ **ข้อจำกัดสำคัญ**: แผนฟรีของ Cloudflare จำกัดขนาดไฟล์ที่อัพโหลดผ่าน
> ได้ที่ **100 MB ต่อไฟล์** ถ้าใช้วิธีนี้ ให้ตั้ง `MAX_VIDEO_MB=95` และ
> `MAX_VIDEO_SECONDS=60` ใน `.env` เพื่อให้แอปบอกแขกตรง ๆ แทนที่จะให้
> อัพไปครึ่งทางแล้วเจอ error ของ Cloudflare

---

ถัดไป: [บทที่ 3 · ตั้งค่างานและพิมพ์การ์ด QR](03-qr-cards.md)
