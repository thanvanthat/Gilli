# Builds a production release: the website is compiled by Vite and served by the C# server itself
# (one origin, so the browser reaches the SignalR hub at /hubs/game with no CORS configuration).
#   .\scripts\publish.ps1                 -> .\publish\  (run with: dotnet .\publish\Gilli.Server.dll)
param([string]$Out = 'publish')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $root $Out

Push-Location (Join-Path $root 'client')
try {
    if (-not (Test-Path node_modules)) { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' } }
    npm run build; if ($LASTEXITCODE) { throw 'Website build failed' }
} finally { Pop-Location }

dotnet publish (Join-Path $root 'server\Gilli.Server') -c Release -o $outDir -nologo
if ($LASTEXITCODE) { throw 'Server publish failed' }

$wwwroot = Join-Path $outDir 'wwwroot'
if (Test-Path $wwwroot) { Remove-Item -Recurse -Force $wwwroot }
Copy-Item -Recurse (Join-Path $root 'client\dist') $wwwroot
Write-Host "Release ready in $outDir"
Write-Host "Run locally:  `$env:ASPNETCORE_URLS='http://localhost:8080'; dotnet $outDir\Gilli.Server.dll"
