// Limpieza de archivos sueltos en R2 (corre con el escaneo diario). Solo toca archivos de más de 2 días
// (para no pisar subidas en curso). Si CLEANUP_DELETE="1" borra; si no, solo informa (simulación).
//   - álbumes cuyo set ya no existe (evento borrado o fotógrafo que salió)
//   - fotos de un álbum sin registro en `photos` (subidas que se cortaron a mitad)
//   - portadas de evento reemplazadas
//   - avatar, logo y fotos de portfolio reemplazados o borrados
import { adminGetMany, adminQuery } from './admin.js';

const MIN_AGE = 2 * 86400_000;

// Clave de R2 a partir de una URL pública (dominio de fotos o /public/ del Worker).
const keyOf = url => { try { return new URL(url).pathname.replace(/^\/(public\/)?/, ''); } catch { return ''; } };

export async function cleanOrphans(env, { sets, ids, docs, profileObjs, coverObjs }) {
  const cutoff = Date.now() - MIN_AGE;
  const items = []; // { key, size, kind, reason }
  const add = (o, reason) => { if (o.uploaded && o.uploaded < cutoff) items.push({ key: o.key, size: o.size, kind: o.kind, reason }); };

  // ---- álbumes
  for (const [i, id] of ids.entries()) {
    const s = sets[id], set = docs[i];
    if (!set) { s.objs.forEach(o => add(o, 'Álbum borrado')); continue; }
    const pidOf = k => k.split('/')[3].replace(/_(p|t)\.jpg$/, '');
    const pids = [...new Set(s.objs.map(o => pidOf(o.key)))];
    if (pids.length === (set.photoCount || 0)) continue; // coincide: no hay sueltos
    const found = new Set();
    for (let j = 0; j < pids.length; j += 100) {
      const got = await adminGetMany(env, pids.slice(j, j + 100).map(p => `photos/${p}`));
      got.forEach((d, n) => { if (d) found.add(pids[j + n]); });
    }
    s.objs.filter(o => !found.has(pidOf(o.key))).forEach(o => add(o, 'Foto sin registro'));
  }

  // ---- portadas de eventos
  const eids = Object.keys(coverObjs);
  for (let j = 0; j < eids.length; j += 100) {
    const evs = await adminGetMany(env, eids.slice(j, j + 100).map(e => `events/${e}`));
    evs.forEach((ev, n) => {
      const keep = ev?.coverUrl ? keyOf(ev.coverUrl) : '';
      coverObjs[eids[j + n]].forEach(o => { if (o.key !== keep) add(o, ev ? 'Portada reemplazada' : 'Portada de evento borrado'); });
    });
  }

  // ---- perfil: avatar, logo y portfolio
  const uids = Object.keys(profileObjs);
  // Todo el portfolio en una sola consulta (antes era una por fotógrafo: muchos pedidos por ejecución).
  const pfAll = uids.length ? await adminQuery(env, 'portfolio', { limit: 20000 }) : [];
  const pfBy = new Map();
  for (const p of pfAll) (pfBy.get(p.photographerUid) || pfBy.set(p.photographerUid, []).get(p.photographerUid)).push(p);
  for (let j = 0; j < uids.length; j += 100) {
    const users = await adminGetMany(env, uids.slice(j, j + 100).map(u => `users/${u}`));
    for (const [n, user] of users.entries()) {
      if (!user) continue; // sin perfil: no se toca (por las dudas)
      const uid = uids[j + n];
      const keep = new Set([keyOf(user.avatarUrl || ''), user.watermark?.logoKey || '', keyOf(user.watermark?.logoUrl || ''), keyOf(user.site?.heroUrl || ''), keyOf(user.profileCoverUrl || '')]);
      const pf = pfBy.get(uid) || [];
      for (const p of pf) [p.urlKey, p.thumbKey, p.cleanKey, keyOf(p.url || ''), keyOf(p.thumbUrl || ''), keyOf(p.cleanUrl || '')].forEach(k => k && keep.add(k));
      profileObjs[uid].forEach(o => { if (!keep.has(o.key)) add(o, o.key.includes('/pf/') ? 'Foto de portfolio borrada' : 'Imagen de perfil reemplazada'); });
    }
  }

  const deleting = env.CLEANUP_DELETE === '1';
  const deletedKeys = new Set();
  if (deleting && items.length) {
    for (const kind of ['pub', 'priv']) {
      const keys = items.filter(x => x.kind === kind).map(x => x.key);
      const bucket = kind === 'pub' ? env.PUBLIC : env.PRIVATE;
      for (let j = 0; j < keys.length; j += 1000) await bucket.delete(keys.slice(j, j + 1000));
      keys.forEach(k => deletedKeys.add(k));
    }
  }
  const byReason = {};
  for (const x of items) { const r = (byReason[x.reason] ||= { count: 0, bytes: 0 }); r.count++; r.bytes += x.size; }
  return {
    mode: deleting ? 'on' : 'simulacion', count: items.length, bytes: items.reduce((a, x) => a + x.size, 0),
    byReason, sample: items.slice(0, 25).map(x => ({ key: x.key, size: x.size, reason: x.reason })),
    ...(deleting ? { deletedKeys } : {}),
  };
}
