# Pasa los contadores de ventas de los sets (públicos) a salesStats/{eid}_{uid} (privado) y los saca del set.
# Correr una vez después de desplegar el Worker que escribe en salesStats. Uso: python3 tools/migrate-sales.py [--dry]
import json, subprocess, sys, urllib.request

P = 'quieromisfotos-71629'
B = f'https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents'
TOKEN = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
dry = '--dry' in sys.argv


def req(method, url, body=None):
    r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(r).read() or b'{}')


sets = [r['document'] for r in req('POST', f'{B}:runQuery', {'structuredQuery': {'from': [{'collectionId': 'sets', 'allDescendants': True}]}}) if 'document' in r]
for s in sets:
    f = s['fields']
    if 'soldPhotos' not in f and 'soldOrders' not in f: continue
    path = s['name'].split('/documents/')[1]
    eid, uid = path.split('/')[1], path.split('/')[3]
    sp, so = int(f.get('soldPhotos', {}).get('integerValue', 0)), int(f.get('soldOrders', {}).get('integerValue', 0))
    print(path, '->', f'salesStats/{eid}_{uid}', sp, 'fotos', so, 'pedidos', '(simulación)' if dry else '')
    if dry: continue
    req('POST', f'{B}:commit', {'writes': [
        {'update': {'name': f'projects/{P}/databases/(default)/documents/salesStats/{eid}_{uid}',
                    'fields': {'eventId': {'stringValue': eid}, 'photographerUid': {'stringValue': uid}}},
         'updateMask': {'fieldPaths': ['eventId', 'photographerUid']}},
        {'transform': {'document': f'projects/{P}/databases/(default)/documents/salesStats/{eid}_{uid}',
                       'fieldTransforms': [{'fieldPath': 'soldPhotos', 'increment': {'integerValue': str(sp)}},
                                           {'fieldPath': 'soldOrders', 'increment': {'integerValue': str(so)}}]}},
        {'update': {'name': s['name'], 'fields': {}}, 'updateMask': {'fieldPaths': ['soldPhotos', 'soldOrders']}, 'currentDocument': {'exists': True}},
    ]})
