// Búsqueda por selfie. Índice de caras por álbum en R2 privado: solo huellas numéricas (128 bytes en base64 por cara),
// nunca la imagen de una cara. Las calcula el navegador del fotógrafo al subir (js/faces.js).
// La comparación se hace acá: el índice nunca se publica; el cliente manda la huella de su selfie (la imagen no sale de su
// celular) y recibe solo las fotos donde aparece. La huella de la selfie no se guarda.
//   POST /faces/{eid}          X-Upload-Token  {items: [{p, f: [huella…]}]}  -> agrega al índice (un archivo por quien sube)
//   GET  /faces/{eid}/mine     X-Upload-Token                               -> ids ya indexados (para preparar fotos viejas)
//   POST /faces/{eid}/match    público, con límite por persona              {d: [128 números]} -> { photos: [{p, d}] }
import { adminGetMany, adminCommit } from './admin.js';
import { json, httpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const B64_RE = /^[A-Za-z0-9+/]{171}=$/; // 128 bytes
const MATCH = 0.55, MAX_RESULTS = 80, MAX_FACES_PER_PHOTO = 15;
const SEARCHES_PER_HOUR = 20;
const SCALE = 400;

const keyOf = (eid, owner, by) => `faces/${eid}/${owner}/${by}.json`;
async function readIndex(env, key) {
  const obj = await env.PRIVATE.get(key);
  return obj ? obj.json().catch(() => ({ items: {} })) : { items: {} };
}

export async function addFaces(req, env, s, eid) {
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
  const { items } = await req.json().catch(() => ({}));
  if (!Array.isArray(items) || !items.length || items.length > 50) throw httpError(400, 'Pedido inválido');
  const key = keyOf(eid, s.uid, s.by || s.uid);
  const idx = await readIndex(env, key);
  for (const it of items) {
    if (!ID_RE.test(it?.p || '') || !Array.isArray(it.f)) continue;
    idx.items[it.p] = it.f.filter(f => typeof f === 'string' && B64_RE.test(f)).slice(0, MAX_FACES_PER_PHOTO);
  }
  await env.PRIVATE.put(key, JSON.stringify(idx), { httpMetadata: { contentType: 'application/json' } });
  // La galería muestra el botón de selfie cuando el álbum ya tiene fotos procesadas.
  const n = Object.keys(idx.items).length;
  await adminCommit(env, [{ update: `events/${eid}/sets/${s.uid}`, data: { facesPhotos: n, facesAt: new Date() }, mask: ['facesPhotos', 'facesAt'] }]).catch(() => {});
  return json({ ok: true, photos: n });
}

export async function myFaces(req, env, s, eid) {
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
  const idx = await readIndex(env, keyOf(eid, s.uid, s.by || s.uid));
  return json({ ids: Object.keys(idx.items) });
}

const unpack = b64 => {
  const raw = atob(b64), out = new Float32Array(128);
  for (let i = 0; i < 128; i++) { const v = raw.charCodeAt(i); out[i] = (v > 127 ? v - 256 : v) / SCALE; }
  return out;
};

export async function matchFaces(req, env, ctx, eid) {
  // Límite por persona (IP) y evento, sin guardar la IP: contador en la caché de Cloudflare por una hora.
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const rk = new Request(`https://qmf-faces.internal/${eid}/${encodeURIComponent(ip)}`);
  const used = Number(await (await caches.default.match(rk))?.text() || 0);
  if (used >= SEARCHES_PER_HOUR) throw httpError(429, 'Hiciste muchas búsquedas seguidas. Probá de nuevo en un rato.');
  ctx.waitUntil(caches.default.put(rk, new Response(String(used + 1), { headers: { 'Cache-Control': 'max-age=3600' } })));

  const { d } = await req.json().catch(() => ({}));
  if (!Array.isArray(d) || d.length !== 128 || !d.every(x => Number.isFinite(x) && Math.abs(x) < 2)) throw httpError(400, 'Pedido inválido');
  const [ev, st] = await adminGetMany(env, [`events/${eid}`, 'settings/platform']);
  if (!ev || ev.status !== 'published') throw httpError(404, 'El evento no está disponible');
  if (st?.selfieEnabled === false) throw httpError(404, 'La búsqueda por selfie no está disponible');
  // Solo los álbumes con la búsqueda por selfie activada.
  const uids = ev.photographerUids || [];
  const sets = uids.length ? await adminGetMany(env, uids.map(u => `events/${eid}/sets/${u}`)) : [];
  const on = new Set(uids.filter((u, i) => sets[i] && sets[i].selfie !== false));
  const listed = await env.PRIVATE.list({ prefix: `faces/${eid}/`, limit: 1000 });
  const files = listed.objects.filter(o => on.has(o.key.split('/')[2]));
  const best = new Map();
  for (const f of files) {
    const idx = await readIndex(env, f.key);
    for (const [pid, list] of Object.entries(idx.items || {})) {
      for (const s of list) {
        const v = unpack(s);
        let sum = 0;
        for (let i = 0; i < 128; i++) { const x = d[i] - v[i]; sum += x * x; }
        const dist = Math.sqrt(sum);
        if (dist < MATCH && dist < (best.get(pid) ?? 9)) best.set(pid, dist);
      }
    }
  }
  const photos = [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, MAX_RESULTS).map(([p, dist]) => ({ p, d: Math.round(dist * 1000) / 1000 }));
  return json({ photos, searched: files.length > 0 });
}
