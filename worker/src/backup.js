// Respaldo semanal de Firestore en R2 privado: backups/{fecha}/{colección}.json (respuesta cruda de runQuery,
// sin procesar, para no gastar CPU). Se guardan las últimas KEEP semanas. No incluye mpTokens (se revinculan).
// Cron semanal y a pedido: POST /admin/backup (superadmin).
import { verifyIdToken } from './firebase.js';
import { adminExportRaw, adminSet } from './admin.js';
import { json, httpError } from './http.js';

const COLLECTIONS = ['settings', 'tagTypes', 'tags', 'slugs', 'users', 'userPrivate', 'events', 'sets', 'photos', 'portfolio',
  'orders', 'extensions', 'subscriptions', 'customers', 'follows', 'domains', 'planRequests', 'adminStats'];
const KEEP = 8;

export async function runBackup(env) {
  const day = new Date().toISOString().slice(0, 10);
  const files = [];
  for (const c of COLLECTIONS) {
    const buf = await adminExportRaw(env, c);
    await env.PRIVATE.put(`backups/${day}/${c}.json`, buf, { httpMetadata: { contentType: 'application/json' } });
    files.push({ col: c, bytes: buf.byteLength });
  }
  // Borra respaldos viejos.
  const listed = await env.PRIVATE.list({ prefix: 'backups/', delimiter: '/' });
  const days = (listed.delimitedPrefixes || []).map(p => p.split('/')[1]).sort();
  for (const old of days.slice(0, Math.max(0, days.length - KEEP))) {
    let cursor;
    do {
      const r = await env.PRIVATE.list({ prefix: `backups/${old}/`, cursor });
      if (r.objects.length) await env.PRIVATE.delete(r.objects.map(o => o.key));
      cursor = r.truncated ? r.cursor : undefined;
    } while (cursor);
  }
  const info = { at: new Date(), day, files, total: files.reduce((a, f) => a + f.bytes, 0), kept: Math.min(days.length, KEEP) };
  await adminSet(env, 'adminStats/backup', info);
  return info;
}

export async function backupRequest(req, env) {
  const idToken = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!idToken) throw httpError(401, 'Falta autenticación');
  const c = await verifyIdToken(idToken, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const info = await runBackup(env);
  return json({ ok: true, day: info.day, total: info.total });
}
