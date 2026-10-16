# Fotos del evento de ejemplo (carrera 10K): fotos reales de Pexels (licencia libre) con dorsales visibles.
# Uso: python3 tools/make-demo-run.py  -> escribe demo/run-XX_p.jpg (muestra con marca) y run-XX_t.jpg (miniatura)
import io, pathlib, urllib.request, importlib.util
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent

src = (ROOT / 'make-demo.py').read_text().split('def save(')[0]  # solo font() y watermark(), sin generar nada
ns = {'__file__': str(ROOT / 'make-demo.py')}
exec(src, ns)
watermark, OUT = ns['watermark'], ns['OUT']

IDS = [10225452, 10313667, 10313668, 10417359, 10499987, 2403029, 2421564, 2526884, 29400388, 29400389, 18408962, 7523360]
sizes = []
for i, pid in enumerate(IDS):
    url = f'https://images.pexels.com/photos/{pid}/pexels-photo-{pid}.jpeg?auto=compress&cs=tinysrgb&w=1600'
    img = Image.open(io.BytesIO(urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})).read())).convert('RGB')
    img.thumbnail((1600, 1600), Image.LANCZOS)
    watermark(img).save(OUT / f'run-{i:02d}_p.jpg', 'JPEG', quality=82, optimize=True, progressive=True)
    t = img.copy(); t.thumbnail((400, 400), Image.LANCZOS)
    watermark(t).save(OUT / f'run-{i:02d}_t.jpg', 'JPEG', quality=72, optimize=True, progressive=True)
    if i == 4:
        c = img.copy(); c.thumbnail((1600, 900), Image.LANCZOS); c.save(OUT / 'run-cover.jpg', 'JPEG', quality=78, optimize=True, progressive=True)
    sizes.append(img.size)
print(sizes)
