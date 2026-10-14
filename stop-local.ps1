$ErrorActionPreference = 'SilentlyContinue'
$Repo = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $Repo '.local\gateway.pid'
if (Test-Path $pidFile) {
    $processId = [int](Get-Content $pidFile)
    if (Get-Process -Id $processId) { Stop-Process -Id $processId -Force }
    Remove-Item $pidFile -Force
    Write-Host "Stopped Server Board process $processId."
} else {
    Write-Host 'Server Board is not running.'
}
