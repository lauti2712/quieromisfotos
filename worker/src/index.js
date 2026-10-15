// API de Quiero Mis Fotos (Cloudflare Worker).
//
// Fase 2 — subida de fotos:
//   POST   /upload-session            {eventId?}  Bearer <Firebase ID token>  -> { token, exp, publicBase }
//   PUT    /upload/{kind}/{eid}/{pid}  X-Upload-Token                         kind: preview|thumb|original
//   PUT    /asset/{kind}               X-Upload-Token                         kind: avatar|logo|cover|portfolio
//   DELETE /asset?key=u/{uid}/...      X-Upload-Token                         borra un asset propio
//   DELETE /photo/{eid}/{pid}          X-Upload-Token                         borra muestra, miniatura y original
//   GET    /public/{key}                                                      sirve qmf-public (si no hay dominio público)
//
// Fase 4 — pagos (Mercado Pago marketplace):
//   POST   /mp/connect-url             Bearer (fotógrafo)                     -> { url } de autorización OAuth
//   GET    /mp/callback                ?code&state                            guarda tokens y vuelve al panel
//   POST   /mp/disconnect              Bearer (fotógrafo)
//   POST   /checkout                   Bearer (comprador) {eventId, photographerUid, photoIds}  -> { orderId, initPoint }
//   POST   /mp/webhook?o={orderId}     aviso de MP (se verifica consultando el pago)
//   POST   /orders/{id}/sync           Bearer (comprador) {paymentId?}        consulta el pago a MP
//   POST   /orders/{id}/checkout       Bearer (comprador)                     reintentar pago
//   POST   /orders/{id}/downloads      Bearer (comprador)                     -> links de 15 min
//   GET    /dl/{token}                                                        descarga del original
//   GET    /w/{slug}  ·  {slug}.quieromisfotos.com.ar  ·  dominio propio           web personal del fotógrafo (planes Web)
//   POST   /admin/storage/scan         Bearer (superadmin)                    recalcula el uso de R2 (también corre a diario)
//   POST   /extensions/checkout        Bearer (fotógrafo) {eventId, planId}    extensión paga del plazo -> { initPoint }
//   POST   /extensions/{id}/sync       Bearer (fotógrafo)                     consulta el pago a MP
//   POST   /plans/subscribe · /plans/sync · /plans/cancel   Bearer (fotógrafo)   suscripción mensual a un plan (MP)
//   POST   /tags                       Bearer (fotógrafo aprobado) {type, name}  alta de actividad/club/lugar sin duplicados
//
// Claves en R2:
//   qmf-public:  e/{eid}/{uid}/{pid}_p.jpg  (muestra)   e/{eid}/{uid}/{pid}_t.jpg  (miniatura)
//                u/{uid}/{kind}-{rand}.jpg  (avatar/logo/portada)
//   qmf-private: e/{eid}/{uid}/{pid}        (original, nunca público)

import { verifyIdToken, getDocAsUser } from './firebase.js';
import { adminGet, adminGetMany, adminQuery } from './admin.js';
import { freeLimited, albumLimitBytes, albumPhotoLimit, setActive } from './plans.js';
import { signToken, verifyToken } from './tokens.js';
import { json, httpError, apiUrl } from './http.js';
import { connectUrl, callback, disconnect } from './mp.js';
import { checkout, webhook, syncOrder, retryCheckout, downloadLinks, download } from './orders.js';
import { createTag } from './tags.js';
import { renderSite } from './site.js';
import { scanRequest, scanStorage } from './storage.js';
import { runBackup, backupRequest } from './backup.js';
import { notifyFollowersOnce, drainPushQueue } from './push.js';
import { extensionCheckout, extensionSync } from './extensions.js';
import { subscribe, syncRequest, cancelSubscription, syncAllSubscriptions } from './subscriptions.js';

const MAX = { preview: 6e6, thumb: 1e6, original: 80e6, avatar: 3e6, logo: 2e6, cover: 6e6, portfolio: 6e6, pcover: 6e6 };
const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const SESSION_TTL = 2 * 3600;
const BACKUP_CRON = '0 7 * * 1'; // lunes 04:00 (Argentina)
const PUSH_CRON = '*/5 * * * *'; // cola de avisos a seguidores
const NOTIFY_AT_PHOTOS = 20; // aviso a seguidores cuando el álbum llega a esta cantidad de fotos

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    try {
      let res = await route(req, env, ctx);
      // Algunas respuestas (Response.redirect, objetos de cache) tienen headers inmutables: se copian.
      try { for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); }
      catch { res = new Response(res.body, res); for (const [k, v] of Object.entries(cors)) res.headers.set(k, v); }
      return res;
    } catch (e) {
      const status = e.status || 500;
      if (status >= 500) console.error(e);
      return json({ error: e.message || 'Error' }, status, cors);
    }
  },
  // Cron diario: recalcula el uso de R2.
  async scheduled(event, env, ctx) {
    if (event.cron === BACKUP_CRON) { ctx.waitUntil(runBackup(env)); return; }
    if (event.cron === PUSH_CRON) { ctx.waitUntil(drainPushQueue(env)); return; }
    ctx.waitUntil(scanStorage(env));
    ctx.waitUntil(syncAllSubscriptions(env));
  },
};

async function route(req, env, ctx) {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const m = req.method;

  // Web personal del fotógrafo: {slug}.quieromisfotos.com.ar, dominio propio activado o /w/{slug} (vista previa).
  if (m === 'GET') {
    if (parts[0] === 'w' && parts[1] && parts.length === 2) return renderSite(req, env, ctx, { slug: parts[1].toLowerCase() });
    const host = url.hostname.toLowerCase();
    const sub = host.match(/^([a-z0-9-]+)\.quieromisfotos\.com\.ar$/)?.[1];
    const ours = /(^|\.)(quieromisfotos\.com\.ar|solucionescotidianas\.com\.ar|workers\.dev)$/.test(host) || host === 'localhost';
    const isSite = (sub && !['api', 'fotos', 'www', 'prueba'].includes(sub)) || !ours;
    if (isSite && url.pathname === '/robots.txt') {
      return new Response(`User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain' } });
    }
    if (isSite && url.pathname === '/sitemap.xml') {
      return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://${host}/</loc></url></urlset>\n`, { headers: { 'Content-Type': 'application/xml' } });
    }
    if (url.pathname === '/' && sub && isSite) return renderSite(req, env, ctx, { slug: sub });
    if (url.pathname === '/' && !ours) return renderSite(req, env, ctx, { host: host.replace(/^www\./, '') });
  }
  if (m === 'GET' && parts[0] === 'public') return servePublic(req, env, ctx, parts.slice(1).join('/'));
  if (m === 'GET' && url.pathname === '/') return json({ ok: true, service: 'qmf-api' });
  if (m === 'POST' && url.pathname === '/upload-session') return uploadSession(req, env);
  if (m === 'PUT' && parts[0] === 'upload' && parts.length === 4) return uploadPhotoPart(req, env, parts[1], parts[2], parts[3], ctx);
  if (m === 'PUT' && parts[0] === 'asset' && parts.length === 2) return uploadAsset(req, env, parts[1]);
  if (m === 'DELETE' && parts[0] === 'photo' && parts.length === 3) return deletePhoto(req, env, parts[1], parts[2]);
  if (m === 'DELETE' && url.pathname === '/asset') return deleteAsset(req, env, url.searchParams.get('key') || '');

  if (m === 'POST' && url.pathname === '/mp/connect-url') return connectUrl(req, env);
  if (m === 'GET' && url.pathname === '/mp/callback') return callback(req, env);
  if (m === 'POST' && url.pathname === '/mp/disconnect') return disconnect(req, env);
  if (m === 'POST' && url.pathname === '/mp/webhook') return webhook(req, env);
  if (m === 'POST' && url.pathname === '/checkout') return checkout(req, env);
  if (m === 'POST' && url.pathname === '/tags') return createTag(req, env);
  if (m === 'POST' && url.pathname === '/admin/storage/scan') return scanRequest(req, env);
  if (m === 'POST' && url.pathname === '/admin/backup') return backupRequest(req, env);
  if (m === 'POST' && url.pathname === '/extensions/checkout') return extensionCheckout(req, env);
  if (m === 'POST' && url.pathname === '/plans/subscribe') return subscribe(req, env);
  if (m === 'POST' && url.pathname === '/plans/sync') return syncRequest(req, env);
  if (m === 'POST' && url.pathname === '/plans/cancel') return cancelSubscription(req, env);
  if (m === 'POST' && parts[0] === 'extensions' && parts[2] === 'sync' && parts.length === 3 && ID_RE.test(parts[1])) return extensionSync(req, env, parts[1]);
  if (m === 'POST' && parts[0] === 'orders' && parts.length === 3 && ID_RE.test(parts[1])) {
    if (parts[2] === 'sync') return syncOrder(req, env, parts[1]);
    if (parts[2] === 'checkout') return retryCheckout(req, env, parts[1]);
    if (parts[2] === 'downloads') return downloadLinks(req, env, parts[1]);
  }
  if (m === 'GET' && parts[0] === 'dl' && parts.length === 2) return download(req, env, parts[1]);
  throw httpError(404, 'No encontrado');
}

// ------------------------------------------------------------------ sesión de subida
async function uploadSession(req, env) {
  const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!idToken) throw httpError(401, 'Falta autenticación');
  const claims = await verifyIdToken(idToken, env);
  const uid = claims.sub;
  const body = await req.json().catch(() => ({}));
  const eid = body.eventId || null;

  const user = await getDocAsUser(env, idToken, `users/${uid}`);
  if (!user) throw httpError(403, 'Perfil inexistente');
  const isSuper = claims.email === 'lautarom87@gmail.com' && claims.email_verified === true;
  // Pendientes pueden subir avatar, logo y portfolio; para eventos hay que estar aprobado.
  if (!isSuper && user.status === 'suspended') throw httpError(403, 'Tu cuenta está suspendida');
  if (!isSuper && eid && user.status !== 'approved') throw httpError(403, 'Tu cuenta no está aprobada');
  if (!isSuper && !['approved', 'pending'].includes(user.status)) throw httpError(403, 'Tu cuenta no está habilitada');

  let role = 'profile';
  if (eid) {
    if (!ID_RE.test(eid)) throw httpError(400, 'Evento inválido');
    const ev = await getDocAsUser(env, idToken, `events/${eid}`);
    if (!ev) throw httpError(404, 'Evento no encontrado');
    const member = (ev.photographerUids || []).includes(uid);
    if (member) role = 'member';
    // Plan Gratis: un solo álbum activo a la vez (con fotos y originales guardados).
    if (member && !isSuper && freeLimited(user, await adminGet(env, 'settings/platform'))) {
      const evs = await adminQuery(env, 'events', { filters: [['photographerUids', 'array-contains', uid]], limit: 300 });
      const others = evs.filter(e => e.id !== eid);
      const sets = others.length ? await adminGetMany(env, others.map(e => `events/${e.id}/sets/${uid}`)) : [];
      const busy = others.find((e, i) => setActive(sets[i]));
      if (busy) throw httpError(403, `Con el plan Gratis podés tener 1 álbum activo a la vez y ya tenés "${busy.name}". Pasate al plan Profesional o esperá a que venza.`);
    }
    else if (isSuper || ev.createdBy === uid) role = 'editor';
    else throw httpError(403, 'No participás en este evento');
  }
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL;
  const token = await signToken({ uid, eid, role, exp }, env.UPLOAD_SECRET);
  return json({ token, exp, publicBase: publicBase(req, env) });
}

async function session(req, env) {
  const t = req.headers.get('X-Upload-Token');
  if (!t) throw httpError(401, 'Falta token de subida');
  const s = await verifyToken(t, env.UPLOAD_SECRET);
  if (!s || s.exp < Date.now() / 1000) throw httpError(401, 'Token de subida inválido o vencido');
  return s;
}

function checkSize(req, kind) {
  const len = Number(req.headers.get('Content-Length') || 0);
  if (!len) throw httpError(411, 'Falta Content-Length');
  if (len > MAX[kind]) throw httpError(413, 'Archivo demasiado grande');
}

// ------------------------------------------------------------------ fotos
async function uploadPhotoPart(req, env, kind, eid, pid, ctx) {
  if (!['preview', 'thumb', 'original'].includes(kind)) throw httpError(400, 'Tipo inválido');
  if (!ID_RE.test(eid) || !ID_RE.test(pid)) throw httpError(400, 'Id inválido');
  const s = await session(req, env);
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
  checkSize(req, kind);

  const base = `e/${eid}/${s.uid}/${pid}`;
  // Límite de espacio por álbum (settings.albumLimitGB + espacio comprado): se controla al empezar cada foto.
  if (kind === 'preview') {
    const [set, st, user] = await adminGetMany(env, [`events/${eid}/sets/${s.uid}`, 'settings/platform', `users/${s.uid}`]);
    // Planes nuevos: tope en cantidad de fotos. Esquema anterior: en espacio.
    const maxPhotos = albumPhotoLimit(set, st, user);
    if (maxPhotos > 0 && set && (set.photoCount || 0) >= maxPhotos) {
      throw httpError(402, freeLimited(user, st)
        ? `Tu álbum llegó al tope de ${maxPhotos} fotos del plan Gratis. Pasate a un plan pago para seguir subiendo.`
        : `El álbum llegó a su tope de ${maxPhotos} fotos. Sumá más fotos con un pack para seguir subiendo.`);
    }
    const max = albumLimitBytes(set, st, user);
    if (max > 0 && set) {
      const used = (set.bytesOriginal || 0) + (set.bytesPublic || 0);
      const gb = Math.round(max / 1e8) / 10;
      if (used >= max) throw httpError(402, freeLimited(user, st)
        ? `Tu álbum llegó al tope de ${gb} GB del plan Gratis. Pasate al plan Profesional para seguir subiendo.`
        : `El álbum llegó a su límite de ${gb} GB. Comprá más espacio para seguir subiendo.`);
    }
    // Avisar a los seguidores del evento y del fotógrafo cuando el álbum ya tiene fotos.
    if (set && !set.followersNotifiedAt && (set.photoCount || 0) >= NOTIFY_AT_PHOTOS) {
      ctx.waitUntil(notifyFollowersOnce(env, eid, s.uid).catch(e => console.error('seguidores', e)));
    }
  }
  if (kind === 'original') {
    const type = req.headers.get('Content-Type') || 'application/octet-stream';
    await env.PRIVATE.put(base, req.body, { httpMetadata: { contentType: type }, customMetadata: { uid: s.uid } });
    return json({ ok: true });
  }
  const key = `${base}_${kind === 'preview' ? 'p' : 't'}.jpg`;
  await env.PUBLIC.put(key, req.body, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true, key, url: `${publicBase(req, env)}/${key}` });
}

async function deletePhoto(req, env, eid, pid) {
  if (!ID_RE.test(eid) || !ID_RE.test(pid)) throw httpError(400, 'Id inválido');
  const s = await session(req, env);
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
  const base = `e/${eid}/${s.uid}/${pid}`;
  await Promise.all([env.PUBLIC.delete([`${base}_p.jpg`, `${base}_t.jpg`]), env.PRIVATE.delete(base)]);
  return json({ ok: true });
}

// ------------------------------------------------------------------ avatar / logo / portada
async function uploadAsset(req, env, kind) {
  if (!['avatar', 'logo', 'cover', 'portfolio', 'pcover'].includes(kind)) throw httpError(400, 'Tipo inválido');
  const s = await session(req, env);
  if (kind === 'cover' && !s.eid) throw httpError(400, 'La portada requiere un evento');
  checkSize(req, kind);
  const type = req.headers.get('Content-Type') || '';
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw httpError(415, 'Formato no soportado');
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const rand = crypto.randomUUID().slice(0, 8);
  const key = kind === 'cover' ? `e/${s.eid}/cover-${rand}.${ext}`
    : kind === 'portfolio' ? `u/${s.uid}/pf/${rand}.${ext}`
    : `u/${s.uid}/${kind}-${rand}.${ext}`;
  await env.PUBLIC.put(key, req.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  return json({ ok: true, key, url: `${publicBase(req, env)}/${key}` });
}

async function deleteAsset(req, env, key) {
  const s = await session(req, env);
  if (!key.startsWith(`u/${s.uid}/`) || key.includes('..')) throw httpError(403, 'No podés borrar este archivo');
  await env.PUBLIC.delete(key);
  return json({ ok: true });
}

// ------------------------------------------------------------------ lectura pública (fallback / dev)
async function servePublic(req, env, ctx, key) {
  if (!key || key.includes('..')) throw httpError(404, 'No encontrado');
  const cache = caches.default;
  const hit = await cache.match(req);
  if (hit) return new Response(hit.body, hit);
  const obj = await env.PUBLIC.get(key);
  if (!obj) throw httpError(404, 'No encontrado');
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('ETag', obj.httpEtag);
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'public, max-age=86400');
  const res = new Response(obj.body, { headers });
  ctx.waitUntil(cache.put(req, res.clone()));
  return res;
}

// ------------------------------------------------------------------ helpers
function publicBase(req, env) {
  return (env.PUBLIC_BASE_URL || `${apiUrl(env, req)}/public`).replace(/\/$/, '');
}

function corsHeaders(req, env) {
  const origin = req.headers.get('Origin') || '';
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim());
  const ok = allowed.includes(origin) || /^http:\/\/localhost:\d+$/.test(origin);
  return ok ? {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Upload-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  } : { Vary: 'Origin' };
}
