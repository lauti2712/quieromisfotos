# Carga (o borra) el fotógrafo y el evento de ejemplo en Firestore.
#   python3 tools/seed-demo.py emu      -> emulador local (imágenes desde http://localhost:5175/demo)
#   python3 tools/seed-demo.py prod     -> producción (usa `gcloud auth print-access-token`)
#   python3 tools/seed-demo.py prod --delete
# Todos los documentos llevan demo: true.
import json, subprocess, sys, urllib.request, urllib.error, datetime, re

P = 'quieromisfotos-71629'
target = sys.argv[1] if len(sys.argv) > 1 else 'emu'
delete = '--delete' in sys.argv
if target == 'prod':
    BASE = f'https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents'
    TOKEN = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
    IMG = 'https://solucionescotidianas.com.ar/quieromisfotos/demo'
else:
    BASE = f'http://127.0.0.1:8085/v1/projects/{P}/databases/(default)/documents'
    TOKEN = 'owner'
    IMG = 'http://localhost:5175/demo'

UID = 'demo-fotografo'
SLUG = 'fotografo-ejemplo'
EID = 'demo-evento'
NOW = datetime.datetime.now(datetime.timezone.utc)


class TS(datetime.datetime):
    pass


def val(v):
    if isinstance(v, datetime.datetime):
        return {'timestampValue': v.astimezone(datetime.timezone.utc).isoformat().replace('+00:00', 'Z')}
    if isinstance(v, bool): return {'booleanValue': v}
    if isinstance(v, int): return {'integerValue': str(v)}
    if isinstance(v, float): return {'doubleValue': v}
    if v is None: return {'nullValue': None}
    if isinstance(v, str): return {'stringValue': v}
    if isinstance(v, list): return {'arrayValue': {'values': [val(x) for x in v]}}
    if isinstance(v, dict): return {'mapValue': {'fields': {k: val(x) for k, x in v.items()}}}
    raise TypeError(v)


def req(method, url, body=None):
    r = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={'Authorization': f'Bearer {TOKEN}', 'Content-Type': 'application/json', 'x-goog-user-project': P})
    try:
        raw = urllib.request.urlopen(r).read()
        return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        if e.code == 404 and method in ('GET', 'DELETE'): return None
        print(e.read().decode()); raise


def put(path, data): req('PATCH', f'{BASE}/{path}', {'fields': {k: val(v) for k, v in data.items()}})
def get(path): return req('GET', f'{BASE}/{path}')
def rm(path): req('DELETE', f'{BASE}/{path}')


def tokens(*texts):
    out = set()
    import unicodedata
    t = unicodedata.normalize('NFD', ' '.join(texts)).encode('ascii', 'ignore').decode().lower()
    for w in re.split(r'[^a-z0-9]+', t):
        if len(w) < 2: continue
        out.add(w)
        for i in range(3, len(w)): out.add(w[:i])
    return sorted(out)


def plain(fields):
    out = {}
    for k, v in (fields or {}).items():
        if 'stringValue' in v: out[k] = v['stringValue']
        elif 'integerValue' in v: out[k] = int(v['integerValue'])
        elif 'arrayValue' in v: out[k] = [plain({'x': x})['x'] for x in v['arrayValue'].get('values', [])]
        elif 'mapValue' in v: out[k] = plain(v['mapValue'].get('fields'))
        elif 'booleanValue' in v: out[k] = v['booleanValue']
    return out


# ---------------------------------------------------------------- borrar
if delete:
    for i in range(12): rm(f'photos/demo-{i:02d}')
    for i in range(6): rm(f'portfolio/{UID}_{i}')
    rm(f'events/{EID}/sets/{UID}'); rm(f'events/{EID}'); rm(f'slugs/{SLUG}'); rm(f'users/{UID}')
    print('Ejemplo borrado.')
    sys.exit()

# ---------------------------------------------------------------- etiquetas (deportes reales, útiles)
types = [plain(d['fields']) | {'id': d['name'].split('/')[-1]} for d in (req('GET', f'{BASE}/tagTypes') or {}).get('documents', [])]
deporte = next((t['id'] for t in types if t['name'].lower() == 'deporte'), None)
existing = [plain(d['fields']) | {'id': d['name'].split('/')[-1]} for d in (req('GET', f'{BASE}/tags?pageSize=500') or {}).get('documents', [])]
futbol = None
if deporte:
    for name in ['Fútbol', 'Hockey', 'Básquet', 'Rugby', 'Vóley']:
        t = next((x for x in existing if x['typeId'] == deporte and x['name'].lower() == name.lower()), None)
        if not t:
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower().replace('ú', 'u').replace('á', 'a').replace('ó', 'o'))
            t = {'id': slug, 'typeId': deporte, 'name': name, 'slug': slug}
            put(f'tags/{slug}', {k: t[k] for k in ('typeId', 'name', 'slug')})
            existing.append(t)
        if name == 'Fútbol': futbol = t['id']
    put('settings/tags', {
        'types': [{'id': t['id'], 'name': t['name'], 'order': t.get('order', 0)} for t in types],
        'tags': [{'id': t['id'], 'typeId': t['typeId'], 'name': t['name'], 'slug': t['slug']} for t in existing],
        'updatedAt': NOW,
    })

# settings/platform: completar campos nuevos sin pisar los existentes
plat = plain((get('settings/platform') or {}).get('fields'))
put('settings/platform', {'feePercent': plat.get('feePercent', 3), 'retentionDays': plat.get('retentionDays', 14),
                          'extensionPlans': plat.get('extensionPlans', []), 'proPrice': plat.get('proPrice', 3000),
                          'freePortfolioLimit': plat.get('freePortfolioLimit', 12), 'proPortfolioLimit': plat.get('proPortfolioLimit', 200)})

# ---------------------------------------------------------------- fotógrafo
put(f'slugs/{SLUG}', {'uid': UID})
put(f'users/{UID}', {
    'role': 'photographer', 'status': 'approved', 'demo': True,
    'displayName': 'Fotógrafo de Ejemplo', 'slug': SLUG, 'avatarUrl': f'{IMG}/avatar.jpg',
    'bio': 'Este es un perfil de ejemplo para mostrar cómo funciona Quiero Mis Fotos: portfolio, contacto para presupuestos y eventos con fotos a la venta.',
    'zone': 'Rosario, Santa Fe', 'workZones': 'Rosario y alrededores',
    'socials': {}, 'specialties': [futbol] if futbol else [], 'services': ['Deportes', 'Eventos sociales'],
    'plan': 'pro', 'proUntil': datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc),
    'mpConnected': False, 'mpUserId': None,
    'defaults': {'price': 2500, 'packs': [{'qty': 3, 'price': 6000}, {'qty': 5, 'price': 9000}], 'feeMode': 'buyer'},
    'watermark': {'type': 'text', 'text': 'Fotógrafo de Ejemplo', 'position': 'both', 'opacity': 0.35},
    'createdAt': NOW,
})
for i in range(6):
    put(f'portfolio/{UID}_{i}', {'photographerUid': UID, 'slot': i, 'url': f'{IMG}/pf-{i}_p.jpg', 'thumbUrl': f'{IMG}/pf-{i}_t.jpg',
                                 'width': 1600, 'height': 1067, 'caption': ['Final de torneo', 'Festejo', 'Entrada en calor', 'Jugada', 'Equipo', 'Atardecer en la cancha'][i],
                                 'order': i, 'demo': True, 'createdAt': NOW})

# ---------------------------------------------------------------- evento + set + fotos
name, loc = 'Torneo de Ejemplo — Fecha 1', 'Rosario, Santa Fe'
put(f'events/{EID}', {
    'name': name, 'date': '2026-10-11', 'location': loc, 'tagIds': [futbol] if futbol else [],
    'coverUrl': f'{IMG}/cover.jpg', 'status': 'published', 'kind': 'own', 'createdBy': UID,
    'photographerUids': [UID], 'openToJoin': False, 'demo': True,
    'searchTokens': tokens(name, loc, 'Fútbol', 'ejemplo demo'), 'createdAt': NOW, 'updatedAt': NOW,
})
subs = [{'id': 'pt', 'name': 'Primer tiempo', 'order': 0}, {'id': 'st', 'name': 'Segundo tiempo', 'order': 1}]
put(f'events/{EID}/sets/{UID}', {
    'price': 2500, 'packs': [{'qty': 3, 'price': 6000}, {'qty': 5, 'price': 9000}], 'feeMode': 'buyer',
    'subalbums': subs, 'photoCount': 12, 'bytesOriginal': 12 * 8_000_000,
    'expiresAt': datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc), 'demo': True, 'createdAt': NOW,
})
start = datetime.datetime(2026, 10, 11, 15, 0, tzinfo=datetime.timezone.utc)
for i in range(12):
    put(f'photos/demo-{i:02d}', {
        'eventId': EID, 'photographerUid': UID, 'subalbumId': 'pt' if i < 6 else 'st',
        'previewUrl': f'{IMG}/ev-{i:02d}_p.jpg', 'thumbUrl': f'{IMG}/ev-{i:02d}_t.jpg',
        'width': 1600, 'height': 1067, 'bytes': 8_000_000, 'takenAt': start + datetime.timedelta(minutes=7 * i),
        'fileName': f'DEMO_{i + 1:04d}.jpg', 'bibs': [], 'hidden': False, 'originalDeleted': False, 'demo': True, 'createdAt': NOW,
    })
print(f'Ejemplo cargado en {target}: /#/f/{SLUG}  /#/evento/{EID}')
