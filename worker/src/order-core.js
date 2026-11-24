// Núcleo de pedidos: plazos de venta/descarga y el cambio de estado de un pedido (venta contada, mail, avisos).
// Lo usan orders.js (Mercado Pago), transfers.js (transferencias), extensions.js y storage.js, sin depender entre ellos:
// así no hay imports circulares orders ↔ transfers ↔ extensions.
import { adminGet, adminUpdate, adminCommit } from './admin.js';
import { siteUrl } from './mp.js';
import { signToken } from './tokens.js';
import { notifyUser, notifySuper } from './push.js';
import { GRACE_DAYS } from './plans.js';
import { sendMail, mailLayout } from './mail.js';

const DOWNLOAD_DAYS = 7;

// Fecha hasta la que el set se puede vender (originales disponibles).
export function setAvailableUntil(set) {
  const a = set?.expiresAt?.getTime?.() || 0, b = set?.extendedUntil?.getTime?.() || 0;
  return Math.max(a, b) || null;
}

// El comprador descarga mientras exista el original (venta + gracia, con las extensiones), y como mínimo 7 días.
export function downloadUntil(paidAt, set) {
  const until = setAvailableUntil(set);
  return Math.max(paidAt + DOWNLOAD_DAYS * 86400_000, until ? until + GRACE_DAYS * 86400_000 : 0);
}

// Ventas por álbum en salesStats/{eid}_{uid}: privado (fotógrafo y superadmin), no en el set que es público.
// Plan Empresas: además, por fotógrafo que sacó cada foto (byUploader, con el monto proporcional) y teamSales/{eid}_{empresa}_{colaborador}
// (lo que ve el colaborador: cantidad de fotos vendidas).
function countSale(env, order, sign) {
  const path = `salesStats/${order.eventId}_${order.photographerUid}`;
  const by = {};
  for (const it of order.items || []) { const u = it.uploadedBy || order.photographerUid; by[u] = (by[u] || 0) + 1; }
  const n = order.count || (order.items || []).length || 1;
  const fields = { soldPhotos: sign * (order.count || 0), soldOrders: sign };
  const ops = [{ upsert: path, data: { eventId: order.eventId, photographerUid: order.photographerUid, updatedAt: new Date() } }];
  const team = Object.keys(by).some(u => u !== order.photographerUid);
  if (team) {
    for (const [u, k] of Object.entries(by)) {
      fields[`byUploader.${u}.photos`] = sign * k;
      fields[`byUploader.${u}.amount`] = sign * Math.round((order.subtotal || 0) * k / n);
      if (u === order.photographerUid) continue;
      const tp = `teamSales/${order.eventId}_${order.photographerUid}_${u}`;
      ops.push({ upsert: tp, data: { eventId: order.eventId, teamUid: order.photographerUid, memberUid: u, updatedAt: new Date() } });
      ops.push({ inc: tp, fields: { soldPhotos: sign * k } });
    }
  }
  ops.splice(1, 0, { inc: path, fields });
  return adminCommit(env, ops).catch(e => console.error('ventas', e));
}

// Guarda el cambio de estado del pedido y, si pasó a aprobado (o se reembolsó), cuenta la venta y avisa.
// Lo usan el pago con Mercado Pago y el cobro por transferencia (transfers.js).
export async function commitOrderUpdate(env, orderId, order, upd) {
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
  // Contador de ventas del álbum (solo la primera vez que el pedido pasa a aprobado o se reembolsa).
  if (upd.status === 'approved' && order.status !== 'approved') {
    await countSale(env, order, 1);
    await mailDownloads(env, orderId, { ...order, ...upd }).catch(e => console.error('mail compra', e));
    // Transferencia: la plata llegó entera al fotógrafo; la comisión queda como saldo a pagar a la plataforma.
    if (order.payMethod === 'transfer' && order.platformFee > 0) {
      await adminCommit(env, [
        { upsert: `feeBalance/${order.photographerUid}`, data: { updatedAt: new Date() } },
        { inc: `feeBalance/${order.photographerUid}`, fields: { accrued: order.platformFee, orders: 1 } },
      ]).catch(e => console.error('saldo comisión', e));
    }
    // Aviso al fotógrafo en sus dispositivos.
    const n = order.count || 0;
    await notifyUser(env, order.photographerUid, {
      title: `💰 ¡Vendiste ${n} foto${n === 1 ? '' : 's'}!`,
      body: `${order.eventName || 'Evento'} · $${Math.round(order.total || 0).toLocaleString('es-AR')}`,
      link: `${(env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html')}#/ventas`,
    }).catch(e => console.error('push', e));
    await notifySuper(env, 'sale', {
      title: `💰 Venta: ${n} foto${n === 1 ? '' : 's'} · $${Math.round(order.total || 0).toLocaleString('es-AR')}`,
      body: `${order.photographerName || 'Fotógrafo'} · ${order.eventName || 'Evento'} · comisión $${Math.round(order.platformFee || 0).toLocaleString('es-AR')}`,
      link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/admin/metricas`,
    });
  } else if (upd.status === 'refunded' && order.status === 'approved') {
    await countSale(env, order, -1);
  }
  return { ...order, ...upd };
}

// Mail al comprador con el link a sus descargas (también quedan en Mis compras).
async function mailDownloads(env, orderId, order) {
  const priv = await adminGet(env, `orderPrivate/${orderId}`);
  if (order.buyerGuest) {
    if (!priv?.mpPayerEmail) return;
    const nG = order.count || (order.items || []).length;
    await sendMail(env, {
      to: priv.mpPayerEmail,
      subject: `✅ Compra confirmada: fotos de ${order.eventName || 'tu evento'}`,
      html: mailLayout({
        title: '¡Compra confirmada!',
        intro: `Tu pago se acreditó. Descargá ${nG === 1 ? 'tu foto' : `tus ${nG} fotos`} en alta calidad y sin marca de agua con el botón de abajo (funciona en cualquier celular o computadora).`,
        rows: [['Evento', order.eventName || ''], ['Fotógrafo', order.photographerName || ''], ['Fotos', String(nG)], ['Total', `$${Number(order.total || 0).toLocaleString('es-AR')}`]],
        cta: { label: '⬇️ Descargar mis fotos', url: await orderLinkUrl(env, orderId) },
        foot: 'Guardá este mail para volver a tus fotos. También te creamos una cuenta con este mail: te llega otro mail para elegir tu contraseña.',
      }),
    });
    return;
  }
  if (!priv?.buyerEmail) return;
  const site = (env.SITE_URL || 'https://quieromisfotos.com.ar/').replace(/\/?$/, '/');
  const until = order.downloadExpiresAt ? new Date(order.downloadExpiresAt).toLocaleDateString('es-AR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Argentina/Buenos_Aires' }) : '';
  const n = order.count || (order.items || []).length;
  await sendMail(env, {
    to: priv.buyerEmail,
    subject: `✅ Compra confirmada: fotos de ${order.eventName || 'tu evento'}`,
    html: mailLayout({
      title: '¡Compra confirmada!',
      intro: `${priv.buyerName ? `Hola ${priv.buyerName.split(' ')[0]}, ` : ''}tu pago se acreditó. ${n === 1 ? 'Tu foto está' : `Tus ${n} fotos están`} en <strong>Mis compras</strong>, para descargar en alta calidad y sin marca de agua desde Quiero Mis Fotos.`,
      rows: [['Evento', order.eventName || ''], ['Fotógrafo', order.photographerName || ''], ['Fotos', String(n)], ['Total', `$${Number(order.total || 0).toLocaleString('es-AR')}`], ...(until ? [['Disponibles hasta', until]] : [])],
      cta: { label: 'Ver mi compra', url: `${site}#/pedido/${orderId}` },
      foot: 'Las fotos se descargan desde la app, ingresando con la misma cuenta con la que compraste.',
    }),
  });
}

// La llave abre ese pedido en cualquier navegador: va en el link de vuelta de Mercado Pago y en el mail del invitado.
export const orderKey = (env, orderId) => signToken({ typ: 'ord', o: orderId }, env.UPLOAD_SECRET);
export const orderLinkUrl = async (env, orderId) => `${siteUrl(env)}#/pedido/${orderId}?k=${await orderKey(env, orderId)}`;
