// Suscripciones mensuales a los planes (Pro / Web / Web + Dominio) con Mercado Pago (preapproval), cobradas
// a la cuenta de la plataforma (MP_ACCESS_TOKEN). Cada cobro aprobado extiende users.proUntil un mes.
// Se sincroniza al volver de MP, por webhook (si está configurado en la app de MP) y todos los días por cron.
import { adminGet, adminSet, adminUpdate, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { mpFetch, panelUrl } from './mp.js';
import { json, httpError } from './http.js';

const PLANS = { pro: { label: 'Portfolio Pro', priceKey: 'proPrice' }, web: { label: 'Web', priceKey: 'webPrice' }, webdomain: { label: 'Web + Dominio', priceKey: 'webDomainPrice' } };
const DAY = 86400_000;
const GRACE = 3 * DAY; // margen por si el débito del mes se demora

// POST /plans/subscribe  (Bearer fotógrafo) {plan, payerEmail} -> { initPoint }
export async function subscribe(req, env) {
  const claims = await requireUser(req, env);
  const { plan, payerEmail } = await req.json().catch(() => ({}));
  if (!PLANS[plan]) throw httpError(400, 'Plan inválido');
  const email = String(payerEmail || claims.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Ingresá el email de tu cuenta de Mercado Pago');
  const [user, settings] = await Promise.all([adminGet(env, `users/${claims.sub}`), adminGet(env, 'settings/platform')]);
  if (!user || user.role !== 'photographer') throw httpError(403, 'Solo fotógrafos');
  const amount = Number(settings?.[PLANS[plan].priceKey]) || 0;
  if (!(amount > 0)) throw httpError(409, 'Precio del plan no configurado');

  const fromStaging = req.headers.get('Origin') === 'https://prueba.quieromisfotos.com.ar';
  const back = `${fromStaging ? 'https://prueba.quieromisfotos.com.ar/panel.html' : panelUrl(env)}#/web?sub=1`;
  const pre = await mpFetch(env.MP_ACCESS_TOKEN, '/preapproval', {
    method: 'POST',
    body: JSON.stringify({
      reason: `Quiero Mis Fotos — Plan ${PLANS[plan].label}`,
      external_reference: `sub_${claims.sub}_${plan}`,
      payer_email: email,
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: amount, currency_id: 'ARS' },
      back_url: back,
      status: 'pending',
    }),
  });
  const prev = await adminGet(env, `subscriptions/${claims.sub}`);
  await adminSet(env, `subscriptions/${claims.sub}`, {
    plan, amount, payerEmail: email, preapprovalId: pre.id, status: pre.status || 'pending', createdAt: new Date(),
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
    const paidUntil = last ? last + 31 * DAY + GRACE : Date.now() + GRACE;
    const until = user?.plan === sub.plan ? Math.max(current, paidUntil) : paidUntil;
    if (user && (user.plan !== sub.plan || until !== current)) await adminUpdate(env, `users/${uid}`, { plan: sub.plan, proUntil: new Date(until) });
    if (sub.previousPreapprovalId && sub.previousPreapprovalId !== sub.preapprovalId) {
      await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.previousPreapprovalId)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) }).catch(e => console.error('cancel prev', e));
      upd.previousPreapprovalId = null;
    }
    if (last) upd.lastPaidAt = new Date(last);
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
