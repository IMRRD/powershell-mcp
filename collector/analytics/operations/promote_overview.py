"""Guarded overview promotion contract for an approved org-1 Grafana adapter.

The caller must supply an authenticated org-1-only adapter and durably persist the
returned receipt before claiming activation. This module never changes an org itself.
"""
import copy
import hashlib
import json

LIVE_UID = 'powershell-mcp-usage'
PREVIEW_UID = 'powershell-mcp-overview-preview'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode('utf-8')).hexdigest()


def _panels(panels):
    seen = set()
    for p in panels:
        ident = p['id']
        if ident in seen:
            raise ValueError('duplicate panel')
        seen.add(ident)
        grid = p['gridPos']
        if not (0 <= grid['x'] < 24 and 0 < grid['w'] <= 24 - grid['x']
                and grid['y'] >= 0 and grid['h'] > 0):
            raise ValueError('invalid grid')
        _panels(p.get('panels', []))


def apply(adapter, preview, baseline_digest, baseline_version, *, receipt=None):
    if preview.get('uid') != PREVIEW_UID or len(preview['uid']) > 40:
        raise ValueError('wrong preview UID')
    _panels(preview['panels'])
    current = adapter.read(LIVE_UID)
    if current.get('uid') != LIVE_UID:
        raise ValueError('wrong live UID')
    if receipt is not None:
        if (receipt['baseline_digest'] != baseline_digest or
                receipt['preview_digest'] != digest(preview) or
                receipt['candidate_digest'] != digest(current)):
            raise ValueError('repeat apply drift')
        return receipt
    if current['version'] != baseline_version or digest(current) != baseline_digest:
        raise ValueError('baseline drift')
    candidate = copy.deepcopy(preview)
    candidate['uid'] = LIVE_UID
    candidate['version'] = baseline_version
    # Grafana assigns the existing dashboard's id and increments its version.
    if 'id' in current:
        candidate['id'] = current['id']
    adapter.write(candidate, baseline_version)
    actual = adapter.read(LIVE_UID)
    expected = copy.deepcopy(candidate)
    expected['version'] += 1
    if actual != expected:
        raise RuntimeError('promotion outcome unknown: reconcile before retry')
    return {'before': current, 'baseline_digest': baseline_digest,
            'preview_digest': digest(preview), 'candidate_digest': digest(actual)}


def rollback(adapter, receipt):
    current = adapter.read(LIVE_UID)
    if digest(current) != receipt['candidate_digest']:
        raise ValueError('rollback drift')
    prior = copy.deepcopy(receipt['before'])
    prior['version'] = current['version']
    adapter.write(prior, current['version'])
    actual = adapter.read(LIVE_UID)
    prior['version'] += 1
    if actual != prior:
        raise RuntimeError('rollback outcome unknown: reconcile manually')
    return actual
