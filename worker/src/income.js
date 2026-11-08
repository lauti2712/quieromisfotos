// Ingresos de la plataforma en su cuenta de Mercado Pago (superadmin): cuándo se acredita cada cobro.
//   GET /admin/income   Bearer (superadmin)
// - Planes y extensiones: pagos cobrados con la cuenta de la plataforma (MP_ACCESS_TOKEN), con el neto y la fecha de
//   liberación que informa Mercado Pago (money_release_date).
// - Comisiones de ventas: entran como marketplace_fee de cada pago del fotógrafo; se liberan con ese pago. La fecha sale de
//   orders.mpReleaseAt (se guarda desde 11/2026; los pedidos anteriores no la tienen).
import { requireUser } from './firebase.js';
import { adminQuery } from './admin.js';
import { mpFetch } from './mp.js';
import { json, httpError } from './http.js';

const DAYS = 90;

export async function incomeRequest(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const since = Date.now() - DAYS * 86400_000;
  const payments = [];
  let error = '';
  if (env.MP_ACCESS_TOKEN) {
    try {
      for (let offset = 0; offset < 500; offset += 100) {
        const r = await mpFetch(env.MP_ACCESS_TOKEN, `/v1/payments/search?sort=date_created&criteria=desc&range=date_created&begin_date=NOW-${DAYS}DAYS&end_date=NOW&limit=100&offset=${offset}`);
        for (const p of r.results || []) {
          if (p.status !== 'approved') continue;
          payments.push({
            id: String(p.id), kind: 'mp', at: p.date_approved || p.date_created, desc: p.description || p.external_reference || 'Cobro',
            amount: p.transaction_amount, net: p.transaction_details?.net_received_amount ?? p.transaction_amount,
            releaseAt: p.money_release_date || null, released: p.money_release_status === 'released',
          });
        }
        if ((r.results || []).length < 100) break;
      }
    } catch (e) { error = String(e.message || e).slice(0, 200); }
  }
  // Comisiones de ventas pagadas con Mercado Pago (las de transferencia las paga el fotógrafo aparte: feePayments).
  const orders = await adminQuery(env, 'orders', { filters: [['status', '==', 'approved']], limit: 5000 }).catch(() => []);
  const fees = orders
    .filter(o => o.payMethod !== 'transfer' && (o.platformFee || 0) > 0 && (o.paidAt?.getTime?.() || 0) >= since)
    .map(o => ({
      id: o.id, kind: 'fee', at: o.paidAt?.toISOString?.() || null, desc: `Comisión · ${o.photographerName || ''} · ${o.eventName || ''}`,
      amount: o.platformFee, net: o.platformFee, releaseAt: o.mpReleaseAt?.toISOString?.() || null,
      released: !!o.mpReleaseAt && o.mpReleaseAt.getTime() <= Date.now(),
    }));
  // Pagos de saldo de comisiones por transferencia, confirmados por vos.
  const fps = await adminQuery(env, 'feePayments', { filters: [['status', '==', 'confirmed']], limit: 500 }).catch(() => []);
  const transfers = fps.filter(f => (f.resolvedAt?.getTime?.() || 0) >= since).map(f => ({
    id: f.id, kind: 'transfer', at: f.resolvedAt?.toISOString?.() || null, desc: `Saldo de comisiones · ${f.name || ''}`,
    amount: f.amount, net: f.amount, releaseAt: f.resolvedAt?.toISOString?.() || null, released: true,
  }));
  return json({ days: DAYS, items: [...payments, ...fees, ...transfers], error });
}
