// Álbum vencido (originales borrados por retención): quedan SAMPLE_COUNT fotos de muestra con marca de agua, para que se
// vea el trabajo del fotógrafo y el evento. Se eligen las más vendidas y, si faltan, al azar. El resto de las muestras se
// borra (documento + archivos públicos). Las vendidas que no quedan se ocultan y conservan la miniatura (se ve en Mis compras).
// Ya no se pueden comprar: el set queda con originalsDeleted (setForSale = false en el sitio y checkout lo rechaza).
import { adminQuery, adminCommit } from './admin.js';

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
    pubKeys.push(`${base}_p.jpg`);
    if (sold.has(p.id)) { if (!p.hidden) ops.push({ update: `photos/${p.id}`, data: { hidden: true, soldHidden: true }, mask: ['hidden', 'soldHidden'] }); }
    else { ops.push({ del: `photos/${p.id}` }); pubKeys.push(`${base}_t.jpg`); }
  }
  ops.push({ update: `events/${eid}/sets/${uid}`, data: { photoCount: keep.size, hourCounts, samplesKept: true, samplesKeptAt: new Date() }, mask: ['photoCount', 'hourCounts', 'samplesKept', 'samplesKeptAt'] });
  for (let i = 0; i < ops.length; i += 400) await adminCommit(env, ops.slice(i, i + 400));
  // Archivos después de Firestore: si algo falla, queda un archivo suelto (lo limpia el escaneo), nunca una foto rota.
  for (let i = 0; i < pubKeys.length; i += 1000) await env.PUBLIC.delete(pubKeys.slice(i, i + 1000));
  return { kept: keep.size, removed: photos.length - keep.size };
}
