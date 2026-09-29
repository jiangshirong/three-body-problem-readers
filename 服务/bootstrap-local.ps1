param([Parameter(Mandatory=$true)][string]$DataRoot,[ValidateSet('CustomVoice')][string]$Model='CustomVoice',[ValidateSet('cpu','cuda')][string]$Device='cuda',[switch]$PrepareOnly)
$ErrorActionPreference='Stop'
$rootPath=[IO.Path]::GetFullPath($DataRoot)
$runtimePath=Join-Path $rootPath 'runtime'
$runtimePython=Join-Path $runtimePath 'Scripts/python.exe'
if (-not (Test-Path -LiteralPath $runtimePython)) {
    $runtimePython=Join-Path $runtimePath 'python.exe'
    if (-not (Test-Path -LiteralPath (Join-Path $runtimePath 'Lib/site-packages/pip/__main__.py'))) {
        Write-Output '{"stage":"Preparing private Python runtime"}'
        $downloadPath=Join-Path $rootPath 'downloads'
        New-Item -ItemType Directory -Force -Path $downloadPath,$runtimePath | Out-Null
        [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
        function Get-VerifiedFile($Url,$Destination,$ExpectedHash) {
            if ((Test-Path -LiteralPath $Destination) -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -eq $ExpectedHash) { return }
            Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
            if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $ExpectedHash) { throw 'Runtime download checksum mismatch. Retry installation.' }
        }
        $pythonArchive=Join-Path $downloadPath 'python-3.11.9.zip'
        Get-VerifiedFile 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip' $pythonArchive '009d6bf7e3b2ddca3d784fa09f90fe54336d5b60f0e0f305c37f400bf83cfd3b'
        Expand-Archive -LiteralPath $pythonArchive -DestinationPath $runtimePath -Force
        $pipArchive=Join-Path $downloadPath 'pip-25.0.1.zip'
        Get-VerifiedFile 'https://files.pythonhosted.org/packages/c9/bc/b7db44f5f39f9d0494071bddae6880eb645970366d0a200022a1a93d57f5/pip-25.0.1-py3-none-any.whl' $pipArchive 'c46efd13b6aa8279f33f2864459c8ce587ea6a1a59ee20de055868d8f7688f7f'
        Expand-Archive -LiteralPath $pipArchive -DestinationPath (Join-Path $runtimePath 'Lib/site-packages') -Force
        [IO.File]::WriteAllText((Join-Path $runtimePath 'python311._pth'),"python311.zip`n.`nLib/site-packages`nimport site`n")
    }
}
if ($PrepareOnly) { & $runtimePython -m pip --version; exit $LASTEXITCODE }
& $runtimePython (Join-Path $PSScriptRoot 'local-tts.py') install $rootPath $Model $Device
exit $LASTEXITCODE
