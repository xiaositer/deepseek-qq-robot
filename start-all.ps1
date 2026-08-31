$ErrorActionPreference = 'Stop'

$projectDir = 'D:\qq-persona-companion'
$snowLumaDir = 'D:\SnowLuma'
$snowLumaNode = Join-Path $snowLumaDir 'node.exe'
$snowLumaWebUrl = 'http://127.0.0.1:5099/'
$consoleUrl = 'http://127.0.0.1:3100/'

function Wait-LocalPort {
  param(
    [int]$Port,
    [int]$TimeoutSeconds = 20
  )
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-NetConnection -ComputerName '127.0.0.1' -Port $Port -InformationLevel Quiet -WarningAction SilentlyContinue) {
      return $true
    }
    Start-Sleep -Milliseconds 400
  }
  return $false
}

if (-not (Test-Path -LiteralPath $projectDir)) { throw "Project directory not found: $projectDir" }
if (-not (Test-Path -LiteralPath $snowLumaNode)) { throw "SnowLuma executable not found: $snowLumaNode" }

if (-not (Wait-LocalPort -Port 5099 -TimeoutSeconds 1)) {
  Write-Host 'Starting SnowLuma...'
  Start-Process -FilePath $snowLumaNode -ArgumentList 'index.mjs' -WorkingDirectory $snowLumaDir -WindowStyle Hidden
  if (-not (Wait-LocalPort -Port 5099)) { throw 'SnowLuma startup timed out; WebUI port 5099 was not detected.' }
} else {
  Write-Host 'SnowLuma is already running.'
}

if (-not (Wait-LocalPort -Port 3100 -TimeoutSeconds 1)) {
  Write-Host 'Starting QQ Persona Companion console...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm start' -WorkingDirectory $projectDir -WindowStyle Hidden
  if (-not (Wait-LocalPort -Port 3100)) { throw 'Console startup timed out; port 3100 was not detected.' }
} else {
  Write-Host 'QQ Persona Companion console is already running.'
}

if (-not (Wait-LocalPort -Port 3001 -TimeoutSeconds 90)) {
  Start-Process $snowLumaWebUrl
  Start-Process $consoleUrl
  Write-Warning 'SnowLuma WebUI is running, but QQ / OneBot is not ready on port 3001. Please log in or reconnect QQ in SnowLuma, then run this script again.'
  exit 2
}

try {
  Invoke-RestMethod -Uri 'http://127.0.0.1:3100/api/chat/start' -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 10 | Out-Null
  Write-Host 'Chat service is running.'
} catch {
  throw "Console is running, but chat service failed to start: $($_.Exception.Message)"
}

Start-Process $consoleUrl
Write-Host "Startup complete: $consoleUrl"
