# บทที่ 14 · Zigbee บน Home Assistant ที่รันเป็น VM บน Synology

บทนี้เขียนสำหรับของชุดนี้โดยเฉพาะ

| ของที่มี | จำนวน | รายละเอียด |
|---|---|---|
| **Sonoff ZBDongle-P** (ZigBee 3.0 USB Dongle Plus) | 3 | ชิป TI **CC2652P** + ชิปแปลง USB→Serial **CP2102N** (Silicon Labs, `10c4:ea60`) มีเสาอากาศถอดได้ |
| สาย USB ต่อยาว 1.5 ม. | มากับกล่อง | **ต้องใช้** ไม่ใช่ของแถมที่ทิ้งได้ — เหตุผลอยู่ในข้อ 1 |
| **Lincukoo** Zigbee 3.0 Temperature & Humidity Sensor | 2 | ถ่าน AAA · ตัวลูกข่าย (end device) เกาะกับ dongle ที่เป็น coordinator |
| Home Assistant | 1 | รันเป็น **VM บน Synology** (Virtual Machine Manager) |

**สิ่งที่ยากที่สุดในงานนี้ไม่ใช่ฝั่ง Home Assistant** — ฝั่ง HA กดไม่กี่ครั้งก็จบ
ของยากคือ **ทำให้ USB ที่เสียบอยู่ที่ตัว NAS โผล่เข้าไปในเครื่องเสมือน** ข้อ 2 จึงยาวที่สุด
และมีทางสำรองสองทางเผื่อรุ่น NAS ไม่รองรับ

> ผมเขียนบทนี้จากสเปกของอุปกรณ์และพฤติกรรมของ DSM/HA เท่าที่รู้ **แต่ยังไม่ได้ลงมือบนเครื่องจริงของคุณ**
> เมนู VMM ต่างกันเล็กน้อยตามรุ่น NAS และเวอร์ชัน DSM · ทุกข้อที่ผมไม่แน่ใจ ผมทำเครื่องหมาย ⚠️ ไว้ให้

---

## 0. ตัดสินใจก่อน 3 เรื่อง ทำครั้งเดียวจบ

| เรื่อง | ตัวเลือก | เลือกอันไหน |
|---|---|---|
| **ใช้ dongle กี่ตัว** | 1 / 2 / 3 | **ใช้ตัวเดียวเป็น coordinator** · ตัวที่ 2 แฟลชเป็น router ขยายสัญญาณ (ข้อ 8) · ตัวที่ 3 เก็บเป็นอะไหล่ **ห้ามเสียบสองตัวเป็น coordinator พร้อมกัน** |
| **ZHA หรือ Zigbee2MQTT** | สองตัวนี้ทำงานเหมือนกัน แต่คนละระบบ | **Zigbee2MQTT** — เพราะเซ็นเซอร์ Lincukoo เป็นของที่ผลิตตาม Tuya/eWeLink และ Z2M รู้จักของกลุ่มนี้ครบกว่า ถ้าเจอรุ่นที่ยังไม่รู้จักก็เพิ่มไฟล์เองได้ (ข้อ 7) · ZHA ง่ายกว่าแต่เพิ่มรุ่นเองยาก |
| **ช่องสัญญาณ (channel)** | 11–26 | **25** ถ้า Wi-Fi 2.4G ของบ้านอยู่ช่อง 1 หรือ 6 · ดูตารางในข้อ 5 — **เลือกตอนนี้เลย เพราะย้ายทีหลังต้องจับคู่อุปกรณ์ใหม่ทุกตัว** |

**ห้ามลง ZHA กับ Zigbee2MQTT พร้อมกัน** ทั้งคู่จะแย่งพอร์ต USB เดียวกันแล้วพังทั้งสองฝั่ง
ถ้าเคยเปิด ZHA ไว้ ให้ลบ integration ออกก่อน

---

## 1. เสียบ dongle ให้ถูกวิธี — ข้อนี้ข้ามไม่ได้

Zigbee ใช้คลื่น 2.4 GHz ช่วงเดียวกับ Wi-Fi และ **พอร์ต USB 3.0 กับ SSD ปล่อยสัญญาณรบกวนย่านนี้แรงมาก**
เสียบ dongle ติดตัว NAS ตรง ๆ คือสาเหตุอันดับหนึ่งของอาการ "จับคู่ได้แต่หลุดตลอด"

| ทำ | อย่าทำ |
|---|---|
| ใช้**สายต่อ 1.5 ม. ที่แถมมา** เสมอ | เสียบเข้าตัว NAS ตรง ๆ |
| เสียบสายเข้า **พอร์ต USB 2.0** (ช่องดำ) ถ้า NAS มี | เสียบพอร์ต USB 3.0 (ช่องน้ำเงิน) โดยไม่จำเป็น |
| วางให้ห่างจากตัว NAS / เราเตอร์ / กล้องวงจรปิด อย่างน้อย 1 เมตร | วางทับบน NAS หรือหลังตู้เหล็ก |
| **หมุนเสาอากาศให้ตั้งฉาก** กับพื้น | ปล่อยเสาพับติดตัวเครื่อง |

ถ้าจำเป็นต้องใช้ช่อง USB 3.0 จริง ๆ ให้ยิ่งยืดสายออกให้ไกลที่สุด

---

## 2. ส่ง USB จาก NAS เข้าไปในเครื่องเสมือน

นี่คือหัวใจของงาน ทำตามทางหลักก่อน ถ้ารุ่น NAS ไม่รองรับค่อยถอยไปทางสำรอง

### ทางหลัก — USB passthrough ของ Virtual Machine Manager

ใช้ได้กับ NAS ตระกูล x86 (รุ่นลงท้าย `+` เป็นต้นไป) ที่ลง **Virtual Machine Manager** รุ่นใหม่บน DSM 7
⚠️ บางรุ่น/บางเวอร์ชันไม่มีเมนูนี้ — ถ้าไม่เจอตามขั้นที่ 4 ให้ข้ามไปทางสำรอง

| ขั้น | ทำอะไร |
|---|---|
| 1 | เสียบ dongle (ผ่านสายต่อ) เข้าพอร์ต USB ที่ **ตัว NAS** ไม่ใช่ที่เครื่องอื่น |
| 2 | เปิด DSM → **Virtual Machine Manager** |
| 3 | เลือก VM ของ Home Assistant → **ปิดเครื่อง (Shut Down)** — ต้องปิดจริง ๆ ไม่ใช่แค่ pause · ปิดจากใน HA ก็ได้ (Settings → System → กดปุ่มปิดเครื่อง) |
| 4 | เลือก VM → **แก้ไข (Edit)** → แท็บ **อื่น ๆ (Other)** → หา **อุปกรณ์ USB (USB Device)** |
| 5 | ในรายการจะเห็นชื่อประมาณ **`Silicon Labs CP2102N USB to UART Bridge Controller`** — ติ๊กเลือกตัวนั้น |
| 6 | **ใช้ (Apply)** แล้วเปิด VM ขึ้นมา |

**ถ้ารายการว่างเปล่า** ให้ลองตามลำดับนี้: ถอดแล้วเสียบ USB ใหม่ → กดรีเฟรชหน้า VMM →
ย้ายไปพอร์ต USB อีกช่อง → รีบูต NAS หนึ่งครั้ง · ถ้ายังว่าง แปลว่ารุ่นนี้ไม่รองรับ → ทางสำรอง

**ข้อควรรู้ที่ทำให้เสียเวลากันบ่อย**

- ถ้า **ถอด dongle ออกมาเสียบใหม่** หรือ **ย้ายพอร์ต** VMM มักหลุดการผูก ต้องปิด VM แล้วเลือกใหม่ตามขั้น 4–6
- หลัง **NAS รีบูต** ให้เช็กว่า VM ยังเห็น USB อยู่ (ข้อ 3) ก่อนไปงงว่าทำไมเซ็นเซอร์เงียบ
- ⚠️ ถ้าเปิด **High Availability / ย้าย VM ข้ามโฮสต์** USB จะตามไปไม่ได้ เพราะมันผูกกับเครื่องที่เสียบอยู่จริง

### ทางสำรอง ก. — ต่อผ่าน LAN ด้วย ser2net (ไม่ต้องพึ่ง passthrough เลย)

เอา dongle ไปเสียบกับเครื่อง Linux เล็ก ๆ ที่เปิดตลอด (Raspberry Pi, มินิพีซี, หรือเครื่องบูธในบทที่ 13)
แล้วเปิดพอร์ตอนุกรมออกมาทาง LAN ให้ HA เรียกข้ามเครื่องมา **วิธีนี้ยังทำให้วาง dongle ไว้กลางบ้านได้ด้วย สัญญาณดีกว่าอยู่ในห้อง NAS**

```bash
sudo apt update && sudo apt install -y ser2net
ls -l /dev/serial/by-id/          # ดูชื่อจริงของ dongle
```

`/etc/ser2net.yaml` (รูปแบบใหม่ของ ser2net 4.x):

```yaml
connection: &zigbee
  accepter: tcp,6638
  connector: serialdev,/dev/serial/by-id/usb-ITead_SONOFF_Zigbee_3.0_USB_Dongle_Plus_XXXXXXXX-if00-port0,115200n81,local
  options:
    kickolduser: true
```

```bash
sudo systemctl enable --now ser2net
```

แล้วในข้อ 5 ใช้พอร์ตเป็น `tcp://192.168.2.50:6638` แทน `/dev/ttyUSB0`
(เปลี่ยน `192.168.2.50` เป็นไอพีของเครื่องนั้น และ **จองไอพีนั้นไว้ใน MikroTik** ไม่ให้เปลี่ยน)

### ทางสำรอง ข. — ไม่ใช้ VM เลย รันบน Container Manager ของ NAS

ถ้า DSM มองเห็น dongle ได้เอง (ต้องลงไดรเวอร์ CP210x เพิ่ม ซึ่ง Synology ไม่ได้ให้มา)
ก็รัน Zigbee2MQTT เป็นคอนเทนเนอร์บน NAS แล้ว map `/dev/ttyUSB0` เข้าไป
⚠️ ทางนี้ต้องลงแพ็กเกจไดรเวอร์จากนอก Synology ซึ่ง**หลุดจากมาตรฐาน infra ในบทที่ 7** และพังได้ทุกครั้งที่อัปเดต DSM
ผมแนะนำให้ใช้ทางสำรอง ก. มากกว่า ถ้าทางหลักไม่ผ่าน

---

## 3. เช็กว่า Home Assistant เห็น dongle แล้วจริง

เปิด VM ขึ้นมา แล้วดูสองที่

**ที่ 1 — หน้าฮาร์ดแวร์**
`Settings → System → Hardware` → เมนูสามจุดมุมขวาบน → **All Hardware** → ค้นหาคำว่า `ttyUSB`
ต้องเจอ `/dev/ttyUSB0` และถ้ากดดูรายละเอียดจะเห็น `ID_VENDOR: Silicon_Labs`

**ที่ 2 — ชื่อพอร์ตแบบถาวร (สำคัญเพราะคุณมี 3 ตัว)**
ถ้าเปิด add-on **Advanced SSH & Web Terminal** ไว้ ให้รัน

```bash
ls -l /dev/serial/by-id/
```

จะได้ประมาณ

```
usb-ITead_SONOFF_Zigbee_3.0_USB_Dongle_Plus_20230415123456-if00-port0 -> ../../ttyUSB0
```

**ใช้ชื่อยาว ๆ ของ `by-id` เสมอ อย่าใช้ `/dev/ttyUSB0`** — เพราะวันไหนเสียบ dongle ตัวที่สอง
หรือมี USB อื่นเพิ่ม เลข `0` `1` สลับกันได้ แต่ชื่อ by-id ผูกกับซีเรียลของตัวนั้นตลอดไป

**ไม่เจอ `ttyUSB` เลย?** → กลับไปข้อ 2 · VM ยังไม่ได้รับ USB จริง ๆ ไม่ใช่ปัญหาของ HA

---

## 4. ลง Mosquitto + Zigbee2MQTT

ต้องเป็น **Home Assistant OS หรือ Supervised** ถึงจะมีร้าน add-on
⚠️ ถ้า VM ของคุณลงเป็น HA **Container/Core** จะไม่มีเมนูนี้ ต้องรัน Z2M เป็นคอนเทนเนอร์แยก — บอกผมได้ ผมเขียนส่วนนั้นเพิ่มให้

| ขั้น | ทำอะไร |
|---|---|
| 1 | `Settings → Add-ons → Add-on Store` → ค้นหา **Mosquitto broker** → Install → **Start** → เปิด *Start on boot* และ *Watchdog* |
| 2 | `Settings → Devices & Services` — HA จะเด้ง **MQTT** ขึ้นมาให้กด **Configure** เอง กดรับไปเลย ไม่ต้องกรอกรหัสอะไร |
| 3 | กลับไป Add-on Store → เมนูสามจุด → **Repositories** → ใส่ `https://github.com/zigbee2mqtt/hassio-zigbee2mqtt` |
| 4 | ติดตั้ง **Zigbee2MQTT** (ตัวที่ไม่มีคำว่า Edge) → **ยังไม่ต้องกด Start** |

---

## 5. ตั้งค่า Zigbee2MQTT

ไปที่แท็บ **Configuration** ของ add-on แล้วแก้ให้ตรงกับของจริง

```yaml
serial:
  port: /dev/serial/by-id/usb-ITead_SONOFF_Zigbee_3.0_USB_Dongle_Plus_XXXXXXXX-if00-port0
  adapter: zstack
  baudrate: 115200
  rtscts: false
advanced:
  channel: 25
  transmit_power: 20
  log_level: info
```

| ค่า | ทำไม |
|---|---|
| `adapter: zstack` | ZBDongle-**P** คือชิป TI ต้องใช้ zstack · ถ้าเป็นรุ่น **E** (ชิป Silabs) ต้องใช้ `ember` — **ของคุณคือรุ่น P** |
| `baudrate: 115200` | ค่ามาตรฐานของเฟิร์มแวร์ที่ติดมากับเครื่อง |
| `rtscts: false` | ZBDongle-P ไม่ใช้ hardware flow control |
| `transmit_power: 20` | CC2652**P** มีภาคขยายกำลังส่ง ตั้ง 20 dBm ได้ (ไม่ใช่ 5 เหมือนรุ่นไม่มี P) |
| `channel` | ดูตารางข้างล่าง |

**เลือกช่องให้ไม่ชนกับ Wi-Fi**

| Wi-Fi 2.4G ของบ้านอยู่ช่อง | ให้ตั้ง Zigbee ช่อง |
|---|---|
| 1 | **25** หรือ 26 |
| 6 | **25** |
| 11 | **15** |
| ไม่รู้ / เปลี่ยนไปมา | **25** แล้วไปล็อก Wi-Fi ของ MikroTik ไว้ที่ช่อง 1 |

**ใช้ `tcp://` แทนถ้าเลือกทางสำรอง ก.**

```yaml
serial:
  port: tcp://192.168.2.50:6638
  adapter: zstack
```

กด **Start** แล้วเปิดแท็บ **Log** ทันที · ที่ต้องเห็นคือ

```
Starting zigbee-herdsman (x.x.x)
zigbee-herdsman started (resumed)
Coordinator firmware version: '{"type":"zStack3x0","meta":{...,"revision":2022xxxx}}'
Currently 0 devices are joined
```

เห็น `Coordinator firmware version` = **ฝั่งฮาร์ดแวร์ผ่านหมดแล้ว** ที่เหลือคือเรื่องง่าย

---

## 6. จับคู่เซ็นเซอร์ Lincukoo ทั้งสองตัว

| ขั้น | ทำอะไร |
|---|---|
| 1 | ใส่ถ่าน AAA — ดึงแผ่นพลาสติกกันถ่านออก ถ้ามี |
| 2 | ใน HA เปิดหน้า **Zigbee2MQTT** (เมนูซ้ายมือ) → กด **Permit join (All)** → มีเวลา 255 วินาที |
| 3 | ที่ตัวเซ็นเซอร์ **กดปุ่ม reset ค้างไว้ ~5 วินาที** จนไฟกะพริบ (ปุ่มอยู่ข้างเครื่อง หรือในช่องถ่าน บางรุ่นต้องใช้เข็มจิ้ม) |
| 4 | ดูที่แท็บ Log จะขึ้น `Successfully interviewed '0x...'` แล้วอุปกรณ์จะโผล่ในรายการ |
| 5 | **ตั้งชื่อทันที** กดไอคอนดินสอ → เปลี่ยนเป็น `temp_livingroom` / `temp_bedroom` — ถ้าปล่อยเป็น `0x00124b00...` ทั้งสองตัว จะแยกไม่ออกว่าตัวไหนอยู่ห้องไหน |
| 6 | ทำซ้ำกับตัวที่สอง |
| 7 | **ปิด Permit join** เมื่อจับคู่ครบ — เปิดค้างไว้เสี่ยงและกินแบตอุปกรณ์ |

**จับคู่ตรงไหนดี** — จับคู่ในตำแหน่งที่จะใช้งานจริงเลย ดีกว่าจับคู่ข้าง coordinator แล้วค่อยเอาไปวาง
เพราะตอน interview มันจะเลือกเส้นทางที่เหมาะกับจุดนั้น

**กดปุ่มแล้วไม่มีอะไรเกิดขึ้น** — ตัวเซ็นเซอร์ใช้ถ่านจึง "หลับ" เป็นส่วนใหญ่
ระหว่างที่ Log ยังไม่ขึ้น `interview` ให้กดปุ่มเบา ๆ ซ้ำทุก 10 วินาทีเพื่อปลุกมันไว้

หลังจับคู่เสร็จ เข้าไปที่ `Settings → Devices & Services → MQTT → x devices`
จะเห็น entity ชุดนี้ต่อเซ็นเซอร์หนึ่งตัว: `sensor.temp_livingroom_temperature`,
`..._humidity`, `..._battery`, `..._linkquality`

---

## 7. ถ้า Z2M ขึ้นว่า "Device unsupported"

เซ็นเซอร์กลุ่ม Tuya/eWeLink มีการเปลี่ยนรหัสผู้ผลิตบ่อย รุ่นใหม่ ๆ จึงหลุดฐานข้อมูลได้

**ลองตามลำดับ**

1. **อัปเดต add-on Zigbee2MQTT ให้เป็นรุ่นล่าสุดก่อน** — ส่วนใหญ่จบตรงนี้ เพราะรุ่นใหม่เพิ่มรายชื่อเข้าไปแล้ว
2. ยังไม่หาย → เปิดหน้าอุปกรณ์ใน Z2M จดค่า **`model ID`** (มักเป็น `TS0201`) กับ **`manufacturer`** (เช่น `_TZ3000_xxxxxxxx`) จาก Log
3. สร้างไฟล์ `/config/zigbee2mqtt/lincukoo.js` (ใช้ add-on **File editor** หรือ Samba)

```js
const {temperature, humidity, battery} = require('zigbee-herdsman-converters/lib/modernExtend');

module.exports = {
    zigbeeModel: ['TS0201'],
    fingerprint: [{modelID: 'TS0201', manufacturerName: '_TZ3000_xxxxxxxx'}],
    model: 'LINCUKOO-TH',
    vendor: 'Lincukoo',
    description: 'Temperature & humidity sensor',
    extend: [battery(), temperature(), humidity()],
};
```

แก้ `_TZ3000_xxxxxxxx` เป็นค่าจริงที่จดมาจากข้อ 2 แล้วเพิ่มในหน้า Configuration

```yaml
external_converters:
  - lincukoo.js
```

รีสตาร์ต add-on · ⚠️ Zigbee2MQTT รุ่น 2.x เปลี่ยนไปใช้รูปแบบ ESM — ถ้ารีสตาร์ตแล้ว Log ฟ้อง
เรื่อง `require`/`module.exports` ให้เปลี่ยนหัวเป็น `import {...} from '...'` และท้ายเป็น `export default {...}`

---

## 8. เอา dongle อีกสองตัวไปทำอะไร

| ตัว | หน้าที่ | หมายเหตุ |
|---|---|---|
| #1 | **Coordinator** | ตัวเดียวที่เสียบกับ HA |
| #2 | **Router / ตัวขยายสัญญาณ** | แฟลชเฟิร์มแวร์ router แล้วเสียบหัวชาร์จ USB ไว้กลางทางระหว่าง NAS กับห้องที่วางเซ็นเซอร์ |
| #3 | **อะไหล่** | เก็บไว้เฉย ๆ วันที่ตัวหลักพัง เอา backup จากข้อ 9 ลงตัวนี้แล้วใช้ต่อได้เลยโดยไม่ต้องจับคู่ใหม่ทั้งบ้าน |

**ห้ามเสียบ dongle สองตัวที่เป็น coordinator ไว้ใกล้กันและใช้ช่องเดียวกัน** — มันจะกวนกันเอง

**วิธีแฟลชตัวที่ 2 เป็น router** (ทำบนเครื่อง Linux/Windows เครื่องไหนก็ได้ ไม่ต้องทำบน NAS)

1. โหลดไฟล์ `CC1352P2_CC2652P_launchpad_router_*.zip` จาก repo **Koenkk/Z-Stack-firmware**
   (โฟลเดอร์ `router/Z-Stack_3.x.0`) — **ต้องเป็นไฟล์ที่มี `CC1352P2_CC2652P` เท่านั้น** ไฟล์ของชิปอื่นจะทำให้ดองเกิลใช้ไม่ได้
2. **กดปุ่ม BOOT ค้างไว้ขณะเสียบ USB** แล้วค่อยปล่อย — เป็นการเข้าโหมด bootloader
3. แฟลชด้วย `cc2538-bsl`

```bash
git clone https://github.com/JelmerT/cc2538-bsl.git && cd cc2538-bsl
pip3 install pyserial intelhex
python3 cc2538-bsl.py -p /dev/ttyUSB0 -evw CC1352P2_CC2652P_launchpad_router_XXXXXXXX.hex
```

4. ถอดเสียบใหม่ แล้วเปิด **Permit join** ใน Z2M · router จะเข้าร่วมเครือข่ายเองเหมือนอุปกรณ์ทั่วไป

---

## 9. สำรองข้อมูล — ทำทันทีที่จับคู่เสร็จ

ในเครือข่าย Zigbee **กุญแจเครือข่ายกับรายชื่ออุปกรณ์อยู่ในตัว dongle** ถ้าดองเกิลพัง
และไม่มี backup = ต้องเดินไปกดปุ่มจับคู่ใหม่ทุกตัวในบ้าน

| ไฟล์ | ที่อยู่ | คือ |
|---|---|---|
| `coordinator_backup.json` | `/config/zigbee2mqtt/` | กุญแจเครือข่าย + PAN ID — **ไฟล์ที่สำคัญที่สุด** |
| `database.db` | `/config/zigbee2mqtt/` | รายชื่ออุปกรณ์และชื่อที่ตั้งไว้ |
| `configuration.yaml` | `/config/zigbee2mqtt/` | ค่าที่ตั้งในข้อ 5 |

ก๊อปสามไฟล์นี้ออกไปเก็บนอก VM (Hyper Backup ของ NAS หรือโฟลเดอร์เดียวกับที่สำรองงานอื่นอยู่)
และ **ถ่ายรูปหน้า Zigbee2MQTT → Settings → Network เก็บค่า PAN ID กับ channel ไว้ด้วย**

เสริมอีกชั้น: `Settings → System → Backups` ของ HA ตั้ง backup อัตโนมัติรายสัปดาห์ให้เก็บลง NAS

---

## 10. ตรวจว่าใช้ได้จริง แล้วเอาไปใช้งาน

**ตรวจ 4 ข้อ**

| ตรวจ | ผ่านคือ |
|---|---|
| ค่าอุณหภูมิขึ้น | `sensor.*_temperature` มีตัวเลข ไม่ใช่ `unavailable` |
| ค่าอัปเดตจริง | เอามือกำเซ็นเซอร์ไว้ 2–3 นาที แล้วดูกราฟว่าขยับขึ้น (อุปกรณ์ใช้ถ่านจะส่งค่าเมื่อค่าเปลี่ยนถึงเกณฑ์ ไม่ได้ส่งทุกวินาที) |
| สัญญาณแรงพอ | `*_linkquality` (LQI) **เกิน 50** ถือว่าใช้ได้ · ต่ำกว่า 30 ให้ขยับตำแหน่งหรือเพิ่ม router จากข้อ 8 |
| รอดการรีบูต | รีสตาร์ต VM หนึ่งครั้ง แล้วค่าต้องกลับมาเองภายใน 1–2 นาที **โดยไม่ต้องไปแตะ VMM** |

**ตัวอย่างการ์ดบนหน้าจอ** — `Settings → Dashboards` → เพิ่มการ์ดแบบ Manual

```yaml
type: entities
title: อุณหภูมิในบ้าน
entities:
  - entity: sensor.temp_livingroom_temperature
    name: ห้องนั่งเล่น
  - entity: sensor.temp_livingroom_humidity
    name: ความชื้นห้องนั่งเล่น
  - entity: sensor.temp_bedroom_temperature
    name: ห้องนอน
  - entity: sensor.temp_bedroom_battery
    name: แบตเตอรี่ห้องนอน
```

**ตัวอย่างการแจ้งเตือนถ่านใกล้หมด** — `Settings → Automations` → แก้เป็น YAML

```yaml
alias: เตือนถ่านเซ็นเซอร์ใกล้หมด
trigger:
  - platform: numeric_state
    entity_id:
      - sensor.temp_livingroom_battery
      - sensor.temp_bedroom_battery
    below: 20
    for: "01:00:00"
action:
  - service: notify.persistent_notification
    data:
      message: "ถ่านของ {{ trigger.to_state.name }} เหลือ {{ trigger.to_state.state }}%"
mode: single
```

---

## 11. อาการที่เจอบ่อยและทางแก้

| อาการ | สาเหตุที่พบบ่อยที่สุด | แก้ |
|---|---|---|
| VMM ไม่เห็นอุปกรณ์ USB เลย | รุ่น NAS/DSM ไม่รองรับ passthrough | ทางสำรอง ก. ในข้อ 2 |
| HA ไม่มี `/dev/ttyUSB0` | ผูก USB ตอน VM ยังเปิดอยู่ | ปิด VM → ผูกใหม่ → เปิด |
| Z2M เด้งขึ้นมาแล้วดับซ้ำ ๆ | พอร์ตผิด หรือ `adapter` ผิด (ใส่ `ember` ให้ดองเกิลรุ่น P) | แก้ตามข้อ 5 ใช้ชื่อ by-id |
| Log ขึ้น `Error: Resource temporarily unavailable` | มีโปรแกรมอื่นจับพอร์ตอยู่ — มักเป็น **ZHA ที่ยังเปิดค้าง** | ลบ ZHA integration ออก แล้วรีสตาร์ต |
| จับคู่ติดแต่ไม่กี่ชั่วโมงก็ `unavailable` | สัญญาณรบกวน / ระยะไกลเกิน | ข้อ 1 (สายต่อ + เสาตั้ง) แล้วเพิ่ม router ข้อ 8 |
| ค่าไม่อัปเดตนาน ๆ แต่ไม่ขึ้น unavailable | ปกติของเซ็นเซอร์ถ่าน มันส่งเมื่อค่าเปลี่ยน | ไม่ต้องแก้ · ถ้าอยากเช็ก กดปุ่มที่ตัวเซ็นเซอร์ ค่าจะเด้งทันที |
| ทุกอย่างหายหลัง NAS รีบูต | VMM หลุดการผูก USB | ข้อ 2 หัวข้อ "ข้อควรรู้" — ทำใหม่ แล้วเช็กด้วยข้อ 3 |
| เครือข่ายรวนหลังเพิ่มอุปกรณ์ Wi-Fi ใหม่ | ช่อง Zigbee ชนกับ Wi-Fi | ล็อกช่อง Wi-Fi ที่ MikroTik แทนที่จะย้ายช่อง Zigbee (ย้าย Zigbee = จับคู่ใหม่ทั้งบ้าน) |

---

## 12. ลำดับที่แนะนำให้ทำจริง

1. เสียบ dongle ตัวที่ 1 ผ่านสายต่อ เข้าพอร์ต USB 2.0 ของ NAS — ข้อ 1
2. ปิด VM → ผูก USB ใน VMM → เปิด VM — ข้อ 2
3. เช็กว่าเห็น `ttyUSB0` และจด**ชื่อ by-id** ไว้ — ข้อ 3
4. ลง Mosquitto → ลง Zigbee2MQTT — ข้อ 4
5. ใส่ config → Start → **ต้องเห็น `Coordinator firmware version` ใน Log** — ข้อ 5
6. จับคู่เซ็นเซอร์สองตัว แล้วตั้งชื่อทันที — ข้อ 6
7. **ก๊อป `coordinator_backup.json` ออกมาเก็บ** — ข้อ 9
8. ทำการ์ดขึ้นหน้าจอ + ตั้งเตือนถ่าน — ข้อ 10
9. ค่อยแฟลชตัวที่ 2 เป็น router ตอนที่เห็นว่า LQI ต่ำจริง ๆ — ข้อ 8

ข้อ 1–7 ใช้เวลาประมาณหนึ่งชั่วโมงถ้าไม่ติดปัญหา
