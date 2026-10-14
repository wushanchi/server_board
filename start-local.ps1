param(
    [int]$Port = 8766,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $repo
$stateDirectory = Join-Path $repo '.local'
$virtualEnvironment = Join-Path $repo '.venv'
$virtualPython = Join-Path $virtualEnvironment 'Scripts\python.exe'
$pidFile = Join-Path $stateDirectory 'gateway.pid'
$logFile = Join-Path $stateDirectory 'gateway.log'
$errorLogFile = Join-Path $stateDirectory 'gateway-error.log'
$siteDirectory = Join-Path $repo 'dist'
New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null

if (Test-Path $pidFile) {
    $oldProcessId = [int](Get-Content $pidFile)
    if (Get-Process -Id $oldProcessId -ErrorAction SilentlyContinue) {
        throw 'Server Board is already running. Run stop-local.cmd before starting it again.'
    }
    Remove-Item $pidFile -Force
}

if (-not (Test-Path (Join-Path $siteDirectory 'index.html'))) {
    $npm = Get-Command npm -ErrorAction SilentlyContinue
    if (-not $npm) { throw 'dist/index.html is missing. Install Node.js, then run npm ci and npm run build.' }
    if (-not (Test-Path (Join-Path $repo 'node_modules'))) {
        & $npm.Source ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
    }
    & $npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed.' }
}

$bundledPython = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$python = if (Test-Path $bundledPython) { $bundledPython } else { (Get-Command python -ErrorAction Stop).Source }
if (-not (Test-Path $virtualPython)) {
    Write-Host 'Creating Python environment...'
    & $python -m venv $virtualEnvironment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create Python environment.' }
}
try {
    & $virtualPython -c "import importlib.util; raise SystemExit(importlib.util.find_spec('paramiko') is None)"
    $hasParamiko = $LASTEXITCODE -eq 0
} catch {
    $hasParamiko = $false
}
if (-not $hasParamiko) {
    Write-Host 'Installing SSH dependency...'
    & $virtualPython -m pip install --disable-pip-version-check -r (Join-Path $repo 'agent\requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Could not install SSH dependency.' }
}

if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Port must be between 1024 and 65535.' }
$available = $false
for ($candidate = $Port; $candidate -lt [Math]::Min($Port + 30, 65536); $candidate++) {
    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        $listener.Start()
        $Port = $candidate
        $available = $true
        break
    } catch {
        continue
    } finally {
        if ($listener) { $listener.Stop() }
    }
}
if (-not $available) { throw 'No available local port was found.' }

$tokenBytes = [byte[]]::new(32)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($tokenBytes) } finally { $random.Dispose() }
$gatewayToken = [BitConverter]::ToString($tokenBytes).Replace('-', '').ToLowerInvariant()
$env:SB_GATEWAY_TOKEN = $gatewayToken
$env:SB_GATEWAY_HOST = '127.0.0.1'
$env:SB_GATEWAY_PORT = [string]$Port
$env:SB_SITE_DIR = $siteDirectory
$env:SB_ALLOWED_ORIGINS = "http://127.0.0.1:$Port,http://localhost:$Port"

$process = Start-Process -FilePath $virtualPython -ArgumentList @('agent\ssh_gateway.py') -WorkingDirectory $repo -PassThru -WindowStyle Hidden -RedirectStandardOutput $logFile -RedirectStandardError $errorLogFile
$process.Id | Set-Content $pidFile -NoNewline
$url = "http://127.0.0.1:$Port/server_board/"
$ready = $false
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-Process -Id $process.Id -ErrorAction SilentlyContinue)) { break }
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
        if ($response.StatusCode -eq 200) { $ready = $true; break }
    } catch { Start-Sleep -Milliseconds 250 }
}
if (-not $ready) {
    if (Get-Process -Id $process.Id -ErrorAction SilentlyContinue) { Stop-Process -Id $process.Id -Force }
    Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    throw "Server Board did not start. Check $errorLogFile"
}

Write-Host "Server Board: $url" -ForegroundColor Green
Write-Host 'The SSH gateway address and temporary token are filled in automatically.'
Write-Host 'Run stop-local.cmd to stop the service.'
if (-not $NoBrowser) { Start-Process $url }
