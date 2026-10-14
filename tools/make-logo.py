# Genera los PNG del logo (íconos, apple-touch, imagen para compartir) a partir de la geometría de assets/logo.svg.
# Uso: python3 tools/make-logo.py
import pathlib
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets'
ORANGE, WHITE, INK, MUTED = (255, 90, 31), (255, 255, 255), (21, 24, 30), (93, 101, 115)
SS = 4  # supersampling

HEART = [((32, 44), (21, 37), (17, 31.5), (17, 26.5)), ((17, 26.5), (17, 22.4), (20.2, 19), (24.3, 19)),
         ((24.3, 19), (27.5, 19), (30.3, 20.9), (32, 23.7)), ((32, 23.7), (33.7, 20.9), (36.5, 19), (39.7, 19)),
         ((39.7, 19), (43.8, 19), (47, 22.4), (47, 26.5)), ((47, 26.5), (47, 31.5), (43, 37), (32, 44))]
CORNERS = [[(12, 22), (12, 12), (22, 12)], [(42, 12), (52, 12), (52, 22)], [(52, 42), (52, 52), (42, 52)], [(22, 52), (12, 52), (12, 42)]]


def bez(p0, p1, p2, p3, n=24):
    return [tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t ** 2 * c + t ** 3 * d for a, b, c, d in zip(p0, p1, p2, p3))
            for t in (i / n for i in range(n + 1))]


def icon(size, radius=True, pad=0):
    S = size * SS
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    k = (S - 2 * pad * SS) / 64
    o = pad * SS
    P = lambda x, y: (o + x * k, o + y * k)
    if radius: d.rounded_rectangle([0, 0, S - 1, S - 1], radius=16 * S / 64, fill=ORANGE)
    else: d.rectangle([0, 0, S, S], fill=ORANGE)
    w = 5 * k
    for line in CORNERS:
        pts = [P(*p) for p in line]
        d.line(pts, fill=WHITE, width=round(w), joint='curve')
        for x, y in pts: d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=WHITE)
    heart = [P(*p) for seg in HEART for p in bez(*seg)]
    d.polygon(heart, fill=WHITE)
    return img.resize((size, size), Image.LANCZOS)


def font(size):
    for p in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf']:
        try: return ImageFont.truetype(p, size)
        except OSError: pass
    return ImageFont.load_default()


def font_regular(size):
    for p in ['/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf']:
        try: return ImageFont.truetype(p, size)
        except OSError: pass
    return ImageFont.load_default()


icon(512).save(OUT / 'logo-512.png')
icon(192).save(OUT / 'icon-192.png')
icon(512).save(OUT / 'icon-512.png')
icon(180, radius=False).convert('RGB').save(OUT / 'apple-touch-icon.png')   # iOS redondea solo
icon(512, radius=False, pad=56).save(OUT / 'icon-maskable-512.png')          # zona segura Android
icon(48).save(OUT / 'favicon-48.png')

# Imagen para compartir (WhatsApp, redes): 1200x630
W, H = 1200, 630
og = Image.new('RGB', (W, H), WHITE)
d = ImageDraw.Draw(og)
d.rectangle([0, H - 14, W, H], fill=ORANGE)
og.paste(icon(220), (110, 180), icon(220))
f = font(84)
x, y = 370, 215
for part, col in (('quiero', INK), ('mis', ORANGE), ('fotos', INK)):
    d.text((x, y), part, font=f, fill=col)
    x += d.textlength(part, font=f)
d.text((374, 330), 'Encontrá tu foto. Reviví tu momento.', font=font_regular(40), fill=MUTED)
og.save(OUT / 'og-image.png', optimize=True)
print('ok')
