# ถอนการตั้งบูธให้เปิดเองออกจาก Windows
#
# คลิกขวาที่ไฟล์นี้ → Run with PowerShell  (ไม่ต้องเป็น Administrator)
#
# เอาออกเฉพาะสิ่งที่ windows-setup.ps1 สร้างไว้ อย่างละเอียดทีละชิ้น
#   1. ทางลัดในโฟลเดอร์ Startup  → บูธไม่ขึ้นเองตอนล็อกอินอีก
#   2. ตัวเปิด scripts\booth-start.cmd
#   3. คืนเวลาหลับของเครื่องเป็นค่าปกติของ Windows
#
# ⚠️ **ไม่แตะรูป ไม่แตะค่าตั้ง ไม่แตะสมุดบัญชี** — ของพวกนั้นอยู่ใน
#    %APPDATA%\photobooth\booth\ และเป็นงานของลูกค้า ไม่ใช่ของสคริปต์นี้
#    อยากลบต้องไปลบเองที่โฟลเดอร์นั้น โดยรู้ตัวว่ากำลังลบอะไร
#
# รันซ้ำได้ — ของที่ไม่มีอยู่แล้วก็บอกว่าไม่มี ไม่ใช่ล้มกลางทาง

$ErrorActionPreference = 'Stop'

$booth = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $booth 'scripts\booth-start.cmd'
$shortcut = Join-Path $startup 'Photo Booth.lnk'

Write-Host ''
Write-Host '=== ถอนการตั้งบูธให้เปิดเอง ===' -ForegroundColor Cyan
Write-Host ''

# ── 1. ทางลัดใน Startup ───────────────────────────────────────────────────
# ลบตัวนี้ก่อนเสมอ · ถ้าลบตัวเปิดก่อนแล้วสคริปต์ล้มกลางทาง จะเหลือทางลัดที่ชี้ไปที่
# ไฟล์ที่ไม่มีอยู่ — ล็อกอินทีหน้าต่าง error เด้งขึ้นมาทุกครั้งโดยไม่มีบูธให้ใช้
if (Test-Path $shortcut) {
    Remove-Item $shortcut -Force
    Write-Host "[1/3] เอาทางลัดออกจาก Startup แล้ว: $shortcut" -ForegroundColor Green
} else {
    Write-Host '[1/3] ไม่มีทางลัดใน Startup อยู่แล้ว' -ForegroundColor DarkGray
}

# ── 2. ตัวเปิด ────────────────────────────────────────────────────────────
if (Test-Path $launcher) {
    Remove-Item $launcher -Force
    Write-Host "[2/3] ลบตัวเปิดแล้ว: $launcher" -ForegroundColor Green
} else {
    Write-Host '[2/3] ไม่มีตัวเปิดอยู่แล้ว' -ForegroundColor DarkGray
}

# ── 3. คืนเวลาหลับ ────────────────────────────────────────────────────────
#
# setup ตั้งเป็น 0 (ไม่หลับเลย) ซึ่งถูกสำหรับเครื่องที่ยืนเป็นบูธทั้งคืน แต่ผิดสำหรับ
# เครื่องที่กลับไปเป็นเครื่องใช้งานทั่วไป · 30 นาที/15 นาที คือค่าปกติของ Windows
Write-Host ''
Write-Host '[3/3] คืนเวลาหลับของเครื่องเป็นค่าปกติ (เครื่องหลับ 30 นาที จอดับ 15 นาที)...'
powercfg /change standby-timeout-ac 30
powercfg /change monitor-timeout-ac 15
Write-Host '[3/3] คืนแล้ว' -ForegroundColor Green

Write-Host ''
Write-Host '=== เรียบร้อย ===' -ForegroundColor Cyan
Write-Host 'บูธจะไม่ขึ้นเองตอนเปิดเครื่องอีก · เปิดด้วยมือได้ตามปกติด้วย npm start'
Write-Host ''
Write-Host 'สิ่งที่ยังอยู่ครบ (ตั้งใจไม่แตะ):' -ForegroundColor Yellow
Write-Host '  - รูป ค่าตั้ง และสมุดบัญชี ที่ %APPDATA%\photobooth\booth\'
Write-Host '  - ตัวโปรแกรมกับ node_modules ในโฟลเดอร์นี้'
Write-Host ''
Read-Host 'กด Enter เพื่อปิด'
