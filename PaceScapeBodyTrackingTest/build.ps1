[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$OrbbecWrapperZip
)

$ErrorActionPreference = 'Stop'
$wrapperZip = (Resolve-Path -LiteralPath $OrbbecWrapperZip).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) {
    throw 'Install the Visual Studio Build Tools workload Desktop development with C++.'
}
$msbuild = Join-Path $installation 'MSBuild\Current\Bin\amd64\MSBuild.exe'
$solution = Join-Path $PSScriptRoot 'PaceScapeBodyTrackingTest.sln'
& $msbuild $solution -restore -p:RestorePackagesConfig=true -p:Configuration=Release -p:Platform=x64 -p:PreferredToolArchitecture=x64 -p:GlfwPlatformToolset=v142
if ($LASTEXITCODE -ne 0) {
    throw "MSBuild failed with exit code $LASTEXITCODE."
}

$wrapperFolder = Join-Path $PSScriptRoot ('build\wrapper-' + [guid]::NewGuid().ToString('N'))
try {
    Expand-Archive -LiteralPath $wrapperZip -DestinationPath $wrapperFolder
    $wrapperBin = Join-Path $wrapperFolder 'bin'
    $output = Join-Path $PSScriptRoot 'build\bin\Release'
    $runtimeFiles = 'k4a.dll', 'k4arecord.dll', 'depthengine_2_0.dll', 'OrbbecSDK.dll', 'OrbbecSDKConfig.xml', 'extensions'
    foreach ($file in $runtimeFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $wrapperBin $file))) {
            throw "The Windows Orbbec K4A Wrapper ZIP is missing bin/$file."
        }
    }
    foreach ($file in $runtimeFiles) {
        Copy-Item -LiteralPath (Join-Path $wrapperBin $file) -Destination $output -Recurse -Force
    }
    Get-Item -LiteralPath (Join-Path $output 'PaceScapeBodyTrackingTest.exe')
}
finally {
    if (Test-Path -LiteralPath $wrapperFolder) {
        $resolvedWrapper = (Resolve-Path -LiteralPath $wrapperFolder).Path
        $buildFolder = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'build')).Path
        if ((Split-Path -Parent $resolvedWrapper) -eq $buildFolder) {
            Remove-Item -LiteralPath $resolvedWrapper -Recurse -Force
        }
    }
}
