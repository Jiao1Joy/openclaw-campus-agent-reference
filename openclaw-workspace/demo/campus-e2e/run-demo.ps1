[CmdletBinding()]
param(
    [switch]$KeepRuntime
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$runner = Join-Path $scriptRoot "demo.py"
$python = Get-Command python -ErrorAction Stop
$arguments = @($runner)

if ($KeepRuntime) {
    $arguments += "--keep-runtime"
}

& $python.Source @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Campus end-to-end demo failed with exit code $LASTEXITCODE"
}
