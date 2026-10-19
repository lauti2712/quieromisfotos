// Links para compartir con vista previa al instante (WhatsApp, Instagram, Facebook): ver.quieromisfotos.com.ar/e/{id}
// arma en el momento la página con título, foto y descripción (og:*) y lleva a la galería. Las páginas /e/{id}/ del sitio
// se generan cada hora para Google; un evento recién creado no tenía vista previa hasta entonces.
//   /e/{eventId}?f={uid}&foto={photoId}&dorsal={n}
import { adminGet } from './admin.js';
import { siteUrl } from './mp.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = iso => {
  if (!iso) return '';
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
};

function page({ title, desc, image, target, canonical }) {
  return `<!doctype html>
<html lang="es-AR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Quiero Mis Fotos">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:url" content="${esc(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="canonical" href="${esc(canonical)}">
<meta http-equiv="refresh" content="0;url=${esc(target)}">
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>
</head><body style="font-family:system-ui,sans-serif;padding:24px"><p>Abriendo <a href="${esc(target)}">${esc(title)}</a>…</p></body></html>`;
}

export async function sharePage(req, env, ctx) {
  const url = new URL(req.url);
  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  const site = siteUrl(env).replace(/\/?$/, '/');
  const [, kind, id] = url.pathname.split('/');
  const home = Response.redirect(site, 302);
  if (kind !== 'e' || !ID_RE.test(id || '')) return home;
  const ev = await adminGet(env, `events/${id}`);
  if (!ev || ev.status !== 'published') return home;

  const q = url.searchParams;
  const f = ID_RE.test(q.get('f') || '') ? q.get('f') : '';
  const foto = ID_RE.test(q.get('foto') || '') ? q.get('foto') : '';
  const dorsal = /^\d{1,6}$/.test(q.get('dorsal') || '') ? q.get('dorsal') : '';
  let image = ev.coverUrl || `${site}assets/og-image.png`;
  if (foto) {
    const p = await adminGet(env, `photos/${foto}`);
    if (p && p.eventId === id && !p.hidden && p.previewUrl) image = p.previewUrl;
  }
  const when = [fmtDate(ev.date), ev.location].filter(Boolean).join(' · ');
  const title = dorsal ? `Fotos del dorsal ${dorsal} · ${ev.name}` : foto ? `Una foto de ${ev.name}` : `Fotos de ${ev.name}`;
  const desc = `${when ? `${when}. ` : ''}Buscate y descargá tus fotos en alta calidad en Quiero Mis Fotos.`;
  const appQ = new URLSearchParams();
  if (f) appQ.set('f', f);
  if (foto) appQ.set('foto', foto);
  if (dorsal) appQ.set('dorsal', dorsal);
  // ?s=1 antes del # para que las estadísticas lo cuenten como "link compartido".
  const target = `${site}?s=1#/evento/${id}${appQ.toString() ? `?${appQ}` : ''}`;
  const res = new Response(page({ title, desc, image, target, canonical: `${site}e/${id}/` }), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60, s-maxage=300' },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}
