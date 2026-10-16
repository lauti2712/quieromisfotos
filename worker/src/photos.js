// Registro y borrado de fotos de un álbum. Lo hace el Worker (no el navegador) para que el contador de fotos,
// los bytes, el vencimiento y el conteo por hora sean confiables (el tope del plan y la retención dependen de eso).
//   POST /photos/{eid}/{pid}       X-Upload-Token  {subalbumId, width, height, takenAt, fileName, fileBytes}
//        -> registra la foto ya subida (muestra, miniatura y original en R2) y suma al set.
//   POST /photos/{eid}/delete      X-Upload-Token  {ids: [...]} (hasta 100)
//        -> borra las fotos; las que tienen una venta con descarga vigente solo se ocultan.
import { adminGetMany, adminQuery, adminCommit } from './admin.js';
import { albumPhotoLimit, rulesFor, isFree } from './plans.js';
import { json, httpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const DAY = 86400_000;
const hourOf = ms => Math.floor(ms / 3600_000) * 3600_000;

function member(s, eid) {
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
}

export async function commitPhoto(req, env, s, eid, pid, publicBase) {
  member(s, eid);
  const b = await req.json().catch(() => ({}));
  const base = `e/${eid}/${s.uid}/${pid}`;
  const [orig, prev, thumb] = await Promise.all([env.PRIVATE.head(base), env.PUBLIC.head(`${base}_p.jpg`), env.PUBLIC.head(`${base}_t.jpg`)]);
  if (!orig || !prev || !thumb) throw httpError(409, 'La foto no terminó de subir. Se reintenta sola.');

  const [set, st, user, existing] = await adminGetMany(env, [`events/${eid}/sets/${s.uid}`, 'settings/platform', `users/${s.uid}`, `photos/${pid}`]);
  if (existing) {
    if (existing.photographerUid !== s.uid) throw httpError(409, 'Id de foto en uso');
    return json({ ok: true, already: true, expiresAt: set?.expiresAt?.getTime?.() || null });
  }
  if (!set) throw httpError(409, 'Guardá primero los datos de tu álbum en este evento');
  const max = albumPhotoLimit(set, st || {}, user);
  if (max > 0 && (set.photoCount || 0) >= max) {
    throw httpError(402, isFree(user)
      ? `Tu álbum llegó al tope de ${max} fotos del plan Gratis. Pasate a un plan pago para seguir subiendo.`
      : `El álbum llegó a su tope de ${max} fotos. Sumá más fotos con un pack para seguir subiendo.`);
  }

  const subs = (set.subalbums || []).map(x => x.id);
  const subalbumId = subs.includes(b.subalbumId) ? b.subalbumId : '';
  const now = Date.now();
  const t = Number(b.takenAt);
  const takenAt = Number.isFinite(t) && t > Date.UTC(1995, 0, 1) && t < now + DAY ? t : now;
  const bytesPublic = prev.size + thumb.size;
  const photo = {
    eventId: eid, photographerUid: s.uid, subalbumId,
    previewUrl: `${publicBase}/${base}_p.jpg`, thumbUrl: `${publicBase}/${base}_t.jpg`,
    width: Math.max(1, Math.round(Number(b.width) || 1)), height: Math.max(1, Math.round(Number(b.height) || 1)),
    bytes: orig.size, fileBytes: Math.max(0, Math.round(Number(b.fileBytes) || orig.size)), bytesPublic,
    takenAt: new Date(takenAt), fileName: String(b.fileName || '').slice(0, 120),
    bibs: [], hidden: false, originalDeleted: false, createdAt: new Date(now),
  };
  const setPath = `events/${eid}/sets/${s.uid}`;
  const ops = [
    { set: `photos/${pid}`, data: photo, mustNotExist: true },
    { inc: setPath, fields: { photoCount: 1, bytesOriginal: orig.size, bytesPublic, [`hourCounts.${hourOf(takenAt)}`]: 1 } },
  ];
  // El plazo de venta arranca con la primera foto (una sola vez), según el plan del fotógrafo.
  let expiresAt = set.expiresAt?.getTime?.() || null;
  if (!expiresAt) {
    expiresAt = now + rulesFor(user, st || {}).days * DAY;
    ops.push({ update: setPath, data: { expiresAt: new Date(expiresAt) } });
  }
  const ok = await adminCommit(env, ops);
  return json({ ok: true, already: !ok, expiresAt, photo: { ...photo, takenAt, createdAt: now } });
}

// Fecha hasta la que el comprador puede descargar un pedido.
export const orderDownloadUntil = o => o?.downloadExpiresAt?.getTime?.() || 0;

export async function deletePhotos(req, env, s, eid) {
  member(s, eid);
  const { ids } = await req.json().catch(() => ({}));
  const list = [...new Set(Array.isArray(ids) ? ids : [])].filter(id => ID_RE.test(id)).slice(0, 100);
  if (!list.length) throw httpError(400, 'Sin fotos');
  const photos = await adminGetMany(env, list.map(id => `photos/${id}`));
  // Fotos vendidas con descarga vigente: no se borran (el comprador las tiene que poder bajar), se ocultan.
  const orders = await adminQuery(env, 'orders', { filters: [['photographerUid', '==', s.uid], ['eventId', '==', eid], ['status', '==', 'approved']], limit: 2000 });
  const now = Date.now();
  const sold = new Set(orders.filter(o => orderDownloadUntil(o) > now).flatMap(o => (o.items || []).map(i => i.photoId)));

  const setPath = `events/${eid}/sets/${s.uid}`;
  const deleted = [], hidden = [], keys = [];
  const ops = [];
  const dec = { photoCount: 0, bytesOriginal: 0, bytesPublic: 0 };
  list.forEach((id, i) => {
    const p = photos[i];
    const base = `e/${eid}/${s.uid}/${id}`;
    if (!p) { keys.push(base, `${base}_p.jpg`, `${base}_t.jpg`); deleted.push(id); return; } // subida a medias
    if (p.photographerUid !== s.uid || p.eventId !== eid) return;
    if (sold.has(id)) {
      if (!p.hidden) ops.push({ update: `photos/${id}`, data: { hidden: true, soldHidden: true } });
      hidden.push(id);
      return;
    }
    keys.push(base, `${base}_p.jpg`, `${base}_t.jpg`);
    ops.push({ del: `photos/${id}` });
    dec.photoCount -= 1; dec.bytesOriginal -= p.bytes || 0; dec.bytesPublic -= p.bytesPublic || 0;
    const h = p.takenAt?.getTime?.();
    if (h) dec[`hourCounts.${hourOf(h)}`] = (dec[`hourCounts.${hourOf(h)}`] || 0) - 1;
    deleted.push(id);
  });
  if (dec.photoCount) ops.push({ inc: setPath, fields: dec });
  if (ops.length) await adminCommit(env, ops);
  // R2 después de Firestore: si algo falla en el medio, queda un archivo suelto (lo limpia el escaneo), nunca una foto rota.
  const priv = keys.filter(k => !k.endsWith('.jpg')), pub = keys.filter(k => k.endsWith('.jpg'));
  if (priv.length) await env.PRIVATE.delete(priv);
  if (pub.length) await env.PUBLIC.delete(pub);
  return json({ ok: true, deleted, hidden });
}
