// Compras sin cuenta ("invitado" = usuario anónimo de Firebase). El pedido queda con buyerGuest: true.
// - POST /orders/claim  Bearer (cuenta real)  {anonToken?}: al crear cuenta o ingresar desde el invitado, sus compras pasan
//   a esa cuenta (si el uid no cambió —se vinculó la cuenta—, solo se marca que ya no es invitado).
// - convertGuests (cron): si a las 2 horas de pagar sigue como invitado, se le crea la cuenta con el email que usó en
//   Mercado Pago (o, si ya existe una con ese email, la compra pasa ahí) y se le avisa por mail cómo entrar.
import { requireUser, verifyIdToken } from './firebase.js';
import { verifyToken } from './tokens.js';
import { adminQuery, adminCommit, adminGetMany, serviceToken } from './admin.js';
import { sendMail, mailLayout } from './mail.js';
import { json, httpError } from './http.js';

export const isGuest = claims => claims?.firebase?.sign_in_provider === 'anonymous';
const IDT = env => `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function idt(env, path, body) {
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  const res = await fetch(`${IDT(env)}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Firebase Auth: ${d.error?.message || res.status}`);
  return d;
}

// Pasa los pedidos (y su parte privada) de un comprador a otro.
async function moveOrders(env, fromUid, toUid) {
  const orders = await adminQuery(env, 'orders', { filters: [['buyerUid', '==', fromUid]], limit: 200 });
  const ops = orders.flatMap(o => [
    { update: `orders/${o.id}`, data: { buyerUid: toUid, buyerGuest: false }, mask: ['buyerUid', 'buyerGuest'] },
    { update: `orderPrivate/${o.id}`, data: { buyerUid: toUid }, mask: ['buyerUid'] },
  ]);
  for (let i = 0; i < ops.length; i += 400) await adminCommit(env, ops.slice(i, i + 400));
  return orders;
}

export async function claimOrders(req, env) {
  const claims = await requireUser(req, env);
  if (isGuest(claims)) throw httpError(400, 'Primero ingresá con tu cuenta');
  const { anonToken, orderKeys } = await req.json().catch(() => ({}));
  let moved = 0;
  // Pedidos de invitado abiertos con su llave (link de MP o del mail): pasan a esta cuenta con todas las compras de ese invitado.
  for (const k of (Array.isArray(orderKeys) ? orderKeys : []).slice(0, 5)) {
    const t = await verifyToken(k, env.UPLOAD_SECRET, 'ord');
    const [o] = t ? await adminGetMany(env, [`orders/${t.o}`]) : [];
    if (o?.buyerGuest && o.buyerUid !== claims.sub) moved += (await moveOrders(env, o.buyerUid, claims.sub)).length;
  }
  if (anonToken) {
    const anon = await verifyIdToken(anonToken, env).catch(() => null);
    if (anon && isGuest(anon) && anon.sub !== claims.sub) moved = (await moveOrders(env, anon.sub, claims.sub)).length;
  }
  // La misma cuenta (el invitado se convirtió en cuenta real): ya no es invitado.
  const own = await adminQuery(env, 'orders', { filters: [['buyerUid', '==', claims.sub], ['buyerGuest', '==', true]], limit: 200 });
  if (own.length) await adminCommit(env, own.map(o => ({ update: `orders/${o.id}`, data: { buyerGuest: false }, mask: ['buyerGuest'] })));
  return json({ ok: true, moved, linked: own.length });
}

const WAIT = 2 * 3600_000, PER_RUN = 3;
export async function convertGuests(env) {
  if (env.FIREBASE_EMULATOR) return;
  const list = (await adminQuery(env, 'orders', { filters: [['buyerGuest', '==', true], ['status', '==', 'approved']], limit: 50 }))
    .filter(o => Date.now() - (o.paidAt?.getTime?.() || 0) > WAIT);
  const done = new Set();
  for (const o of list) {
    if (done.has(o.buyerUid) || done.size >= PER_RUN) continue;
    done.add(o.buyerUid);
    try {
      const [priv] = await adminGetMany(env, [`orderPrivate/${o.id}`]);
      const email = String(priv?.mpPayerEmail || priv?.buyerEmail || '').trim().toLowerCase();
      const look = await idt(env, '/accounts:lookup', { localId: [o.buyerUid] });
      const u = look.users?.[0];
      // Ya no es invitado (se vinculó a Google o email desde la app): solo se actualiza la marca.
      if (u && (u.providerUserInfo || []).length) { await moveOrders(env, o.buyerUid, o.buyerUid); continue; }
      if (!email) { await adminCommit(env, [{ update: `orders/${o.id}`, data: { buyerGuest: false, guestNoEmail: true }, mask: ['buyerGuest', 'guestNoEmail'] }]); continue; }
      const existing = (await idt(env, '/accounts:lookup', { email: [email] })).users?.[0];
      let uid = existing?.localId, link = '';
      if (!uid) {
        const pass = crypto.randomUUID() + crypto.randomUUID();
        uid = (await idt(env, '/accounts', { email, password: pass, ...(priv?.buyerName ? { displayName: priv.buyerName } : {}) })).localId;
        link = (await idt(env, '/accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email, returnOobLink: true })).oobLink || '';
      }
      const orders = await moveOrders(env, o.buyerUid, uid);
      const site = (env.SITE_URL || 'https://quieromisfotos.com.ar/').replace(/\/?$/, '/');
      const events = [...new Set(orders.map(x => x.eventName).filter(Boolean))].join(', ');
      await sendMail(env, {
        to: email,
        subject: existing ? '📸 Tu compra quedó guardada en tu cuenta' : '📸 Creamos tu cuenta en Quiero Mis Fotos',
        html: mailLayout({
          title: existing ? 'Tu compra quedó en tu cuenta' : 'Creamos tu cuenta para guardar tu compra',
          intro: existing
            ? `Tu compra${events ? ` de <strong>${esc(events)}</strong>` : ''} quedó guardada en tu cuenta de Quiero Mis Fotos con este mail. Entrá a <strong>Mis compras</strong> para volver a descargar tus fotos.`
            : `Para que puedas volver a descargar tus fotos${events ? ` de <strong>${esc(events)}</strong>` : ''}, creamos tu cuenta con este mail (es el que usaste en Mercado Pago). Elegí una contraseña y entrá a <strong>Mis compras</strong>.`,
          cta: existing ? { label: 'Ir a Mis compras', url: `${site}#/cuenta` } : { label: '🔑 Elegir mi contraseña', url: link || `${site}#/cuenta` },
          foot: existing ? '' : `También podés entrar con <strong>Continuar con Google</strong> si este mail es de Gmail. Después de elegir la contraseña, entrá desde ${esc(site)} → Ingresar.`,
        }),
      }).catch(e => console.error('mail invitado', e));
    } catch (e) { console.error('convertir invitado', o.buyerUid, e); }
  }
}
