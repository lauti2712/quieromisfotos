# Carga sets.hourCounts (fotos por hora, lo usa el filtro horario de la galería) en los álbumes que todavía no lo tienen.
# Lo lleva el Worker al subir y borrar; esto es solo para álbumes anteriores. Uso: python3 tools/backfill-hours.py [--dry]
import json, subprocess, sys, urllib.request, datetime

P = 'quieromisfotos-71629'
B = f'https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents'
TOKEN = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
dry = '--dry' in sys.argv


def req(method, url, body=None):
    r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r).read() or b'{}')


def query(coll, filters, all_desc=False):
    ff = [{'fieldFilter': {'field': {'fieldPath': f}, 'op': 'EQUAL', 'value': v}} for f, v in filters]
    sq = {'from': [{'collectionId': coll, 'allDescendants': all_desc}]}
    if ff: sq['where'] = ff[0] if len(ff) == 1 else {'compositeFilter': {'op': 'AND', 'filters': ff}}
    return [r['document'] for r in req('POST', f'{B}:runQuery', {'structuredQuery': sq}) if 'document' in r]


for s in query('sets', [], all_desc=True):
    f = s['fields']
    n = int(f.get('photoCount', {}).get('integerValue', 0))
    if n == 0 or 'hourCounts' in f: continue
    path = s['name'].split('/documents/')[1]
    eid, uid = path.split('/')[1], path.split('/')[3]
    counts = {}
    for p in query('photos', [('eventId', {'stringValue': eid}), ('photographerUid', {'stringValue': uid})]):
        ts = p['fields'].get('takenAt', {}).get('timestampValue')
        if not ts: continue
        ms = int(datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).timestamp() * 1000)
        h = str(ms // 3600000 * 3600000)
        counts[h] = counts.get(h, 0) + 1
    print(path, n, 'fotos ->', len(counts), 'horas', '' if not dry else '(simulación)')
    if not dry:
        req('PATCH', f'{B}/{path}?updateMask.fieldPaths=hourCounts&currentDocument.exists=true',
            {'fields': {'hourCounts': {'mapValue': {'fields': {h: {'integerValue': str(c)} for h, c in counts.items()}}}}})
