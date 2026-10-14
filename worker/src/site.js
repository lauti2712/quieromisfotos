// Web personal del fotógrafo (planes Web y Web + Dominio). HTML armado en el servidor (SEO + vista previa en WhatsApp),
// cacheado 5 minutos. Se sirve en {slug}.quieromisfotos.com.ar, en el dominio propio del fotógrafo o en /w/{slug}.
import { adminGet, adminQuery } from './admin.js';
import { siteUrl } from './mp.js';

const PAID_WEB = ['web', 'webdomain'];
const TEMPLATES = ['clasica', 'oscura', 'minimal'];
const CACHE_SECONDS = 300;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function waNumber(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);
  if (d.length === 12 && !d.startsWith('54')) { const k = [2, 3, 4].find(n => d.slice(n, n + 2) === '15'); if (k) d = d.slice(0, k) + d.slice(k + 2); }
  if (d.length === 10) d = `549${d}`;
  else if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) d = `549${d.slice(2)}`;
  return d;
}

const SOCIAL = {
  instagram: v => `https://instagram.com/${String(v).replace(/^@/, '')}`,
  facebook: v => (String(v).startsWith('http') ? v : `https://facebook.com/${v}`),
  web: v => (String(v).startsWith('http') ? v : `https://${v}`),
};

const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
};

// Resuelve qué web mostrar: por slug (/w/{slug} o subdominio) o por dominio propio activado (domains/{host}).
export async function resolveSite(env, { slug, host }) {
  let uid = null;
  if (slug) uid = (await adminGet(env, `slugs/${slug}`))?.uid;
  else if (host) uid = (await adminGet(env, `domains/${host}`))?.uid;
  return uid;
}

export async function renderSite(req, env, ctx, { slug, host }) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(req.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const uid = await resolveSite(env, { slug, host });
  const user = uid ? await adminGet(env, `users/${uid}`) : null;
  const paid = user && PAID_WEB.includes(user.plan) && user.proUntil && user.proUntil.getTime() > Date.now();
  // Sin plan Web activo: al perfil en Quiero Mis Fotos.
  if (!user || user.status !== 'approved' || !paid) {
    const to = user?.slug ? `${siteUrl(env)}#/f/${user.slug}` : siteUrl(env);
    return new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });
  }

  const [items, events, tax] = await Promise.all([
    adminQuery(env, 'portfolio', { filters: [['photographerUid', '==', uid]], limit: 300 }),
    adminQuery(env, 'events', { filters: [['photographerUids', 'array-contains', uid], ['status', '==', 'published']], orderBy: [['date', 'desc']], limit: 12 }),
    adminGet(env, 'settings/tags'),
  ]);
  const settings = (await adminGet(env, 'settings/platform')) || {};
  const limit = settings.proPortfolioLimit || 200;
  const site = user.site || {};
  const clean = !!site.clean;
  const photos = items.filter(p => p.slot < limit && p.url)
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.slot - b.slot)
    .map(p => {
      const src = clean && p.cleanUrl ? p.cleanUrl : p.url;
      // Sin marca: la miniatura guardada tiene marca, así que la grilla usa la versión limpia.
      return { src, thumb: clean && p.cleanUrl ? p.cleanUrl : p.thumbUrl, caption: p.caption || '', album: (p.album || '').trim() };
    });

  const html = page({ env, user, site, photos, events: events.filter(e => !e.demo), tax, slug: user.slug });
  const res = new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=60, s-maxage=${CACHE_SECONDS}` },
  });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

function page({ env, user, site, photos, events, tax, slug }) {
  const tpl = TEMPLATES.includes(site.template) ? site.template : 'clasica';
  const accent = /^#[0-9a-fA-F]{6}$/.test(site.accent || '') ? site.accent : '#ff5a1f';
  const hero = photos.find(p => p.src === site.heroUrl) || photos[0];
  const tagline = site.tagline || user.bio?.split('\n')[0] || 'Fotografía';
  const tagName = id => (tax?.tags || []).find(t => t.id === id)?.name;
  const activities = (user.specialties || []).map(tagName).filter(Boolean);
  const albums = [...new Set(photos.map(p => p.album).filter(Boolean))];
  const services = (site.services || []).filter(s => s.name);
  const wa = user.socials?.whatsapp ? `https://wa.me/${waNumber(user.socials.whatsapp)}?text=${encodeURIComponent(`¡Hola ${user.displayName}! Vi tu web y quería consultarte por `)}` : '';
  const socials = Object.entries(SOCIAL).filter(([k]) => user.socials?.[k]).map(([k, f]) => `<a href="${esc(f(user.socials[k]))}" target="_blank" rel="noopener">${k === 'web' ? 'Web' : k[0].toUpperCase() + k.slice(1)}</a>`);
  const gear = (user.gear || []).filter(g => g.name);
  const site0 = siteUrl(env);
  const desc = `${user.displayName} · ${tagline}${user.zone ? ` · ${user.zone}` : ''}`;

  return `<!doctype html>
<html lang="es-AR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(user.displayName)} · Fotografía</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(user.displayName)}">
<meta property="og:description" content="${esc(desc)}">
${hero ? `<meta property="og:image" content="${esc(hero.src)}">` : ''}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="${accent}">
${user.avatarUrl ? `<link rel="icon" href="${esc(user.avatarUrl)}">` : ''}
<style>
:root{--a:${accent};--bg:#ffffff;--fg:#14161b;--mu:#5d6573;--card:#f4f5f7;--bd:#e3e6eb}
body.oscura{--bg:#0d0f13;--fg:#f1f2f4;--mu:#9aa3b2;--card:#171a21;--bd:#262b35}
body.minimal{--card:#ffffff;--bd:#ececec}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
a{color:inherit}img{display:block;max-width:100%}
.wrap{max-width:1180px;margin:0 auto;padding:0 20px}
nav{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--bd)}
nav .wrap{display:flex;align-items:center;gap:18px;height:62px}
nav .brand{display:flex;align-items:center;gap:10px;font-weight:800;text-decoration:none;letter-spacing:-.01em}
nav .brand img{width:34px;height:34px;border-radius:50%;object-fit:cover}
nav .links{margin-left:auto;display:flex;gap:18px;font-size:.92rem}
nav .links a{text-decoration:none;color:var(--mu)}nav .links a:hover{color:var(--fg)}
@media(max-width:720px){nav .links{display:none}}
.btn{display:inline-flex;align-items:center;gap:8px;background:var(--a);color:#fff;border:0;border-radius:999px;padding:12px 22px;font-weight:700;text-decoration:none;cursor:pointer;font:inherit;font-weight:700}
.btn.ghost{background:transparent;color:inherit;border:1.5px solid currentColor}
.hero{position:relative;min-height:78vh;display:grid;align-items:end;color:#fff;overflow:hidden;background:#111}
.hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.hero::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,.05) 30%,rgba(0,0,0,.72))}
.hero .wrap{position:relative;z-index:1;padding-bottom:56px}
.hero h1{font-size:clamp(2.3rem,7vw,4.6rem);line-height:1.02;letter-spacing:-.03em;margin:0 0 10px}
.hero p{font-size:clamp(1.05rem,2.6vw,1.35rem);margin:0 0 22px;opacity:.92;max-width:680px}
body.minimal .hero{min-height:auto;background:none;color:var(--fg);padding:70px 0 10px}
body.minimal .hero img,body.minimal .hero::after{display:none}
body.minimal .hero .wrap{padding-bottom:10px}
section{padding:64px 0}
h2{font-size:clamp(1.6rem,4vw,2.3rem);letter-spacing:-.02em;margin:0 0 22px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.tabs button{border:1px solid var(--bd);background:var(--card);color:var(--fg);border-radius:999px;padding:7px 16px;font:inherit;font-size:.9rem;cursor:pointer}
.tabs button.on{background:var(--a);border-color:var(--a);color:#fff}
.grid{columns:3 260px;column-gap:12px}
.grid figure{margin:0 0 12px;break-inside:avoid;cursor:zoom-in;border-radius:10px;overflow:hidden;background:var(--card)}
.grid img{width:100%;height:auto;transition:transform .3s}.grid figure:hover img{transform:scale(1.02)}
.about{display:grid;grid-template-columns:200px 1fr;gap:36px;align-items:start}
@media(max-width:720px){.about{grid-template-columns:1fr}}
.about img{width:200px;height:200px;border-radius:50%;object-fit:cover}
.pills{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.pill{background:var(--card);border:1px solid var(--bd);border-radius:999px;padding:4px 12px;font-size:.88rem}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}
.card{background:var(--card);border:1px solid var(--bd);border-radius:14px;padding:18px}
.card strong{display:block;margin-bottom:4px}.card .price{color:var(--a);font-weight:800;font-size:1.15rem}
.ev{text-decoration:none;display:grid;gap:4px}
.ev .date{color:var(--a);font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.ev .cta{margin-top:6px;font-size:.9rem;font-weight:700;color:var(--a)}
.contact{text-align:center;background:var(--card);border-top:1px solid var(--bd);border-bottom:1px solid var(--bd)}
.contact .row{display:flex;justify-content:center;flex-wrap:wrap;gap:12px;margin-top:18px}
.muted{color:var(--mu)}
footer{padding:28px 0;text-align:center;font-size:.85rem;color:var(--mu)}
footer a{color:var(--a);text-decoration:none;font-weight:600}
.lb{position:fixed;inset:0;z-index:20;background:rgba(5,6,8,.95);display:none;align-items:center;justify-content:center;padding:56px 60px}
.lb.on{display:flex}.lb img{max-width:100%;max-height:100%;object-fit:contain;border-radius:4px}
.lb button{position:absolute;background:rgba(255,255,255,.12);color:#fff;border:0;border-radius:50%;width:44px;height:44px;font-size:22px;cursor:pointer}
.lb .x{top:12px;right:12px}.lb .p{left:10px;top:50%}.lb .n{right:10px;top:50%}
.lb .cap{position:absolute;bottom:14px;left:0;right:0;text-align:center;color:#ddd;font-size:.9rem}
@media(max-width:640px){.lb{padding:50px 0}.lb .p,.lb .n{display:none}}
.wa{position:fixed;right:18px;bottom:18px;z-index:6;width:56px;height:56px;border-radius:50%;background:#25d366;display:grid;place-items:center;box-shadow:0 6px 20px rgba(0,0,0,.25)}
</style>
</head>
<body class="${tpl}">
<nav><div class="wrap">
  <a class="brand" href="#inicio">${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="">` : ''}${esc(user.displayName)}</a>
  <div class="links">
    ${photos.length ? '<a href="#galeria">Galería</a>' : ''}<a href="#sobre-mi">Sobre mí</a>
    ${services.length ? '<a href="#servicios">Servicios</a>' : ''}${events.length ? '<a href="#eventos">Eventos</a>' : ''}<a href="#contacto">Contacto</a>
  </div>
</div></nav>

<header class="hero" id="inicio">
  ${hero ? `<img src="${esc(hero.src)}" alt="">` : ''}
  <div class="wrap">
    <h1>${esc(user.displayName)}</h1>
    <p>${esc(tagline)}${user.zone ? ` · ${esc(user.zone)}` : ''}</p>
    ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">💬 Pedir presupuesto</a>` : ''}
  </div>
</header>

${photos.length ? `<section id="galeria"><div class="wrap">
  <h2>Galería</h2>
  ${albums.length > 1 ? `<div class="tabs"><button class="on" data-album="">Todas</button>${albums.map(a => `<button data-album="${esc(a)}">${esc(a)}</button>`).join('')}</div>` : ''}
  <div class="grid">${photos.map((p, i) => `<figure data-i="${i}" data-album="${esc(p.album)}"><img src="${esc(p.thumb || p.src)}" data-full="${esc(p.src)}" alt="${esc(p.caption)}" loading="lazy"></figure>`).join('')}</div>
</div></section>` : ''}

<section id="sobre-mi"${photos.length ? '' : ' style="padding-top:40px"'}><div class="wrap about">
  ${user.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="${esc(user.displayName)}">` : '<span></span>'}
  <div>
    <h2>Sobre mí</h2>
    ${user.bio ? `<p style="white-space:pre-line;margin:0">${esc(user.bio)}</p>` : ''}
    ${user.workZones ? `<p class="muted">📍 Trabajo en ${esc(user.workZones)}</p>` : ''}
    ${activities.length || (user.services || []).length ? `<div class="pills">${activities.map(a => `<span class="pill">${esc(a)}</span>`).join('')}${(user.services || []).map(a => `<span class="pill">${esc(a)}</span>`).join('')}</div>` : ''}
    ${gear.length ? `<p class="muted" style="margin-top:18px"><strong style="color:var(--fg)">📷 Equipo:</strong> ${gear.map(g => esc(g.name)).join(' · ')}</p>` : ''}
  </div>
</div></section>

${services.length ? `<section id="servicios" style="padding-top:0"><div class="wrap">
  <h2>Servicios</h2>
  <div class="cards">${services.map(s => `<div class="card"><strong>${esc(s.name)}</strong>${s.detail ? `<span class="muted">${esc(s.detail)}</span>` : ''}${s.price ? `<div class="price">${esc(s.price)}</div>` : ''}</div>`).join('')}</div>
  <p class="muted" style="font-size:.85rem;margin-top:12px">Precios de referencia. Consultá por tu evento.</p>
</div></section>` : ''}

${events.length && site.showEvents !== false ? `<section id="eventos" style="padding-top:0"><div class="wrap">
  <h2>Eventos</h2>
  <p class="muted" style="margin-top:-12px">¿Estuviste en alguno? Buscate y descargá tus fotos.</p>
  <div class="cards">${events.map(e => `<a class="card ev" href="${esc(site0)}#/evento/${esc(e.id)}?f=${esc(user.id)}" target="_blank" rel="noopener">
    <span class="date">${esc(fmtDate(e.date))}</span><strong>${esc(e.name)}</strong>${e.location ? `<span class="muted">📍 ${esc(e.location)}</span>` : ''}<span class="cta">Ver y comprar fotos →</span></a>`).join('')}</div>
</div></section>` : ''}

<section class="contact" id="contacto"><div class="wrap">
  <h2>¿Hablamos?</h2>
  <p class="muted">Contame qué necesitás y te paso un presupuesto.</p>
  <div class="row">
    ${wa ? `<a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>` : ''}
    ${socials.map(s => s.replace('<a ', '<a class="btn ghost" ')).join('')}
  </div>
</div></section>

<footer>
  Web creada con <a href="${esc(site0)}" target="_blank" rel="noopener">Quiero Mis Fotos</a><br>
  Desarrollado por <a href="https://solucionescotidianas.com.ar" target="_blank" rel="noopener">Soluciones Cotidianas</a>
</footer>

${wa ? `<a class="wa" href="${esc(wa)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg width="28" height="28" viewBox="0 0 24 24" fill="#fff"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm5.3 14.2c-.2.6-1.3 1.2-1.8 1.2-.5.1-1 .2-3.4-.7-2.9-1.1-4.7-4-4.9-4.2-.1-.2-1.2-1.6-1.2-3s.7-2.1 1-2.4c.3-.3.6-.4.8-.4h.6c.2 0 .4 0 .6.5l.9 2.1c.1.2.1.4 0 .6l-.4.6-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.2 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.9-1.1c.2-.3.4-.2.7-.1l2 1c.3.1.5.2.5.3.1.2.1.7-.1 1.3Z"/></svg></a>` : ''}

<div class="lb" id="lb" role="dialog" aria-label="Foto"><button class="x" aria-label="Cerrar">✕</button><button class="p" aria-label="Anterior">‹</button><img alt=""><button class="n" aria-label="Siguiente">›</button><div class="cap"></div></div>
<script>
(function(){
  var figs=[].slice.call(document.querySelectorAll('.grid figure')),lb=document.getElementById('lb'),img=lb.querySelector('img'),cap=lb.querySelector('.cap'),i=0;
  function vis(){return figs.filter(function(f){return f.style.display!=='none'})}
  function show(k){var v=vis();if(!v.length)return;i=(k+v.length)%v.length;var im=v[i].querySelector('img');img.src=im.dataset.full;cap.textContent=im.alt||'';lb.classList.add('on');document.body.style.overflow='hidden'}
  function close(){lb.classList.remove('on');document.body.style.overflow=''}
  figs.forEach(function(f){f.addEventListener('click',function(){show(vis().indexOf(f))})});
  lb.querySelector('.x').onclick=close;lb.querySelector('.p').onclick=function(){show(i-1)};lb.querySelector('.n').onclick=function(){show(i+1)};
  lb.addEventListener('click',function(e){if(e.target===lb)close()});
  document.addEventListener('keydown',function(e){if(!lb.classList.contains('on'))return;if(e.key==='Escape')close();if(e.key==='ArrowLeft')show(i-1);if(e.key==='ArrowRight')show(i+1)});
  var x0=null;lb.addEventListener('touchstart',function(e){x0=e.touches[0].clientX},{passive:true});lb.addEventListener('touchend',function(e){if(x0===null)return;var d=e.changedTouches[0].clientX-x0;if(Math.abs(d)>40)show(d<0?i+1:i-1);x0=null});
  img.addEventListener('contextmenu',function(e){e.preventDefault()});
  [].slice.call(document.querySelectorAll('.tabs button')).forEach(function(b){b.addEventListener('click',function(){
    document.querySelectorAll('.tabs button').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
    figs.forEach(function(f){f.style.display=!b.dataset.album||f.dataset.album===b.dataset.album?'':'none'});
  })});
})();
</script>
</body>
</html>`;
}
