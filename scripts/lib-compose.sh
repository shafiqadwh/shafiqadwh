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
gpu_ready() {
  [ -f docker-compose.gpu.yml ] || return 1
  docker image inspect wedding-share:latest >/dev/null 2>&1 || return 1
  docker run --rm --gpus all wedding-share:latest true >/dev/null 2>&1
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
