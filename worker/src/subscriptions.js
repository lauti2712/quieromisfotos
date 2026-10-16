// Suscripciones a los planes (Lite / Profesional / Premium), mensuales o anuales, con Mercado Pago (preapproval), cobradas
// a la cuenta de la plataforma (MP_ACCESS_TOKEN). Cada cobro aprobado extiende users.proUntil un mes.
// Se sincroniza al volver de MP, por webhook (si está configurado en la app de MP) y todos los días por cron.
import { adminGet, adminSet, adminUpdate, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { mpFetch, panelUrl } from './mp.js';
import { json, httpError } from './http.js';
import { planSpec } from '../../js/plans-core.js';

// Premium cobra más el primer pago para cubrir el registro del dominio.
const PLANS = { lite: { label: 'Profesional Lite', priceKey: 'litePrice' },
  web: { label: 'Profesional', priceKey: 'webPrice' }, webdomain: { label: 'Profesional Premium', priceKey: 'webDomainPrice', firstKey: 'webDomainFirstPrice' } };
const DAY = 86400_000;
const GRACE = 3 * DAY; // margen por si el débito del mes se demora

// POST /plans/subscribe  (Bearer fotógrafo) {plan, payerEmail} -> { initPoint }
export async function subscribe(req, env) {
  const claims = await requireUser(req, env);
  const { plan, payerEmail, period = 'month' } = await req.json().catch(() => ({}));
  if (!PLANS[plan]) throw httpError(400, 'Plan inválido');
  if (!['month', 'year'].includes(period)) throw httpError(400, 'Período inválido');
  const email = String(payerEmail || claims.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Ingresá el email de tu cuenta de Mercado Pago');
  const [user, settings] = await Promise.all([adminGet(env, `users/${claims.sub}`), adminGet(env, 'settings/platform')]);
  if (!user || user.role !== 'photographer') throw httpError(403, 'Solo fotógrafos');
  const spec = planSpec(plan, settings || {});
  const yearly = period === 'year';
  if (yearly && !(spec.year > 0)) throw httpError(400, 'Este plan no tiene abono anual');
  // Abono del período (tabla de Plataforma).
  const amount = yearly ? spec.year : spec.price;
  if (!(amount > 0)) throw httpError(409, 'Precio del plan no configurado');
  // Premium: el primer cobro suma el registro del dominio (primer mes − mensual). MP no admite un primer cobro distinto:
  // la suscripción arranca con ese monto y, cuando se cobra, syncSubscription la baja al abono normal.
  const domainExtra = PLANS[plan].firstKey ? Math.max(0, (spec.first || 0) - spec.price) : 0;
  const first = amount + domainExtra;

  const fromStaging = req.headers.get('Origin') === 'https://prueba.quieromisfotos.com.ar';
  const back = `${fromStaging ? 'https://prueba.quieromisfotos.com.ar/panel.html' : panelUrl(env)}#/web?sub=1`;
  const pre = await mpFetch(env.MP_ACCESS_TOKEN, '/preapproval', {
    method: 'POST',
    body: JSON.stringify({
      reason: `Quiero Mis Fotos — Plan ${PLANS[plan].label}${yearly ? ' (anual)' : ''}`,
      external_reference: `sub_${claims.sub}_${plan}`,
      payer_email: email,
      auto_recurring: { frequency: yearly ? 12 : 1, frequency_type: 'months', transaction_amount: first, currency_id: 'ARS' },
      back_url: back,
      status: 'pending',
    }),
  });
  const prev = await adminGet(env, `subscriptions/${claims.sub}`);
  await adminSet(env, `subscriptions/${claims.sub}`, {
    plan, period, amount, firstAmount: first, needsAdjust: first !== amount, payerEmail: email, preapprovalId: pre.id, status: pre.status || 'pending', createdAt: new Date(),
    // La anterior se cancela recién cuando la nueva queda autorizada (cambio de plan sin cortar el servicio).
    ...(prev?.preapprovalId && prev.status === 'authorized' ? { previousPreapprovalId: prev.preapprovalId } : {}),
  });
  return json({ initPoint: pre.init_point });
}

// Lee la suscripción en MP y actualiza el plan del usuario.
export async function syncSubscription(env, uid) {
  const sub = await adminGet(env, `subscriptions/${uid}`);
  if (!sub?.preapprovalId) return null;
  const pre = await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`);
  const upd = { status: pre.status, nextPaymentDate: pre.next_payment_date ? new Date(pre.next_payment_date) : null, syncedAt: new Date() };
  const last = pre.summarized?.last_charged_date ? new Date(pre.summarized.last_charged_date).getTime() : 0;
  if (pre.status === 'authorized') {
    const user = await adminGet(env, `users/${uid}`);
    const current = user?.proUntil?.getTime?.() || 0;
    // Cubierto hasta un mes después del último cobro (o unos días si todavía no se debitó el primero).
    const paidUntil = last ? last + (sub.period === 'year' ? 366 : 31) * DAY + GRACE : Date.now() + GRACE;
    // Al pasar de la prueba gratis a un plan pago, se respeta lo que quedaba de prueba.
    const until = user?.plan === sub.plan || user?.trial ? Math.max(current, paidUntil) : paidUntil;
    if (user && (user.plan !== sub.plan || until !== current || user.trial)) await adminUpdate(env, `users/${uid}`, { plan: sub.plan, proUntil: new Date(until), trial: false });
    if (sub.previousPreapprovalId && sub.previousPreapprovalId !== sub.preapprovalId) {
      await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.previousPreapprovalId)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }).catch(e => console.error('cancel prev', e));
      upd.previousPreapprovalId = null;
    }
    if (last) upd.lastPaidAt = new Date(last);
    // Ya se cobró el primer mes (más caro): de acá en adelante, el precio mensual.
    if (sub.needsAdjust && (pre.summarized?.charged_quantity || 0) >= 1) {
      await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`, {
        method: 'PUT', body: JSON.stringify({ auto_recurring: { transaction_amount: sub.amount, currency_id: 'ARS' } }),
      }).then(() => { upd.needsAdjust = false; upd.amountAdjustedAt = new Date(); }).catch(e => console.error('ajuste de monto', e));
    }
  }
  await adminUpdate(env, `subscriptions/${uid}`, upd);
  return { ...sub, ...upd };
}

// POST /plans/sync  (Bearer)
export async function syncRequest(req, env) {
  const claims = await requireUser(req, env);
  const s = await syncSubscription(env, claims.sub);
  return json({ status: s?.status || 'none' });
}

// POST /plans/cancel  (Bearer): cancela el débito; el plan sigue hasta la fecha ya pagada.
export async function cancelSubscription(req, env) {
  const claims = await requireUser(req, env);
  const sub = await adminGet(env, `subscriptions/${claims.sub}`);
  if (!sub?.preapprovalId) throw httpError(404, 'No tenés una suscripción');
  await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) });
  await adminUpdate(env, `subscriptions/${claims.sub}`, { status: 'cancelled', cancelledAt: new Date() });
  return json({ ok: true });
}

// Webhook de MP (topics subscription_preapproval / subscription_authorized_payment).
export async function subscriptionWebhook(env, preapprovalId) {
  if (!preapprovalId) return json({ ok: true, ignored: true });
  const pre = await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(preapprovalId)}`).catch(() => null);
  const m = String(pre?.external_reference || '').match(/^sub_([A-Za-z0-9]+)_/);
  if (m) await syncSubscription(env, m[1]);
  return json({ ok: true });
}

// Cron diario: renueva los planes de las suscripciones activas.
export async function syncAllSubscriptions(env) {
  const subs = await adminQuery(env, 'subscriptions', { filters: [['status', '==', 'authorized']], limit: 500 });
  for (const s of subs) await syncSubscription(env, s.id).catch(e => console.error('sub sync', s.id, e));
}
