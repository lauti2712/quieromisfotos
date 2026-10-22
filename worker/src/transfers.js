// Cobro por transferencia al alias del fotógrafo (sin la comisión de Mercado Pago).
// El comprador transfiere un monto con centavos únicos (ej. $8.500,37): así se reconoce el pago entre los cobros del
// fotógrafo en su Mercado Pago (las transferencias entrantes aparecen en /v1/payments/search con su token, sin
// external_reference). La comisión de la plataforma queda como saldo (feeBalance/{uid}) que el fotógrafo paga aparte.
//   (checkout con method: 'transfer')         -> pedido pendiente con transferAmount y 48 h para pagar
//   POST /orders/{id}/sync                    (comprador) busca el pago ya (también corre cada 5 minutos)
//   POST /orders/{id}/mark-paid               (fotógrafo o superadmin) lo aprueba a mano
//   POST /fees/report {amount}                (fotógrafo) avisa que pagó su saldo de comisiones
//   POST /admin/fees/confirm {id} | {uid, amount}  (superadmin) confirma un pago de saldo
// Habilitado por plan (settings/platform.transfer.plans), por el fotógrafo (users.transferOn + transferAlias)
// y bloqueable por el superadmin (users.transferBlocked).
import { adminGet, adminGetMany, adminSet, adminQuery, adminCommit } from './admin.js';
import { requireUser } from './firebase.js';
import { sellerToken, mpFetch } from './mp.js';
import { planOf } from './plans.js';
import { notifyUser, notifySuper } from './push.js';
import { json, httpError } from './http.js';
import { commitOrderUpdate, downloadUntil } from './orders.js';

const PAY_HOURS = 48;
const isSuper = c => c.email === 'lautarom87@gmail.com' && c.email_verified === true;
const cents = n => Math.round(n * 100);
const panel = env => env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';
const money = n => `$${Number(n || 0).toLocaleString('es-AR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export function transferAllowed(ph, st) {
  return !!(ph?.transferOn && String(ph.transferAlias || '').trim() && !ph.transferBlocked
    && (st?.transfer?.plans || []).includes(planOf(ph)));
}

// Pedido por transferencia (lo llama checkout después de validar fotos y precios).
export async function createTransferOrder(env, { claims, ev, ph, settings, photos, t, ids, photographerUid, eventId, orderId }) {
  if (!transferAllowed(ph, settings)) throw httpError(409, 'Este fotógrafo no recibe pagos por transferencia');
  const pending = await adminQuery(env, 'orders', { filters: [['photographerUid', '==', photographerUid], ['payMethod', '==', 'transfer'], ['status', '==', 'pending']], limit: 300 });
  // Mismo comprador y mismas fotos con una transferencia todavía pendiente: se reusa.
  const key = [...ids].sort().join(',');
  const open = pending.find(o => o.buyerUid === claims.sub && o.eventId === eventId && o.total === t.total
    && (o.items || []).map(i => i.photoId).sort().join(',') === key);
  if (open) return { orderId: open.id, transfer: true, reused: true };
  // Centavos únicos entre los pedidos pendientes del fotógrafo (1 a 99).
  const used = new Set(pending.map(o => cents(o.transferAmount || 0)));
  const free = [];
  for (let c = 1; c <= 99; c++) if (!used.has(cents(t.total) + c)) free.push(c);
  if (!free.length) throw httpError(409, 'Hay muchos pagos por transferencia pendientes con este fotógrafo. Probá con Mercado Pago.');
  const c = free[Math.floor(Math.random() * free.length)];
  const now = new Date();
  const order = {
    buyerUid: claims.sub,
    photographerUid, photographerName: ph.displayName || '', eventId, eventName: ev.name || '', eventDate: ev.date || '',
    items: photos.map(p => ({ photoId: p.id, thumbUrl: p.thumbUrl || '', fileName: p.fileName || '', uploadedBy: p.uploadedBy || photographerUid })),
    count: ids.length, lines: t.lines, subtotal: t.subtotal, serviceFee: t.serviceFee, platformFee: t.platformFee,
    total: t.total, feeMode: t.feeMode, status: 'pending', createdAt: now,
    payMethod: 'transfer', transferAmount: (cents(t.total) + c) / 100,
    transferAlias: String(ph.transferAlias).trim(), transferHolder: String(ph.transferHolder || '').trim(),
    transferExpiresAt: new Date(now.getTime() + PAY_HOURS * 3600_000),
  };
  await adminSet(env, `orders/${orderId}`, order, { mustNotExist: true });
  await adminSet(env, `orderPrivate/${orderId}`, { buyerUid: claims.sub, buyerEmail: claims.email, buyerName: claims.name || '', createdAt: now });
  return { orderId, transfer: true };
}

async function approve(env, order0, { paymentId, paidAt, manual }) {
  // Se relee para tener la versión (el cron y "Ya transferí" pueden correr a la vez: solo gana uno).
  const order = await adminGet(env, `orders/${order0.id}`);
  if (!order || order.status === 'approved') return order || order0;
  const set = await adminGet(env, `events/${order.eventId}/sets/${order.photographerUid}`).catch(() => null);
  const upd = {
    status: 'approved', paidAt, downloadExpiresAt: new Date(downloadUntil(paidAt.getTime(), set)),
    ...(paymentId ? { mpPaymentId: String(paymentId), mpStatus: 'approved' } : {}),
    ...(manual ? { paidManually: manual } : {}),
  };
  const done = await commitOrderUpdate(env, order.id, order, upd);
  if (done.status === 'approved') {
    await notifyUser(env, order.buyerUid, { title: '✅ Recibimos tu transferencia', body: `Ya podés descargar tus fotos de ${order.eventName || 'tu evento'}.`, link: `${env.SITE_URL || 'https://quieromisfotos.com.ar/'}#/pedido/${order.id}` }).catch(() => {});
  }
  return done;
}

// Busca entre los cobros del fotógrafo los pagos de sus pedidos pendientes (monto exacto con centavos).
async function matchForPhotographer(env, uid, orders) {
  if (!orders.length) return 0;
  const [token, ph] = await Promise.all([sellerToken(env, uid), adminGet(env, `users/${uid}`)]);
  const since = Math.min(...orders.map(o => o.createdAt?.getTime?.() || Date.now())) - 10 * 60_000;
  const q = new URLSearchParams({ sort: 'date_created', criteria: 'desc', range: 'date_created', begin_date: `NOW-${Math.max(1, Math.ceil((Date.now() - since) / 86400_000))}DAYS`, end_date: 'NOW', status: 'approved', limit: '100' });
  const r = await mpFetch(token, `/v1/payments/search?${q}`);
  const payments = (r.results || []).filter(p => !p.external_reference && p.operation_type !== 'partition_transfer'
    && (!ph?.mpUserId || String(p.collector_id || '') === String(ph.mpUserId)));
  let n = 0;
  const taken = new Set();
  for (const o of orders) {
    const want = cents(o.transferAmount || 0);
    const created = (o.createdAt?.getTime?.() || 0) - 2 * 60_000;
    const p = payments.find(x => !taken.has(x.id) && cents(Number(x.transaction_amount) || 0) === want && new Date(x.date_created).getTime() >= created);
    if (!p) continue;
    // Un mismo cobro no puede pagar dos pedidos.
    const dup = await adminQuery(env, 'orders', { filters: [['mpPaymentId', '==', String(p.id)]], limit: 1 });
    if (dup.length) { taken.add(p.id); continue; }
    taken.add(p.id);
    await approve(env, o, { paymentId: p.id, paidAt: new Date(p.date_approved || p.date_created) });
    n++;
  }
  return n;
}

// Cron (cada 5 minutos): busca pagos de los pedidos pendientes y vence los que pasaron las 48 h.
export async function matchPendingTransfers(env) {
  const pending = await adminQuery(env, 'orders', { filters: [['payMethod', '==', 'transfer'], ['status', '==', 'pending']], limit: 300 });
  if (!pending.length) return 0;
  const byUid = {};
  for (const o of pending) (byUid[o.photographerUid] ||= []).push(o);
  let n = 0;
  for (const [uid, list] of Object.entries(byUid)) {
    try { n += await matchForPhotographer(env, uid, list); } catch (e) { console.error('transferencias', uid, e.message); }
  }
  // Vencidos (se revisan después de buscar, por si el pago entró justo).
  const now = Date.now();
  const fresh = await adminQuery(env, 'orders', { filters: [['payMethod', '==', 'transfer'], ['status', '==', 'pending']], limit: 300 });
  const late = fresh.filter(o => (o.transferExpiresAt?.getTime?.() || Infinity) < now);
  if (late.length) await adminCommit(env, late.map(o => ({ update: `orders/${o.id}`, data: { status: 'expired', expiredAt: new Date() }, mask: ['status', 'expiredAt'] })));
  return n;
}

// Sincronización pedida por el comprador ("Ya transferí").
export async function syncTransferOrder(env, order) {
  if (order.status !== 'pending') return order;
  await matchForPhotographer(env, order.photographerUid, [order]);
  return (await adminGet(env, `orders/${order.id}`)) || order;
}

export async function markPaid(req, env, orderId) {
  const claims = await requireUser(req, env);
  const order = await adminGet(env, `orders/${orderId}`);
  if (!order || (order.photographerUid !== claims.sub && !isSuper(claims))) throw httpError(404, 'Pedido no encontrado');
  if (order.payMethod !== 'transfer') throw httpError(409, 'Solo los pedidos por transferencia se marcan a mano');
  if (order.status === 'approved') return json({ status: 'approved' });
  if (!['pending', 'expired'].includes(order.status)) throw httpError(409, 'Este pedido no se puede marcar como pagado');
  const done = await approve(env, { ...order, id: orderId }, { paidAt: new Date(), manual: isSuper(claims) && order.photographerUid !== claims.sub ? 'superadmin' : 'fotografo' });
  return json({ status: done.status });
}

// ------------------------------------------------------------------ saldo de comisiones
export async function reportFeePayment(req, env) {
  const claims = await requireUser(req, env);
  const { amount, note } = await req.json().catch(() => ({}));
  const a = Math.round(Number(amount) * 100) / 100;
  if (!(a > 0 && a < 10_000_000)) throw httpError(400, 'Monto inválido');
  const user = await adminGet(env, `users/${claims.sub}`);
  if (!user || user.role !== 'photographer') throw httpError(403, 'Solo fotógrafos');
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  await adminSet(env, `feePayments/${id}`, { uid: claims.sub, name: user.displayName || '', amount: a, note: String(note || '').slice(0, 200), status: 'reported', reportedAt: new Date() });
  await notifySuper(env, 'sale', { title: `💸 ${user.displayName || 'Un fotógrafo'} avisó que pagó ${money(a)} de comisiones`, body: 'Revisá tu cuenta y confirmalo en Fotógrafos.', link: `${panel(env)}#/admin/fotografos` });
  return json({ ok: true, id });
}

export async function confirmFeePayment(req, env) {
  const claims = await requireUser(req, env);
  if (!isSuper(claims)) throw httpError(403, 'Solo superadmin');
  const { id, uid, amount, reject } = await req.json().catch(() => ({}));
  let fp;
  if (id) {
    fp = await adminGet(env, `feePayments/${id}`);
    if (!fp || fp.status !== 'reported') throw httpError(404, 'Pago no encontrado');
  } else {
    const a = Math.round(Number(amount) * 100) / 100;
    if (!/^[A-Za-z0-9_-]{6,40}$/.test(uid || '') || !(a > 0)) throw httpError(400, 'Pedido inválido');
    fp = { uid, amount: a };
  }
  const now = new Date();
  const docId = id || crypto.randomUUID().replace(/-/g, '').slice(0, 20);
  if (reject) {
    await adminCommit(env, [{ update: `feePayments/${docId}`, data: { status: 'rejected', resolvedAt: now }, mask: ['status', 'resolvedAt'] }]);
    await notifyUser(env, fp.uid, { title: 'Pago de comisiones sin confirmar', body: `No encontramos tu pago de ${money(fp.amount)}. Escribinos por WhatsApp.`, link: `${panel(env)}#/mp` }).catch(() => {});
    return json({ ok: true });
  }
  await adminCommit(env, [
    id ? { update: `feePayments/${docId}`, data: { status: 'confirmed', resolvedAt: now }, mask: ['status', 'resolvedAt'] }
      : { set: `feePayments/${docId}`, data: { uid: fp.uid, amount: fp.amount, status: 'confirmed', reportedAt: now, resolvedAt: now, byAdmin: true } },
    { upsert: `feeBalance/${fp.uid}`, data: { updatedAt: now } },
    { inc: `feeBalance/${fp.uid}`, fields: { paid: fp.amount } },
  ]);
  await notifyUser(env, fp.uid, { title: '✅ Pago de comisiones confirmado', body: `Registramos tu pago de ${money(fp.amount)}. ¡Gracias!`, link: `${panel(env)}#/mp` }).catch(() => {});
  return json({ ok: true });
}
