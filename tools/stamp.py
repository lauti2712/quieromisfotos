# Versionado de archivos para evitar caché viejo (GitHub Pages cachea 10 min).
# Genera un import map en index.html y panel.html que pide cada módulo de js/ con ?v=<hash del contenido>,
# y agrega ?v= al CSS. Correr antes de cada commit:  python3 tools/stamp.py
import hashlib, json, pathlib, re

ROOT = pathlib.Path(__file__).resolve().parent.parent
files = sorted((ROOT / 'js').glob('*.js')) + [ROOT / 'css' / 'app.css']
ver = lambda p: hashlib.sha1(p.read_bytes()).hexdigest()[:8]

imports = {f'./js/{p.name}': f'./js/{p.name}?v={ver(p)}' for p in sorted((ROOT / 'js').glob('*.js'))}
css_v = ver(ROOT / 'css' / 'app.css')
# Versión de la app: cambia con cualquier módulo o el CSS. Los navegadores abiertos la comparan con version.json.
app_v = hashlib.sha1((json.dumps(imports, sort_keys=True) + css_v).encode()).hexdigest()[:10]
(ROOT / 'version.json').write_text(json.dumps({'v': app_v}) + '\n')
# Precarga: todos los módulos que importa la página (de forma estática) se piden de entrada y en paralelo,
# en vez de en cadena (cada import descubre el siguiente: 4 o 5 viajes seguidos en un celular).
IMPORT_RE = re.compile(r'''^\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]''', re.M)
def graph(entry):
    seen, todo, ext = [], [entry], []
    while todo:
        name = todo.pop(0)
        if name in seen: continue
        seen.append(name)
        for m in IMPORT_RE.finditer((ROOT / 'js' / name).read_text()):
            spec = m.group(1) or m.group(2)
            if spec.startswith('http'):
                if spec not in ext: ext.append(spec)
            elif spec.startswith('./'): todo.append(spec[2:])
    return seen, ext
PRECONNECT = ['https://www.gstatic.com', 'https://firestore.googleapis.com', 'https://api.quieromisfotos.com.ar']
def block_for(entry):
    mods, ext = graph(entry)
    pre = ''.join(f'\n  <link rel="preconnect" href="{u}" crossorigin>' for u in PRECONNECT)
    pre += '\n  <link rel="preconnect" href="https://qmf-fotos.solucionescotidianas.com.ar">'  # fotos (R2 público)
    pre += ''.join(f'\n  <link rel="modulepreload" href="js/{m}?v={ver(ROOT / "js" / m)}">' for m in mods)
    pre += ''.join(f'\n  <link rel="modulepreload" href="{u}" crossorigin>' for u in ext)
    return ('<!-- stamp:start -->\n  <meta name="app-version" content="' + app_v + '">\n  <script type="importmap">' + json.dumps({'imports': imports}, separators=(',', ':')) +
            '</script>' + pre + '\n  <!-- stamp:end -->')

for name, entry in (('index.html', 'public.js'), ('panel.html', 'panel.js')):
    block = block_for(entry)
    p = ROOT / name
    s = p.read_text()
    if '<!-- stamp:start -->' in s:
        s = re.sub(r'<!-- stamp:start -->.*?<!-- stamp:end -->', lambda m: block, s, flags=re.S)
    else:  # el import map tiene que ir antes del primer <script type="module">
        s = s.replace('<link rel="stylesheet"', block + '\n  <link rel="stylesheet"', 1)
    s = re.sub(r'href="css/app\.css(\?v=[0-9a-f]+)?"', f'href="css/app.css?v={css_v}"', s)
    s = re.sub(r'src="js/(public|panel)\.js(\?v=[0-9a-f]+)?"', lambda m: f'src="js/{m.group(1)}.js?v={ver(ROOT / "js" / (m.group(1) + ".js"))}"', s)
    p.write_text(s)
print('stamp ok:', len(imports), 'módulos')
