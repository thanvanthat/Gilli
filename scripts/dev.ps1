# Gilli local development launcher (Windows PowerShell 5.1+ / PowerShell 7).
#   .\scripts\dev.ps1            install if needed, start backend + website, check health, open the browser
#   .\scripts\dev.ps1 -NoBrowser do not open a browser
#   .\scripts\stop.ps1           stop both processes
param([switch]$NoBrowser, [int]$ServerPort = 5080, [int]$WebPort = 5173)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root '.dev'
New-Item -ItemType Directory -Force $logs | Out-Null

function Test-Port([int]$port) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return [bool]$c
}
function Wait-Url([string]$url, [int]$seconds) {
    for ($i = 0; $i -lt $seconds * 2; $i++) {
        try { $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 $url; if ($r.StatusCode -eq 200) { return $r.Content } } catch { }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

# 1. tools
foreach ($tool in 'dotnet', 'node', 'npm') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "$tool is not installed. Install the .NET 10 SDK and Node.js 20+ (see README)." }
}

# 2. port conflicts: refuse rather than silently using other ports
foreach ($p in $ServerPort, $WebPort) {
    if (Test-Port $p) { throw "Port $p is already in use. Stop the other process (or run .\scripts\stop.ps1) and try again." }
}

# 3. dependencies
if (-not (Test-Path (Join-Path $root 'client\node_modules'))) {
    Write-Host 'Installing website dependencies (npm ci)...'
    Push-Location (Join-Path $root 'client'); npm ci; Pop-Location
}
Write-Host 'Restoring and building the C# server...'
dotnet build (Join-Path $root 'server\Gilli.Server') -nologo -v q | Out-Host
if ($LASTEXITCODE -ne 0) { throw 'C# build failed.' }

# 4. start backend
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$server = Start-Process dotnet -ArgumentList @('run', '--no-build', '--project', (Join-Path $root 'server\Gilli.Server'), '--urls', "http://localhost:$ServerPort") `
    -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server.err.log') -PassThru -WindowStyle Hidden
$server.Id | Set-Content (Join-Path $logs 'server.pid')
$health = Wait-Url "http://localhost:$ServerPort/health" 60
if (-not $health) { throw "Backend did not become healthy. See $logs\server.log" }
Write-Host "Backend healthy: $health"

# 5. start website (Vite proxies /hubs and /api to the backend)
$env:GILLI_SERVER_URL = "http://localhost:$ServerPort"
$web = Start-Process npm.cmd -ArgumentList @('run', 'dev', '--', '--port', "$WebPort", '--strictPort') -WorkingDirectory (Join-Path $root 'client') `
    -RedirectStandardOutput (Join-Path $logs 'web.log') -RedirectStandardError (Join-Path $logs 'web.err.log') -PassThru -WindowStyle Hidden
$web.Id | Set-Content (Join-Path $logs 'web.pid')
if (-not (Wait-Url "http://localhost:$WebPort/" 60)) { throw "Website did not start. See $logs\web.log" }
if (-not (Wait-Url "http://localhost:$WebPort/api/layout" 20)) { throw 'Website is up but cannot reach the backend through the proxy.' }

Write-Host ''
Write-Host "Gilli is running:" -ForegroundColor Green
Write-Host "  Website : http://localhost:$WebPort/"
Write-Host "  Backend : http://localhost:$ServerPort/  (SignalR hub /hubs/game, health /health, metrics /api/metrics)"
Write-Host "  Logs    : $logs"
Write-Host "  Stop    : .\scripts\stop.ps1"
if (-not $NoBrowser) { Start-Process "http://localhost:$WebPort/" }
