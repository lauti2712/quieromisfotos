# Genera las imágenes del fotógrafo/evento de ejemplo (escenas de fútbol dibujadas, con marca DEMO).
# Uso: python3 tools/make-demo.py  -> escribe en demo/
import math, random, pathlib
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = pathlib.Path(__file__).resolve().parent.parent / 'demo'
OUT.mkdir(exist_ok=True)
W, H = 1600, 1067

def font(size, bold=True):
    for p in ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Helvetica.ttc', '/Library/Fonts/Arial Bold.ttf']:
        try: return ImageFont.truetype(p, size)
        except OSError: pass
    return ImageFont.load_default()

def scene(seed, w=W, h=H):
    r = random.Random(seed)
    img = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(img)
    horizon = int(h * r.uniform(0.28, 0.42))
    # cielo
    top, bot = (70 + r.randint(0, 40), 130 + r.randint(0, 40), 200 + r.randint(0, 40)), (190, 215, 235)
    for y in range(horizon):
        t = y / horizon
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] * (1 - t) + bot[i] * t) for i in range(3)))
    # tribuna
    d.rectangle([0, horizon - int(h * .08), w, horizon], fill=(60, 64, 78))
    for x in range(0, w, 14):
        y0 = horizon - int(h * .07) + r.randint(0, 20)
        d.ellipse([x, y0, x + 9, y0 + 9],
                  fill=r.choice([(200, 60, 60), (230, 230, 230), (40, 90, 180), (240, 200, 60)]))
    # césped a franjas
    for i, y in enumerate(range(horizon, h, int(h * .06))):
        d.rectangle([0, y, w, y + int(h * .06)], fill=(52, 140, 62) if i % 2 else (60, 155, 70))
    d.line([(0, horizon + int(h * .25)), (w, horizon + int(h * .2))], fill=(235, 245, 235), width=5)
    # arco (a veces)
    if r.random() < .5:
        gx = r.randint(int(w * .55), int(w * .8)); gy = horizon + 10
        d.rectangle([gx, gy, gx + 260, gy + 120], outline=(250, 250, 250), width=8)
        for k in range(gx, gx + 260, 18): d.line([(k, gy), (k, gy + 120)], fill=(220, 220, 220), width=1)
    img = img.filter(ImageFilter.GaussianBlur(2.2))  # profundidad de campo
    d = ImageDraw.Draw(img)
    # jugadores
    teams = [((210, 40, 40), (255, 255, 255)), ((30, 80, 170), (255, 230, 80))]
    n = r.randint(2, 4)
    for j in range(n):
        shirt, num_col = teams[j % 2]
        scale = r.uniform(.7, 1.25) * h / 1067
        cx = int(w * (0.15 + 0.7 * (j + r.random() * .6) / n)); base = int(h * r.uniform(.78, .95))
        bw, bh = int(110 * scale), int(190 * scale)
        legs = int(150 * scale)
        lean = r.randint(-25, 25)
        d.line([(cx - bw // 4, base - legs), (cx - bw // 3 + lean, base)], fill=(30, 30, 30), width=int(26 * scale))
        d.line([(cx + bw // 4, base - legs), (cx + bw // 3 - lean, base)], fill=(30, 30, 30), width=int(26 * scale))
        d.rounded_rectangle([cx - bw // 2, base - legs - bh, cx + bw // 2, base - legs], radius=int(28 * scale), fill=shirt)
        d.line([(cx - bw // 2, base - legs - bh + 30), (cx - bw + lean, base - legs - bh // 2)], fill=shirt, width=int(30 * scale))
        d.line([(cx + bw // 2, base - legs - bh + 30), (cx + bw - lean, base - legs - bh // 2)], fill=shirt, width=int(30 * scale))
        hr = int(42 * scale)
        d.ellipse([cx - hr, base - legs - bh - 2 * hr - 6, cx + hr, base - legs - bh - 6], fill=r.choice([(241, 199, 160), (198, 140, 100), (120, 80, 55)]))
        d.text((cx, base - legs - bh // 2), str(r.randint(2, 23)), fill=num_col, font=font(int(70 * scale)), anchor='mm')
    # pelota
    bx, by, br = r.randint(int(w * .2), int(w * .8)), r.randint(int(h * .55), int(h * .9)), int(h * .028)
    d.ellipse([bx - br, by - br, bx + br, by + br], fill=(250, 250, 250), outline=(40, 40, 40), width=3)
    d.regular_polygon((bx, by, br * .45), 5, fill=(40, 40, 40))
    return img

def watermark(img, text='QUIERO MIS FOTOS · DEMO', opacity=.35):
    w, h = img.size
    layer = Image.new('RGBA', (w * 2, h * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    size = max(12, int(max(w, h) * .026))
    f = font(size)
    a = int(255 * opacity * .75)
    tw = d.textlength(text, font=f) + size * 3
    for row, y in enumerate(range(0, h * 2, int(size * 5.5))):
        off = tw / 2 if row % 2 else 0
        x = -tw + off
        while x < w * 2:
            d.text((x, y), text, font=f, fill=(255, 255, 255, a), stroke_width=max(1, size // 10), stroke_fill=(0, 0, 0, a // 2))
            x += tw
    layer = layer.rotate(30, resample=Image.BICUBIC).crop((w // 2, h // 2, w // 2 + w, h // 2 + h))
    out = Image.alpha_composite(img.convert('RGBA'), layer)
    d = ImageDraw.Draw(out)
    big = font(int(min(w, h) * .1))
    d.text((w / 2, h / 2), 'DEMO', font=big, fill=(255, 255, 255, int(255 * min(.95, opacity * 1.4))), anchor='mm',
           stroke_width=max(2, int(min(w, h) * .008)), stroke_fill=(0, 0, 0, 140))
    return out.convert('RGB')

def save(img, name, q):
    img.save(OUT / name, 'JPEG', quality=q, optimize=True, progressive=True)

# fotos del evento (12) — muestra 1600 + miniatura 400
for i in range(12):
    s = scene(100 + i)
    wm = watermark(s)
    save(wm, f'ev-{i:02d}_p.jpg', 80)
    t = s.resize((400, int(400 * H / W)), Image.LANCZOS)
    save(watermark(t), f'ev-{i:02d}_t.jpg', 72)

# portfolio (6)
for i in range(6):
    s = scene(500 + i)
    save(watermark(s, 'FOTÓGRAFO DE EJEMPLO', .3), f'pf-{i}_p.jpg', 80)
    save(watermark(s.resize((400, int(400 * H / W)), Image.LANCZOS), 'FOTÓGRAFO DE EJEMPLO', .3), f'pf-{i}_t.jpg', 72)

# portada y avatar
save(scene(42).resize((1600, 900)), 'cover.jpg', 78)
av = Image.new('RGB', (400, 400), (255, 90, 31))
d = ImageDraw.Draw(av)
d.ellipse([110, 60, 290, 240], fill=(255, 225, 205))
d.rounded_rectangle([70, 250, 330, 440], radius=80, fill=(255, 240, 230))
d.rounded_rectangle([140, 300, 260, 370], radius=14, fill=(30, 30, 30))
d.ellipse([175, 310, 225, 360], fill=(90, 90, 90))
save(av, 'avatar.jpg', 85)
print('ok', len(list(OUT.glob('*.jpg'))), 'imágenes')
