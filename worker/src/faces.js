// Búsqueda por selfie. Índice de caras por álbum en R2 privado: solo huellas numéricas (128 bytes en base64 por cara),
// nunca la imagen de una cara. Las calcula el navegador del fotógrafo al subir (js/faces.js).
// La comparación se hace acá: el índice nunca se publica; el cliente manda la huella de su selfie (la imagen no sale de su
// celular) y recibe solo las fotos donde aparece. La huella de la selfie no se guarda.
//   POST /faces/{eid}          X-Upload-Token  {items: [{p, f: [huella…]}]}  -> agrega al índice (un archivo por quien sube)
//   GET  /faces/{eid}/mine     X-Upload-Token                               -> ids ya indexados (para preparar fotos viejas)
//   POST /faces/{eid}/match    público, con límite por persona              {d: [128 números]} -> { photos: [{p, d}] }
// Cara guardada del comprador (opcional, con su consentimiento): avisarle cuando aparece en fotos nuevas.
// Una sola huella por cuenta, en R2 privado (buyers/index.json). Al subir fotos (addFaces) se compara con las guardadas.
//   GET  /faces/me             Bearer   -> { saved, at }
//   POST /faces/me             Bearer   {d: [128 números]} -> guarda (reemplaza)
//   POST /faces/me/delete      Bearer   -> borra
import { adminGet, adminGetMany, adminCommit, adminSet, adminUpdate, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { json, httpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const B64_RE = /^[A-Za-z0-9+/]{171}=$/; // 128 bytes
const MATCH = 0.55, AUTO_MATCH = 0.5, MAX_RESULTS = 80, MAX_FACES_PER_PHOTO = 15;
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
  await matchSavedFaces(env, eid, s.uid, items).catch(e => console.error('caras guardadas', e));
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

// ---------------------------------------------------------------- cara guardada del comprador
const BUYERS = 'buyers/index.json';
const pack = d => {
  const b = new Uint8Array(128);
  for (let i = 0; i < 128; i++) b[i] = Math.max(-127, Math.min(127, Math.round(d[i] * SCALE))) & 255;
  return btoa(String.fromCharCode(...b));
};
const readBuyers = async env => (await (await env.PRIVATE.get(BUYERS))?.json().catch(() => null)) || {};
const writeBuyers = (env, all) => env.PRIVATE.put(BUYERS, JSON.stringify(all), { httpMetadata: { contentType: 'application/json' } });

export async function myFace(req, env, action) {
  const c = await requireUser(req, env);
  const all = await readBuyers(env);
  if (req.method === 'GET') return json({ saved: !!all[c.uid], at: all[c.uid]?.at || null });
  if (action === 'delete') {
    if (all[c.uid]) { delete all[c.uid]; await writeBuyers(env, all); }
    return json({ ok: true, saved: false });
  }
  const { d } = await req.json().catch(() => ({}));
  if (!Array.isArray(d) || d.length !== 128 || !d.every(x => Number.isFinite(x) && Math.abs(x) < 2)) throw httpError(400, 'Pedido inválido');
  if (!all[c.uid] && Object.keys(all).length >= 20000) throw httpError(503, 'No se pudo guardar. Probá más tarde.');
  all[c.uid] = { d: pack(d), at: new Date().toISOString() };
  await writeBuyers(env, all);
  return json({ ok: true, saved: true });
}

// Fotos nuevas de un álbum contra las caras guardadas: un aviso por persona y evento (faceHits/{eid}_{uid}).
// Si el evento todavía no está publicado, el aviso queda pendiente y sale al publicarse (sendPendingFaceHits).
async function matchSavedFaces(env, eid, by, items) {
  const all = await readBuyers(env);
  const buyers = Object.entries(all).filter(([uid]) => uid !== by).map(([uid, v]) => [uid, unpack(v.d)]);
  if (!buyers.length) return;
  const st = await adminGet(env, 'settings/platform');
  if (st?.selfieEnabled === false) return;
  const hits = new Map();
  for (const it of items) {
    for (const f of (it?.f || []).filter(x => typeof x === 'string' && B64_RE.test(x))) {
      const v = unpack(f);
      for (const [uid, b] of buyers) {
        let sum = 0;
        for (let i = 0; i < 128; i++) { const x = b[i] - v[i]; sum += x * x; }
        if (Math.sqrt(sum) < AUTO_MATCH) hits.set(uid, (hits.get(uid) || 0) + 1);
      }
    }
  }
  if (!hits.size) return;
  const ev = await adminGet(env, `events/${eid}`);
  const published = ev?.status === 'published';
  for (const uid of hits.keys()) {
    const created = await adminSet(env, `faceHits/${eid}_${uid}`, { eid, uid, at: new Date(), pending: !published }, { mustNotExist: true }).then(() => true).catch(() => false);
    if (created && published) await queueFaceHit(env, ev, eid, uid);
  }
}

async function queueFaceHit(env, ev, eid, uid) {
  const site = env.SITE_URL || 'https://quieromisfotos.com.ar/';
  await adminSet(env, `pushQueue/face_${eid}_${uid}`, {
    title: `🤳 Aparecés en fotos de ${ev?.name || 'un evento'}`,
    body: 'Encontramos fotos nuevas donde parecés estar. Buscate con tu selfie y descargalas.',
    link: `${site}#/evento/${eid}`, uids: [uid], createdAt: new Date(),
    foot: 'Te llega este mail porque guardaste tu cara en Quiero Mis Fotos para que te avisemos. Podés borrarla cuando quieras en Mi cuenta.',
  }, { mustNotExist: true }).catch(() => {});
}

export async function sendPendingFaceHits(env, eid) {
  const list = await adminQuery(env, 'faceHits', { filters: [['eid', '==', eid], ['pending', '==', true]], limit: 500 });
  if (!list.length) return;
  const ev = await adminGet(env, `events/${eid}`);
  if (ev?.status !== 'published') return;
  for (const h of list) {
    await adminUpdate(env, `faceHits/${h.id}`, { pending: false });
    await queueFaceHit(env, ev, eid, h.uid);
  }
}
