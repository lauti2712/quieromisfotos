// Uso de R2: recorre los dos buckets, suma bytes por álbum (set) y por fotógrafo, corrige los contadores
// de cada set y guarda un resumen en adminStats/storage (solo lo lee el superadmin).
// Corre todos los días (cron) y a pedido desde el panel: POST /admin/storage/scan.
//
// Retención: los originales de un álbum se borran GRACE_DAYS después de que deja de venderse
// (vencimiento + extensiones pagas). Solo borra si RETENTION_DELETE="1"; si no, lo informa como simulación.
import { verifyIdToken } from './firebase.js';
import { adminGet, adminGetMany, adminSet, adminUpdateMany } from './admin.js';
import { json, httpError } from './http.js';
import { setAvailableUntil } from './orders.js';
import { notifyUser, notifyFollowersOnce } from './push.js';
import { cleanOrphans } from './cleanup.js';

const GRACE_DAYS = 7;

export async function scanStorage(env) {
  const sets = {};      // "eid/uid" -> { pub, priv, n, keys (originales), objs }
  const profiles = {};  // uid -> bytes (avatar, logo, portfolio)
  const profileObjs = {}, coverObjs = {}; // para la limpieza de archivos sueltos
  let covers = 0, other = 0;
  const totals = { pub: 0, priv: 0, objects: 0 };

  for (const [bucket, kind] of [[env.PUBLIC, 'pub'], [env.PRIVATE, 'priv']]) {
    let cursor;
    do {
      const r = await bucket.list({ cursor, limit: 1000 });
      for (const o of r.objects) {
        totals[kind] += o.size; totals.objects++;
        const k = o.key.split('/');
        if (k[0] === 'e' && k.length === 4) {
          const s = (sets[`${k[1]}/${k[2]}`] ||= { pub: 0, priv: 0, n: 0, keys: [], objs: [] });
          s[kind] += o.size;
          s.objs.push({ key: o.key, size: o.size, uploaded: o.uploaded?.getTime?.() || 0, kind });
          if (kind === 'priv') { s.n++; s.keys.push(o.key); }
        } else if (k[0] === 'e') {
          covers += o.size;
          (coverObjs[k[1]] ||= []).push({ key: o.key, size: o.size, uploaded: o.uploaded?.getTime?.() || 0, kind });
        } else if (k[0] === 'u') {
          profiles[k[1]] = (profiles[k[1]] || 0) + o.size;
          (profileObjs[k[1]] ||= []).push({ key: o.key, size: o.size, uploaded: o.uploaded?.getTime?.() || 0, kind });
        }
        else other += o.size;
      }
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }

  // Corrige bytes de cada set existente; lo que no tiene set (borrado) queda como "huérfano".
  const ids = Object.keys(sets);
  const docs = [];
  for (let i = 0; i < ids.length; i += 100) {
    docs.push(...await adminGetMany(env, ids.slice(i, i + 100).map(id => { const [e, u] = id.split('/'); return `events/${e}/sets/${u}`; })));
  }
  const now = new Date();
  const updates = [];

  // ---- retención
  const deleting = env.RETENTION_DELETE === '1';
  const retention = { mode: deleting ? 'on' : 'simulacion', deleted: [], due: [], upcoming: [] };
  const warnings = [];
  for (const [i, id] of ids.entries()) {
    const set = docs[i], s = sets[id];
    const until = set && setAvailableUntil(set);
    if (!until || !s.keys.length) continue;
    const deleteAt = until + GRACE_DAYS * 86400_000;
    const row = { eid: id.split('/')[0], uid: id.split('/')[1], photos: s.n, bytes: s.priv, until: new Date(until), deleteAt: new Date(deleteAt) };
    // Avisos push al fotógrafo: 3 días antes de que deje de venderse y 2 días antes del borrado.
    const left = until - now.getTime();
    if (left > 0 && left <= 3 * 86400_000 && set.warnedExpiry?.getTime?.() !== until) {
      warnings.push({ id, type: 'expiry', until, days: Math.ceil(left / 86400_000) });
    } else if (left <= 0 && deleteAt - now.getTime() <= 2 * 86400_000 && deleteAt > now.getTime() && set.warnedDelete?.getTime?.() !== deleteAt) {
      warnings.push({ id, type: 'delete', deleteAt });
    }
    if (deleteAt > now.getTime()) { retention.upcoming.push(row); continue; }
    if (!deleting) { retention.due.push(row); continue; }
    for (let j = 0; j < s.keys.length; j += 1000) await env.PRIVATE.delete(s.keys.slice(j, j + 1000));
    s.deleted = true;
    retention.deleted.push(row);
    totals.priv -= s.priv; totals.objects -= s.n;
    s.priv = 0; s.n = 0;
  }
  retention.upcoming.sort((a, b) => a.deleteAt - b.deleteAt).splice(40);
  const warnUpd = await sendWarnings(env, warnings).catch(e => { console.error('avisos', e); return {}; });
  // Avisos a seguidores pendientes (álbumes con menos de 20 fotos o eventos publicados después de subir).
  for (const [i, id] of ids.entries()) {
    const set = docs[i];
    if (!set || set.followersNotifiedAt || !(set.photoCount > 0) || set.originalsDeleted) continue;
    const [eid, uid] = id.split('/');
    await notifyFollowersOnce(env, eid, uid).catch(e => console.error('seguidores', e));
  }

  // ---- archivos sueltos (álbumes/portadas/fotos borrados, imágenes de perfil reemplazadas)
  const cleanup = await cleanOrphans(env, { sets, ids, docs, profileObjs, coverObjs }).catch(e => { console.error('limpieza', e); return { mode: 'error', error: String(e.message || e) }; });
  if (cleanup.deletedKeys) {
    for (const id of ids) {
      const s = sets[id];
      const gone = s.objs.filter(o => cleanup.deletedKeys.has(o.key));
      for (const o of gone) { s[o.kind] -= o.size; totals[o.kind] -= o.size; totals.objects--; if (o.kind === 'priv') s.n--; }
    }
    delete cleanup.deletedKeys;
  }
  let orphan = 0;
  const byUser = {};
  ids.forEach((id, i) => {
    const s = sets[id];
    const uid = id.split('/')[1];
    if (!docs[i]) { orphan += s.pub + s.priv; return; }
    updates.push({ path: `events/${id.replace('/', '/sets/')}`, data: { bytesOriginal: s.priv, bytesPublic: s.pub, storageAt: now, ...(s.deleted ? { originalsDeleted: true, originalsDeletedAt: now } : {}), ...(warnUpd[id] || {}) } });
    const u = (byUser[uid] ||= { albums: 0, photos: 0, profile: 0, albumsBytes: 0 });
    u.albums++; u.photos += s.n; u.albumsBytes += s.pub + s.priv;
  });
  for (const [uid, b] of Object.entries(profiles)) (byUser[uid] ||= { albums: 0, photos: 0, profile: 0, albumsBytes: 0 }).profile = b;
  await adminUpdateMany(env, updates);

  const total = totals.pub + totals.priv;
  const prev = await adminGet(env, 'adminStats/storage');
  const day = now.toISOString().slice(0, 10);
  const history = [...(prev?.history || []).filter(h => h.d !== day), { d: day, b: total }].slice(-120);
  const topSets = ids.filter((id, i) => docs[i])
    .map(id => ({ eid: id.split('/')[0], uid: id.split('/')[1], bytes: sets[id].pub + sets[id].priv, photos: sets[id].n }))
    .sort((a, b) => b.bytes - a.bytes).slice(0, 60);

  const summary = {
    scannedAt: now, total, publicBytes: totals.pub, privateBytes: totals.priv, objects: totals.objects,
    coversBytes: covers, orphanBytes: orphan, otherBytes: other, byUser, topSets, history,
    retention: { ...retention, lastDeleted: retention.deleted.length ? retention.deleted : (prev?.retention?.lastDeleted || []) },
    cleanup,
  };
  await adminSet(env, 'adminStats/storage', summary);
  return summary;
}

export async function scanRequest(req, env) {
  const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!idToken) throw httpError(401, 'Falta autenticación');
  const c = await verifyIdToken(idToken, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const s = await scanStorage(env);
  return json({ ok: true, total: s.total, objects: s.objects });
}

// Envía los avisos de vencimiento y devuelve los campos a marcar en cada set (para no repetirlos).
async function sendWarnings(env, warnings) {
  const out = {};
  if (!warnings.length) return out;
  const evs = await adminGetMany(env, [...new Set(warnings.map(w => w.id.split('/')[0]))].map(e => `events/${e}`));
  const name = Object.fromEntries(evs.filter(Boolean).map(e => [e.id, e.name || 'tu evento']));
  const panel = env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';
  for (const w of warnings) {
    const [eid, uid] = w.id.split('/');
    const msg = w.type === 'expiry'
      ? { title: `⏳ Tu álbum deja de venderse en ${w.days} día${w.days === 1 ? '' : 's'}`, body: `${name[eid] || 'Tu evento'}: extendé el plazo desde el panel para seguir vendiendo.` }
      : { title: '🗑️ Se borran los originales de tu álbum', body: `${name[eid] || 'Tu evento'}: en 2 días se eliminan los originales. Extendé el plazo si querés conservarlos.` };
    await notifyUser(env, uid, { ...msg, link: `${panel}#/evento/${eid}` }).catch(e => console.error('aviso', e));
    out[w.id] = w.type === 'expiry' ? { warnedExpiry: new Date(w.until) } : { warnedDelete: new Date(w.deleteAt) };
  }
  return out;
}
