// Cobros de suscripciones (planes de fotógrafos) para el resumen de Compras del superadmin.
//   GET /admin/plan-payments   Bearer (superadmin)  -> { items: [{id, uid, name, plan, amount, at, first}], error }
// Cada cobro aprobado queda en planPayments/{pago}. A Mercado Pago solo se le pregunta por las suscripciones con un cobro
// más nuevo que el último guardado (o que nunca se consultaron), con tope por vez. Nunca se listan movimientos de la cuenta.
import { requireUser } from './firebase.js';
import { adminQuery, adminGetMany, adminCommit } from './admin.js';
import { mpFetch } from './mp.js';
import { json, httpError } from './http.js';

const MAX_MP = 20;

export async function planPaymentsRequest(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const [subs, saved] = await Promise.all([
    adminQuery(env, 'subscriptions', { limit: 500 }).catch(() => []),
    adminQuery(env, 'planPayments', { limit: 5000 }).catch(() => []),
  ]);
  const lastSaved = new Map();
  for (const p of saved) lastSaved.set(p.preapprovalId, Math.max(lastSaved.get(p.preapprovalId) || 0, p.at?.getTime?.() || 0));
  // Suscripciones a consultar: la actual y la anterior (si cambió de plan), con un cobro que todavía no está guardado.
  const todo = [];
  for (const s of subs) {
    for (const pre of [s.preapprovalId, s.previousPreapprovalId].filter(Boolean)) {
      const last = s.lastPaidAt?.getTime?.() || 0;
      const known = lastSaved.has(pre);
      if (!known || (pre === s.preapprovalId && last > (lastSaved.get(pre) || 0) + 60_000)) todo.push({ s, pre });
    }
  }
  let error = '';
  const fresh = [];
  if (todo.length && env.MP_ACCESS_TOKEN) {
    const users = await adminGetMany(env, [...new Set(todo.map(x => `users/${x.s.id}`))]).catch(() => []);
    const nameOf = uid => users.find(u => u?.id === uid)?.displayName || '';
    for (const { s, pre } of todo.slice(0, MAX_MP)) {
      try {
        const r = await mpFetch(env.MP_ACCESS_TOKEN, `/authorized_payments/search?preapproval_id=${encodeURIComponent(pre)}`);
        for (const a of r.results || []) {
          if (!a.payment?.id || a.payment.status !== 'approved') continue;
          fresh.push({ set: `planPayments/${a.payment.id}`, data: {
            uid: s.id, name: nameOf(s.id), plan: s.plan || '', period: s.period || 'month', preapprovalId: pre,
            amount: Number(a.transaction_amount) || 0, at: new Date(a.debit_date || a.date_created || Date.now()),
          } });
        }
        // Marca de consulta (con o sin cobros): no se vuelve a preguntar hasta que la suscripción tenga un cobro más nuevo.
        fresh.push({ set: `planPayments/chk_${pre}`, data: { uid: s.id, preapprovalId: pre, none: true, at: new Date(s.lastPaidAt?.getTime?.() || 0) } });
      } catch (e) { error ||= String(e.message || e).slice(0, 200); }
    }
    if (todo.length > MAX_MP && !error) error = 'Faltan suscripciones por consultar: abrí de nuevo en un rato.';
  }
  if (fresh.length) await adminCommit(env, fresh).catch(e => { error ||= String(e.message || e).slice(0, 200); });
  const byId = new Map(saved.map(p => [p.id, p]));
  for (const f of fresh) byId.set(f.set.split('/')[1], { id: f.set.split('/')[1], ...f.data });
  const list = [...byId.values()].filter(p => !p.none).map(p => ({ id: p.id, uid: p.uid, name: p.name, plan: p.plan, period: p.period, preapprovalId: p.preapprovalId, amount: p.amount, at: (p.at instanceof Date ? p.at : new Date(p.at)).toISOString() }));
  // Primer cobro de cada fotógrafo (alta) vs. renovaciones.
  const firstOf = new Map();
  for (const p of list) if (!firstOf.has(p.uid) || p.at < firstOf.get(p.uid).at) firstOf.set(p.uid, p);
  const items = list.map(p => ({ ...p, first: firstOf.get(p.uid)?.id === p.id })).sort((a, b) => (a.at < b.at ? 1 : -1));
  return json({ items, error });
}
