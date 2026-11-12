// Resumen del día para el superadmin, todas las noches a las 23 (Argentina): fotógrafos nuevos, álbumes nuevos,
// ventas (cantidad y $) y la comisión de la plataforma. Llega como aviso al celular (o por mail si no tiene avisos activados).
import { adminGet, adminSet, serviceToken } from './admin.js';
import { decodeFields } from './firebase.js';
import { accessToken } from './admin.js';

const ADMIN_EMAIL = 'lautarom87@gmail.com';
const root = env => `https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const tsv = ms => ({ timestampValue: new Date(ms).toISOString() });
const range = (field, from, to) => ({ compositeFilter: { op: 'AND', filters: [
  { fieldFilter: { field: { fieldPath: field }, op: 'GREATER_THAN_OR_EQUAL', value: tsv(from) } },
  { fieldFilter: { field: { fieldPath: field }, op: 'LESS_THAN', value: tsv(to) } }] } });

async function run(env, collectionId, fields, { where, allDescendants = false } = {}) {
  const res = await fetch(`${root(env)}:runQuery`, {
    method: 'POST', headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId, allDescendants }], select: { fields: fields.map(fieldPath => ({ fieldPath })) }, ...(where ? { where } : {}) } }),
  });
  if (!res.ok) throw new Error(`Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).filter(r => r.document).map(r => decodeFields(r.document.fields || {}));
}
const ms = v => (v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);
const money = n => '$' + Math.round(n).toLocaleString('es-AR').replace(/,/g, '.');

async function adminUid(env) {
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: [ADMIN_EMAIL] }),
  });
  return res.ok ? (await res.json()).users?.[0]?.localId || null : null;
}

export async function dailySummary(env, now = Date.now()) {
  // Día de hoy en Argentina (UTC-3).
  const art = new Date(now - 3 * 3600e3);
  const from = Date.UTC(art.getUTCFullYear(), art.getUTCMonth(), art.getUTCDate()) + 3 * 3600e3, to = from + 86400e3;
  const day = art.toISOString().slice(0, 10);
  const key = `adminStats/daily-${day}`;
  if (await adminGet(env, key)) return false; // ya se mandó
  const [users, sets, orders] = await Promise.all([
    run(env, 'users', ['role', 'demo'], { where: range('createdAt', from, to) }),
    run(env, 'sets', ['createdAt'], { allDescendants: true }), // colección de grupo: sin índice por fecha, se filtra acá
    run(env, 'orders', ['status', 'total', 'platformFee', 'count'], { where: range('paidAt', from, to) }),
  ]);
  const photogs = users.filter(u => u.role === 'photographer' && !u.demo).length;
  const albums = sets.filter(s => { const t = ms(s.createdAt); return t >= from && t < to; }).length;
  const paid = orders.filter(o => o.status === 'approved');
  const gmv = paid.reduce((a, o) => a + (Number(o.total) || 0), 0);
  const fee = paid.reduce((a, o) => a + (Number(o.platformFee) || 0), 0);
  const photos = paid.reduce((a, o) => a + (Number(o.count) || 0), 0);
  const body = `📸 ${photogs} fotógrafo${photogs === 1 ? '' : 's'} nuevo${photogs === 1 ? '' : 's'} · 📁 ${albums} álbum${albums === 1 ? '' : 'es'} nuevo${albums === 1 ? '' : 's'}\n`
    + `🛒 ${paid.length} venta${paid.length === 1 ? '' : 's'} (${photos} foto${photos === 1 ? '' : 's'}) por ${money(gmv)} · 💰 tu comisión: ${money(fee)}`;
  const uid = await adminUid(env);
  if (!uid) throw new Error('No se encontró la cuenta del superadmin');
  const site = env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';
  await adminSet(env, `pushQueue/daily_${day}`, {
    title: `📊 Resumen de hoy en QMF`, body, link: `${site}#/admin`, uids: [uid], createdAt: new Date(), cta: 'Ir al panel',
    foot: 'Resumen diario de Quiero Mis Fotos (solo para el superadmin).',
  });
  await adminSet(env, key, { sentAt: new Date(), photogs, albums, sales: paid.length, photos, gmv, fee });
  return true;
}
