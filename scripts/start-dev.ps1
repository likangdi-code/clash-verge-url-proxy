# Start clash dev, ensuring clash-verge-service is running first.
#
# When TUN (enable_tun_mode) is on and the service is stopped, the app waits for
# the service IPC for SERVICE_WAIT_MAX (30s) and can get stuck. So start the
# service (if installed) before launching `pnpm dev`.
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\start-dev.ps1

$ErrorActionPreference = 'SilentlyContinue'

$svc = Get-Service -Name 'clash_verge_service' -ErrorAction SilentlyContinue
if ($svc) {
    if ($svc.Status -eq 'Running') {
        Write-Host '[start-dev] clash-verge-service already running'
    } else {
        Write-Host '[start-dev] starting clash-verge-service...'
        try {
            Start-Service -Name 'clash_verge_service' -ErrorAction Stop
            # wait until service is running
            $deadline = (Get-Date).AddSeconds(15)
            while ((Get-Service -Name 'clash_verge_service').Status -ne 'Running' -and (Get-Date) -lt $deadline) {
                Start-Sleep -Milliseconds 500
            }
            Write-Host '[start-dev] service started'
        } catch {
            Write-Warning "[start-dev] failed to start service: $_"
        }
    }
} else {
    Write-Host '[start-dev] clash-verge-service not installed, skip'
}

# wait for service IPC pipe so app won't wait on it
$pipe = '\\.\pipe\clash-verge-service'
$deadline = (Get-Date).AddSeconds(10)
while (-not [System.IO.File]::Exists($pipe) -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 500
}

Write-Host '[start-dev] launching pnpm dev...'
pnpm dev
