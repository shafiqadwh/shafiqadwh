# บทที่ 1 · ติดตั้งบน NAS (Xpenology / Synology DSM 7)

เป้าหมายของบทนี้: เปิดเว็บได้จากมือถือที่อยู่ใน Wi-Fi บ้านเดียวกับ NAS
(ยังไม่ต้องสนใจอินเทอร์เน็ต จะทำในบทที่ 2)

---

## 1. สร้างโฟลเดอร์เก็บรูป

เข้า DSM → **Control Panel → Shared Folder → Create**

- ชื่อ: `wedding`
- Location: `volume1`
- ติ๊ก **Enable Recycle Bin** (กันลบพลาด)

จากนั้นเข้า **File Station** สร้างโฟลเดอร์ย่อย 4 อันใน `wedding`

| โฟลเดอร์ | เก็บอะไร | ต้อง backup ไหม |
|---|---|---|
| `uploads` | ไฟล์ต้นฉบับทั้งหมดที่แขกส่งมา | **ต้อง** — นี่คือความทรงจำของงาน |
| `derived` | รูปย่อ ภาพปกวิดีโอ วิดีโอที่แปลงแล้ว | ไม่ต้อง สร้างใหม่ได้ |
| `db` | ฐานข้อมูล SQLite (ชื่อผู้ส่ง คำอวยพร) | **ต้อง** — ไฟล์เล็กแต่สำคัญ |
| `tmp` | ไฟล์ชั่วคราวระหว่างอัพโหลด | ไม่ต้อง |

## 2. หาเลข PUID / PGID

คอนเทนเนอร์ต้องเขียนไฟล์ลงโฟลเดอร์ข้างบนได้ ถ้าเลขไม่ตรงจะเจออาการ
"อัพโหลดแล้วขึ้น error ทุกครั้ง"

เปิด **Control Panel → Terminal & SNMP → Enable SSH** แล้ว ssh เข้า NAS

```bash
ssh ผู้ใช้ของคุณ@ไอพีของ-nas
id
# ตัวอย่างผลลัพธ์: uid=1026(shafiq) gid=100(users) groups=100(users),101(administrators)
```

จดเลข `uid` (เช่น 1026) และ `gid` (เช่น 100) ไว้

## 3. เอาโค้ดขึ้น NAS

```bash
cd /volume1/docker            # ถ้ายังไม่มีโฟลเดอร์นี้ ให้สร้าง shared folder ชื่อ docker ก่อน
git clone <URL ของ repo นี้> wedding-share
cd wedding-share
cp .env.example .env
```

## 4. แก้ไฟล์ `.env`

แก้อย่างน้อย 4 บรรทัดนี้

```env
COUPLE_NAMES=ชื่อบ่าวสาว
EVENT_DATE=14.11.2026
ADMIN_PASSWORD=ตั้งรหัสยาว ๆ อย่างน้อย 8 ตัว
BASE_URL=https://wedding.xxxx.synology.me     # ที่อยู่จริงจากบทที่ 2 (ตอนนี้ใส่ไว้ก่อนได้)
```

> ⚠️ `BASE_URL` คือที่อยู่ที่จะฝังอยู่ใน QR code — ต้องใส่ให้ถูก **ก่อน** สั่งพิมพ์การ์ด
> ถ้าเปลี่ยนทีหลัง ต้องพิมพ์การ์ดใหม่

## 5. ตรวจ path ใน `docker-compose.yml`

ถ้าคุณสร้าง shared folder ชื่ออื่น หรืออยู่คนละ volume ให้แก้ 4 บรรทัดนี้ให้ตรง

```yaml
    volumes:
      - /volume1/wedding/uploads:/app/data/uploads
      - /volume1/wedding/derived:/app/data/derived
      - /volume1/wedding/db:/app/data/db
      - /volume1/wedding/tmp:/app/data/tmp
```

และใส่เลขจากข้อ 2 ลงไปในไฟล์ `.env`

```env
PUID=1026
PGID=100
HTTP_PORT=8080
```

## 6. สั่งรัน

**วิธีที่เร็วที่สุด — สคริปต์เดียวจบ**

```bash
cd /volume1/docker/wedding-share
sudo ./scripts/deploy-nas.sh
```

สคริปต์จะทำข้อ 1–6 ให้ทั้งหมด: ตรวจ docker, เช็คว่าพอร์ตว่าง, สร้างโฟลเดอร์,
ตั้งสิทธิ์ตาม PUID/PGID ของคุณ, สร้าง `.env` พร้อม**รหัสแอดมินแบบสุ่ม**,
build, รัน แล้วรอจนเว็บตอบก่อนบอก URL

```bash
sudo ./scripts/deploy-nas.sh --dry-run          # ดูก่อนว่าจะทำอะไรบ้าง
sudo ./scripts/deploy-nas.sh --port 8181        # ถ้าพอร์ต 8080 ชนกับแอปอื่น
sudo ./scripts/deploy-nas.sh --data /volume2/wedding
```

ถ้าเคยสร้าง `.env` ไว้แล้ว สคริปต์จะไม่เขียนทับ

หรือถ้าอยากทำเองทีละขั้น ใช้สองวิธีข้างล่างนี้

**วิธีที่ 1 — ผ่าน SSH (เห็น log ตอนมีปัญหา)**

```bash
cd /volume1/docker/wedding-share
sudo docker compose up -d --build      # ครั้งแรกใช้เวลา 3-5 นาที
sudo docker compose logs -f            # ดู log, ออกด้วย Ctrl+C
```

รอจนเห็นบรรทัด

```
Ali & Nurul — listening on http://0.0.0.0:3000
```

**วิธีที่ 2 — ผ่านหน้าจอ Container Manager**

DSM → **Container Manager → Project → Create**
- Project name: `wedding-share`
- Path: `/volume1/docker/wedding-share`
- Source: **Use existing docker-compose.yml**
- กด Next → Done

## 7. ทดสอบ

เปิดมือถือที่ต่อ Wi-Fi บ้าน แล้วเข้า

```
http://ไอพีของ-nas:8080
```

ต้องเห็นหน้าภาษาไทย ลองอัพโหลดรูป 1 รูป แล้วเช็คว่าไฟล์โผล่ใน File Station
ที่ `wedding/uploads` จริง

ลองเข้า `http://ไอพีของ-nas:8080/admin` แล้วล็อกอินด้วยรหัสใน `.env`

---

## แก้ปัญหาที่เจอบ่อย

**อัพโหลดแล้ว error ทุกครั้ง / log ขึ้น `EACCES: permission denied`**
เลข PUID/PGID ไม่ตรงกับเจ้าของโฟลเดอร์ แก้โดย

```bash
sudo chown -R 1026:100 /volume1/wedding      # ใส่เลขของคุณเอง
sudo docker compose restart
```

**คอนเทนเนอร์ restart วนไม่หยุด**
ดู log ด้วย `sudo docker compose logs --tail 50` — ถ้าเขียนว่า
`ADMIN_PASSWORD is required` แปลว่ายังไม่ได้ตั้งรหัสใน `.env`

**พอร์ต 8080 ชนกับแอปอื่นของ DSM**
เปลี่ยน `HTTP_PORT` ใน `.env` เป็นเลขอื่น เช่น 8181 แล้ว `docker compose up -d`

**อยากอัปเดตโค้ดใหม่**
```bash
cd /volume1/docker/wedding-share
git pull
sudo docker compose up -d --build
```
รูปและคำอวยพรไม่หาย เพราะเก็บอยู่นอกคอนเทนเนอร์

---

ถัดไป: [บทที่ 2 · เปิดให้แขกเข้าจากอินเทอร์เน็ต](02-ddns-reverse-proxy.md)
