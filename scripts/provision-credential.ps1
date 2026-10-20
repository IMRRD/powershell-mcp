param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Reference)
$ErrorActionPreference = 'Stop'
if ($Reference -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$') { throw 'Invalid reference' }
# Operator-only provisioning: JSON record arrives via stdin, never a command-line argument.
$record = [Console]::In.ReadToEnd() | ConvertFrom-Json
$names = @($record.PSObject.Properties.Name)
if (@($names | Where-Object { $_ -cnotin @('transport','host','port','principal','password','passphrase','privateKey') }).Count -gt 0 -or
  $record.transport -cnotin @('ssh','sftp','winrm') -or [string]::IsNullOrEmpty($record.host) -or
  [string]::IsNullOrEmpty($record.principal) -or $record.port -isnot [long] -and $record.port -isnot [int] -or
  (([bool]$record.password) -eq ([bool]$record.privateKey)) -or
  ($record.transport -eq 'winrm' -and ($record.privateKey -or $record.passphrase))) { throw 'Invalid credential record' }
Add-Type -Path ([IO.Path]::Combine($PSScriptRoot, 'ProtectedCredentialStore.cs'))
# Ancestry and root remain open without DELETE sharing through publication.
$store = New-Object ProtectedCredentialStore($Directory, $true)
try {
$sha = [Security.Cryptography.SHA256]::Create()
$name = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Reference)))).Replace('-','').ToLowerInvariant() + '.dpapi'
$target = [IO.Path]::Combine($Directory, $name)
if ([IO.File]::Exists($target)) { throw 'Reference already exists; rotate offline by removing the old entry first' }
Add-Type -AssemblyName System.Security
$plain = [Text.Encoding]::UTF8.GetBytes(($record | ConvertTo-Json -Compress -Depth 4))
$blob = [Security.Cryptography.ProtectedData]::Protect($plain, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
$store.Publish($name, $blob)
[Console]::Out.WriteLine('Credential provisioned')
} finally { $store.Dispose() }
