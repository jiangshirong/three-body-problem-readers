param([switch]$Restart)
$ErrorActionPreference = 'Stop'
$readerProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$readerUrl = 'http://127.0.0.1:8766'
$readerStatus = $null
try { $readerStatus = Invoke-RestMethod "$readerUrl/api/status" -TimeoutSec 2 } catch {}
if ($readerStatus -and $readerStatus.instanceId -ne $readerProject) {
    # Only replace the service that identifies itself as this workspace's pre-migration reader.
    $oldReaderProject = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    if ($readerStatus.instanceId -ne $oldReaderProject) { throw 'Another reader is using port 8766. Nothing was stopped.' }
    $portOwner = Get-NetTCPConnection -LocalPort 8766 -State Listen -ErrorAction Stop | Select-Object -First 1 -ExpandProperty OwningProcess
    Stop-Process -Id $portOwner -ErrorAction Stop
    Wait-Process -Id $portOwner -Timeout 10 -ErrorAction SilentlyContinue
    $readerStatus = $null
}
if ($Restart -and $readerStatus) {
    $readerScript = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'start-english.mjs'))
    $readerPattern = '(?:^|\s)"?' + [regex]::Escape($readerScript) + '"?\s*$'
    $readerProcesses = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match $readerPattern })
    if (-not $readerProcesses) { throw 'Cannot verify the reader process. Nothing stopped.' }
    foreach ($readerProcess in $readerProcesses) {
        Stop-Process -Id $readerProcess.ProcessId -ErrorAction Stop
        Wait-Process -Id $readerProcess.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    }
    $readerStatus = $null
}
if (-not $readerStatus) {
    $readerNode = (Get-Command node -ErrorAction Stop).Source
    $env:NODE_USE_ENV_PROXY = '1'
    Start-Process -FilePath $readerNode -ArgumentList @('"' + (Join-Path $PSScriptRoot 'start-english.mjs') + '"') -WorkingDirectory $readerProject -WindowStyle Hidden
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        Start-Sleep -Milliseconds 200
        try { $readerStatus=Invoke-RestMethod "$readerUrl/api/status" -TimeoutSec 1; if($readerStatus.instanceId -eq $readerProject){break} } catch {}
    }
}
if ($readerStatus.instanceId -ne $readerProject) { throw 'Reader failed to start.' }
Start-Process $readerUrl
