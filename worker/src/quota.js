// Cupo de fotos de la cuenta (entre todos sus álbumes): para controlarlo al subir hacen falta los demás sets del
// fotógrafo. Se guardan 2 minutos en la caché del Worker para no consultar todos sus eventos en cada foto
// (el set del álbum que se está subiendo se lee siempre fresco).
import { adminQuery, adminGetMany } from './admin.js';
import { albumPhotoLimit } from './plans.js';

const TTL = 120;
const keyOf = uid => new Request(`https://cache.quieromisfotos.internal/quota/${uid}`);

async function allSets(env, uid) {
  const cache = caches.default;
  const hit = await cache.match(keyOf(uid)).catch(() => null);
  if (hit) return hit.json();
  const evs = await adminQuery(env, 'events', { filters: [['photographerUids', 'array-contains', uid]], limit: 500 });
  const sets = evs.length ? await adminGetMany(env, evs.map(e => `events/${e.id}/sets/${uid}`)) : [];
  const out = evs.map((e, i) => (sets[i] ? { eid: e.id, photoCount: sets[i].photoCount || 0, extraPhotos: sets[i].extraPhotos || 0, originalsDeleted: !!sets[i].originalsDeleted } : null)).filter(Boolean);
  await cache.put(keyOf(uid), new Response(JSON.stringify(out), { headers: { 'Cache-Control': `max-age=${TTL}` } })).catch(() => {});
  return out;
}

// Tope de fotos para este álbum (0 = sin tope), según el cupo de la cuenta.
export async function albumLimitFor(env, uid, eid, set, st, user) {
  const lim = albumPhotoLimit(set, st || {}, user, []);
  if (!lim) return 0;
  const others = (await allSets(env, uid)).filter(s => s.eid !== eid);
  return albumPhotoLimit(set, st || {}, user, others);
}

// Mensaje cuando no entra otra foto.
export const fullMsg = (max, free) => (free
  ? `Llegaste al tope de fotos del plan Gratis. Pasate a un plan pago o esperá a que se borre un álbum vencido.`
  : `Llegaste al tope de fotos de tu plan entre todos tus álbumes. Sumá más fotos con un pack o esperá a que se borre un álbum vencido.`);
