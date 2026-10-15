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
block = ('<!-- stamp:start -->\n  <meta name="app-version" content="' + app_v + '">\n  <script type="importmap">' + json.dumps({'imports': imports}, separators=(',', ':')) +
         '</script>\n  <!-- stamp:end -->')

for name in ('index.html', 'panel.html'):
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
