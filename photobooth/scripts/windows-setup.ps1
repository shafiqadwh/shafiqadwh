# ตั้งบูธบน Windows ให้เปิดเองตอนเปิดเครื่อง
#
# คลิกขวาที่ไฟล์นี้ → Run with PowerShell  (ไม่ต้องเป็น Administrator)
#
# ทำสามอย่าง แล้วบอกว่าทำอะไรไปบ้าง
#   1. ลงไลบรารีที่โปรแกรมต้องใช้ (npm install)
#   2. สร้างตัวเปิดที่ **เปิดใหม่เองเมื่อโปรแกรมปิดไปกลางงาน**
#   3. วางทางลัดไว้ในโฟลเดอร์ Startup — ล็อกอินเข้า Windows แล้วบูธขึ้นเอง
#
# ทุกอย่างอยู่ในบัญชีผู้ใช้คนนี้เท่านั้น ไม่แตะระบบ ไม่ต้องใช้สิทธิ์ผู้ดูแล
# ถอนออกได้ด้วย windows-remove.ps1 ซึ่งอยู่ข้าง ๆ กัน

$ErrorActionPreference = 'Stop'

$booth = Split-Path -Parent $PSScriptRoot
$startup = [Environment]::GetFolderPath('Startup')
$launcher = Join-Path $booth 'scripts\booth-start.cmd'
$shortcut = Join-Path $startup 'Photo Booth.lnk'

Write-Host ''
Write-Host '=== ตั้งบูธถ่ายรูปบน Windows ===' -ForegroundColor Cyan
Write-Host "โฟลเดอร์โปรแกรม: $booth"
Write-Host ''

# ── 1. ตรวจ Node ──────────────────────────────────────────────────────────
# ต้องเช็คก่อนลง ไม่งั้น npm install จะล้มด้วยข้อความที่อ่านไม่ออกว่าเกี่ยวกับอะไร
try {
    $node = (node --version) -replace 'v', ''
} catch {
    Write-Host 'ไม่พบ Node.js บนเครื่องนี้' -ForegroundColor Red
    Write-Host 'ติดตั้งรุ่น LTS จาก https://nodejs.org แล้วรันไฟล์นี้ใหม่'
    Read-Host 'กด Enter เพื่อปิด'
    exit 1
}

$major = [int]($node -split '\.')[0]
if ($major -lt 20) {
    Write-Host "Node.js เวอร์ชัน $node เก่าเกินไป — ต้อง 20 ขึ้นไป (แนะนำ 22)" -ForegroundColor Red
    Read-Host 'กด Enter เพื่อปิด'
    exit 1
}
Write-Host "[1/3] Node.js $node ใช้ได้" -ForegroundColor Green

# ── 2. ลงไลบรารี ──────────────────────────────────────────────────────────
Write-Host '[2/3] กำลังลงไลบรารี (ครั้งแรกใช้เวลาหลายนาที ปล่อยไว้ได้)...'
Push-Location $booth
try {
    npm install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install ล้มเหลว (รหัส $LASTEXITCODE)" }
} finally {
    Pop-Location
}
Write-Host '[2/3] ลงไลบรารีเรียบร้อย' -ForegroundColor Green

# ── 3. ตัวเปิดที่เปิดใหม่เองเมื่อปิดไป ──────────────────────────────────────
#
# บูธเปิดค้างทั้งคืนโดยไม่มีใครนั่งเฝ้า · ปิดไปเองเมื่อไรต้องกลับมาเอง
# ไม่ใช่รอให้เจ้าของเดินมาเห็นจอเปล่าตอนมีคนต่อแถวอยู่แล้ว
#
# **มีเพดานการลองใหม่** — ปิดเพราะตั้งค่าผิด (เช่นหาไฟล์ไม่เจอ) จะปิดทันทีทุกครั้ง
# วนไม่จำกัดคือเครื่องที่หมุนอยู่อย่างนั้นทั้งคืนโดยไม่มีอะไรบนจอบอกว่าเกิดอะไรขึ้น
$cmd = @"
@echo off
rem ตัวเปิดบูธ — สร้างโดย windows-setup.ps1 แก้ได้ตามสบาย
rem เปิดใหม่เองเมื่อโปรแกรมปิดไป แต่ไม่เกิน 10 ครั้งติดกัน
cd /d "%~dp0.."
set TRIES=0
:run
call npm start
set /a TRIES+=1
if %TRIES% GEQ 10 (
  echo บูธปิดตัวเอง 10 ครั้งติดกัน - หยุดลองใหม่แล้ว
  echo เปิดหน้าตั้งค่าหรือดูข้อความข้างบนเพื่อหาสาเหตุ
  pause
  exit /b 1
)
timeout /t 3 /nobreak >nul
goto run
"@
Set-Content -Path $launcher -Value $cmd -Encoding OEM
Write-Host "[3/3] สร้างตัวเปิดแล้ว: $launcher" -ForegroundColor Green

# ทางลัดใน Startup · WindowStyle 7 = ย่อหน้าต่างคอนโซลลงทันที
# (หน้าต่างบูธเต็มจอทับอยู่แล้ว แต่ไม่ควรมีหน้าต่างดำแวบขึ้นมาให้แขกเห็น)
$wsh = New-Object -ComObject WScript.Shell
$link = $wsh.CreateShortcut($shortcut)
$link.TargetPath = $launcher
$link.WorkingDirectory = $booth
$link.WindowStyle = 7
$link.Description = 'Photo Booth'
$link.Save()

Write-Host "[3/3] วางทางลัดใน Startup แล้ว: $shortcut" -ForegroundColor Green

# ── กันเครื่องหลับ ────────────────────────────────────────────────────────
#
# ตัวโปรแกรมกันจอดับไว้เองแล้ว (powerSaveBlocker) แต่ **การหลับของตัวเครื่อง**
# เป็นคนละเรื่องและโปรแกรมสั่งไม่ได้ · เครื่องที่หลับกลางงานคือบูธที่ตายสนิท
Write-Host ''
Write-Host 'กำลังตั้งไม่ให้เครื่องหลับตอนเสียบปลั๊ก...'
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
Write-Host 'ตั้งแล้ว (เฉพาะตอนเสียบปลั๊ก - ตอนใช้แบตยังหลับตามเดิม)' -ForegroundColor Green

Write-Host ''
Write-Host '=== เรียบร้อย ===' -ForegroundColor Cyan
Write-Host 'รีสตาร์ตเครื่องหนึ่งครั้งเพื่อดูว่าบูธขึ้นเองจริงไหม'
Write-Host ''
Write-Host 'สิ่งที่ยังต้องทำเองก่อนใช้งานจริง:' -ForegroundColor Yellow
Write-Host '  - เปิดหน้าตั้งค่าในบูธ (กดค้างที่ชื่องานสองวินาที) แล้วตั้งชื่องาน ราคา เครื่องพิมพ์'
Write-Host '  - ตัวขับเครื่องพิมพ์บน Windows ต้องเลือก "สั่งพิมพ์ผ่านระบบ" (CUPS ใช้ไม่ได้)'
Write-Host '  - ถ้าอยากให้ขึ้นโดยไม่ต้องพิมพ์รหัสผ่าน ให้ตั้ง auto-login ด้วยคำสั่ง netplwiz'
Write-Host ''
Read-Host 'กด Enter เพื่อปิด'
