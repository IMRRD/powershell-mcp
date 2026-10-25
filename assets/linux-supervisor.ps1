param([string]$AssemblyPath = (Join-Path $PSScriptRoot 'linux-supervisor.dll'))
$ErrorActionPreference = 'Stop'
# Built against locked .NET Core 3.1 references; never compile on the consumer.
Add-Type -Path $AssemblyPath
$request = [Console]::ReadLine() | ConvertFrom-Json
if ([string]$request.nonce -cnotmatch '^[a-f0-9]{48}$') { throw 'Invalid request' }
[LinuxJob]::Run([string]$request.program, [string[]]@($request.args), [string]$request.cwd, [string]$request.input, [string]$request.nonce)
