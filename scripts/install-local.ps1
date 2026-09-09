param([switch]$WebOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or [int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) {
    throw 'Node.js 22 or newer is required.'
}
Push-Location $projectRoot
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Web dependencies failed to install.' }
    if (-not $WebOnly) {
        Push-Location (Join-Path $projectRoot 'photobooth')
        try {
            & npm.cmd ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw 'Photo Booth dependencies failed to install.' }
        } finally { Pop-Location }
    }
    Write-Host 'Installed. Configure .env, run npm.cmd start, then npm.cmd run check:booth.'
    Write-Host 'Start Photo Booth from photobooth with npm.cmd start.'
} finally { Pop-Location }
