# Operator-only local storage protocol. Requests arrive on stdin; never emit errors or paths.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$store = $null
$lease = $null
$MinFreeBytes = 67108864L
$MaxBytes = 262144L
$TtlMs = 3600000L
$entropy = [Text.Encoding]::UTF8.GetBytes('powershell-mcp-restricted-diagnostics-v1')
function Reply($value) { [Console]::Out.Write(($value | ConvertTo-Json -Depth 12 -Compress)) }
function Exact($value, [string[]]$names) {
    return $null -ne $value -and $value -is [pscustomobject] -and
        (($value.PSObject.Properties.Name | Sort-Object) -join ',') -ceq (($names | Sort-Object) -join ',')
}
function Integer($value, [long]$min, [long]$max) {
    return ($value -is [int] -or $value -is [long]) -and $value -ge $min -and $value -le $max
}
function Valid-Pair($pair) {
    if ($pair -isnot [array] -or $pair.Count -ne 2) { return $false }
    foreach ($row in $pair) {
        if (-not (Exact $row @('schemaVersion','correlationId','stage','type','nativeCode','elapsedMs')) -or
            -not (Integer $row.schemaVersion 1 1) -or $row.correlationId -isnot [string] -or
            $row.correlationId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or
            -not (Integer $row.elapsedMs 0 300000) -or
            ($null -ne $row.nativeCode -and -not (Integer $row.nativeCode -2147483648 2147483647))) { return $false }
    }
    $tools = @('run_program','run_powershell','list_services','get_service','control_service','system_info','ssh_exec','winrm_exec','sftp_upload','sftp_download')
    $types = @('completed','nonzero_exit','script_error','remote_error','transport_error','timeout','cancelled','unknown','Error','TypeError','RangeError','SyntaxError','other_exception')
    $tool = $pair[0].stage -creplace '\.handler$', ''
    return $tools -ccontains $tool -and $pair[0].stage -ceq "$tool.handler" -and $pair[1].stage -ceq "$tool.result" -and
        $pair[0].correlationId -ceq $pair[1].correlationId -and $pair[0].type -ceq 'started' -and
        $null -eq $pair[0].nativeCode -and $pair[0].elapsedMs -eq 0 -and $types -ccontains $pair[1].type
}
function Protect($value) {
    $plain = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Compress -Depth 12))
    if ($plain.Length -gt 1024) { throw 'Invalid' }
    return ,([Security.Cryptography.ProtectedData]::Protect($plain, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser))
}
function Read-Private([string]$name) {
    # ProtectedCredentialStore pins every ancestor, refuses reparse points and verifies owner/private DACL on every read.
    $info = New-Object IO.FileInfo([IO.Path]::Combine($directory, $name))
    if ($info.Length -gt 2048) { throw 'Invalid' }
    $bytes = $store.Read($name)
    if ($bytes.Length -gt 2048) { throw 'Invalid' }
    $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($plain.Length -gt 1024) { throw 'Invalid' }
    return ([Text.Encoding]::UTF8.GetString($plain) | ConvertFrom-Json)
}
function Files {
    $result = New-Object 'System.Collections.Generic.List[string]'
    foreach ($path in [IO.Directory]::EnumerateFileSystemEntries($directory)) {
        if ($result.Count -ge 132) { throw 'Invalid' }
        $result.Add([IO.Path]::GetFileName($path))
    }
    return ,$result.ToArray()
}
try {
    [Console]::InputEncoding = New-Object Text.UTF8Encoding($false)
    [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
    $chars = New-Object char[] 4097
    $count = [Console]::In.ReadBlock($chars, 0, $chars.Length)
    $inputText = New-Object string($chars, 0, $count)
    if ($count -gt 4096 -or [Text.Encoding]::UTF8.GetByteCount($inputText) -gt 4096) { throw 'Invalid' }
    $r = $inputText | ConvertFrom-Json
    $fields = @('operation','directory','installation')
    switch -CaseSensitive ($r.operation) {
        'consent' { $fields += 'policy'; if ($r.policy -cne 'restricted-local-v1') { throw 'Invalid' } }
        'append' { $fields += 'pair'; if (-not (Valid-Pair $r.pair)) { throw 'Invalid' } }
        'read' { $fields += 'limit'; if (-not (Integer $r.limit 1 16)) { throw 'Invalid' }; if ($r.PSObject.Properties.Name -ccontains 'after') { $fields += 'after'; if ($r.after -isnot [string] -or $r.after -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') { throw 'Invalid' } } }
        'disable' { }
        'revoke' { }
        default { throw 'Invalid' }
    }
    if (-not (Exact $r $fields) -or $r.installation -isnot [string] -or $r.installation -cnotmatch '^[a-z][a-z0-9-]{0,63}$' -or
        $r.directory -isnot [string] -or $r.directory -notmatch '^[A-Za-z]:[\\/]' -or $r.directory.Substring(3).Contains(':')) { throw 'Invalid' }
    $directory = [IO.Path]::GetFullPath($r.directory)
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($directory))
    if ($drive.DriveType -ne [IO.DriveType]::Fixed) { throw 'Invalid' }
    Add-Type -Path (Join-Path $PSScriptRoot 'ProtectedCredentialStore.cs')
    Add-Type -AssemblyName System.Security
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    if ($r.operation -ceq 'consent') {
        # Consent never adopts/changes existing storage, including aggregate/credential/output stores.
        if ([IO.Directory]::Exists($directory) -or [IO.File]::Exists($directory)) { throw 'Denied' }
        if ($drive.AvailableFreeSpace -lt $MinFreeBytes) { Reply @{status='limited'}; exit 0 }
        $store = New-Object ProtectedCredentialStore($directory, $true)
        $store.Publish('access.lock', [byte[]]@())
        $consent = @{schemaVersion=1; policy='restricted-local-v1'; installation=$r.installation; issuedAt=$now; expiresAt=($now + $TtlMs)}
        $store.Publish('consent.dpapi', (Protect $consent))
        Reply @{status='ok'}; exit 0
    }
    if (-not [IO.Directory]::Exists($directory)) { Reply @{status='inactive'}; exit 0 }
    $store = New-Object ProtectedCredentialStore($directory, $false)
    [void]$store.Read('access.lock')
    # Cross-process, fail-fast, exclusive admission. No waiting/stealing a stale PID lock.
    $lease = [IO.File]::Open([IO.Path]::Combine($directory,'access.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $consent = Read-Private 'consent.dpapi'
    if (-not (Exact $consent @('schemaVersion','policy','installation','issuedAt','expiresAt')) -or
        $consent.schemaVersion -ne 1 -or $consent.policy -cne 'restricted-local-v1' -or $consent.installation -cne $r.installation -or
        -not (Integer $consent.issuedAt 0 ([long]::MaxValue - $TtlMs)) -or $consent.expiresAt -ne ($consent.issuedAt + $TtlMs)) { throw 'Denied' }
    if ($r.operation -ceq 'disable' -or $r.operation -ceq 'revoke') {
        $marker = if ($r.operation -ceq 'revoke') { 'revoked.dpapi' } else { 'disabled.dpapi' }
        if (-not [IO.File]::Exists([IO.Path]::Combine($directory,$marker))) { $store.Publish($marker, (Protect @{schemaVersion=1})) }
        if ($r.operation -ceq 'revoke') {
            foreach ($name in (Files)) {
                if ($name -cmatch '^record-[0-9a-f-]{36}\.dpapi$' -or $name -cmatch '^[a-z0-9]{8}\.[a-z0-9]{3}$') {
                    # Validate the actual file ACL/type before deletion. Never recurse or follow an alias.
                    [void]$store.Read($name)
                    [IO.File]::Delete([IO.Path]::Combine($directory,$name))
                }
            }
        }
        Reply @{status='ok'}; exit 0
    }
    if ([IO.File]::Exists([IO.Path]::Combine($directory,'disabled.dpapi')) -or [IO.File]::Exists([IO.Path]::Combine($directory,'revoked.dpapi')) -or
        $now -lt $consent.issuedAt -or $now -ge $consent.expiresAt) { Reply @{status='inactive'}; exit 0 }
    $rows = New-Object 'System.Collections.Generic.List[object]'
    $bytes = 0L
    foreach ($name in (Files)) {
        if ($name -ceq 'access.lock' -or $name -ceq 'consent.dpapi') { $bytes += (New-Object IO.FileInfo([IO.Path]::Combine($directory,$name))).Length; continue }
        # Interrupted publications/unknown entries remain reserved and block admission/retrieval.
        if ($name -cnotmatch '^record-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.dpapi$') { throw 'Denied' }
        $value = Read-Private $name
        if (-not (Exact $value @('storedAt','pair')) -or -not (Integer $value.storedAt 0 $now) -or
            -not (Valid-Pair $value.pair) -or $name -cne ('record-' + $value.pair[0].correlationId + '.dpapi')) { throw 'Denied' }
        if ($now - $value.storedAt -ge $TtlMs) { [IO.File]::Delete([IO.Path]::Combine($directory,$name)); continue }
        $bytes += (New-Object IO.FileInfo([IO.Path]::Combine($directory,$name))).Length
        $rows.Add($value)
    }
    if ($r.operation -ceq 'append') {
        $recent = @($rows | Where-Object { $now - $_.storedAt -lt 60000 }).Count
        $blob = Protect @{storedAt=$now; pair=$r.pair}
        # Reserve two maximum-sized tombstones so disable/revoke cannot exceed the byte budget.
        if ($blob.Length -gt 2048 -or $rows.Count -ge 128 -or $bytes + $blob.Length + 4096 -gt $MaxBytes -or
            $recent -ge 6 -or $drive.AvailableFreeSpace -lt $MinFreeBytes) { Reply @{status='limited'}; exit 0 }
        $store.Publish(('record-' + $r.pair[0].correlationId + '.dpapi'), $blob)
        Reply @{status='ok'}; exit 0
    }
    $ordered = @($rows | Sort-Object { $_.pair[0].correlationId } | Where-Object { -not $r.after -or [string]::CompareOrdinal($_.pair[0].correlationId,$r.after) -gt 0 })
    $selected = @($ordered | Select-Object -First $r.limit)
    $pairs = @($selected | ForEach-Object { ,$_.pair })
    $next = $null
    if ($ordered.Count -gt $selected.Count) { $next = $selected[-1].pair[0].correlationId }
    Reply @{status='ok'; pairs=$pairs; nextAfter=$next}
} catch {
    Reply @{status='denied'}
} finally {
    if ($null -ne $lease) { $lease.Dispose() }
    if ($null -ne $store) { $store.Dispose() }
}
