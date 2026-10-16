# Carga (o borra) el fotógrafo y el evento de ejemplo en Firestore.
#   python3 tools/seed-demo.py emu      -> emulador local (imágenes desde http://localhost:5175/demo)
#   python3 tools/seed-demo.py prod     -> producción (usa `gcloud auth print-access-token`)
#   python3 tools/seed-demo.py prod --delete
# Todos los documentos llevan demo: true.
import json, os, subprocess, sys, urllib.request, urllib.error, datetime, re

P = 'quieromisfotos-71629'
target = sys.argv[1] if len(sys.argv) > 1 else 'emu'
delete = '--delete' in sys.argv
if target == 'prod':
    BASE = f'https://firestore.googleapis.com/v1/projects/{P}/databases/(default)/documents'
    TOKEN = subprocess.check_output(['gcloud', 'auth', 'print-access-token']).decode().strip()
    IMG = os.environ.get('DEMO_IMG', 'https://quieromisfotos.com.ar/demo')  # DEMO_IMG=https://prueba.../demo mientras no se publica
else:
    BASE = f'http://127.0.0.1:8085/v1/projects/{P}/databases/(default)/documents'
    TOKEN = 'owner'
    IMG = 'http://localhost:5175/demo'

V = '?v=4'  # cache-busting cuando se regeneran las imágenes
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
    for i in range(14): rm(f'portfolio/{UID}_{i}')
    rm(f'events/{EID}/sets/{UID}'); rm(f'events/{EID}'); rm(f'slugs/{SLUG}'); rm(f'users/{UID}')
    print('Ejemplo borrado.')
    sys.exit()

# ---------------------------------------------------------------- etiquetas (deportes reales, útiles)
types = [plain(d['fields']) | {'id': d['name'].split('/')[-1]} for d in (req('GET', f'{BASE}/tagTypes') or {}).get('documents', [])]
deporte = next((t['id'] for t in types if t['id'] == 'deporte' or t['name'].lower() in ('deporte', 'actividad')), None)
existing = [plain(d['fields']) | {'id': d['name'].split('/')[-1]} for d in (req('GET', f'{BASE}/tags?pageSize=500') or {}).get('documents', [])]
futbol = None
sport_ids = {}
if deporte:
    for name in ['Fútbol', 'Hockey', 'Básquet', 'Rugby', 'Vóley', 'Running']:
        t = next((x for x in existing if x['typeId'] == deporte and x['name'].lower() == name.lower()), None)
        if not t:
            slug = re.sub(r'[^a-z0-9]+', '-', name.lower().replace('ú', 'u').replace('á', 'a').replace('ó', 'o'))
            t = {'id': slug, 'typeId': deporte, 'name': name, 'slug': slug}
            put(f'tags/{slug}', {k: t[k] for k in ('typeId', 'name', 'slug')})
            existing.append(t)
        sport_ids[name] = t['id']
        if name == 'Fútbol': futbol = t['id']
    put('settings/tags', {
        'types': [{'id': t['id'], 'name': t['name'], 'order': t.get('order', 0)} for t in types],
        'tags': [{'id': t['id'], 'typeId': t['typeId'], 'name': t['name'], 'slug': t['slug']} for t in existing],
        'updatedAt': NOW,
    })

# settings/platform NO se toca acá: lo maneja el superadmin desde Plataforma (un PATCH completo borraba campos).

# ---------------------------------------------------------------- fotógrafo
put(f'slugs/{SLUG}', {'uid': UID})
put(f'users/{UID}', {
    'role': 'photographer', 'status': 'approved', 'demo': True,
    'displayName': 'Tomás Aguirre Fotografía', 'slug': SLUG, 'avatarUrl': f'{IMG}/avatar.jpg{V}',
    'bio': ('Fotógrafo con más de 10 años en Rosario y la región: deportes, casamientos, cumpleaños, retratos, producto y tomas con drone. '
            'Cubro torneos de ligas infantiles, juveniles y amateurs, y también eventos sociales e institucionales.\n\n'
            '📸 Entrega rápida: las fotos de cada fecha se suben el mismo día.\n'
            '🏆 Cobertura de torneos completos, con equipo de varios fotógrafos.\n'
            '💬 Escribime para presupuestos de eventos, books deportivos o fotos de equipo.'),
    'zone': 'Rosario, Santa Fe',
    'workZones': 'Rosario, Funes, Roldán, Granadero Baigorria y Villa Gobernador Gálvez',
    'socials': {'instagram': '@tomasaguirre.foto', 'facebook': 'tomasaguirrefoto', 'whatsapp': '341 555-0100', 'web': 'www.tomasaguirrefoto.com.ar'},
    'specialties': [sport_ids[n] for n in ('Running', 'Fútbol', 'Hockey', 'Rugby') if n in sport_ids],
    'services': ['Deportes', 'Eventos sociales', 'Retratos / books', 'Producto', 'Institucional'],
    'gear': [{'type': 'Cámara', 'name': 'Sony A1'}, {'type': 'Cámara', 'name': 'Sony A7 IV'},
             {'type': 'Lente', 'name': 'Sony FE 70-200mm f/2.8 GM II'}, {'type': 'Lente', 'name': 'Sony FE 24-70mm f/2.8 GM II'},
             {'type': 'Lente', 'name': 'Sony FE 400mm f/2.8 GM'}, {'type': 'Drone', 'name': 'DJI Air 3'},
             {'type': 'Flash / iluminación', 'name': 'Godox V1'}],
    'plan': 'web', 'proUntil': datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc),
    'mpConnected': False, 'mpUserId': None,
    'defaults': {'price': 2500, 'packs': [{'qty': 3, 'price': 6000}, {'qty': 5, 'price': 9000}], 'feeMode': 'buyer'},
    'watermark': {'type': 'text', 'text': 'www.quieromisfotos.com.ar', 'position': 'both', 'opacity': 0.35},
    'site': {'template': 'oscura', 'accent': '#ff5a1f', 'tagline': 'Deportes, eventos, retratos y drone en Rosario', 'heroUrl': f'{IMG}/pf-0_p.jpg{V}',
             'clean': False, 'showEvents': True,
             'services': [{'name': 'Cobertura de partido', 'detail': 'Hasta 2 horas · 80 fotos editadas', 'price': '$35.000'},
                          {'name': 'Torneo completo', 'detail': 'Todo el día · fotos a la venta para las familias', 'price': 'Consultar'},
                          {'name': 'Book deportivo', 'detail': '1 hora · 30 fotos editadas', 'price': '$40.000'}]},
    'createdAt': NOW,
})
# Portfolio: fotos reales de Pexels (licencia libre) de distintos tipos de fotografía.
PF = [('Tackle en la semifinal', 'Deportes', 1200, 800), ('Los novios', 'Casamientos', 1600, 1200), ('Atardecer sobre la ciudad', 'Drone', 1600, 899),
      ('Cumple de Sofi', 'Cumpleaños', 1600, 1067), ('Retrato corporativo', 'Retratos', 1600, 1067), ('Labiales para catálogo', 'Producto', 1600, 900),
      ('Jugada en el área', 'Deportes', 1200, 798), ('Casamiento al aire libre', 'Casamientos', 1600, 1067), ('La costa desde el aire', 'Drone', 1600, 1200),
      ('Soplando la vela', 'Cumpleaños', 1600, 1067), ('Book profesional', 'Retratos', 1600, 900), ('Perfumes', 'Producto', 1600, 1067),
      ('Final de hockey', 'Deportes', 1200, 799), ('Largada de la 10K', 'Deportes', 1200, 800)]
for i, (cap, album, w, h) in enumerate(PF):
    put(f'portfolio/{UID}_{i}', {'photographerUid': UID, 'slot': i, 'url': f'{IMG}/pf-{i}_p.jpg{V}', 'thumbUrl': f'{IMG}/pf-{i}_t.jpg{V}',
                                 'cleanUrl': f'{IMG}/pf-{i}_c.jpg{V}', 'width': w, 'height': h, 'caption': cap, 'album': album,
                                 'order': i, 'demo': True, 'createdAt': NOW})

# ---------------------------------------------------------------- evento + set + fotos
# Carrera 10K con fotos reales (Pexels) y dorsales leídos (tools/make-demo-run.py): sirve para probar la búsqueda por dorsal.
running = sport_ids.get('Running')
name, loc = '10K Ciudad de Rosario (ejemplo)', 'Parque de la Independencia, Rosario'
put(f'events/{EID}', {
    'name': name, 'date': '2026-10-11', 'location': loc, 'tagIds': [running] if running else [],
    'coverUrl': f'{IMG}/run-cover.jpg{V}', 'status': 'published', 'kind': 'own', 'createdBy': UID,
    'photographerUids': [UID], 'openToJoin': False, 'demo': True,
    'searchTokens': tokens(name, loc, 'Running 10k carrera maraton', 'ejemplo demo'), 'createdAt': NOW, 'updatedAt': NOW,
})
RUN = [  # (sub-álbum, ancho, alto, dorsales)
    ('lar', 1600, 1067, ['560', '561']), ('lar', 1600, 1067, ['451', '7999', '18']), ('lar', 1600, 1067, ['7999', '12']),
    ('lar', 1600, 1067, ['65']), ('rec', 1600, 1067, ['890', '174', '2018', '711', '3009', '710']), ('rec', 1600, 900, ['4745', '1178']),
    ('rec', 1600, 900, ['537', '278']), ('rec', 1600, 900, ['2', '294', '289']), ('lle', 1600, 1067, ['56224', '34101']),
    ('lle', 1600, 1067, ['62956', '64938', '15249']), ('lle', 1600, 1067, ['3028']), ('lle', 1600, 1067, ['692', '684', '654', '66']),
]
subs = [{'id': 'lar', 'name': 'Largada', 'order': 0}, {'id': 'rec', 'name': 'Recorrido', 'order': 1}, {'id': 'lle', 'name': 'Llegada', 'order': 2}]
put(f'events/{EID}/sets/{UID}', {
    'price': 3000, 'packs': [{'qty': 3, 'price': 7500}, {'qty': 5, 'price': 11000}], 'feeMode': 'buyer',
    'subalbums': subs, 'photoCount': len(RUN), 'bytesOriginal': len(RUN) * 8_000_000, 'showHours': True,
    'detectBibs': True, 'bibScans': len(RUN), 'bibPhotos': sum(1 for r in RUN if r[3]),
    'expiresAt': datetime.datetime(2099, 1, 1, tzinfo=datetime.timezone.utc), 'demo': True, 'createdAt': NOW,
})
start = datetime.datetime(2026, 10, 11, 10, 0, tzinfo=datetime.timezone.utc)  # 7:00 en Argentina
for i, (sub, w, h, bibs) in enumerate(RUN):
    put(f'photos/demo-{i:02d}', {
        'eventId': EID, 'photographerUid': UID, 'subalbumId': sub,
        'previewUrl': f'{IMG}/run-{i:02d}_p.jpg{V}', 'thumbUrl': f'{IMG}/run-{i:02d}_t.jpg{V}',
        'width': w, 'height': h, 'bytes': 8_000_000, 'takenAt': start + datetime.timedelta(minutes=6 * i),
        'fileName': f'DEMO_{i + 1:04d}.jpg', 'bibs': bibs, 'bibScanAt': NOW, 'hidden': False, 'originalDeleted': False, 'demo': True, 'createdAt': NOW,
    })
print(f'Ejemplo cargado en {target}: /#/f/{SLUG}  /#/evento/{EID}')
