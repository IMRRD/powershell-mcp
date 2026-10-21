#!/usr/bin/env python3
"""Ephemeral SSH-stdio helper; no listener, forwarding, or arbitrary SQL/URL."""
import json
import os
import sys
import urllib.request

MAX_REQUEST = 65536
MAX_RESPONSE = 65536


def handle(request):
    operation = request.get('operation')
    if operation == 'grafana':
        if set(request) != {'operation', 'method', 'path'} or request['method'] != 'GET' or request['path'] != '/api/health':
            raise ValueError('operation not allowed')
        with urllib.request.urlopen('http://127.0.0.1:13000/api/health', timeout=5) as response:
            body = response.read(MAX_RESPONSE + 1)
            if len(body) > MAX_RESPONSE:
                raise ValueError('response too large')
            return {'health': json.loads(body)}
    if operation == 'pg':
        if set(request) != {'operation', 'query'} or request['query'] != 'private_database_exists':
            raise ValueError('operation not allowed')
        # Local libpq authority only; never accept connection parameters over the wire.
        import psycopg
        with psycopg.connect(os.environ.get('ANALYTICS_LOCAL_PG_DSN', ''), connect_timeout=5,
                             options='-c default_transaction_read_only=on -c statement_timeout=5000') as conn:
            with conn.cursor() as cursor:
                cursor.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname=%s)', ('hermes_mcp_analytics_private',))
                return {'database': cursor.fetchone()[0]}
    raise ValueError('operation not allowed')


def main():
    raw = sys.stdin.buffer.read(MAX_REQUEST + 1)
    if len(raw) > MAX_REQUEST:
        raise ValueError('request too large')
    request = json.loads(raw)
    result = handle(request)
    print(json.dumps({'ok': True, 'result': result}, separators=(',', ':')))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never echo exception strings: urllib and libpq may include credential material.
        print(json.dumps({'ok': False, 'error': 'remote operation failed'}))
        sys.exit(1)
