// Suscripciones a los planes (Lite / Profesional / Premium), mensuales o anuales, con Mercado Pago (preapproval), cobradas
// a la cuenta de la plataforma (MP_ACCESS_TOKEN). Cada cobro aprobado extiende users.proUntil un mes.
// Se sincroniza al volver de MP, por webhook (si está configurado en la app de MP) y todos los días por cron.
import { adminGet, adminSet, adminUpdate, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { mpFetch, panelUrl } from './mp.js';
import { json, httpError } from './http.js';
import { notifySuper } from './push.js';
import { planSpec } from '../../js/plans-core.js';

// Premium cobra más el primer pago para cubrir el registro del dominio.
const PLANS = { lite: { label: 'Profesional Lite', priceKey: 'litePrice' },
  web: { label: 'Profesional', priceKey: 'webPrice' }, webdomain: { label: 'Profesional Premium', priceKey: 'webDomainPrice', firstKey: 'webDomainFirstPrice' },
  empresa: { label: 'Empresas', priceKey: 'empresaPrice', firstKey: 'empresaFirstPrice' } };
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
  // Empresas: los lugares extra que ya pagaba siguen en el débito.
  const seatAmount = plan === 'empresa' ? Math.max(0, user.teamPaidSeats || 0) * (spec.seatPrice || 0) * (yearly ? 12 : 1) : 0;
  const first = amount + domainExtra + seatAmount;

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
  const attempt = { plan, period, amount, seatAmount, firstAmount: first, needsAdjust: first !== amount + seatAmount, payerEmail: email, preapprovalId: pre.id, createdAt: new Date() };
  if (prev?.preapprovalId && prev.status === 'authorized') {
    // Cambio de plan: la activa no se toca hasta que la nueva quede autorizada (si la abandona, sigue la de antes).
    if (prev.pending?.preapprovalId) await cancelPreapproval(env, prev.pending.preapprovalId);
    await adminUpdate(env, `subscriptions/${claims.sub}`, { pending: attempt });
  } else {
    if (prev?.preapprovalId && prev.status === 'pending') await cancelPreapproval(env, prev.preapprovalId);
    await adminSet(env, `subscriptions/${claims.sub}`, { ...attempt, status: pre.status || 'pending' });
  }
  return json({ initPoint: pre.init_point });
}

// Lee la suscripción en MP y actualiza el plan del usuario.
const cancelPreapproval = (env, id) => mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ status: 'cancelled' }) })
  .catch(e => console.error('cancelar suscripción', id, e));
const PENDING_TTL = 3 * DAY; // un cambio de plan sin confirmar se descarta a los 3 días

export async function syncSubscription(env, uid) {
  let sub = await adminGet(env, `subscriptions/${uid}`);
  if (!sub?.preapprovalId) return null;
  // Cambio de plan en curso: si la nueva quedó autorizada pasa a ser la activa y se cancela la anterior.
  if (sub.pending?.preapprovalId) {
    const np = await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.pending.preapprovalId)}`).catch(() => null);
    const age = Date.now() - (sub.pending.createdAt?.getTime?.() || 0);
    if (np?.status === 'authorized') {
      await cancelPreapproval(env, sub.preapprovalId);
      const next = { ...sub.pending, status: 'authorized', pending: null, lastPaidAt: null, nextPaymentDate: null };
      await adminSet(env, `subscriptions/${uid}`, next);
      sub = { ...next, id: uid };
    } else if (np && (['cancelled', 'paused'].includes(np.status) || age > PENDING_TTL)) {
      if (np.status === 'pending') await cancelPreapproval(env, sub.pending.preapprovalId);
      await adminUpdate(env, `subscriptions/${uid}`, { pending: null });
      sub.pending = null;
    }
  }
  const pre = await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`);
  const upd = { status: pre.status, nextPaymentDate: pre.next_payment_date ? new Date(pre.next_payment_date) : null, syncedAt: new Date() };
  const last = pre.summarized?.last_charged_date ? new Date(pre.summarized.last_charged_date).getTime() : 0;
  if (pre.status === 'authorized') {
    const user = await adminGet(env, `users/${uid}`);
    const current = user?.proUntil?.getTime?.() || 0;
    // Cubierto hasta un período después del último cobro. Si todavía no se cobró nunca, unos días desde el alta
    // (una sola vez: si el primer cobro no entra, el plan vence y no se renueva solo).
    const startedAt = sub.createdAt?.getTime?.() || Date.now();
    const paidUntil = last ? last + (sub.period === 'year' ? 366 : 31) * DAY + GRACE : startedAt + GRACE;
    // Al pasar de la prueba gratis a un plan pago, se respeta lo que quedaba de prueba.
    const until = user?.plan === sub.plan || user?.trial ? Math.max(current, paidUntil) : paidUntil;
    if (user && !user.courtesy && (user.plan !== sub.plan || until !== current || user.trial)) await adminUpdate(env, `users/${uid}`, { plan: sub.plan, proUntil: new Date(until), trial: false });
    if (sub.previousPreapprovalId && sub.previousPreapprovalId !== sub.preapprovalId) {
      await cancelPreapproval(env, sub.previousPreapprovalId);
      upd.previousPreapprovalId = null;
    }
    if (last) upd.lastPaidAt = new Date(last);
    // Cobro nuevo de la membresía: aviso al superadmin (una vez por cobro).
    if (last && last !== (sub.lastPaidAt?.getTime?.() || 0)) {
      const amt = Math.round(pre.summarized?.last_charged_amount || sub.amount || 0);
      await notifySuper(env, 'membership', {
        title: `⭐ Pago de membresía: $${amt.toLocaleString('es-AR')}`,
        body: `${user?.displayName || 'Un fotógrafo'} · plan ${PLANS[sub.plan]?.label || sub.plan}${sub.period === 'year' ? ' (anual)' : ''}`,
        link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/admin/fotografos`,
      });
    }
    // Ya se cobró el primer mes (más caro): de acá en adelante, el precio mensual.
    if (sub.needsAdjust && (pre.summarized?.charged_quantity || 0) >= 1) {
      await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`, {
        method: 'PUT', body: JSON.stringify({ auto_recurring: { transaction_amount: sub.amount + (sub.seatAmount || 0), currency_id: 'ARS' } }),
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

// Cron cada 5 minutos: sincroniza de a pocas las suscripciones que no se revisaron en las últimas 20 horas
// (el plan gratis de Workers limita los pedidos por ejecución; así cada suscripción se revisa una vez por día).
const PER_RUN = 5;
export async function syncDueSubscriptions(env) {
  const now = Date.now();
  const [active, pending] = await Promise.all([
    adminQuery(env, 'subscriptions', { filters: [['status', '==', 'authorized']], limit: 1000 }),
    adminQuery(env, 'subscriptions', { filters: [['status', '==', 'pending']], limit: 200 }),
  ]);
  // Activas: una vez por día. Pendientes de los últimos 3 días: cada 15 minutos (por si pagó y cerró la pestaña sin volver
  // al panel y el aviso de Mercado Pago no llegó).
  const synced = x => x.syncedAt?.getTime?.() || 0;
  const due = [
    ...pending.filter(x => now - (x.createdAt?.getTime?.() || 0) < 3 * DAY && now - synced(x) > 15 * 60_000),
    ...active.filter(x => now - synced(x) > 20 * 3600_000),
  ].sort((a, b) => synced(a) - synced(b)).slice(0, PER_RUN);
  for (const s of due) await syncSubscription(env, s.id).catch(e => console.error('sub sync', s.id, e));
}

// POST /admin/plans/sync {uid} (superadmin): revisa en Mercado Pago la suscripción de un fotógrafo y aplica el plan.
export async function adminSyncSubscription(req, env) {
  const claims = await requireUser(req, env);
  if (claims.email !== 'lautarom87@gmail.com' || claims.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const { uid } = await req.json().catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(uid || '')) throw httpError(400, 'Pedido inválido');
  const s = await syncSubscription(env, uid);
  if (!s) return json({ status: 'none' });
  return json({ status: s.status, plan: s.plan, amount: s.amount, lastPaidAt: s.lastPaidAt || null, nextPaymentDate: s.nextPaymentDate || null });
}

// ------------------------------------------------------------------ plan Empresas: lugares extra del equipo
// POST /team/seats {delta: 1|-1}  (Bearer empresa con suscripción activa): suma o quita un lugar y ajusta el débito mensual
// (o anual: el lugar ×12). Los lugares pagos van en users.teamPaidSeats; los que da el superadmin, en teamExtraSeats.
export async function changeSeats(req, env) {
  const claims = await requireUser(req, env);
  const { delta } = await req.json().catch(() => ({}));
  if (delta !== 1 && delta !== -1) throw httpError(400, 'Pedido inválido');
  const [user, sub, team, settings] = await Promise.all([adminGet(env, `users/${claims.sub}`), adminGet(env, `subscriptions/${claims.sub}`),
    adminGet(env, `teams/${claims.sub}`), adminGet(env, 'settings/platform')]);
  if (!user || user.plan !== 'empresa' || user.courtesy) throw httpError(409, 'Los lugares extra se suman con el plan Empresas pago. Escribinos si tenés un plan de cortesía.');
  if (!sub?.preapprovalId || sub.status !== 'authorized' || sub.plan !== 'empresa') throw httpError(409, 'Necesitás la suscripción al plan Empresas activa en Mercado Pago.');
  const spec = planSpec('empresa', settings || {});
  const paid = Math.max(0, user.teamPaidSeats || 0);
  const next = paid + delta;
  if (next < 0) throw httpError(409, 'No tenés lugares extra para quitar');
  if (next > 50) throw httpError(409, 'Escribinos para equipos de más de 50 fotógrafos');
  const seats = spec.team + (user.teamExtraSeats || 0) + next;
  if ((team?.members || []).length > seats) throw httpError(409, 'Primero sacá a un fotógrafo del equipo para liberar el lugar');
  const seatAmount = next * spec.seatPrice * (sub.period === 'year' ? 12 : 1);
  // Mientras no se cobró el primer pago (más caro por el dominio), el débito sigue en ese monto + los lugares.
  const baseFirst = (sub.firstAmount || sub.amount) - (sub.seatAmount || 0);
  const amount = (sub.needsAdjust ? baseFirst : sub.amount) + seatAmount;
  await mpFetch(env.MP_ACCESS_TOKEN, `/preapproval/${encodeURIComponent(sub.preapprovalId)}`, {
    method: 'PUT', body: JSON.stringify({ auto_recurring: { transaction_amount: amount, currency_id: 'ARS' } }),
  });
  await adminUpdate(env, `subscriptions/${claims.sub}`, { seatAmount, paidSeats: next, seatsChangedAt: new Date(), ...(sub.needsAdjust ? { firstAmount: baseFirst + seatAmount } : {}) });
  await adminUpdate(env, `users/${claims.sub}`, { teamPaidSeats: next });
  return json({ ok: true, paidSeats: next, seats, amount });
}

// POST /admin/mp/whoami (superadmin): de qué cuenta de Mercado Pago es el token con el que cobra la plataforma
// (suscripciones y extensiones). No devuelve el token: solo la cuenta y si es de prueba.
export async function platformAccount(req, env) {
  const claims = await requireUser(req, env);
  if (claims.email !== 'lautarom87@gmail.com' || claims.email_verified !== true) throw httpError(403, 'Solo superadmin');
  if (!env.MP_ACCESS_TOKEN) return json({ configured: false });
  const me = await mpFetch(env.MP_ACCESS_TOKEN, '/users/me');
  const test = (me.tags || []).includes('test_user') || String(env.MP_ACCESS_TOKEN).startsWith('TEST-');
  return json({ configured: true, id: me.id, nickname: me.nickname || '', email: me.email || '', site: me.site_id || '', test });
}
