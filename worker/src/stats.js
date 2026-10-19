// Estadísticas anónimas (visitas a eventos y perfiles, fotos vistas y agregadas al carrito). Antes las escribía el navegador
// directo en Firestore y cualquiera podía inflarlas; ahora pasan por acá: se valida el evento o el perfil, cada visita cuenta
// una vez por persona (IP) cada 6 horas y las fotos vistas tienen tope diario. No se guarda la IP en ningún lado.
//   POST /stats  (texto con JSON, sin login)  {kind: 'event'|'profile', id, src?, pv?: {uid: n}, ca?: {uid: n}}
import { adminGet, adminCommit } from './admin.js';
import { json } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const SOURCES = ['whatsapp', 'instagram', 'facebook', 'google', 'link', 'sitio', 'directo', 'otro'];
const VIEW_TTL = 6 * 3600;            // una visita por persona cada 6 horas
const DAY = 86400;
const CAP = { pv: 400, ca: 100 };     // tope diario por persona y evento

const cacheUrl = (...parts) => `https://qmf-stats.internal/${parts.map(encodeURIComponent).join('/')}`;

async function cacheGet(key) {
  const r = await caches.default.match(cacheUrl(...key));
  return r ? r.json().catch(() => null) : null;
}
function cachePut(ctx, key, value, ttl) {
  ctx.waitUntil(caches.default.put(cacheUrl(...key), new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` } })));
}

// Evento o perfil válido (cacheado 5 minutos): solo publicados/aprobados, nunca el ejemplo.
async function target(env, ctx, kind, id) {
  const cached = await cacheGet(['t', kind, id]);
  if (cached) return cached;
  let t = { ok: false };
  if (kind === 'event') {
    const ev = await adminGet(env, `events/${id}`);
    if (ev && ev.status === 'published' && !ev.demo) t = { ok: true, uids: ev.photographerUids || [] };
  } else {
    const u = await adminGet(env, `users/${id}`);
    if (u && u.status === 'approved' && !u.demo) t = { ok: true };
  }
  cachePut(ctx, ['t', kind, id], t, 300);
  return t;
}

export async function statsHit(req, env, ctx) {
  let b;
  try { b = JSON.parse(await req.text()); } catch { return json({ ok: false }); }
  const kind = b.kind === 'profile' ? 'profile' : 'event';
  if (!ID_RE.test(b.id || '')) return json({ ok: false });
  const t = await target(env, ctx, kind, b.id);
  if (!t.ok) return json({ ok: false });
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const day = new Date().toISOString().slice(0, 10);
  const fields = {};

  if (b.view) {
    const seen = await cacheGet(['v', kind, b.id, ip]);
    if (!seen) {
      const src = SOURCES.includes(b.src) ? b.src : 'otro';
      Object.assign(fields, { views: 1, [`days.${day}`]: 1, [`src.${src}`]: 1 });
      cachePut(ctx, ['v', kind, b.id, ip], 1, VIEW_TTL);
    }
  }
  // Fotos vistas / agregadas al carrito, por fotógrafo del evento (con tope diario por persona).
  if (kind === 'event' && (b.pv || b.ca)) {
    const used = (await cacheGet(['c', b.id, ip, day])) || { pv: 0, ca: 0 };
    for (const f of ['pv', 'ca']) {
      for (const [uid, n] of Object.entries(b[f] || {})) {
        if (!t.uids.includes(uid)) continue;
        const k = Math.max(0, Math.min(Math.round(Number(n) || 0), CAP[f] - used[f]));
        if (!k) continue;
        used[f] += k;
        fields[`${f}.${uid}`] = (fields[`${f}.${uid}`] || 0) + k;
      }
    }
    cachePut(ctx, ['c', b.id, ip, day], used, DAY);
  }
  if (!Object.keys(fields).length) return json({ ok: true, counted: false });
  const path = `stats/${kind === 'profile' ? `u_${b.id}` : b.id}`;
  ctx.waitUntil(adminCommit(env, [
    { upsert: path, data: { updatedAt: new Date() } },
    { inc: path, fields },
  ]).catch(e => console.error('stats', e)));
  return json({ ok: true, counted: true });
}
