# Migración 2026-10-14: "Deporte" pasa a llamarse "Actividad" y se elimina el tipo "Categoría".
# Uso: python3 tools/migrate-actividad.py [--dry]
import json, subprocess, sys, urllib.request, urllib.error

P = 'quieromisfotos-71629'
BASE = f'https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents'
TOKEN = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
DRY = '--dry' in sys.argv


def req(method, url, body=None):
    r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json', 'x-goog-user-project': P})
    try:
        raw = urllib.request.urlopen(r).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 404: return None
        print(e.read().decode()); raise


def docs(col):
    return (req('GET', f'{BASE}/{col}?pageSize=500') or {}).get('documents', [])


def val(f): return list(f.values())[0] if f else None


cat_tags = {d['name'].split('/')[-1] for d in docs('tags') if val(d['fields'].get('typeId')) == 'categoria'}
used = [d['name'].split('/')[-1] for d in docs('events')
        if any(val(x) in cat_tags for x in d['fields'].get('tagIds', {}).get('arrayValue', {}).get('values', []))]
print('etiquetas de categoría:', sorted(cat_tags), '| eventos que las usan:', used)
if used:
    sys.exit('Hay eventos con categoría: revisar a mano antes de borrar.')
if DRY:
    sys.exit('dry-run: sin cambios')

req('PATCH', f'{BASE}/tagTypes/deporte?updateMask.fieldPaths=name&updateMask.fieldPaths=order', {'fields': {'name': {'stringValue': 'Actividad'}, 'order': {'integerValue': '0'}}})
req('PATCH', f'{BASE}/tagTypes/club?updateMask.fieldPaths=order', {'fields': {'order': {'integerValue': '1'}}})
req('PATCH', f'{BASE}/tagTypes/lugar?updateMask.fieldPaths=order', {'fields': {'order': {'integerValue': '2'}}})
for t in cat_tags: req('DELETE', f'{BASE}/tags/{t}')
req('DELETE', f'{BASE}/tagTypes/categoria')

# Rehacer el snapshot settings/tags
types = [{'mapValue': {'fields': {'id': {'stringValue': d['name'].split('/')[-1]}, 'name': d['fields']['name'], 'order': d['fields'].get('order', {'integerValue': '0'})}}} for d in docs('tagTypes')]
tags = [{'mapValue': {'fields': {'id': {'stringValue': d['name'].split('/')[-1]}, 'typeId': d['fields']['typeId'], 'name': d['fields']['name'],
                                 'slug': d['fields'].get('slug', d['fields']['name'])}}} for d in docs('tags')]
req('PATCH', f'{BASE}/settings/tags', {'fields': {'types': {'arrayValue': {'values': types}}, 'tags': {'arrayValue': {'values': tags}}}})
print('ok:', len(types), 'tipos,', len(tags), 'etiquetas')
