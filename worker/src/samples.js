// Álbum vencido (originales borrados por retención): quedan SAMPLE_COUNT fotos de muestra con marca de agua, para que se
// vea el trabajo del fotógrafo y el evento. Se eligen las más vendidas y, si faltan, al azar. El resto de las muestras se
// borra (documento + archivos públicos). Las vendidas que no quedan se ocultan y conservan la miniatura (se ve en Mis compras).
// Ya no se pueden comprar: el set queda con originalsDeleted (setForSale = false en el sitio y checkout lo rechaza).
import { adminQuery, adminCommit, adminGet } from './admin.js';
import { requireUser } from './firebase.js';
import { json, httpError } from './http.js';
import { PREVIEW_SUFFIXES, THUMB_SUFFIXES } from './photos.js';

export const SAMPLE_COUNT = 10;
const hourOf = ms => Math.floor(ms / 3600_000) * 3600_000;

export async function keepSamples(env, eid, uid) {
  const [photos, orders] = await Promise.all([
    adminQuery(env, 'photos', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid]], limit: 10000 }),
    adminQuery(env, 'orders', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid], ['status', '==', 'approved']], limit: 5000 }),
  ]);
  const sold = new Map();
  for (const o of orders) for (const it of o.items || []) sold.set(it.photoId, (sold.get(it.photoId) || 0) + 1);
  // Las más vendidas primero; el resto, mezclado.
  const visible = photos.filter(p => !p.hidden).map(p => ({ p, n: sold.get(p.id) || 0, r: Math.random() }))
    .sort((a, b) => b.n - a.n || a.r - b.r);
  const keep = new Set(visible.slice(0, SAMPLE_COUNT).map(x => x.p.id));
  const ops = [], pubKeys = [];
  const hourCounts = {};
  for (const p of photos) {
    const base = `e/${eid}/${uid}/${p.id}`;
    if (keep.has(p.id)) {
      ops.push({ update: `photos/${p.id}`, data: { sample: true, price: 0 }, mask: ['sample', 'price'] });
      const h = p.takenAt?.getTime?.();
      if (h) hourCounts[hourOf(h)] = (hourCounts[hourOf(h)] || 0) + 1;
      continue;
    }
    pubKeys.push(...PREVIEW_SUFFIXES.map(x => base + x));
    if (sold.has(p.id)) { if (!p.hidden) ops.push({ update: `photos/${p.id}`, data: { hidden: true, soldHidden: true }, mask: ['hidden', 'soldHidden'] }); }
    else { ops.push({ del: `photos/${p.id}` }); pubKeys.push(...THUMB_SUFFIXES.map(x => base + x)); }
  }
  ops.push({ update: `events/${eid}/sets/${uid}`, data: { photoCount: keep.size, hourCounts, samplesKept: true, samplesKeptAt: new Date() }, mask: ['photoCount', 'hourCounts', 'samplesKept', 'samplesKeptAt'] });
  for (let i = 0; i < ops.length; i += 400) await adminCommit(env, ops.slice(i, i + 400));
  // Archivos después de Firestore: si algo falla, queda un archivo suelto (lo limpia el escaneo), nunca una foto rota.
  for (let i = 0; i < pubKeys.length; i += 1000) await env.PUBLIC.delete(pubKeys.slice(i, i + 1000));
  return { kept: keep.size, removed: photos.length - keep.size };
}

// "Cerrar álbum" (el fotógrafo, antes de que venza): igual que el vencimiento pero en el momento. Se borran los originales
// y las huellas de caras, el set queda con originalsDeleted (deja de contar como álbum activo) y quedan 10 fotos de muestra.
//   POST /events/{eid}/close   Bearer (fotógrafo del set o superadmin)  {uid?}
export async function closeAlbum(req, env, eid) {
  const c = await requireUser(req, env);
  const isSuper = c.email === 'lautarom87@gmail.com' && c.email_verified === true;
  const body = await req.json().catch(() => ({}));
  const uid = isSuper && body.uid ? String(body.uid) : c.sub;
  const set = await adminGet(env, `events/${eid}/sets/${uid}`);
  if (!set) throw httpError(404, 'No tenés fotos en este evento');
  if (set.originalsDeleted) return json({ ok: true, already: true });
  // Los originales vendidos quedan (quien compró puede seguir descargando hasta su fecha); se borran al vencer, como siempre.
  const orders = await adminQuery(env, 'orders', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid], ['status', '==', 'approved']], limit: 5000 });
  const sold = new Set(orders.flatMap(o => (o.items || []).map(it => it.photoId)));
  for (const prefix of [`e/${eid}/${uid}/`, `faces/${eid}/${uid}/`]) {
    let cursor;
    do {
      const r = await env.PRIVATE.list({ prefix, cursor, limit: 1000 });
      const keys = r.objects.map(o => o.key).filter(k => !(k.startsWith('e/') && sold.has(k.split('/')[3])));
      if (keys.length) await env.PRIVATE.delete(keys);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }
  const now = new Date();
  await adminCommit(env, [{ update: `events/${eid}/sets/${uid}`, data: { originalsDeleted: true, originalsDeletedAt: now, closedAt: now, facesPhotos: 0 }, mask: ['originalsDeleted', 'originalsDeletedAt', 'closedAt', 'facesPhotos'] }]);
  const r = await keepSamples(env, eid, uid);
  return json({ ok: true, ...r });
}

// Superadmin: eliminar del todo el álbum de un fotógrafo (fotos, archivos, huellas y su set). Si era el único fotógrafo
// de un evento propio, se borra también el evento. No se permite si hay ventas (los compradores tienen que poder descargar).
//   POST /admin/events/{eid}/delete-album   Bearer (superadmin)  {uid}
export async function forceDeleteAlbum(req, env, eid) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const { uid } = await req.json().catch(() => ({}));
  if (!uid) throw httpError(400, 'Falta el fotógrafo');
  const [ev, set] = await Promise.all([adminGet(env, `events/${eid}`), adminGet(env, `events/${eid}/sets/${uid}`)]);
  if (!ev) throw httpError(404, 'El evento no existe');
  const orders = await adminQuery(env, 'orders', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid], ['status', '==', 'approved']], limit: 1 });
  if (orders.length) throw httpError(409, 'Este álbum tiene ventas: no se puede eliminar. Usá "Cerrar álbum" (quedan 10 de muestra y los compradores siguen descargando).');
  const photos = await adminQuery(env, 'photos', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid]], limit: 10000 });
  const ops = photos.map(p => ({ del: `photos/${p.id}` }));
  if (set) ops.push({ del: `events/${eid}/sets/${uid}` });
  const others = (ev.photographerUids || []).filter(u => u !== uid);
  const dropEvent = ev.kind === 'own' && !others.length;
  if (dropEvent) ops.push({ del: `events/${eid}` });
  else ops.push({ update: `events/${eid}`, data: { photographerUids: others }, mask: ['photographerUids'] });
  for (let i = 0; i < ops.length; i += 400) await adminCommit(env, ops.slice(i, i + 400));
  let files = 0;
  for (const [bucket, prefix] of [[env.PRIVATE, `e/${eid}/${uid}/`], [env.PUBLIC, `e/${eid}/${uid}/`], [env.PRIVATE, `faces/${eid}/${uid}/`]]) {
    let cursor;
    do {
      const r = await bucket.list({ prefix, cursor, limit: 1000 });
      if (r.objects.length) { await bucket.delete(r.objects.map(o => o.key)); files += r.objects.length; }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }
  return json({ ok: true, photos: photos.length, files, eventDeleted: dropEvent });
}

// "Eliminar del historial" (el fotógrafo, solo con el álbum ya cerrado o vacío): se borran las fotos de muestra y el álbum
// deja de verse en la web y en su panel. Si hubo ventas, lo vendido queda (oculto) para que los compradores sigan
// descargando hasta su fecha: el set se marca removed en vez de borrarse (así la limpieza no toca esos originales).
//   POST /events/{eid}/remove   Bearer (fotógrafo del set o superadmin)  {uid?}
export async function removeAlbum(req, env, eid) {
  const c = await requireUser(req, env);
  const isSuper = c.email === 'lautarom87@gmail.com' && c.email_verified === true;
  const body = await req.json().catch(() => ({}));
  const uid = isSuper && body.uid ? String(body.uid) : c.sub;
  const [ev, set] = await Promise.all([adminGet(env, `events/${eid}`), adminGet(env, `events/${eid}/sets/${uid}`)]);
  if (!ev || !(ev.photographerUids || []).includes(uid)) throw httpError(404, 'No tenés un álbum en este evento');
  if (set && (set.photoCount || 0) > 0 && !set.originalsDeleted) throw httpError(409, 'Primero cerrá el álbum (📦 Cerrar álbum). Después lo podés eliminar del historial.');
  const [photos, orders, aliases] = await Promise.all([
    adminQuery(env, 'photos', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid]], limit: 10000 }),
    adminQuery(env, 'orders', { filters: [['eventId', '==', eid], ['photographerUid', '==', uid], ['status', '==', 'approved']], limit: 5000 }),
    adminQuery(env, 'aliases', { filters: [['uid', '==', uid], ['eventId', '==', eid]], limit: 20 }),
  ]);
  const sold = new Set(orders.flatMap(o => (o.items || []).map(it => it.photoId)));
  const ops = [], pubKeys = [];
  for (const p of photos) {
    const base = `e/${eid}/${uid}/${p.id}`;
    pubKeys.push(...PREVIEW_SUFFIXES.map(x => base + x));
    // Lo vendido queda oculto con su miniatura (se ve en "Mis compras"); lo demás se borra.
    if (sold.has(p.id)) ops.push({ update: `photos/${p.id}`, data: { hidden: true, soldHidden: true, sample: false }, mask: ['hidden', 'soldHidden', 'sample'] });
    else { ops.push({ del: `photos/${p.id}` }); pubKeys.push(...THUMB_SUFFIXES.map(x => base + x)); }
  }
  for (const a of aliases) ops.push({ del: `aliases/${a.id}` });
  const now = new Date();
  if (!set) { /* nada */ } else if (sold.size) ops.push({ update: `events/${eid}/sets/${uid}`, data: { removed: true, removedAt: now, photoCount: 0, hourCounts: {} }, mask: ['removed', 'removedAt', 'photoCount', 'hourCounts'] });
  else ops.push({ del: `events/${eid}/sets/${uid}` });
  const others = (ev.photographerUids || []).filter(u => u !== uid);
  const dropEvent = ev.kind === 'own' && !others.length;
  if (dropEvent && !sold.size) ops.push({ del: `events/${eid}` });
  // Con ventas el evento queda (los pedidos lo nombran) pero fuera de la web y del panel.
  else if (dropEvent) ops.push({ update: `events/${eid}`, data: { status: 'removed', photographerUids: [], photoCount: 0, removedAt: now }, mask: ['status', 'photographerUids', 'photoCount', 'removedAt'] });
  else ops.push({ update: `events/${eid}`, data: { photographerUids: others }, mask: ['photographerUids'] });
  for (let i = 0; i < ops.length; i += 400) await adminCommit(env, ops.slice(i, i + 400));
  // Archivos: muestras públicas, huellas de caras y originales no vendidos (los vendidos se borran al vencer, como siempre).
  for (let i = 0; i < pubKeys.length; i += 1000) await env.PUBLIC.delete(pubKeys.slice(i, i + 1000));
  for (const prefix of [`e/${eid}/${uid}/`, `faces/${eid}/${uid}/`]) {
    let cursor;
    do {
      const r = await env.PRIVATE.list({ prefix, cursor, limit: 1000 });
      const keys = r.objects.map(o => o.key).filter(k => !(k.startsWith('e/') && sold.has(k.split('/')[3])));
      if (keys.length) await env.PRIVATE.delete(keys);
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }
  return json({ ok: true, removed: photos.length - sold.size, eventDeleted: dropEvent && !sold.size });
}
