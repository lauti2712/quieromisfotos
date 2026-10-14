// Compras: checkout (preferencia de MP con comisión), aviso de pago (webhook), sincronización y descargas.
import { computeTotals } from '../../js/pricing.js';
import { adminGet, adminGetMany, adminSet, adminUpdate, adminIncrement } from './admin.js';
import { requireUser } from './firebase.js';
import { sellerToken, mpFetch, siteUrl } from './mp.js';
import { signToken, verifyToken } from './tokens.js';
import { json, httpError, apiUrl } from './http.js';

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

  const t = computeTotals({ count: ids.length, price: set.price, packs: set.packs, feeMode: set.feeMode, feePercent: settings?.feePercent ?? 3 });
  const orderId = newId();
  const order = {
    buyerUid: claims.sub, buyerEmail: claims.email, buyerName: claims.name || '',
    photographerUid, photographerName: ph.displayName || '', eventId, eventName: ev.name || '', eventDate: ev.date || '',
    items: photos.map(p => ({ photoId: p.id, thumbUrl: p.thumbUrl || '', fileName: p.fileName || '' })),
    count: ids.length, lines: t.lines, subtotal: t.subtotal, serviceFee: t.serviceFee, platformFee: t.platformFee,
    total: t.total, feeMode: t.feeMode, status: 'pending', createdAt: new Date(),
  };
  await adminSet(env, `orders/${orderId}`, order, { mustNotExist: true });

  const api = apiUrl(env, req);
  const back = `${siteUrl(env)}#/pedido/${orderId}`;
  const items = [{ id: orderId, title: `Fotos — ${ev.name}`.slice(0, 250), description: `${ids.length} foto(s) digitales`, quantity: 1, unit_price: t.subtotal, currency_id: 'ARS', category_id: 'art' }];
  if (t.serviceFee) items.push({ id: 'servicio', title: 'Costo de servicio', quantity: 1, unit_price: t.serviceFee, currency_id: 'ARS' });
  const pref = await mpFetch(await sellerToken(env, photographerUid), '/checkout/preferences', {
    method: 'POST',
    headers: { 'X-Idempotency-Key': orderId },
    body: JSON.stringify({
      items,
      marketplace_fee: t.platformFee,
      external_reference: orderId,
      notification_url: `${api}/mp/webhook?o=${orderId}`,
      back_urls: { success: back, failure: back, pending: back },
      auto_return: 'approved',
      binary_mode: true,
      payer: { email: claims.email },
      statement_descriptor: 'QUIEROMISFOTOS',
      metadata: { order_id: orderId },
      expires: true,
      expiration_date_to: new Date(Date.now() + 2 * 3600_000).toISOString(),
    }),
  });
  await adminUpdate(env, `orders/${orderId}`, { mpPreferenceId: pref.id });
  return json({ orderId, initPoint: pref.init_point });
}

// ------------------------------------------------------------------ pago -> orden (idempotente)
const STATUS = { approved: 'approved', authorized: 'pending', pending: 'pending', in_process: 'pending', in_mediation: 'pending',
  rejected: 'rejected', cancelled: 'rejected', refunded: 'refunded', charged_back: 'refunded' };

async function applyPayment(env, orderId, order, payment) {
  if (String(payment.external_reference) !== orderId) throw httpError(400, 'El pago no corresponde a este pedido');
  const status = STATUS[payment.status] || 'pending';
  const upd = { mpPaymentId: String(payment.id), mpStatus: payment.status, mpStatusDetail: payment.status_detail || '' };
  if (status === 'approved') {
    if (Number(payment.transaction_amount) + 1 < order.total) throw httpError(400, 'El monto pagado no coincide');
    if (order.status !== 'approved') {
      const paidAt = payment.date_approved ? new Date(payment.date_approved) : new Date();
      Object.assign(upd, { status: 'approved', paidAt, downloadExpiresAt: new Date(paidAt.getTime() + DOWNLOAD_DAYS * 86400_000) });
    }
  } else if (status === 'refunded') {
    upd.status = 'refunded';
  } else if (order.status !== 'approved') {
    upd.status = status; // un pago rechazado no pisa uno aprobado
  }
  await adminUpdate(env, `orders/${orderId}`, upd);
  // Contador de ventas en el set del fotógrafo (solo la primera vez que el pedido pasa a aprobado o se reembolsa).
  const setPath = `events/${order.eventId}/sets/${order.photographerUid}`;
  if (upd.status === 'approved' && order.status !== 'approved') {
    await adminIncrement(env, setPath, { soldPhotos: order.count || 0, soldOrders: 1 }).catch(e => console.error('soldPhotos', e));
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
  if (type !== 'payment' || !paymentId || !ID_RE.test(orderId || '')) return json({ ok: true, ignored: true });
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order) return json({ ok: true, ignored: true });
  const payment = await mpFetch(await sellerToken(env, order.photographerUid), `/v1/payments/${encodeURIComponent(paymentId)}`);
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
  const pref = await mpFetch(await sellerToken(env, order.photographerUid), `/checkout/preferences/${order.mpPreferenceId}`);
  return json({ initPoint: pref.init_point });
}

// ------------------------------------------------------------------ descargas
// POST /orders/{id}/downloads  (Bearer comprador) -> links firmados de 15 minutos
export async function downloadLinks(req, env, orderId) {
  const claims = await requireUser(req, env);
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order || order.buyerUid !== claims.sub) throw httpError(404, 'Pedido no encontrado');
  if (order.status !== 'approved') throw httpError(409, 'El pedido todavía no está pagado');
  if (order.downloadExpiresAt && order.downloadExpiresAt.getTime() < Date.now()) throw httpError(410, 'El plazo de descarga venció');
  const api = apiUrl(env, req);
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL;
  const links = await Promise.all(order.items.map(async (it, i) => ({
    photoId: it.photoId,
    url: `${api}/dl/${await signToken({ o: orderId, e: order.eventId, u: order.photographerUid, p: it.photoId, n: i + 1, exp }, env.UPLOAD_SECRET)}`,
  })));
  return json({ links, exp });
}

// GET /dl/{token} -> el original, como descarga
export async function download(req, env, token) {
  const t = await verifyToken(token, env.UPLOAD_SECRET);
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
