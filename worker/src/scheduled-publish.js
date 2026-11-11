// Álbumes programados: el fotógrafo eligió "En una fecha y hora" (events.publishMode = 'scheduled', publishAt).
// Lo llama el aviso de cada 5 minutos: publica los que ya llegaron a su hora y tienen precio.
import { adminQuery, adminGetMany, adminUpdate } from './admin.js';

export async function publishScheduled(env) {
  const now = Date.now();
  const due = (await adminQuery(env, 'events', { filters: [['status', '==', 'draft']], limit: 1000 }))
    .filter(e => e.publishMode === 'scheduled' && (e.publishAt?.getTime?.() || Infinity) <= now).slice(0, 20);
  if (!due.length) return 0;
  const sets = await adminGetMany(env, due.map(e => `events/${e.id}/sets/${e.createdBy}`));
  let n = 0;
  for (const [i, e] of due.entries()) {
    // Sin precio no se publica: queda en borrador (el panel avisa que falta el precio).
    if (e.kind === 'own' && !(sets[i]?.price > 0)) { await adminUpdate(env, `events/${e.id}`, { publishMode: 'draft', publishAt: null }); continue; }
    await adminUpdate(env, `events/${e.id}`, { status: 'published', publishMode: null, publishAt: null, publishedAt: new Date(now), updatedAt: new Date(now) });
    n++;
  }
  return n;
}
