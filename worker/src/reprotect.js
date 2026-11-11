// Migración de las fotos viejas a las versiones protegidas (desenfoque real). La hace el superadmin desde el panel
// (Almacenamiento → Protección de fotos): su navegador baja la muestra vieja, genera la miniatura y la muestra nuevas
// con desenfoque + marca de agua y las sube acá. Los originales no se tocan.
//   PUT  /admin/protect/{eid}/{uid}/{pid}/{preview|thumb}?pv=N  Bearer (superadmin)  cuerpo: JPEG -> guarda _pN/_tN
//   POST /admin/protect/{eid}/{uid}/{pid}/commit  {cover, pv}    Bearer (superadmin)               -> apunta la foto a las nuevas y borra las anteriores
// pv: versión nueva (2 la primera vez; para rehacer con otros ajustes, la actual + 1, desde el original).
// Pensado para el plan gratis de Firestore: 1 lectura y 1 escritura por foto (los bytes de cada álbum los corrige el
// escaneo diario de almacenamiento).
import { requireUser } from './firebase.js';
import { adminGet, adminCommit } from './admin.js';
import { json, httpError } from './http.js';
import { suffixOf, pubKeysOf, MAX_PV } from './photos.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX = { preview: 3e6, thumb: 1e6 };

async function superOnly(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
}
const pvOf = v => { const n = Number(v ?? 2); if (!Number.isInteger(n) || n < 2 || n > MAX_PV) throw httpError(400, 'Versión inválida'); return n; };
function baseOf(eid, uid, pid) {
  if (![eid, uid, pid].every(x => ID_RE.test(x))) throw httpError(400, 'Id inválido');
  return `e/${eid}/${uid}/${pid}`;
}

export async function protectPart(req, env, eid, uid, pid, kind) {
  await superOnly(req, env);
  if (!MAX[kind]) throw httpError(400, 'Tipo inválido');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (!len) throw httpError(411, 'Falta Content-Length');
  if (len > MAX[kind]) throw httpError(413, 'Archivo demasiado grande');
  if ((req.headers.get('Content-Type') || '') !== 'image/jpeg') throw httpError(415, 'Tiene que ser JPEG');
  const base = baseOf(eid, uid, pid);
  const pv = pvOf(new URL(req.url).searchParams.get('pv'));
  // Solo fotos que existen (tienen su original): no se puede escribir en cualquier lado.
  if (!await env.PRIVATE.head(base) && !await env.PUBLIC.head(`${base}_t.jpg`)) throw httpError(404, 'Foto no encontrada');
  await env.PUBLIC.put(base + suffixOf(kind, pv), req.body, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true });
}

export async function protectCommit(req, env, ctx, eid, uid, pid) {
  await superOnly(req, env);
  const base = baseOf(eid, uid, pid);
  const b = await req.json().catch(() => ({}));
  const p = await adminGet(env, `photos/${pid}`);
  if (!p || p.eventId !== eid || p.photographerUid !== uid) throw httpError(404, 'Foto no encontrada');
  const pv = pvOf(b.pv), cur = p.pv || 1;
  if (cur >= pv) return json({ ok: true, already: true });
  const pKey = base + suffixOf('preview', pv), tKey = base + suffixOf('thumb', pv);
  const [prev, thumb] = await Promise.all([env.PUBLIC.head(pKey), env.PUBLIC.head(tKey)]);
  if (!prev || !thumb) throw httpError(409, 'Faltan los archivos nuevos');
  // Misma dirección pública que tenía la foto, con el nombre nuevo.
  const swap = (url, kind) => (url || '').replace(/_(p|t)\d?\.jpg$/, suffixOf(kind, pv));
  const previewUrl = swap(p.previewUrl, 'preview'), thumbUrl = swap(p.thumbUrl, 'thumb');
  if (!previewUrl.endsWith(suffixOf('preview', pv)) || !thumbUrl.endsWith(suffixOf('thumb', pv))) throw httpError(409, 'Dirección de la foto inesperada');
  const bytesPublic = prev.size + thumb.size;
  const ops = [{ update: `photos/${pid}`, data: { previewUrl, thumbUrl, pv, bytesPublic }, mask: ['previewUrl', 'thumbUrl', 'pv', 'bytesPublic'] }];
  // Portada automática del evento que apuntaba a la muestra vieja (el panel ya sabe cuál es).
  if (b.cover) ops.push({ update: `events/${eid}`, data: { autoCoverUrl: previewUrl }, mask: ['autoCoverUrl'] });
  await adminCommit(env, ops);
  // Recién ahora se borran las anteriores. Lo que quedó guardado en otros lados (carrito, compras) pasa solo a las nuevas.
  const old = pubKeysOf(base).filter(k => k !== pKey && k !== tKey);
  await env.PUBLIC.delete(old);
  // Copia en la caché de la API (/public/…) en esta región; en las demás vence sola.
  const api = new URL(req.url).origin;
  ctx.waitUntil(Promise.all(old.map(k => caches.default.delete(`${api}/public/${k}`))).catch(() => {}));
  return json({ ok: true, previewUrl, thumbUrl });
}
