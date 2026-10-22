// Prueba para cobros por transferencia: ¿las transferencias que entran al CVU del fotógrafo aparecen en
// /v1/payments/search con su token? Solo superadmin; devuelve los cobros de los últimos días sin datos del pagador.
//   POST /admin/mp/recent {uid, days?}
import { requireUser } from './firebase.js';
import { sellerToken, mpFetch } from './mp.js';
import { json, httpError } from './http.js';

const isSuper = c => c.email === 'lautarom87@gmail.com' && c.email_verified === true;

export async function recentPayments(req, env) {
  const c = await requireUser(req, env);
  if (!isSuper(c)) throw httpError(403, 'Solo superadmin');
  const { uid, days = 3 } = await req.json().catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(uid || '')) throw httpError(400, 'Pedido inválido');
  const token = await sellerToken(env, uid);
  const d = Math.min(30, Math.max(1, Number(days) || 3));
  const q = new URLSearchParams({ sort: 'date_created', criteria: 'desc', range: 'date_created', begin_date: `NOW-${d}DAYS`, end_date: 'NOW', limit: '50' });
  const r = await mpFetch(token, `/v1/payments/search?${q}`);
  const payments = (r.results || []).map(p => ({
    id: p.id, created: p.date_created, approved: p.date_approved, status: p.status, statusDetail: p.status_detail,
    amount: p.transaction_amount, net: p.transaction_details?.net_received_amount ?? null,
    type: p.payment_type_id, method: p.payment_method_id, operation: p.operation_type,
    description: String(p.description || '').slice(0, 80), ref: p.external_reference || '',
  }));
  return json({ total: r.paging?.total ?? payments.length, payments });
}
