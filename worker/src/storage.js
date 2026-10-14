// Uso de R2: recorre los dos buckets, suma bytes por álbum (set) y por fotógrafo, corrige los contadores
// de cada set y guarda un resumen en adminStats/storage (solo lo lee el superadmin).
// Corre todos los días (cron) y a pedido desde el panel: POST /admin/storage/scan.
import { verifyIdToken } from './firebase.js';
import { adminGet, adminGetMany, adminSet, adminUpdateMany } from './admin.js';
import { json, httpError } from './http.js';

export async function scanStorage(env) {
  const sets = {};      // "eid/uid" -> { pub, priv, n }
  const profiles = {};  // uid -> bytes (avatar, logo, portfolio)
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
          const s = (sets[`${k[1]}/${k[2]}`] ||= { pub: 0, priv: 0, n: 0 });
          s[kind] += o.size;
          if (kind === 'priv') s.n++;
        } else if (k[0] === 'e') covers += o.size;
        else if (k[0] === 'u') profiles[k[1]] = (profiles[k[1]] || 0) + o.size;
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
  let orphan = 0;
  const byUser = {};
  ids.forEach((id, i) => {
    const s = sets[id];
    const uid = id.split('/')[1];
    if (!docs[i]) { orphan += s.pub + s.priv; return; }
    updates.push({ path: `events/${id.replace('/', '/sets/')}`, data: { bytesOriginal: s.priv, bytesPublic: s.pub, storageAt: now } });
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
