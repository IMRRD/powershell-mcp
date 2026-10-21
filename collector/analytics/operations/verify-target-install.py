#!/usr/bin/env python3
"""Read-only attestation of both protected target installations."""
import argparse
from ssh_command_transport import execute


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--pg-host', required=True)
    parser.add_argument('--grafana-host', required=True)
    parser.add_argument('--identity-file', required=True)
    args = parser.parse_args()
    for label, host in (('pg', args.pg_host), ('grafana', args.grafana_host)):
        if execute(host, args.identity_file, {'operation': 'attest'}) != {'verified': True}:
            raise RuntimeError('target attestation invalid')
        print(label + ': reviewed installation verified')


if __name__ == '__main__':
    main()
