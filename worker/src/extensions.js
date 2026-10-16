// Extensiones de retención: el fotógrafo paga (a la cuenta de la plataforma, MP_ACCESS_TOKEN) para que su álbum
// se siga vendiendo y no se borren los originales. Se puede extender mientras los originales existan
// (también en los días de gracia después de vencido).
import { adminGet, adminGetMany, adminSet, adminUpdate, adminIncrement } from './admin.js';
import { requireUser } from './firebase.js';
import { mpFetch, panelUrl } from './mp.js';
import { setAvailableUntil } from './orders.js';
import { isFree } from './plans.js';
import { json, httpError, apiUrl } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

// POST /extensions/checkout  (Bearer fotógrafo) {eventId, planId} -> { extensionId, initPoint }
export async function extensionCheckout(req, env) {
  const claims = await requireUser(req, env);
  const { eventId, planId, kind = 'time' } = await req.json().catch(() => ({}));
  if (!['time', 'space'].includes(kind)) throw httpError(400, 'Tipo inválido');
  if (!ID_RE.test(eventId || '') || typeof planId !== 'string' || !planId) throw httpError(400, 'Pedido inválido');
  const uid = claims.sub;
  const [ev, set, settings] = await adminGetMany(env, [`events/${eventId}`, `events/${eventId}/sets/${uid}`, 'settings/platform']);
  if (!ev || !set) throw httpError(404, 'No tenés fotos en este evento');
  if (set.originalsDeleted) throw httpError(409, 'Los originales de este álbum ya se eliminaron');
  if (kind === 'time' && !setAvailableUntil(set)) throw httpError(409, 'El plazo arranca cuando subís la primera foto');
  if (kind === 'space' && isFree(await adminGet(env, `users/${uid}`))) throw httpError(403, 'En el plan Gratis el álbum tiene un tope fijo. Pasate a un plan pago para subir más fotos.');
  const plan = (settings?.[kind === 'space' ? 'storagePlans' : 'extensionPlans'] || []).find(p => p.id === planId);
  // Packs de fotos extra para el álbum, o días extra de venta.
  if (!plan || !(plan.price > 0) || !(kind === 'space' ? plan.photos > 0 : plan.days > 0)) throw httpError(400, 'Plan inválido');
  if (!env.MP_ACCESS_TOKEN) throw httpError(503, 'Pagos de la plataforma no configurados');

  const id = newId();
  await adminSet(env, `extensions/${id}`, {
    photographerUid: uid, photographerEmail: claims.email || '', eventId, eventName: ev.name || '',
    kind, planId: plan.id, label: plan.label || '', ...(kind === 'space' ? { photos: plan.photos } : { days: plan.days }),
    price: plan.price, status: 'pending', createdAt: new Date(),
  }, { mustNotExist: true });

  const fromStaging = req.headers.get('Origin') === 'https://prueba.quieromisfotos.com.ar';
  const back = `${fromStaging ? 'https://prueba.quieromisfotos.com.ar/panel.html' : panelUrl(env)}#/evento/${eventId}?ext=${id}`;
  const pref = await mpFetch(env.MP_ACCESS_TOKEN, '/checkout/preferences', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': id },
    body: JSON.stringify({
      items: [{ id, title: `${kind === 'space' ? `+${plan.photos} fotos` : `Extensión ${plan.label || `+${plan.days} días`}`} — ${ev.name || 'evento'}`.slice(0, 250), quantity: 1, unit_price: plan.price, currency_id: 'ARS' }],
      ...(claims.email ? { payer: { email: claims.email } } : {}),
      external_reference: `ext_${id}`,
      notification_url: `${apiUrl(env, req)}/mp/webhook?x=${id}`,
      back_urls: { success: back, failure: back, pending: back },
      auto_return: 'approved',
      statement_descriptor: 'QUIEROMISFOTOS',
    }),
  });
  await adminUpdate(env, `extensions/${id}`, { mpPreferenceId: pref.id });
  return json({ extensionId: id, initPoint: pref.init_point });
}

// Aplica un pago a la extensión (idempotente: solo la primera aprobación suma días).
async function applyExtensionPayment(env, id, ext, payment) {
  if (String(payment.external_reference) !== `ext_${id}`) throw httpError(400, 'El pago no corresponde');
  const upd = { mpPaymentId: String(payment.id), mpStatus: payment.status };
  if (payment.status !== 'approved' || ext.status === 'approved') {
    if (ext.status !== 'approved') upd.status = payment.status === 'rejected' || payment.status === 'cancelled' ? 'rejected' : 'pending';
    await adminUpdate(env, `extensions/${id}`, upd);
    return { ...ext, ...upd };
  }
  if (Number(payment.transaction_amount) + 1 < ext.price) throw httpError(400, 'El monto pagado no coincide');
  const won = await adminUpdate(env, `extensions/${id}`, { ...upd, status: 'approved', paidAt: new Date() }, { ifUpdateTime: ext._updateTime });
  if (!won) return (await adminGet(env, `extensions/${id}`)) || ext;
  const setPath = `events/${ext.eventId}/sets/${ext.photographerUid}`;
  if (ext.kind === 'space') {
    await adminIncrement(env, setPath, { extraPhotos: Math.round(ext.photos || 0) });
    return { ...ext, ...upd, status: 'approved' };
  }
  const set = await adminGet(env, setPath);
  // Desde el vencimiento actual o desde hoy si ya venció.
  const from = Math.max(setAvailableUntil(set) || 0, Date.now());
  const extendedUntil = new Date(from + ext.days * 86400_000);
  await adminUpdate(env, setPath, { extendedUntil });
  await adminUpdate(env, `extensions/${id}`, { extendedUntil });
  return { ...ext, ...upd, status: 'approved', extendedUntil };
}

// Webhook de MP para extensiones (/mp/webhook?x={id}); se verifica consultando el pago con el token de la plataforma.
export async function extensionWebhook(env, id, paymentId) {
  if (!ID_RE.test(id || '') || !paymentId) return json({ ok: true, ignored: true });
  const ext = await adminGet(env, `extensions/${id}`);
  if (!ext) return json({ ok: true, ignored: true });
  const payment = await mpFetch(env.MP_ACCESS_TOKEN, `/v1/payments/${encodeURIComponent(paymentId)}`);
  await applyExtensionPayment(env, id, ext, payment);
  return json({ ok: true });
}

// POST /extensions/{id}/sync  (Bearer fotógrafo) — al volver de MP.
export async function extensionSync(req, env, id) {
  const claims = await requireUser(req, env);
  const ext = await adminGet(env, `extensions/${id}`);
  if (!ext || ext.photographerUid !== claims.sub) throw httpError(404, 'Extensión no encontrada');
  if (ext.status === 'approved') return json({ status: 'approved', extendedUntil: ext.extendedUntil });
  const r = await mpFetch(env.MP_ACCESS_TOKEN, `/v1/payments/search?external_reference=ext_${id}&sort=date_created&criteria=desc`);
  const payment = r.results?.[0];
  if (!payment) return json({ status: ext.status });
  const out = await applyExtensionPayment(env, id, ext, payment);
  return json({ status: out.status, extendedUntil: out.extendedUntil || null });
}
