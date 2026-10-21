param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Name)
$ErrorActionPreference = 'Stop'
try {
  if ($Name -cnotmatch '^[0-9a-f]{64}\.dpapi$') { throw 'Invalid entry' }
  Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'ProtectedCredentialStore.cs'))
  $store = New-Object ProtectedCredentialStore($Directory, $false)
  try { $blob = $store.Read($Name) } finally { $store.Dispose() }
  Add-Type -AssemblyName System.Security
  $plain = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($plain))
} catch { exit 1 }
