# Stops the processes started by scripts\dev.ps1 (and their child processes).
$root = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $root '.dev'
foreach ($name in 'web', 'server') {
    $pidFile = Join-Path $logs "$name.pid"
    if (-not (Test-Path $pidFile)) { continue }
    $procId = Get-Content $pidFile
    if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
        # /T stops the whole tree (npm -> node vite, dotnet run -> Gilli.Server)
        taskkill /PID $procId /T /F | Out-Null
        Write-Host "Stopped $name (pid $procId)"
    }
    Remove-Item $pidFile
}
foreach ($port in 5080, 5173) {
    $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($c) { Write-Host "Port $port is still in use by process $($c.OwningProcess) (not started by dev.ps1)." }
}
