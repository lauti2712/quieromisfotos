// Compras: checkout (preferencia de MP con comisión), aviso de pago (webhook), sincronización y descargas.
import { computeTotals } from '../../js/pricing.js';
import { adminGet, adminGetMany, adminSet, adminUpdate, adminIncrement, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { sellerToken, mpFetch, siteUrl } from './mp.js';
import { signToken, verifyToken } from './tokens.js';
import { json, httpError, apiUrl } from './http.js';
import { extensionWebhook } from './extensions.js';
import { notifyUser } from './push.js';
import { feePercentFor, GRACE_DAYS } from './plans.js';
import { subscriptionWebhook } from './subscriptions.js';
import { addAlert } from './alerts.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const MAX_ITEMS = 300;
const DOWNLOAD_DAYS = 7;
const LINK_TTL = 15 * 60;

const newId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 20);

// Fecha hasta la que el set se puede vender (originales disponibles).
export function setAvailableUntil(set) {
  const a = set?.expiresAt?.getTime?.() || 0, b = set?.extendedUntil?.getTime?.() || 0;
  return Math.max(a, b) || null;
}

// El comprador descarga mientras exista el original (venta + gracia, con las extensiones), y como mínimo 7 días.
function downloadUntil(paidAt, set) {
  const until = setAvailableUntil(set);
  return Math.max(paidAt + DOWNLOAD_DAYS * 86400_000, until ? until + GRACE_DAYS * 86400_000 : 0);
}

// ------------------------------------------------------------------ POST /checkout
export async function checkout(req, env) {
  const claims = await requireUser(req, env);
  if (!claims.email) throw httpError(400, 'Tu cuenta necesita un email');
  const { eventId, photographerUid, photoIds } = await req.json().catch(() => ({}));
  const ids = [...new Set(Array.isArray(photoIds) ? photoIds : [])];
  if (!ID_RE.test(eventId || '') || !ID_RE.test(photographerUid || '') || !ids.length || ids.length > MAX_ITEMS || !ids.every(i => ID_RE.test(i))) {
    throw httpError(400, 'Pedido inválido');
  }

  const [ev, set, ph, settings] = await adminGetMany(env, [
    `events/${eventId}`, `events/${eventId}/sets/${photographerUid}`, `users/${photographerUid}`, 'settings/platform',
  ]);
  if (!ev || ev.status !== 'published' || !(ev.photographerUids || []).includes(photographerUid)) throw httpError(404, 'El evento no está disponible');
  if (ev.demo) throw httpError(409, 'Es un evento de ejemplo: no se puede comprar');
  if (!set || !(set.price > 0)) throw httpError(409, 'Este fotógrafo todavía no definió precios');
  const until = setAvailableUntil(set);
  if (set.originalsDeleted || (until && until < Date.now())) throw httpError(409, 'Las fotos de este evento ya no están disponibles para compra');
  if (!ph || ph.status !== 'approved' || !ph.mpConnected) throw httpError(409, 'El fotógrafo todavía no puede recibir pagos');

  const photos = await adminGetMany(env, ids.map(id => `photos/${id}`));
  const bad = photos.findIndex(p => !p || p.eventId !== eventId || p.photographerUid !== photographerUid || p.hidden || p.originalDeleted);
  if (bad >= 0) throw httpError(409, 'Alguna foto del carrito ya no está disponible. Quitala y probá de nuevo.');

  const t = computeTotals({ count: ids.length, price: set.price, packs: set.packs, feeMode: set.feeMode, feePercent: feePercentFor(ph, settings) });
  // Mismo comprador, mismas fotos y mismo total con un pago todavía abierto: se reusa (evita pagar dos veces lo mismo).
  const key = [...ids].sort().join(',');
  const open = (await adminQuery(env, 'orders', { filters: [['buyerUid', '==', claims.sub], ['status', '==', 'pending']], limit: 30 }))
    .find(o => o.photographerUid === photographerUid && o.eventId === eventId && o.total === t.total && o.mpPreferenceId
      && (o.items || []).map(i => i.photoId).sort().join(',') === key
      && Date.now() - (o.mpPreferenceAt?.getTime?.() || o.createdAt?.getTime?.() || 0) < PREF_TTL - 10 * 60_000);
  if (open) {
    const pref = await mpFetch(await sellerToken(env, photographerUid), `/checkout/preferences/${open.mpPreferenceId}`);
    return json({ orderId: open.id, initPoint: pref.init_point, reused: true });
  }
  const orderId = newId();
  const order = {
    // Sin nombre ni email del comprador: el fotógrafo lee el pedido. Esos datos van a orderPrivate (superadmin y comprador).
    buyerUid: claims.sub,
    photographerUid, photographerName: ph.displayName || '', eventId, eventName: ev.name || '', eventDate: ev.date || '',
    items: photos.map(p => ({ photoId: p.id, thumbUrl: p.thumbUrl || '', fileName: p.fileName || '' })),
    count: ids.length, lines: t.lines, subtotal: t.subtotal, serviceFee: t.serviceFee, platformFee: t.platformFee,
    total: t.total, feeMode: t.feeMode, status: 'pending', createdAt: new Date(),
  };
  await adminSet(env, `orders/${orderId}`, order, { mustNotExist: true });
  await adminSet(env, `orderPrivate/${orderId}`, { buyerUid: claims.sub, buyerEmail: claims.email, buyerName: claims.name || '', createdAt: order.createdAt });

  const pref = await createPreference(req, env, orderId, order, claims.email, 0);
  return json({ orderId, initPoint: pref.init_point });
}

const PREF_TTL = 2 * 3600_000;

// Preferencia de pago de MP (cuenta del fotógrafo, con la comisión de la plataforma). Vence a las 2 horas.
async function createPreference(req, env, orderId, order, buyerEmail, attempt) {
  const api = apiUrl(env, req);
  // Si se compró desde el sitio de prueba, MP vuelve ahí.
  const fromStaging = req.headers.get('Origin') === 'https://prueba.quieromisfotos.com.ar';
  const back = `${fromStaging ? 'https://prueba.quieromisfotos.com.ar/' : siteUrl(env)}#/pedido/${orderId}`;
  const items = [{ id: orderId, title: `Fotos — ${order.eventName}`.slice(0, 250), description: `${order.count} foto(s) digitales`, quantity: 1, unit_price: order.subtotal, currency_id: 'ARS', category_id: 'art' }];
  if (order.serviceFee) items.push({ id: 'servicio', title: 'Costo de servicio', quantity: 1, unit_price: order.serviceFee, currency_id: 'ARS' });
  const pref = await mpFetch(await sellerToken(env, order.photographerUid), '/checkout/preferences', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': attempt ? `${orderId}-${attempt}` : orderId },
    body: JSON.stringify({
      items,
      // MP_TEST_NO_FEE: solo para pruebas, cuando la app de MP es de una cuenta real y el vendedor es de prueba
      // (MP no permite mezclar). La comisión igual queda registrada en el pedido.
      ...(env.MP_TEST_NO_FEE === '1' ? {} : { marketplace_fee: order.platformFee }),
      external_reference: orderId,
      notification_url: `${api}/mp/webhook?o=${orderId}`,
      back_urls: { success: back, failure: back, pending: back },
      auto_return: 'approved',
      binary_mode: true,
      // En modo prueba no se manda el email: si es de una cuenta real, MP rechaza el pago por mezclar cuentas de prueba y reales.
      ...(env.MP_TEST_MODE === '1' || !buyerEmail ? {} : { payer: { email: buyerEmail } }),
      statement_descriptor: 'QUIEROMISFOTOS',
      metadata: { order_id: orderId },
      expires: true,
      expiration_date_to: new Date(Date.now() + PREF_TTL).toISOString(),
    }),
  });
  await adminUpdate(env, `orders/${orderId}`, { mpPreferenceId: pref.id, mpPreferenceAt: new Date(), mpPreferenceAttempt: attempt });
  return pref;
}

// ------------------------------------------------------------------ pago -> orden (idempotente)
const STATUS = { approved: 'approved', authorized: 'pending', pending: 'pending', in_process: 'pending', in_mediation: 'pending',
  rejected: 'rejected', cancelled: 'rejected', refunded: 'refunded', charged_back: 'refunded' };

async function applyPayment(env, orderId, order, payment) {
  if (String(payment.external_reference) !== orderId) throw httpError(400, 'El pago no corresponde a este pedido');
  const status = STATUS[payment.status] || 'pending';
  // Ya pagado con otro pago: si este también se aprobó, es un cobro doble (se avisa para devolverlo; no se pisa el pedido).
  if (order.status === 'approved' && order.mpPaymentId && String(payment.id) !== order.mpPaymentId) {
    if (status === 'approved') {
      await addAlert(env, { type: 'pago-duplicado', ref: `${orderId}_${payment.id}`, text: `Cobro duplicado: el pedido ${orderId} (${order.eventName || ''}, ${order.photographerName || ''}) ya estaba pagado con el pago ${order.mpPaymentId} y entró otro pago aprobado ${payment.id} por $${payment.transaction_amount}. Devolverlo desde Mercado Pago (cuenta del fotógrafo).` });
    }
    return order;
  }
  const upd = { mpPaymentId: String(payment.id), mpStatus: payment.status, mpStatusDetail: payment.status_detail || '' };
  if (status === 'approved') {
    if (Number(payment.transaction_amount) + 1 < order.total) throw httpError(400, 'El monto pagado no coincide');
    if (order.status !== 'approved') {
      const paidAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
      const set = await adminGet(env, `events/${order.eventId}/sets/${order.photographerUid}`).catch(() => null);
      Object.assign(upd, { status: 'approved', paidAt, downloadExpiresAt: new Date(downloadUntil(paidAt.getTime(), set)) });
    }
  } else if (status === 'refunded') {
    upd.status = 'refunded';
  } else if (order.status !== 'approved') {
    upd.status = status; // un pago rechazado no pisa uno aprobado
  }
  const transition = (upd.status === 'approved' && order.status !== 'approved') || (upd.status === 'refunded' && order.status === 'approved');
  if (transition) {
    // El webhook y la sincronización pueden llegar a la vez: solo cuenta el que escribe primero.
    const won = await adminUpdate(env, `orders/${orderId}`, upd, { ifUpdateTime: order._updateTime });
    if (!won) {
      const fresh = await adminGet(env, `orders/${orderId}`);
      return fresh || { ...order, ...upd };
    }
  } else {
    await adminUpdate(env, `orders/${orderId}`, upd);
  }
  // Contador de ventas en el set del fotógrafo (solo la primera vez que el pedido pasa a aprobado o se reembolsa).
  const setPath = `events/${order.eventId}/sets/${order.photographerUid}`;
  if (upd.status === 'approved' && order.status !== 'approved') {
    await adminIncrement(env, setPath, { soldPhotos: order.count || 0, soldOrders: 1 }).catch(e => console.error('soldPhotos', e));
    // Aviso al fotógrafo en sus dispositivos.
    const n = order.count || 0;
    await notifyUser(env, order.photographerUid, {
      title: `💰 ¡Vendiste ${n} foto${n === 1 ? '' : 's'}!`,
      body: `${order.eventName || 'Evento'} · $${Math.round(order.total || 0).toLocaleString('es-AR')}`,
      link: `${(env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html')}#/ventas`,
    }).catch(e => console.error('push', e));
  } else if (upd.status === 'refunded' && order.status === 'approved') {
    await adminIncrement(env, setPath, { soldPhotos: -(order.count || 0), soldOrders: -1 }).catch(e => console.error('soldPhotos', e));
  }
  return { ...order, ...upd };
}

// POST /mp/webhook?o={orderId}  — no se confía en el contenido: se consulta el pago a MP.
export async function webhook(req, env) {
  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = body.type || body.topic || url.searchParams.get('type') || url.searchParams.get('topic');
  const paymentId = body.data?.id || url.searchParams.get('data.id') || (type === 'payment' ? url.searchParams.get('id') : null);
  const orderId = url.searchParams.get('o');
  if (type === 'payment' && url.searchParams.get('x')) return extensionWebhook(env, url.searchParams.get('x'), paymentId);
  // Suscripciones (configurado en la app de MP → Webhooks → "Planes y suscripciones").
  if (type === 'subscription_preapproval') return subscriptionWebhook(env, body.data?.id || url.searchParams.get('data.id'));
  if (type === 'subscription_authorized_payment') {
    const ap = await mpFetch(env.MP_ACCESS_TOKEN, `/authorized_payments/${encodeURIComponent(body.data?.id || url.searchParams.get('data.id'))}`).catch(() => null);
    return subscriptionWebhook(env, ap?.preapproval_id);
  }
  if (type !== 'payment' || !paymentId || !ID_RE.test(orderId || '')) return json({ ok: true, ignored: true });
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order) return json({ ok: true, ignored: true });
  let token;
  try { token = await sellerToken(env, order.photographerUid); }
  catch (e) {
    // El fotógrafo desvinculó MP: el pago existe pero no lo podemos consultar. Queda para revisar a mano.
    await addAlert(env, { type: 'pago-sin-token', ref: orderId, text: `Aviso de pago ${paymentId} del pedido ${orderId} (${order.photographerName || order.photographerUid}, ${order.eventName || ''}): el fotógrafo no tiene Mercado Pago vinculado. Revisar el pago y aprobar el pedido a mano.` });
    return json({ ok: true, alert: true });
  }
  const payment = await mpFetch(token, `/v1/payments/${encodeURIComponent(paymentId)}`);
  await applyPayment(env, orderId, order, payment);
  return json({ ok: true });
}

// POST /orders/{id}/sync  (Bearer comprador) — al volver de MP, por si el webhook todavía no llegó.
export async function syncOrder(req, env, orderId) {
  const claims = await requireUser(req, env);
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order || order.buyerUid !== claims.sub) throw httpError(404, 'Pedido no encontrado');
  if (order.status === 'approved') return json({ status: order.status });
  const { paymentId } = await req.json().catch(() => ({}));
  const token = await sellerToken(env, order.photographerUid);
  let payment = null;
  if (paymentId && /^\d{5,20}$/.test(String(paymentId))) {
    payment = await mpFetch(token, `/v1/payments/${paymentId}`).catch(() => null);
  }
  if (!payment) {
    const r = await mpFetch(token, `/v1/payments/search?external_reference=${orderId}&sort=date_created&criteria=desc`);
    payment = r.results?.[0] || null;
  }
  if (!payment) return json({ status: order.status });
  const updated = await applyPayment(env, orderId, order, payment);
  return json({ status: updated.status });
}

// POST /orders/{id}/checkout  (Bearer comprador) — reintentar el pago de un pedido pendiente/rechazado.
export async function retryCheckout(req, env, orderId) {
  const claims = await requireUser(req, env);
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order || order.buyerUid !== claims.sub) throw httpError(404, 'Pedido no encontrado');
  if (order.status === 'approved') throw httpError(409, 'Este pedido ya está pagado');
  if (!order.mpPreferenceId) throw httpError(409, 'No se puede reintentar este pedido');
  const age = Date.now() - (order.mpPreferenceAt?.getTime?.() || order.createdAt?.getTime?.() || 0);
  if (age < PREF_TTL - 10 * 60_000) {
    const pref = await mpFetch(await sellerToken(env, order.photographerUid), `/checkout/preferences/${order.mpPreferenceId}`);
    return json({ initPoint: pref.init_point });
  }
  // La preferencia venció: se arma otra (si las fotos se siguen vendiendo), con el mismo pedido y el mismo total.
  const [set, ph, ...photos] = await adminGetMany(env, [`events/${order.eventId}/sets/${order.photographerUid}`, `users/${order.photographerUid}`, ...(order.items || []).map(i => `photos/${i.photoId}`)]);
  const until = setAvailableUntil(set);
  if (!set || set.originalsDeleted || (until && until < Date.now())) throw httpError(409, 'Las fotos de este evento ya no están disponibles para compra');
  if (!ph?.mpConnected) throw httpError(409, 'El fotógrafo todavía no puede recibir pagos');
  if (photos.some(p => !p || p.hidden || p.originalDeleted)) throw httpError(409, 'Alguna foto de este pedido ya no está disponible. Armá el carrito de nuevo.');
  const pref = await createPreference(req, env, orderId, order, claims.email, (order.mpPreferenceAttempt || 0) + 1);
  if (order.status === 'rejected') await adminUpdate(env, `orders/${orderId}`, { status: 'pending' });
  return json({ initPoint: pref.init_point });
}

// ------------------------------------------------------------------ descargas
// POST /orders/{id}/downloads  (Bearer comprador) -> links firmados de 15 minutos
export async function downloadLinks(req, env, orderId) {
  const claims = await requireUser(req, env);
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order || order.buyerUid !== claims.sub) throw httpError(404, 'Pedido no encontrado');
  if (order.status !== 'approved') throw httpError(409, 'El pedido todavía no está pagado');
  if (order.downloadExpiresAt && order.downloadExpiresAt.getTime() < Date.now()) {
    // Si el fotógrafo extendió el álbum después de la compra, el plazo se corre con él.
    const set = await adminGet(env, `events/${order.eventId}/sets/${order.photographerUid}`).catch(() => null);
    const until = downloadUntil(order.paidAt?.getTime?.() || 0, set);
    if (until < Date.now()) throw httpError(410, 'El plazo de descarga venció');
    await adminUpdate(env, `orders/${orderId}`, { downloadExpiresAt: new Date(until) }).catch(() => {});
  }
  const api = apiUrl(env, req);
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL;
  const links = await Promise.all(order.items.map(async (it, i) => ({
    photoId: it.photoId,
    url: `${api}/dl/${await signToken({ typ: 'dl', o: orderId, e: order.eventId, u: order.photographerUid, p: it.photoId, n: i + 1, exp }, env.UPLOAD_SECRET)}`,
  })));
  return json({ links, exp });
}

// GET /dl/{token} -> el original, como descarga
export async function download(req, env, token) {
  const t = await verifyToken(token, env.UPLOAD_SECRET, 'dl');
  if (!t || !t.o || t.exp < Date.now() / 1000) throw httpError(401, 'El link de descarga venció. Volvé a tu pedido para generar uno nuevo.');
  const obj = await env.PRIVATE.get(`e/${t.e}/${t.u}/${t.p}`);
  if (!obj) throw httpError(410, 'El original ya no está disponible');
  const type = obj.httpMetadata?.contentType || 'image/jpeg';
  const ext = type.includes('png') ? 'png' : type.includes('webp') ? 'webp' : 'jpg';
  const headers = new Headers({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="quieromisfotos-${t.o.slice(0, 6)}-${String(t.n).padStart(3, '0')}.${ext}"`,
    'Cache-Control': 'private, no-store',
  });
  if (obj.size) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}
