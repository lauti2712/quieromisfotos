# Lista de localidades reales de Argentina para elegir zona del fotógrafo y localidad de los eventos (js/places.js).
# Fuente: API Georef del Gobierno (apis.datos.gob.ar): localidades (BAHRA) + localidades censales, sin duplicados.
# Uso: python3 tools/localidades.py  ->  assets/data/localidades.json  {p: [provincias], l: [[nombre, índice provincia], …]}
import json, pathlib, urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
API = 'https://apis.datos.gob.ar/georef/api'
SHORT = {'Ciudad Autónoma de Buenos Aires': 'CABA', 'Tierra del Fuego, Antártida e Islas del Atlántico Sur': 'Tierra del Fuego'}


def get(path, key):
    with urllib.request.urlopen(f'{API}/{path}?max=5000&campos=nombre,provincia.nombre&aplanar=true', timeout=60) as r:
        return json.load(r)[key]


rows = get('localidades', 'localidades') + get('localidades-censales', 'localidades_censales')
pairs = {(x['nombre'].strip(), SHORT.get(x['provincia_nombre'], x['provincia_nombre'])) for x in rows}
pairs.add(('Ciudad Autónoma de Buenos Aires', 'CABA'))
provs = sorted({p for _, p in pairs})
out = {'p': provs, 'l': sorted([[n, provs.index(p)] for n, p in pairs], key=lambda x: (x[0], x[1]))}
dest = ROOT / 'assets/data/localidades.json'
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
print(f'{len(out["l"])} localidades en {len(provs)} provincias → {dest.relative_to(ROOT)} ({dest.stat().st_size // 1024} KB)')
