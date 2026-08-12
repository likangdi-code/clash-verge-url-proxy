# Graceful stop of clash dev (simulate software exit)
#
# Why: `Stop-Process -Force` is like Windows "End task" - the app's exit cleanup
# does NOT run, leaving: 1) system proxy still pointing to 127.0.0.1:7897 (core dead
# -> no internet) 2) TUN virtual NIC "Meta" not removed.
# This replicates the graceful exit cleanup (feat::window::clean_async):
#   1. Reset system proxy (WinINET ProxyEnable=0)
#   2. Gracefully stop clash-verge-service (stops core, TUN NIC removed)
#   3. Stop GUI / leftover core processes
#
# Usage: powershell -ExecutionPolicy Bypass -File scripts\stop-clash-graceful.ps1

$ErrorActionPreference = 'SilentlyContinue'

Write-Host '[graceful-stop] 1/3 reset system proxy...' -ForegroundColor Cyan
$reg = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
try {
    Set-ItemProperty -Path $reg -Name ProxyEnable -Value 0 -Type DWord -ErrorAction Stop
    Remove-ItemProperty -Path $reg -Name ProxyServer -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $reg -Name AutoConfigURL -ErrorAction SilentlyContinue
    Write-Host '  system proxy reset (ProxyEnable=0)'
} catch {
    Write-Warning "  failed to reset system proxy: $_"
}

Write-Host '[graceful-stop] 2/3 stop clash-verge-service gracefully...' -ForegroundColor Cyan
$svc = Get-Service -Name 'clash_verge_service' -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') {
    try {
        # Stop-Service sends a stop control via SCM (service OnStop can clean up itself)
        Stop-Service -Name 'clash_verge_service' -Force -ErrorAction Stop
        $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 15))
        Write-Host '  service stopped gracefully (core exited, TUN NIC removed)'
    } catch {
        Write-Warning "  failed to stop service: $_"
    }
} else {
    Write-Host '  service not running, skip'
}

Start-Sleep -Milliseconds 800

Write-Host '[graceful-stop] 3/3 stop GUI / leftover core processes...' -ForegroundColor Cyan
Get-Process -Name 'clash-verge', 'verge-mihomo' -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Milliseconds 800
Write-Host '[graceful-stop] done'
