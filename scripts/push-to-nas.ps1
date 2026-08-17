# ส่งโค้ดขึ้น NAS จาก Windows PowerShell
#
#   .\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2
#   .\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2 -Restart
#   .\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2 -Dest /volume1/docker/wedding-share
#   .\scripts\push-to-nas.ps1 shafiqadwh@192.168.2.2 -SshKey $HOME\.ssh\nas_ed25519
#
# ต้องรันจากในโฟลเดอร์โปรเจกต์ (ที่มีไฟล์ package.json)
# ใช้ tar.exe และ scp.exe ที่ติดมากับ Windows 10/11 อยู่แล้ว ไม่ต้องลง WSL
#
# ถ้าเพิ่งติดตั้งครั้งแรกและยังไม่มีโค้ดบนเครื่อง ให้โหลดลง NAS ตรง ๆ แทน
# ดูวิธีในไฟล์ docs/07-shafiq-nas.md หัวข้อ "วิธีที่ 1"

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Target,

    [string]$Dest = '/volume1/docker/wedding-share',
    [string]$SshKey = '',
    [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir

if (-not (Test-Path 'package.json')) {
    throw "ไม่พบ package.json — ต้องรันสคริปต์นี้จากในโฟลเดอร์โปรเจกต์"
}

foreach ($tool in @('tar', 'scp', 'ssh')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "ไม่พบคำสั่ง $tool — Windows 10/11 มีให้อยู่แล้ว ถ้าไม่มีให้เปิด OpenSSH Client ใน Settings > Optional features"
    }
}

$sshArgs = @()
$scpArgs = @('-O')   # legacy protocol — sshd ของ DSM ไม่มี SFTP subsystem
if ($SshKey) {
    $sshArgs += @('-i', $SshKey)
    $scpArgs += @('-i', $SshKey)
}

$archive = Join-Path $env:TEMP 'wedding-share.tar.gz'

Write-Host ''
Write-Host '> รวมไฟล์' -ForegroundColor Yellow
tar --exclude='./.git' `
    --exclude='./node_modules' `
    --exclude='./data' `
    --exclude='./.env' `
    --exclude='./test-output' `
    -czf $archive .
if ($LASTEXITCODE -ne 0) { throw 'tar ล้มเหลว' }
Write-Host ("  {0:N1} MB" -f ((Get-Item $archive).Length / 1MB))

Write-Host ''
Write-Host "> ส่งขึ้น $Target" -ForegroundColor Yellow
& ssh @sshArgs $Target "mkdir -p '$Dest'"
if ($LASTEXITCODE -ne 0) { throw 'ssh ล้มเหลว — ตรวจว่าเปิด SSH ใน DSM แล้ว' }

& scp @scpArgs $archive "${Target}:${Dest}/.push.tar.gz"
if ($LASTEXITCODE -ne 0) { throw 'scp ล้มเหลว' }

Write-Host ''
Write-Host '> แตกไฟล์บน NAS' -ForegroundColor Yellow
# ไม่ลบของเดิม เพราะ .env อยู่ในนั้น — tar เขียนทับเฉพาะไฟล์ที่ส่งไป
& ssh @sshArgs $Target "cd '$Dest' && tar -xzf .push.tar.gz && rm -f .push.tar.gz && ls -1 | head -20"

if ($Restart) {
    Write-Host ''
    Write-Host '> รีสตาร์ทคอนเทนเนอร์' -ForegroundColor Yellow
    & ssh @sshArgs $Target "cd '$Dest' && sudo docker compose restart"
}

Remove-Item $archive -Force -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '===========================================================' -ForegroundColor Green
Write-Host " ส่งขึ้น NAS เรียบร้อย: $Dest"
Write-Host ''
Write-Host ' ขั้นถัดไป ให้ ssh เข้า NAS แล้วรันที่นั่น:'
Write-Host "   ssh $Target"
Write-Host "   cd $Dest"
Write-Host '   แก้แค่โค้ด/คำแปล   sudo docker compose restart'
Write-Host '   แก้ package.json   sudo docker compose up -d --build'
Write-Host '   ติดตั้งครั้งแรก      sudo ./scripts/deploy-nas.sh --lan'
Write-Host '==========================================================='  -ForegroundColor Green
