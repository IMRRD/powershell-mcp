/** Fixed source: no caller values or plaintext passwords are interpolated into this script. */
export const LOAD_PROTECTED_WINRM_CREDENTIAL = `
$credential = $null; $loadedCredentials = [Collections.Generic.List[object]]::new(); $protectedReady = $false
if ($null -ne $payload.protectedCredential) {
  $config = $payload.protectedCredential
  if ($null -ne $payload.password -or $config.transport -cne 'winrm' -or
      $config.host -cne $payload.computerName -or $config.principal -cne $payload.username -or
      [int]$config.port -ne $(if ($payload.useSsl) { 5986 } else { 5985 }) -or
      [string]$config.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      [string]$config.loaderPath -cnotmatch '^[A-Za-z]:[\\\\/]' -or
      ([string]$config.loaderPath).Substring(2) -match '[\\x00-\\x1f:]') { throw 'Protected credential unavailable' }
  $stream = $null; $hash = $null
  try {
    $stream = [IO.File]::Open([string]$config.loaderPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    if ($stream.Length -gt 65536) { throw 'Protected credential unavailable' }
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -le 0) { throw 'Protected credential unavailable' }
      $offset += $count
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    $digest = [BitConverter]::ToString($hash.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant()
    if ($digest -cne [string]$config.sha256) { throw 'Protected credential unavailable' }
    # Execute the exact verified bytes, avoiding a pathname re-open race. Relative
    # loader resources can use PSScriptRoot / PSCommandPath. No loader arguments.
    $source = [Text.UTF8Encoding]::new($false, $true).GetString($bytes).TrimStart([char]0xfeff)
    $savedOut = [Console]::Out; $savedErr = [Console]::Error
    try {
      [Console]::SetOut([IO.TextWriter]::Null); [Console]::SetError([IO.TextWriter]::Null)
      & {
        param($loaderSource, $loaderPath)
        $ErrorActionPreference = 'Stop'
        $PSScriptRoot = [IO.Path]::GetDirectoryName($loaderPath); $PSCommandPath = $loaderPath
        & ([ScriptBlock]::Create($loaderSource))
      } $source ([string]$config.loaderPath) 2>$null 3>$null 4>$null 5>$null 6>$null | ForEach-Object { $loadedCredentials.Add($_) }
    } finally { [Console]::SetOut($savedOut); [Console]::SetError($savedErr) }
    if ($loadedCredentials.Count -ne 1 -or $loadedCredentials[0] -isnot [pscredential]) { throw 'Protected credential unavailable' }
    $credential = $loadedCredentials[0]
    # Invoke the CLR getter explicitly: PS property access can silently turn an
    # ObjectDisposedException into null and otherwise admit a disposed secret.
    if ($credential.UserName -cne [string]$config.principal -or $credential.get_Password().get_Length() -eq 0) { throw 'Protected credential unavailable' }
    $invoke.Credential = $credential
    $protectedReady = $true
  } finally {
    if ($null -ne $hash) { $hash.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
    $source = $null; $bytes = $null
  }
}
`;

export const CLEANUP_PROTECTED_WINRM_CREDENTIAL = `
if ($null -ne $payload.protectedCredential) {
  try {
    if ($protectedReady) {
      # Plaintext exists transiently only in this PowerShell process for redaction;
      # the PSCredential itself is bound natively and never serialized.
      $secret = $credential.GetNetworkCredential().Password
      $variants = @($secret, [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($secret)), [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($secret)))
      $pattern = ($variants | Select-Object -Unique | Sort-Object { $_.Length } -Descending | ForEach-Object { [regex]::Escape($_) }) -join '|'
      function Protect-CredentialText($text) { [regex]::Replace([string]$text, $pattern, '[REDACTED]') }
      function Protect-CredentialCapture($capture) {
        $text = Protect-CredentialText $capture.output
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $data = $utf8.GetBytes($text)
        $keep = [Math]::Min($data.Length, $payloadLimit)
        $start = if ($payloadTail) { $data.Length - $keep } else { 0 }
        # Re-cap the redacted representation at a valid UTF-8 boundary. Preserve
        # original omitted bytes, adding any bytes omitted by expanded redaction.
        while ($true) {
          try { $text = $utf8.GetString($data, $start, $keep); break }
          catch { if ($keep -eq 0) { throw }; $keep--; if ($payloadTail) { $start++ } }
        }
        $capture.output = $text
        $capture.observedBytes = [long]$capture.omittedBytes + $data.Length
        $capture.capturedBytes = $keep
        $capture.omittedBytes = $capture.observedBytes - $keep
        $capture.truncated = $capture.omittedBytes -gt 0
      }
      if ($body.status -eq 'transport_error') { $body.output = Protect-CredentialText $body.output }
      else { Protect-CredentialCapture $body }
      if ($null -ne $body.stderr) { Protect-CredentialCapture $body.stderr }
      foreach ($record in $body.records) {
        foreach ($key in @('category','fullyQualifiedErrorId','exceptionType','message')) { $record.$key = Protect-CredentialText $record.$key }
      }
    } else { $body = @{ status = 'transport_error'; reason = 'invoke_exception'; output = 'Protected credential unavailable' } }
  } catch { $body = @{ status = 'transport_error'; reason = 'invoke_exception'; output = 'Protected credential result unavailable' } }
  finally {
    $secret = $null; $variants = $null; $pattern = $null
    foreach ($item in $loadedCredentials) {
      if ($item -is [pscredential]) {
        try { $item.Password.Dispose() }
        catch { $body = @{ status = 'transport_error'; reason = 'invoke_exception'; output = 'Protected credential cleanup failed' } }
      }
    }
    $invoke.Remove('Credential'); $credential = $null; $loadedCredentials = $null
  }
}
`;
