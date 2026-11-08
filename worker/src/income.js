// Ingresos de la plataforma en su cuenta de Mercado Pago (superadmin): cuándo se acredita cada cobro.
//   GET /admin/income   Bearer (superadmin)
// NO se listan los movimientos de la cuenta (tiene movimientos personales y de otros emprendimientos): solo se consultan,
// uno por uno, los pagos que generó Quiero Mis Fotos.
// - Planes: pagos de cada suscripción (/authorized_payments/search?preapproval_id=…).
// - Extensiones: extensions.mpPaymentId.
//   De cada pago se lee el neto y la fecha de liberación (money_release_date). Los ya liberados quedan guardados en
//   incomeCache/{pago} para no volver a pedirlos.
// - Comisiones de ventas: entran como marketplace_fee de cada pago del fotógrafo y se liberan con ese pago. La fecha sale de
//   orders.mpReleaseAt (se guarda desde 11/2026; los pedidos anteriores no la tienen).
import { requireUser } from './firebase.js';
import { adminQuery, adminGetMany, adminCommit } from './admin.js';
import { mpFetch } from './mp.js';
import { json, httpError } from './http.js';

const DAYS = 90, MAX_MP = 25; // tope de consultas a Mercado Pago por vez (límite de pedidos del Worker)

export async function incomeRequest(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const now = Date.now(), since = now - DAYS * 86400_000;
  let error = '', calls = 0;
  const mp = path => { calls++; return mpFetch(env.MP_ACCESS_TOKEN, path); };

  // Pagos propios de QMF cobrados en tu cuenta: [{pid, kind, desc}]
  const [exts, subs, orders, fps] = await Promise.all([
    adminQuery(env, 'extensions', { filters: [['status', '==', 'approved']], limit: 1000 }).catch(() => []),
    adminQuery(env, 'subscriptions', { limit: 500 }).catch(() => []),
    adminQuery(env, 'orders', { filters: [['status', '==', 'approved']], limit: 5000 }).catch(() => []),
    adminQuery(env, 'feePayments', { filters: [['status', '==', 'confirmed']], limit: 500 }).catch(() => []),
  ]);
  const own = exts.filter(x => x.mpPaymentId && (x.paidAt?.getTime?.() || 0) >= since)
    .map(x => ({ pid: String(x.mpPaymentId), kind: 'mp', desc: `Extensión · ${x.photographerName || x.photographerUid || ''}` }));
  if (env.MP_ACCESS_TOKEN) {
    const paying = subs.filter(s => s.preapprovalId && s.lastPaidAt && s.lastPaidAt.getTime() >= since);
    const names = paying.length ? await adminGetMany(env, paying.map(s => `users/${s.id}`)).catch(() => []) : [];
    for (const [i, s] of paying.entries()) {
      if (calls >= MAX_MP) break;
      try {
        const r = await mp(`/authorized_payments/search?preapproval_id=${encodeURIComponent(s.preapprovalId)}`);
        for (const a of r.results || []) if (a.payment?.id && a.payment.status === 'approved') own.push({ pid: String(a.payment.id), kind: 'mp', desc: `Plan ${s.plan || ''} · ${names[i]?.displayName || 'fotógrafo'}` });
      } catch (e) { error ||= String(e.message || e).slice(0, 200); }
    }
  }
  // Neto y fecha de cada pago: de la caché si ya se liberó; si no, se consulta ese pago puntual.
  const cached = own.length ? await adminGetMany(env, own.map(o => `incomeCache/${o.pid}`)) : [];
  const payments = [], toCache = [];
  for (const [i, o] of own.entries()) {
    let d = cached[i];
    if (!d && env.MP_ACCESS_TOKEN && calls < MAX_MP) {
      try {
        const p = await mp(`/v1/payments/${encodeURIComponent(o.pid)}`);
        d = { at: p.date_approved || p.date_created, amount: p.transaction_amount, net: p.transaction_details?.net_received_amount ?? p.transaction_amount,
          releaseAt: p.money_release_date || null, released: p.money_release_status === 'released' };
        if (d.released) toCache.push({ set: `incomeCache/${o.pid}`, data: { ...d, kind: o.kind, desc: o.desc } });
      } catch (e) { error ||= String(e.message || e).slice(0, 200); }
    }
    if (d) payments.push({ id: o.pid, kind: o.kind, desc: o.desc, at: d.at, amount: d.amount, net: d.net, releaseAt: d.releaseAt, released: !!d.released });
  }
  if (toCache.length) await adminCommit(env, toCache).catch(() => {});
  const missing = own.length - payments.length;

  const fees = orders
    .filter(o => o.payMethod !== 'transfer' && (o.platformFee || 0) > 0 && (o.paidAt?.getTime?.() || 0) >= since)
    .map(o => ({
      id: o.id, kind: 'fee', at: o.paidAt?.toISOString?.() || null, desc: `Comisión · ${o.photographerName || ''} · ${o.eventName || ''}`,
      amount: o.platformFee, net: o.platformFee, releaseAt: o.mpReleaseAt?.toISOString?.() || null,
      released: !!o.mpReleaseAt && o.mpReleaseAt.getTime() <= now,
    }));
  const transfers = fps.filter(f => (f.resolvedAt?.getTime?.() || 0) >= since).map(f => ({
    id: f.id, kind: 'transfer', at: f.resolvedAt?.toISOString?.() || null, desc: `Saldo de comisiones · ${f.name || ''}`,
    amount: f.amount, net: f.amount, releaseAt: f.resolvedAt?.toISOString?.() || null, released: true,
  }));
  if (missing > 0 && !error) error = `Faltan ${missing} cobro${missing === 1 ? '' : 's'} por consultar: abrí de nuevo en un rato.`;
  return json({ days: DAYS, items: [...payments, ...fees, ...transfers], error });
}
