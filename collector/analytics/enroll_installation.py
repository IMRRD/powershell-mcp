#!/usr/bin/env python
"""Local server-side enrollment. No network endpoint and no identifier output."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from import_jsonl import classes


def protected_directory(path, *, directory=True):
    if Path(path).is_symlink():
        raise ValueError('protected path required')
    path = Path(path).resolve(strict=True)
    if (directory and not path.is_dir()) or (not directory and not path.is_file()) or path.is_symlink():
        raise ValueError('protected directory required')
    if os.name == 'nt':
        escaped = str(path).replace("'", "''")
        script = "$ErrorActionPreference='Stop'; Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1'); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $a=Get-Acl -LiteralPath '" + escaped + "'; if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid -or -not $a.AreAccessRulesProtected){exit 2}; foreach($r in $a.Access){$s=$r.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or ($s -ne $sid -and $s -ne 'S-1-5-18')){exit 2}}"
        if not directory:
            script = script.replace(' -or -not $a.AreAccessRulesProtected', '').replace('$r.IsInherited -or ', '')
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, creationflags=0x08000000)
    elif path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o077:
        raise ValueError('protected directory required')
    return path


def enroll(registry, installation_file, cohort):
    registry = Path(registry).absolute()
    protected_directory(registry.parent)
    if cohort not in ('internal', 'test') or registry.is_symlink():
        raise ValueError('invalid enrollment')
    identity = Path(installation_file)
    if identity.is_symlink() or identity.stat().st_size > 128:
        raise ValueError('invalid installation file')
    host = identity.read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', host):
        raise ValueError('invalid installation identity')
    lock = registry.with_suffix(registry.suffix + '.lock')
    fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    temp = registry.with_suffix(registry.suffix + '.new')
    try:
        if registry.exists():
            protected_directory(registry, directory=False)
            internal, test, entries = classes(registry)
            data = json.loads(registry.read_text())
        else:
            internal, test, entries = set(), set(), {}
            data = dict(internalHostIds=[], testHostIds=[])
        if host in internal or host in test or host in entries or len(internal) + len(test) + len(entries) >= 10000:
            raise ValueError('already enrolled, conflicting or full registry')
        data.setdefault('enrollments', []).append(dict(hostId=host, cohort=cohort, fromReceiptUtc=datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')))
        encoded = json.dumps(data) + '\n'
        if len(encoded.encode('utf-8')) > 1024 * 1024:
            raise ValueError('registry capacity reached')
        with temp.open('x', encoding='utf-8') as out:
            if os.name != 'nt': os.chmod(temp, 0o600)
            out.write(encoded)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temp, registry)
        if os.name != 'nt':
            parent = os.open(registry.parent, os.O_RDONLY)
            try: os.fsync(parent)
            finally: os.close(parent)
    finally:
        os.close(fd)
        lock.unlink()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--registry', required=True)
    parser.add_argument('--installation-file', required=True)
    parser.add_argument('--cohort', choices=['internal', 'test'], required=True)
    args = parser.parse_args()
    try:
        enroll(args.registry, args.installation_file, args.cohort)
        print('Enrollment recorded for future receipts; history unchanged.')
    except Exception:
        print('Enrollment failed: protected inputs, registry capacity or conflict; no identifiers emitted.', file=sys.stderr)
        sys.exit(1)
