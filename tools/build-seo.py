# Genera páginas estáticas indexables por Google (el sitio usa rutas con #, que Google no indexa):
#   /e/{eventId}/   /f/{slug}/   /eventos/   /fotografos/   sitemap.xml   robots.txt
# Lee solo datos públicos de Firestore (mismas reglas que un visitante). Lo corre GitHub Actions cada hora.
# Uso: python3 tools/build-seo.py
import html, json, pathlib, re, shutil, urllib.request, datetime

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = 'https://quieromisfotos.com.ar'
PROJECT = 'quieromisfotos-71629'
API_KEY = re.search(r"apiKey: '([^']+)'", (ROOT / 'js' / 'fb.js').read_text()).group(1)
BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/(default)/documents'
e = lambda s: html.escape(str(s or ''), quote=True)


# ---------------------------------------------------------------- Firestore (lectura pública)
def val(v):
    if 'stringValue' in v: return v['stringValue']
    if 'integerValue' in v: return int(v['integerValue'])
    if 'doubleValue' in v: return v['doubleValue']
    if 'booleanValue' in v: return v['booleanValue']
    if 'timestampValue' in v: return v['timestampValue']
    if 'nullValue' in v: return None
    if 'arrayValue' in v: return [val(x) for x in v['arrayValue'].get('values', [])]
    if 'mapValue' in v: return {k: val(x) for k, x in v['mapValue'].get('fields', {}).items()}
    return None


def doc(d): return {'id': d['name'].split('/')[-1], **{k: val(v) for k, v in d.get('fields', {}).items()}}


def get(path):
    try:
        with urllib.request.urlopen(f'{BASE}/{path}?key={API_KEY}') as r: return doc(json.load(r))
    except urllib.error.HTTPError: return None


def query(collection, filters, limit=500, order=None):
    ops = {'==': 'EQUAL', 'contains': 'ARRAY_CONTAINS'}
    ff = [{'fieldFilter': {'field': {'fieldPath': f}, 'op': ops[o], 'value': {'stringValue': v} if isinstance(v, str) else {'booleanValue': v}}} for f, o, v in filters]
    q = {'from': [{'collectionId': collection}], 'limit': limit,
         'where': ff[0] if len(ff) == 1 else {'compositeFilter': {'op': 'AND', 'filters': ff}}}
    if order: q['orderBy'] = [{'field': {'fieldPath': order[0]}, 'direction': order[1]}]
    body = json.dumps({'structuredQuery': q}).encode()
    req = urllib.request.Request(f'{BASE}:runQuery?key={API_KEY}', data=body, headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return [doc(x['document']) for x in json.load(r) if 'document' in x]


# ---------------------------------------------------------------- datos
events = [x for x in query('events', [('status', '==', 'published')], order=('date', 'DESCENDING')) if not x.get('demo')]
users = {u['id']: u for u in query('users', [('status', '==', 'approved')]) if u.get('role') == 'photographer' and not u.get('demo')}
tax = get('settings/tags') or {}
tag_name = {t['id']: t['name'] for t in tax.get('tags', [])}
css = re.search(r'href="(css/app\.css[^"]*)"', (ROOT / 'index.html').read_text()).group(1)


def fmt_date(iso):
    try:
        y, m, d = map(int, iso.split('-'))
        meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
        return f'{d} de {meses[m - 1]} de {y}'
    except Exception: return iso or ''


def page(title, desc, canonical, body, image=None, jsonld=None, redirect=None):
    """redirect: ruta del sitio (con #) a la que se manda al visitante que llega desde un link compartido (?s=1)."""
    img = image or f'{SITE}/assets/og-image.png'
    return f'''<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(title)}</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="{e(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Quiero Mis Fotos">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="{e(canonical)}">
<meta property="og:image" content="{e(img)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#ff5a1f">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/{css}">
{f'<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False)}</script>' if jsonld else ''}
{f'<script>if(/[?&]s=1/.test(location.search)){{var f=new URLSearchParams(location.search).get("f");location.replace("{redirect}"+(f?"?f="+encodeURIComponent(f):""))}}</script>' if redirect else ''}
</head>
<body class="public">
<header class="topbar"><div class="inner">
  <a class="brand" href="/" aria-label="Quiero Mis Fotos"><img class="logo" src="/assets/logo.svg" alt="" width="30" height="30"><span class="brand-txt">quiero<span class="mis">mis</span>fotos</span></a>
  <span class="spacer"></span>
  <a class="btn sm" href="/eventos/">Eventos</a>
  <a class="btn sm" href="/fotografos/">Fotógrafos</a>
</div></header>
<main class="container">{body}</main>
<footer class="site">Quiero Mis Fotos · Encontrá tu foto. Reviví tu momento.
  <div class="foot-links"><a href="/eventos/">Eventos</a> · <a href="/fotografos/">Fotógrafos</a> · <a href="/panel.html">Soy fotógrafo</a></div>
  <div class="credit">Desarrollado por <a href="https://solucionescotidianas.com.ar" target="_blank" rel="noopener">Soluciones Cotidianas</a></div></footer>
</body>
</html>'''


def event_card(ev):
    tags = [tag_name[t] for t in ev.get('tagIds') or [] if t in tag_name][:3]
    cover = f'<img src="{e(ev["coverUrl"])}" alt="" loading="lazy">' if ev.get('coverUrl') else f'<span class="initial">{e((ev.get("name") or "?")[:2].upper())}</span>'
    return f'''<a class="event-card" href="/e/{e(ev["id"])}/"><div class="cover">{cover}</div><div class="body">
      <span class="date">{e(fmt_date(ev.get("date")))}</span><span class="name">{e(ev.get("name"))}</span>
      {f'<span class="muted small">📍 {e(ev["location"])}</span>' if ev.get('location') else ''}
      {f'<div class="pills">{"".join(f"<span class=pill>{e(t)}</span>" for t in tags)}</div>' if tags else ''}</div></a>'''


def pills(items, cls='pill'):
    return ''.join(f'<span class="{cls}">{e(t)}</span>' for t in items)


def people_html(phs):
    links = ''.join(f'<a class="person" href="/f/{e(p.get("slug"))}/"><strong>{e(p.get("displayName"))}</strong></a>' for p in phs)
    return f'<div class="card"><h2>Fotógrafos</h2><div class="people">{links}</div></div>'


def thumbs_html(items, href, alt):
    return ''.join(f'<a class="g-item" href="{href}"><img src="{e(p.get("thumbUrl"))}" alt="{e(p.get("caption") or alt)}" loading="lazy"></a>' for p in items)


# ---------------------------------------------------------------- limpiar y generar
for d in ('e', 'f', 'eventos', 'fotografos'):
    shutil.rmtree(ROOT / d, ignore_errors=True)
urls = [(f'{SITE}/', None), (f'{SITE}/eventos/', None), (f'{SITE}/fotografos/', None)]


def write(rel, content):
    p = ROOT / rel / 'index.html'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


for ev in events:
    tags = [tag_name[t] for t in ev.get('tagIds') or [] if t in tag_name]
    phs = [users[u] for u in ev.get('photographerUids') or [] if u in users]
    photos = query('photos', [('eventId', '==', ev['id']), ('hidden', '==', False)], limit=12)
    first_img = ev.get('coverUrl') or (photos[0]['previewUrl'] if photos else None)
    name = ev.get('name', '')
    title = f'Fotos de {name} · Quiero Mis Fotos'
    desc = f'Encontrá y descargá tus fotos de {name}' + (f' ({fmt_date(ev.get("date"))}' if ev.get('date') else '') + (f', {ev["location"]})' if ev.get('location') else ')' if ev.get('date') else '') + \
        f'. Fotos en alta calidad{" de " + ", ".join(p["displayName"] for p in phs) if phs else ""}.'
    app = f'/#/evento/{ev["id"]}'
    body = f'''
      <a href="/eventos/" class="muted small" style="text-decoration:none">← Todos los eventos</a>
      <div class="event-hero" style="margin-top:10px"><div class="cover">{f'<img src="{e(first_img)}" alt="">' if first_img else ''}
        <div class="meta"><h1>Fotos de {e(name)}</h1><div>{e(fmt_date(ev.get("date")))}{f" · 📍 {e(ev['location'])}" if ev.get('location') else ''}</div></div></div></div>
      {f'<div class="pills" style="margin-bottom:16px">{pills(tags, "pill accent")}</div>' if tags else ''}
      <div class="card stack">
        <p style="margin:0">¿Estuviste en <strong>{e(name)}</strong>? Buscate en las fotos y descargalas en alta calidad, sin marca de agua.</p>
        <a class="btn primary" style="justify-self:start" href="{app}">📸 Ver todas las fotos y comprar</a>
      </div>
      {people_html(phs) if phs else ''}
      {f'<div class="card"><h2>Algunas fotos</h2><div class="gallery">{thumbs_html(photos, app, "Foto de " + name)}</div></div>' if photos else ''}'''
    ld = {'@context': 'https://schema.org', '@type': 'Event', 'name': name, 'startDate': ev.get('date'),
          'eventStatus': 'https://schema.org/EventScheduled', 'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
          'location': {'@type': 'Place', 'name': ev.get('location') or 'Argentina', 'address': ev.get('location') or 'Argentina'},
          'image': [first_img] if first_img else [], 'description': desc, 'url': f'{SITE}/e/{ev["id"]}/',
          'organizer': {'@type': 'Organization', 'name': 'Quiero Mis Fotos', 'url': SITE}}
    write(f'e/{ev["id"]}', page(title, desc, f'{SITE}/e/{ev["id"]}/', body, first_img, ld, redirect=app))
    urls.append((f'{SITE}/e/{ev["id"]}/', ev.get('date')))

for u in users.values():
    slug = u.get('slug')
    if not slug: continue
    acts = [tag_name[t] for t in u.get('specialties') or [] if t in tag_name]
    evs = [ev for ev in events if u['id'] in (ev.get('photographerUids') or [])]
    pf = sorted(query('portfolio', [('photographerUid', '==', u['id'])], limit=60), key=lambda p: (p.get('order') or 0))[:12]
    title = f'{u.get("displayName")} · Fotógrafo{" en " + u["zone"] if u.get("zone") else ""} · Quiero Mis Fotos'
    desc = (u.get('bio') or '').replace('\n', ' ')[:150] or f'{u.get("displayName")}, fotógrafo{" en " + u["zone"] if u.get("zone") else ""}. Mirá su portfolio y sus eventos.'
    app = f'/#/f/{slug}'
    socials = u.get('socials') or {}
    same = [v for v in [f'https://instagram.com/{socials["instagram"].lstrip("@")}' if socials.get('instagram') else None,
                        socials.get('facebook') if str(socials.get('facebook', '')).startswith('http') else None] if v]
    body = f'''
      <div class="profile-head">
        {f'<span class="avatar lg"><img src="{e(u["avatarUrl"])}" alt="{e(u.get("displayName"))}"></span>' if u.get('avatarUrl') else ''}
        <div style="flex:1;min-width:220px">
          <h1 style="margin-bottom:4px">{e(u.get("displayName"))}</h1>
          {f'<div class="muted">📍 {e(u["zone"])}{" · Trabaja en " + e(u["workZones"]) if u.get("workZones") else ""}</div>' if u.get('zone') else ''}
          {f'<p style="white-space:pre-line;margin-top:8px">{e(u["bio"])}</p>' if u.get('bio') else ''}
          {f'<div class="pills">{pills(acts, "pill accent")}{pills(u.get("services") or [])}</div>' if acts or u.get('services') else ''}
          <div class="row" style="margin-top:12px"><a class="btn primary" href="{app}">Ver perfil y pedir presupuesto</a></div>
        </div>
      </div>
      {f'<h2>Portfolio</h2><div class="gallery" style="margin-bottom:24px">{thumbs_html(pf, app, u.get("displayName"))}</div>' if pf else ''}
      {f'<h2>Eventos</h2><div class="events-grid">{"".join(event_card(ev) for ev in evs)}</div>' if evs else ''}'''
    ld = {'@context': 'https://schema.org', '@type': 'Person', 'name': u.get('displayName'), 'jobTitle': 'Fotógrafo',
          'description': desc, 'url': f'{SITE}/f/{slug}/', 'image': u.get('avatarUrl') or None,
          'address': {'@type': 'PostalAddress', 'addressLocality': u.get('zone') or '', 'addressCountry': 'AR'},
          'knowsAbout': acts, 'sameAs': same}
    write(f'f/{slug}', page(title, desc, f'{SITE}/f/{slug}/', body, (pf[0]['url'] if pf else u.get('avatarUrl')), ld, redirect=app))
    urls.append((f'{SITE}/f/{slug}/', None))
    # Web personal (planes Web): también al sitemap
    plan_ok = u.get('plan') in ('web', 'webdomain') and (u.get('proUntil') or '') > datetime.datetime.now(datetime.timezone.utc).isoformat()
    if plan_ok:
        urls.append((f'https://{u["siteDomain"]}/' if u.get('domainActive') and u.get('siteDomain') else f'https://{slug}.quieromisfotos.com.ar/', None))

write('eventos', page('Eventos deportivos con fotos · Quiero Mis Fotos',
                      'Todos los eventos con fotos a la venta: partidos, torneos, carreras y más. Encontrá tu evento y descargá tus fotos.',
                      f'{SITE}/eventos/',
                      f'<h1>Eventos</h1><p class="muted">Encontrá tu evento y descargá tus fotos en alta calidad.</p><div class="events-grid">{"".join(event_card(ev) for ev in events) or "<p>Pronto vas a encontrar eventos acá.</p>"}</div>'))
write('fotografos', page('Fotógrafos deportivos y de eventos · Quiero Mis Fotos',
                         'Encontrá un fotógrafo para tu partido, torneo, evento o sesión y pedile presupuesto.',
                         f'{SITE}/fotografos/',
                         '<h1>Fotógrafos</h1><p class="muted">Encontrá un fotógrafo y pedile presupuesto.</p><div class="dir-grid">' +
                         ''.join(f'<a class="dir-card" href="/f/{e(u["slug"])}/" style="text-decoration:none"><strong>{e(u.get("displayName"))}</strong><span class="muted small">{e(u.get("zone"))}</span></a>' for u in users.values() if u.get('slug')) +
                         '</div>'))

today = datetime.date.today().isoformat()
(ROOT / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
                                  ''.join(f'  <url><loc>{e(u)}</loc>{f"<lastmod>{d}</lastmod>" if d else ""}</url>\n' for u, d in urls) + '</urlset>\n')
(ROOT / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nDisallow: /panel.html\n\nSitemap: {SITE}/sitemap.xml\n')
print(f'SEO ok: {len(events)} eventos, {len(users)} fotógrafos, {len(urls)} URLs en el sitemap')
