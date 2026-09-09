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
            # Electron 44 dropped its postinstall, so npm ci leaves the 150 MB
            # runtime undownloaded. Fetch it now, while there is internet: the
            # booth is meant to run at venues that have none, and the first
            # launch would otherwise try to download it there.
            & npm.cmd run install:electron
            if ($LASTEXITCODE -ne 0) { throw 'The Electron runtime failed to download.' }
        } finally { Pop-Location }
    }
    Write-Host 'Installed. Configure .env, run npm.cmd start, then npm.cmd run check:booth.'
    Write-Host 'Start Photo Booth from photobooth with npm.cmd start.'
} finally { Pop-Location }
