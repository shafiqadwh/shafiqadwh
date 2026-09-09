# เลือกไฟล์ compose ตามว่า GPU ใช้ได้จริงหรือไม่ — ใช้ร่วมกันระหว่าง
# update.sh กับ ensure-up.sh  (ไฟล์นี้ให้ `.` มาใช้ ไม่ได้รันเอง)
#
# ผู้เรียกต้อง cd ไปที่โฟลเดอร์โปรเจกต์แล้วก่อนเรียกฟังก์ชันพวกนี้

# GPU ใช้ได้จริงไหม
#
# ตัดสินด้วยการ "สร้างคอนเทนเนอร์ที่ขอ GPU จริง ๆ แล้วดูว่ารอดไหม" ไม่ใช่ดูว่ามี
# /dev/nvidia* แล้วเดาเอา — ไดรเวอร์ขึ้นบนโฮสต์ไม่ได้แปลว่า nvidia-container-toolkit
# ยังต่ออยู่กับ Docker daemon และตัวที่ทำให้คอนเทนเนอร์สตาร์ทไม่ขึ้นคือชั้นหลัง
#
# ใช้อิมเมจ wedding-share:latest ที่มีอยู่ในเครื่องแล้ว ไม่ดึงอะไรจากเน็ต —
# docker0 ของ NAS ตัวนี้ออกอินเทอร์เน็ตไม่ได้ (ดูคอมเมนต์ใน docker-compose.yml)
#
# **มีเพดานเวลา** — วัดบนเครื่องจริงแล้วตัวตรวจนี้ใช้เวลาถึง 73 วินาทีตอนที่ NAS
# เพิ่งบูตและมีหลายอย่างแย่งกันทำงานอยู่ · ไม่มีเพดานคือรอบกู้ที่ค้างอยู่ตรงนี้
# ได้ไม่มีที่สิ้นสุด แล้วเว็บก็ล่มต่อไปโดยไม่มีอะไรในล็อกบอกว่าติดอยู่ตรงไหน
#
# ตั้งไว้ยาว (2 นาที) โดยตั้งใจ — มันคือตัวกันค้าง ไม่ใช่ตัวเร่งให้ตัดสินใจเร็ว
# ตัดสั้นกว่านี้จะกลายเป็นการถอยไป CPU ทั้งที่ GPU ใช้ได้ แค่ตอบช้าเพราะเครื่องยุ่ง
GPU_PROBE_TIMEOUT="${GPU_PROBE_TIMEOUT:-120}"

# `timeout` มีบน DSM แต่ไม่การันตีทุกรุ่น — ไม่มีก็รันตรง ๆ ดีกว่าล้มทั้งสคริปต์
capped() {
  _secs="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$_secs" "$@"
  else
    "$@"
  fi
}

gpu_ready() {
  [ -f docker-compose.gpu.yml ] || return 1
  capped 20 docker image inspect wedding-share:latest >/dev/null 2>&1 || return 1
  capped "$GPU_PROBE_TIMEOUT" docker run --rm --gpus all wedding-share:latest true \
    >/dev/null 2>&1
}

# อาร์กิวเมนต์ -f ที่จะส่งให้ docker compose
compose_files() {
  if gpu_ready; then
    printf -- '-f docker-compose.yml -f docker-compose.gpu.yml'
  else
    printf -- '-f docker-compose.yml'
  fi
}

# ไฟล์ compose สำหรับโหมด CPU ล้วน — เส้นทางถอยที่ต้องขึ้นได้เสมอ
compose_files_cpu() {
  printf -- '-f docker-compose.yml'
}
