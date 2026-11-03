# Genera páginas estáticas indexables por Google (el sitio usa rutas con #, que Google no indexa):
#   /e/{eventId}/   /f/{slug}/   /eventos/   /fotografos/[{zona}/]   /fotos/[{deporte}/]   /guias/[{guia}/]   sitemap.xml   robots.txt
# Lee solo datos públicos de Firestore (mismas reglas que un visitante). Lo corre GitHub Actions cada hora.
# Uso: python3 tools/build-seo.py
import html, json, pathlib, re, shutil, subprocess, urllib.request, datetime, unicodedata
from seo_guides import GUIDES

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
sports = {t['id']: t for t in tax.get('tags', []) if t.get('typeId') == 'deporte'}


def slugify(t):
    t = unicodedata.normalize('NFD', str(t or '')).encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', '-', t).strip('-')[:60]


def crumbs(items):
    """Ruta de navegación visible + datos para Google. items: [(nombre, url), …] (la última es la página actual)."""
    links = ' › '.join(f'<a href="{e(u)}">{e(n)}</a>' if i < len(items) - 1 else f'<span>{e(n)}</span>' for i, (n, u) in enumerate(items))
    ld = {'@context': 'https://schema.org', '@type': 'BreadcrumbList',
          'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'name': n, 'item': u if u.startswith('http') else SITE + u} for i, (n, u) in enumerate(items)]}
    return f'<nav class="crumbs muted small" aria-label="Ruta">{links}</nav>', ld
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
<script>try{{var t=localStorage.getItem("qmf-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}}catch(e){{}}</script>
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/{css}">
{f'<script type="application/ld+json">{json.dumps(jsonld, ensure_ascii=False)}</script>' if jsonld else ''}
{f'<script>if(/[?&]s=1/.test(location.search)){{var q=new URLSearchParams(location.search);q.delete("s");q=q.toString();location.replace("{redirect}"+(q?"?"+q:""))}}</script>' if redirect else ''}
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
  <div class="foot-links"><a href="/#/arrepentimiento"><strong>Botón de arrepentimiento</strong></a> · <a href="/eventos/">Eventos</a> · <a href="/fotos/">Fotos por deporte</a> · <a href="/fotografos/">Fotógrafos</a> · <a href="/soy-fotografo/">Soy fotógrafo</a> · <a href="/guias/">Guías para fotógrafos</a></div>
  <div class="credit">Desarrollado por <a href="https://solucionescotidianas.com.ar" target="_blank" rel="noopener">Soluciones Cotidianas</a></div></footer>
</body>
</html>'''


def event_card(ev):
    tags = [tag_name[t] for t in ev.get('tagIds') or [] if t in tag_name][:3]
    src = ev.get('coverUrl') or ev.get('autoCoverUrl')
    cover = f'<img src="{e(src)}" alt="" loading="lazy">' if src else f'<span class="initial">{e((ev.get("name") or "?")[:2].upper())}</span>'
    return f'''<a class="event-card" href="/e/{e(ev["id"])}/"><div class="cover">{cover}</div><div class="body">
      <span class="date">{e(fmt_date(ev.get("date")))}</span><span class="name">{e(ev.get("name"))}</span>
      {f'<span class="muted small">📍 {e(ev["location"])}</span>' if ev.get('location') else ''}
      {f'<span class="muted small">📷 {e(", ".join(ev["photographerNames"]))}</span>' if ev.get('photographerNames') else ''}
      {f'<div class="pills">{"".join(f"<span class=pill>{e(t)}</span>" for t in tags)}</div>' if tags else ''}</div></a>'''


def pills(items, cls='pill'):
    return ''.join(f'<span class="{cls}">{e(t)}</span>' for t in items)


def people_html(phs):
    links = ''.join(f'<a class="person" href="/f/{e(p.get("slug"))}/"><strong>{e(p.get("displayName"))}</strong></a>' for p in phs)
    return f'<div class="card"><h2>Fotógrafos</h2><div class="people">{links}</div></div>'


def thumbs_html(items, href, alt):
    return ''.join(f'<a class="g-item" href="{href}"><img src="{e(p.get("thumbUrl"))}" alt="{e(p.get("caption") or alt)}" loading="lazy"></a>' for p in items)


# ---------------------------------------------------------------- limpiar y generar
for d in ('e', 'f', 'eventos', 'fotografos', 'fotos', 'guias'):
    shutil.rmtree(ROOT / d, ignore_errors=True)
urls = [(f'{SITE}/', None), (f'{SITE}/eventos/', None), (f'{SITE}/fotografos/', None), (f'{SITE}/terminos/', None), (f'{SITE}/privacidad/', None)]
images = {}  # url de la página -> [(imagen, título)] para el sitemap de imágenes (Google Imágenes)


def write(rel, content):
    p = ROOT / rel / 'index.html'
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)


for ev in events:
    tags = [tag_name[t] for t in ev.get('tagIds') or [] if t in tag_name]
    phs = [users[u] for u in ev.get('photographerUids') or [] if u in users]
    photos = query('photos', [('eventId', '==', ev['id']), ('hidden', '==', False)], limit=12)
    first_img = ev.get('coverUrl') or ev.get('autoCoverUrl') or (photos[0]['previewUrl'] if photos else None)
    name = ev.get('name', '')
    when = fmt_date(ev.get('date'))
    # Título con fecha y lugar, salvo que ya estén en el nombre o lo hagan muy largo (Google corta ~60 caracteres).
    title = f'Fotos de {name}'
    for extra in ([when] if when and not re.search(r'\d{1,2}/\d{1,2}', name) else []) + ([ev['location'].split(',')[0]] if ev.get('location') else []):
        if len(title) + len(extra) < 62: title += f' · {extra}'
    title += ' | Quiero Mis Fotos'
    ev_sports = [sports[t] for t in ev.get('tagIds') or [] if t in sports]
    desc = f'Encontrá y descargá tus fotos de {name}' + (f' ({fmt_date(ev.get("date"))}' if ev.get('date') else '') + (f', {ev["location"]})' if ev.get('location') else ')' if ev.get('date') else '') + \
        f'. Fotos en alta calidad{" de " + ", ".join(p["displayName"] for p in phs) if phs else ""}.'
    app = f'/#/evento/{ev["id"]}'
    trail = [('Inicio', '/'), ('Eventos', '/eventos/')] + ([(ev_sports[0]['name'], f'/fotos/{ev_sports[0]["slug"]}/')] if ev_sports else []) + [(name, f'/e/{ev["id"]}/')]
    crumb_html, crumb_ld = crumbs(trail)
    related = [x for x in events if x['id'] != ev['id'] and ev_sports and ev_sports[0]['id'] in (x.get('tagIds') or [])][:6]
    body = f'''
      {crumb_html}
      <div class="event-hero" style="margin-top:10px"><div class="cover">{f'<img src="{e(first_img)}" alt="">' if first_img else ''}
        <div class="meta"><h1>Fotos de {e(name)}</h1><div>{e(fmt_date(ev.get("date")))}{f" · 📍 {e(ev['location'])}" if ev.get('location') else ''}</div></div></div></div>
      {f'<div class="pills" style="margin-bottom:16px">{pills(tags, "pill accent")}</div>' if tags else ''}
      <div class="card stack">
        <p style="margin:0">¿Estuviste en <strong>{e(name)}</strong>? Buscate en las fotos y descargalas en alta calidad, sin marca de agua.</p>
        <a class="btn primary" style="justify-self:start" href="{app}">📸 Ver todas las fotos y comprar</a>
      </div>
      {people_html(phs) if phs else ''}
      {f'<div class="card"><h2>Algunas fotos</h2><div class="gallery">{thumbs_html(photos, app, "Foto de " + name + (" · " + ", ".join(p["displayName"] for p in phs) if phs else ""))}</div></div>' if photos else ''}
      {f'<h2>Otros eventos de {e(ev_sports[0]["name"].lower())}</h2><div class="events-grid">{"".join(event_card(x) for x in related)}</div><p><a href="/fotos/{e(ev_sports[0]["slug"])}/">Ver todas las fotos de {e(ev_sports[0]["name"].lower())} →</a></p>' if related else ''}'''
    ld = {'@context': 'https://schema.org', '@type': 'Event', 'name': name, 'startDate': ev.get('date'),
          'eventStatus': 'https://schema.org/EventScheduled', 'eventAttendanceMode': 'https://schema.org/OfflineEventAttendanceMode',
          'location': {'@type': 'Place', 'name': ev.get('location') or 'Argentina', 'address': ev.get('location') or 'Argentina'},
          'image': [first_img] if first_img else [], 'description': desc, 'url': f'{SITE}/e/{ev["id"]}/',
          'organizer': {'@type': 'Organization', 'name': 'Quiero Mis Fotos', 'url': SITE},
          'endDate': ev.get('date'), 'performer': {'@type': 'PerformingGroup', 'name': f'Participantes de {name}'}}
    # Oferta: las fotos del evento, desde el precio por foto más bajo entre los fotógrafos.
    prices = [s.get('price') for s in (get(f'events/{ev["id"]}/sets/{u}') for u in ev.get('photographerUids') or []) if s and (s.get('price') or 0) > 0]
    if prices:
        ld['offers'] = {'@type': 'Offer', 'name': f'Fotos de {name}', 'price': min(prices), 'priceCurrency': 'ARS',
                        'availability': 'https://schema.org/InStock', 'url': f'{SITE}/e/{ev["id"]}/', 'validFrom': ev.get('date')}
    # Fotos de muestra con licencia: Google Imágenes las marca como "con licencia" y enlaza a la página para comprarlas.
    credit = ', '.join(p['displayName'] for p in phs) or 'Quiero Mis Fotos'
    img_ld = [{'@context': 'https://schema.org', '@type': 'ImageObject', 'contentUrl': p['previewUrl'], 'thumbnailUrl': p.get('thumbUrl'),
               'name': f'Foto de {name}', 'creditText': credit, 'creator': {'@type': 'Person', 'name': credit},
               'copyrightNotice': f'© {credit}', 'license': f'{SITE}/terminos/', 'acquireLicensePage': f'{SITE}/e/{ev["id"]}/'}
              for p in photos if p.get('previewUrl')][:6]
    write(f'e/{ev["id"]}', page(title, desc, f'{SITE}/e/{ev["id"]}/', body, first_img, [ld, crumb_ld, *img_ld], redirect=app))
    urls.append((f'{SITE}/e/{ev["id"]}/', ev.get('date')))
    images[f'{SITE}/e/{ev["id"]}/'] = ([(first_img, name)] if first_img else []) + [(p['previewUrl'], f'Foto de {name}') for p in photos if p.get('previewUrl') and p['previewUrl'] != first_img]

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
    zone_slug = slugify(u.get('zone'))
    p_crumb, p_crumb_ld = crumbs([('Inicio', '/'), ('Fotógrafos', '/fotografos/')] + ([(u['zone'], f'/fotografos/{zone_slug}/')] if zone_slug else []) + [(u.get('displayName') or slug, f'/f/{slug}/')])
    body = f'''
      {p_crumb}
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
    write(f'f/{slug}', page(title, desc, f'{SITE}/f/{slug}/', body, (pf[0]['url'] if pf else u.get('avatarUrl')), [ld, p_crumb_ld], redirect=app))
    if pf: images[f'{SITE}/f/{slug}/'] = [(x['url'], f'Foto de {u.get("displayName")}') for x in pf if x.get('url')]
    urls.append((f'{SITE}/f/{slug}/', None))
    # Web personal (planes Web): también al sitemap
    plan_ok = u.get('plan') in ('web', 'webdomain', 'empresa') and (u.get('proUntil') or '') > datetime.datetime.now(datetime.timezone.utc).isoformat()
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

# ---------------------------------------------------------------- fotos por deporte: /fotos/ y /fotos/{deporte}/
SPORT_INTRO = 'Encontrá tus fotos de {s}: partidos, torneos y eventos de {s} con fotos a la venta. Buscate por horario, dorsal o con una selfie, y descargalas en alta calidad, sin marca de agua.'
sport_pages = []
for sid, sp in sports.items():
    evs = [ev for ev in events if sid in (ev.get('tagIds') or [])]
    phs = [u for u in users.values() if sid in (u.get('specialties') or []) and u.get('slug')]
    if not evs and not phs: continue
    sname = sp['name']; slug = sp.get('slug') or slugify(sname)
    sport_pages.append((slug, sname, len(evs)))
    c_html, c_ld = crumbs([('Inicio', '/'), ('Fotos por deporte', '/fotos/'), (sname, f'/fotos/{slug}/')])
    body = f'''{c_html}
      <h1>Fotos de {e(sname.lower())}</h1>
      <p class="muted" style="max-width:65ch">{e(SPORT_INTRO.format(s=sname.lower()))}</p>
      {f'<h2>Eventos de {e(sname.lower())} con fotos</h2><div class="events-grid">{"".join(event_card(ev) for ev in evs)}</div>' if evs else ''}
      {f'<h2>Fotógrafos de {e(sname.lower())}</h2><div class="dir-grid">' + "".join(f'<a class="dir-card" href="/f/{e(u["slug"])}/" style="text-decoration:none"><strong>{e(u.get("displayName"))}</strong><span class="muted small">{e(u.get("zone"))}</span></a>' for u in phs) + '</div>' if phs else ''}
      <div class="card stack" style="margin-top:20px"><strong>¿Sacás fotos de {e(sname.lower())}?</strong><span>Subí tus eventos, la marca de agua se pone sola y cobrás directo con Mercado Pago.</span><a class="btn primary" style="justify-self:start" href="/soy-fotografo/">Vender mis fotos</a></div>'''
    ld = [c_ld, {'@context': 'https://schema.org', '@type': 'CollectionPage', 'name': f'Fotos de {sname.lower()}', 'url': f'{SITE}/fotos/{slug}/',
                 'mainEntity': {'@type': 'ItemList', 'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'url': f'{SITE}/e/{ev["id"]}/', 'name': ev.get('name')} for i, ev in enumerate(evs[:30])]}}]
    first = next((ev.get('coverUrl') or ev.get('autoCoverUrl') for ev in evs if ev.get('coverUrl') or ev.get('autoCoverUrl')), None)
    write(f'fotos/{slug}', page(f'Fotos de {sname.lower()} · partidos, torneos y eventos | Quiero Mis Fotos', SPORT_INTRO.format(s=sname.lower())[:158],
                                f'{SITE}/fotos/{slug}/', body, first, ld))
    urls.append((f'{SITE}/fotos/{slug}/', evs[0].get('date') if evs else None))
if sport_pages:
    c_html, c_ld = crumbs([('Inicio', '/'), ('Fotos por deporte', '/fotos/')])
    write('fotos', page('Fotos por deporte · fútbol, rugby, running y más | Quiero Mis Fotos',
                        'Encontrá las fotos de tu deporte: fútbol, futsal, rugby, hockey, running, básquet, vóley y más. Buscate y descargalas en alta calidad.',
                        f'{SITE}/fotos/', f'''{c_html}<h1>Fotos por deporte</h1><p class="muted">Elegí tu deporte y encontrá tu evento.</p>
                        <div class="dir-grid">{"".join(f'<a class="dir-card" href="/fotos/{e(sl)}/" style="text-decoration:none"><strong>{e(n)}</strong><span class="muted small">{c} evento{"" if c == 1 else "s"}</span></a>' for sl, n, c in sorted(sport_pages, key=lambda x: -x[2]))}</div>''', None, c_ld))
    urls.append((f'{SITE}/fotos/', None))

# ---------------------------------------------------------------- fotógrafos por zona: /fotografos/{zona}/
zones = {}
for u in users.values():
    zs = slugify(u.get('zone'))
    if zs and u.get('slug'):
        zn = u['zone'].strip()
        zones.setdefault(zs, {'name': zn.title() if zn == zn.lower() else zn, 'users': []})['users'].append(u)
for zs, z in zones.items():
    c_html, c_ld = crumbs([('Inicio', '/'), ('Fotógrafos', '/fotografos/'), (z['name'], f'/fotografos/{zs}/')])
    acts = sorted({sports[t]['name'] for u in z['users'] for t in (u.get('specialties') or []) if t in sports})
    body = f'''{c_html}
      <h1>Fotógrafos deportivos en {e(z["name"])}</h1>
      <p class="muted" style="max-width:65ch">Fotógrafos de {e(z["name"])} para tu partido, torneo, carrera o evento{(" de " + e(", ".join(a.lower() for a in acts))) if acts else ""}. Mirá su trabajo y pediles presupuesto por WhatsApp.</p>
      <div class="dir-grid">{"".join(f'<a class="dir-card" href="/f/{e(u["slug"])}/" style="text-decoration:none"><strong>{e(u.get("displayName"))}</strong><span class="muted small">{e(", ".join(sports[t]["name"] for t in (u.get("specialties") or []) if t in sports) or u.get("zone"))}</span></a>' for u in z['users'])}</div>'''
    ld = [c_ld, {'@context': 'https://schema.org', '@type': 'ItemList', 'name': f'Fotógrafos deportivos en {z["name"]}',
                 'itemListElement': [{'@type': 'ListItem', 'position': i + 1, 'url': f'{SITE}/f/{u["slug"]}/', 'name': u.get('displayName')} for i, u in enumerate(z['users'])]}]
    write(f'fotografos/{zs}', page(f'Fotógrafos deportivos en {z["name"]} | Quiero Mis Fotos', f'Encontrá fotógrafos deportivos y de eventos en {z["name"]}. Mirá su portfolio y pediles presupuesto.',
                                   f'{SITE}/fotografos/{zs}/', body, None, ld))
    urls.append((f'{SITE}/fotografos/{zs}/', None))

# ---------------------------------------------------------------- guías para fotógrafos: /guias/ y /guias/{guia}/
for g in GUIDES:
    c_html, c_ld = crumbs([('Inicio', '/'), ('Guías para fotógrafos', '/guias/'), (g['h1'], f'/guias/{g["slug"]}/')])
    others = ''.join(f'<li><a href="/guias/{x["slug"]}/">{e(x["h1"])}</a></li>' for x in GUIDES if x['slug'] != g['slug'])
    body = f'''{c_html}<article class="guide" style="max-width:68ch">
      <h1>{e(g["h1"])}</h1><p class="muted small">Actualizado: {e(fmt_date(g["date"]))}</p>{g["body"]}
      <div class="card stack" style="margin-top:24px"><strong>Vendé tus fotos en Quiero Mis Fotos</strong><span>Empezá gratis: subís tus eventos, la marca de agua se pone sola y cobrás directo con Mercado Pago.</span><a class="btn primary" style="justify-self:start" href="/soy-fotografo/">Conocer la plataforma</a></div>
      <h2>Otras guías</h2><ul>{others}</ul></article>'''
    ld = [c_ld, {'@context': 'https://schema.org', '@type': 'Article', 'headline': g['h1'], 'description': g['desc'], 'datePublished': g['date'], 'dateModified': g['date'],
                 'inLanguage': 'es-AR', 'mainEntityOfPage': f'{SITE}/guias/{g["slug"]}/', 'image': f'{SITE}/assets/og-image.png',
                 'author': {'@type': 'Organization', 'name': 'Quiero Mis Fotos', 'url': SITE}, 'publisher': {'@type': 'Organization', 'name': 'Quiero Mis Fotos', 'logo': {'@type': 'ImageObject', 'url': f'{SITE}/assets/logo-512.png'}}}]
    write(f'guias/{g["slug"]}', page(f'{g["title"]} | Quiero Mis Fotos', g['desc'], f'{SITE}/guias/{g["slug"]}/', body, None, ld))
    urls.append((f'{SITE}/guias/{g["slug"]}/', g['date']))
c_html, c_ld = crumbs([('Inicio', '/'), ('Guías para fotógrafos', '/guias/')])
write('guias', page('Guías para fotógrafos deportivos | Quiero Mis Fotos', 'Guías prácticas para fotógrafos deportivos: cómo vender tus fotos online, cuánto cobrar y cómo compartirlas para vender más.',
                    f'{SITE}/guias/', f'''{c_html}<h1>Guías para fotógrafos deportivos</h1><p class="muted">Todo lo que necesitás para vender las fotos de tus eventos.</p>
                    <div class="dir-grid">{"".join(f'<a class="dir-card" href="/guias/{g["slug"]}/" style="text-decoration:none"><strong>{e(g["h1"])}</strong><span class="muted small">{e(g["desc"][:110])}…</span></a>' for g in GUIDES)}</div>''', None, c_ld))
urls.append((f'{SITE}/guias/', None))

# ---------------------------------------------------------------- "Soy fotógrafo" (para que Google la encuentre)
# La del sitio (#/soy-fotografo) tiene animación y calculadora, pero Google no indexa rutas con #.
# Precios y condiciones: los de Plataforma, con el mismo cálculo que el sitio (js/plans-core.js, vía node).
st = get('settings/platform') or {}
PLAN_IDS = [('free', 'Gratis'), ('lite', 'Profesional Lite'), ('web', 'Profesional'), ('webdomain', 'Profesional Premium'), ('empresa', 'Empresas')]
js = ("import { planSpec, planFeatures } from './js/plans-core.js';"
      "const st = JSON.parse(process.argv[1]);"
      "console.log(JSON.stringify(Object.fromEntries(['free','lite','web','webdomain','empresa'].map(id => [id, { ...planSpec(id, st), items: planFeatures(id, st) }]))));")
plans = json.loads(subprocess.check_output(['node', '--input-type=module', '-e', js, json.dumps(st, default=str)], cwd=ROOT))
money = lambda n: '$' + f'{int(n):,}'.replace(',', '.')
free_fee = str(plans['free']['fee']).replace('.', ',')
# Promo de comisión vigente (la calcula plans-core.js): se muestra arriba de los planes.
promo_until = plans['lite'].get('promoUntil') or plans['free'].get('promoUntil')
MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
promo_html = (f'<div class="lp-promo">🎉 <strong>Promo de lanzamiento: comisión del {free_fee}% en todos los planes</strong> hasta el '
              f'{int(promo_until[8:10])} de {MESES[int(promo_until[5:7]) - 1]}. Registrate ahora y vendé pagando menos.</div>') if promo_until else ''
FAQ = [
    ('¿Cuánto cuesta vender fotos en Quiero Mis Fotos?', f'Podés empezar gratis: sin costo fijo, solo una comisión del {free_fee}% por venta más la comisión de Mercado Pago. Los planes pagos bajan la comisión y suman álbumes ilimitados, web propia y dominio.'),
    ('¿Cómo cobro las fotos que vendo?', 'Cada venta se paga con Mercado Pago y la plata entra directo a tu cuenta. Vos elegís en Mercado Pago el plazo de acreditación: al instante o a más días, con menos comisión.'),
    *([('¿Puedo cobrar por transferencia?', f'Sí, en {", ".join(n for i, n in PLAN_IDS if i in (st.get("transfer") or {}).get("plans", []))}. Tus clientes te transfieren a tu alias de Mercado Pago y la venta se acredita sola: no pagás la comisión de Mercado Pago. La comisión de Quiero Mis Fotos se acumula y la pagás aparte por transferencia.')]
      if (st.get('transfer') or {}).get('plans') else []),
    ('¿Qué deportes y eventos puedo subir?', 'Fútbol, rugby, hockey, básquet, vóley, running, maratones, ciclismo, triatlón, eventos escolares y cualquier evento deportivo o social donde la gente quiera sus fotos.'),
    ('¿Tengo que poner la marca de agua a mano?', 'No. Subís las fotos y la plataforma les pone tu marca de agua, arma la galería y guarda los originales. El comprador descarga la foto en alta calidad y sin marca después de pagar.'),
    ('¿Cómo encuentran sus fotos los deportistas?', 'Por evento, por horario y, en carreras, por número de dorsal: la plataforma lee los dorsales de las fotos. Vos compartís un link por evento en WhatsApp o Instagram.'),
    ('¿Puedo subir desde el celular?', 'Sí. Subís cientos de fotos desde la compu o el celular, y si se corta la conexión la subida sigue sola.'),
    ('¿Puedo poner mis propios precios?', 'Sí. Precio por foto, packs (por ejemplo 5 fotos a un precio menor) y precios distintos por álbum o por foto.'),
]
STEPS = [('📸', 'Subís las fotos', 'Desde la compu o el celular, de a cientos. Se ordenan solas por hora y las podés separar en sub-álbumes.'),
         ('🪄', 'Nosotros las preparamos', 'Marca de agua automática, galería lista para compartir y originales guardados seguros.'),
         ('🔗', 'Compartís el link', 'Un link por evento para el grupo del club, Instagram o WhatsApp, con la portada del evento.'),
         ('💰', 'Cobrás directo', 'Cada venta entra a tu Mercado Pago y el comprador descarga sus fotos en alta calidad al instante.')]
plan_cards = ''.join(f'''<div class="lp-plan{' hot' if pid == 'web' else ''}"><h3>{e(name)}</h3>
  <div class="lp-price">{money(plans[pid]['price']) + '<small>/mes</small>' if plans[pid]['price'] else '$0'}</div>
  {f'<p class="muted small">o {money(plans[pid]["year"])}/año</p>' if plans[pid].get('year') else ''}
  <ul>{''.join(f'<li class="plan-hl">🏦 <strong>{e(t)}</strong></li>' if t.startswith('Cobrá por transferencia') else f'<li>{e(t)}</li>' for t in plans[pid]['items'])}</ul>
  <a class="btn{' primary' if pid == 'web' else ''}" href="/panel.html?plan={pid}">{'Empezar gratis' if pid == 'free' else 'Quiero este plan'}</a></div>''' for pid, name in PLAN_IDS)
soy_body = f'''<div class="lp">
<section class="lp-hero"><div class="lp-hero-txt">
  <h1>Vendé tus fotos de eventos deportivos online</h1>
  <p>Quiero Mis Fotos es la plataforma para fotógrafos deportivos de Argentina: subís las fotos de tus partidos, torneos y carreras, y los deportistas las encuentran, las pagan con Mercado Pago y las descargan en alta calidad. Sin armar una web, sin mandar fotos una por una por WhatsApp y sin perseguir a nadie para cobrar.</p>
  <div class="row"><a class="btn primary" href="/panel.html?plan=free">Crear mi cuenta gratis</a><a class="btn" href="/#/soy-fotografo">Ver la calculadora de ganancias</a></div>
  <p class="muted small">Sin costo fijo para arrancar: solo una comisión del {free_fee}% cuando vendés, más la comisión de Mercado Pago.</p>
</div></section>
<section class="lp-sec"><h2>Cómo funciona</h2><div class="lp-steps">{''.join(f'<div class="lp-step"><span class="lp-n">{i + 1}</span><span class="lp-ic">{ic}</span><h3>{e(t)}</h3><p>{e(d)}</p></div>' for i, (ic, t, d) in enumerate(STEPS))}</div></section>
<section class="lp-sec"><h2>Todo lo que necesitás para vender tus fotos</h2><ul>
  <li><strong>Tus precios:</strong> por foto, packs y precios especiales; al comprador se le aplica solo la combinación más barata.</li>
  <li><strong>Búsqueda por dorsal</strong> en carreras y filtro por horario: el deportista encuentra su foto rápido y compra más.</li>
  <li><strong>Aviso de cada venta</strong> en tu celular y estadísticas de visitas y ventas por evento.</li>
  <li><strong>Seguidores:</strong> la gente te sigue y le avisamos cuando subís fotos nuevas.</li>
  <li><strong>Perfil y portfolio</strong> con botón de WhatsApp para que te pidan presupuesto.</li>
  <li><strong>Tu propia web</strong> (tunombre.quieromisfotos.com.ar) o tu dominio .com.ar, con los planes Profesional.</li>
  <li><strong>Plan Empresas</strong> para productoras y equipos de fotógrafos: cada uno sube a tus álbumes y vos cobrás todo.</li>
</ul></section>
<section class="lp-sec" id="planes"><h2>Planes para fotógrafos</h2>{promo_html}<div class="lp-plans four">{plan_cards}</div>
  <p class="muted small">A la comisión de cada plan se suma la de Mercado Pago, que depende del plazo de cobro que elijas. Los planes pagos se cobran por Mercado Pago y los cancelás cuando quieras.</p></section>
<section class="lp-sec lp-faq"><h2>Preguntas frecuentes</h2>{''.join(f'<details><summary>{e(q)}</summary><p>{e(a)}</p></details>' for q, a in FAQ)}</section>
<section class="lp-final"><h2>¿Arrancamos?</h2><p>Creá tu cuenta en un minuto, subí tu primer evento y compartí el link hoy mismo.</p>
  <a class="btn primary" href="/panel.html?plan=free">Crear mi cuenta gratis</a></section>
</div>'''
soy_ld = [
    {'@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': [{'@type': 'Question', 'name': q, 'acceptedAnswer': {'@type': 'Answer', 'text': a}} for q, a in FAQ]},
    {'@context': 'https://schema.org', '@type': 'Service', 'name': 'Venta de fotos deportivas online para fotógrafos', 'serviceType': 'Plataforma para vender fotos de eventos',
     'areaServed': {'@type': 'Country', 'name': 'Argentina'}, 'provider': {'@type': 'Organization', 'name': 'Quiero Mis Fotos', 'url': SITE},
     'offers': [{'@type': 'Offer', 'name': name, 'price': plans[pid]['price'], 'priceCurrency': 'ARS'} for pid, name in PLAN_IDS]},
]
write('soy-fotografo', page('Vendé tus fotos deportivas online · Plataforma para fotógrafos | Quiero Mis Fotos',
                            f'Plataforma para fotógrafos deportivos en Argentina: subí las fotos de tus eventos, marca de agua automática, búsqueda por dorsal y cobro directo con Mercado Pago. Empezá gratis.',
                            f'{SITE}/soy-fotografo/', soy_body, jsonld=soy_ld))
urls.insert(1, (f'{SITE}/soy-fotografo/', None))

today = datetime.date.today().isoformat()
def img_tags(u):
    return ''.join(f'<image:image><image:loc>{e(src)}</image:loc></image:image>' for src, _ in images.get(u, [])[:12] if src)
(ROOT / 'sitemap.xml').write_text('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n' +
                                  ''.join(f'  <url><loc>{e(u)}</loc>{f"<lastmod>{d}</lastmod>" if d else ""}{img_tags(u)}</url>\n' for u, d in urls) + '</urlset>\n')
(ROOT / 'robots.txt').write_text(f'User-agent: *\nAllow: /\nDisallow: /panel.html\n\nSitemap: {SITE}/sitemap.xml\n')
print(f'SEO ok: {len(events)} eventos, {len(users)} fotógrafos, {len(urls)} URLs en el sitemap')
