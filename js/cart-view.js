// Página del carrito: un bloque por fotógrafo + evento, con desglose de packs y comisión.
import { db, doc, getDoc } from './fb.js';
import { $, $$, esc, fmtMoney, fmtDate, toast, errMsg } from './util.js';
import { cart } from './cart.js';
import { computeTotals, bestPrice } from './pricing.js';
import { loadSettings } from './data.js';
import { currentUser, openLogin } from './account.js';
import { apiPost } from './api.js';

const cache = new Map();
function cachedGet(path) {
  if (!cache.has(path)) cache.set(path, getDoc(doc(db, path)).then(s => (s.exists() ? s.data() : null)).catch(() => null));
  return cache.get(path);
}

export async function renderCart(app) {
  document.title = 'Carrito · Quiero Mis Fotos';
  app.innerHTML = '<div class="spinner"></div>';
  const groups = cart.groups();
  if (!groups.length) {
    app.innerHTML = `<div class="empty"><h2>Tu carrito está vacío</h2><p>Buscá tu evento y agregá las fotos que te gusten.</p><a class="btn primary" href="#/">Ver eventos</a></div>`;
    return;
  }
  const settings = await loadSettings();
  const data = await Promise.all(groups.map(async g => {
    const [ev, set, ph] = await Promise.all([
      cachedGet(`events/${g.eventId}`), cachedGet(`events/${g.eventId}/sets/${g.photographerUid}`), cachedGet(`users/${g.photographerUid}`),
    ]);
    return { ...g, ev, set, ph };
  }));

  app.innerHTML = `
    <h1>Carrito</h1>
    <p class="muted">Cada fotógrafo cobra por separado: vas a hacer un pago por cada bloque.</p>
    ${data.map(g => groupHtml(g, settings)).join('')}`;

  $$('[data-pay]', app).forEach(b => b.onclick = async () => {
    const g = groups.find(x => x.key === b.dataset.pay);
    b.disabled = true; b.textContent = 'Preparando el pago…';
    try {
      const { initPoint } = await apiPost('/checkout', {
        eventId: g.eventId, photographerUid: g.photographerUid, photoIds: g.items.map(i => i.photoId),
      });
      location.href = initPoint;
    } catch (e) {
      b.disabled = false; b.textContent = 'Reintentar pago';
      toast(errMsg(e), 'error');
    }
  });
  $$('[data-login]', app).forEach(b => b.onclick = () => openLogin('Ingresá con Google o tu email para comprar. Tus fotos van a quedar guardadas en Mis compras.'));
  $$('[data-rm]', app).forEach(b => b.onclick = () => { cart.remove(b.dataset.rm); renderCart(app); });
  $$('[data-rmg]', app).forEach(b => b.onclick = () => {
    const [eid, uid] = b.dataset.rmg.split('|');
    if (confirm('¿Quitar todas estas fotos del carrito?')) { cart.removeGroup(eid, uid); renderCart(app); }
  });
}

function groupHtml(g, settings) {
  const available = g.ev && g.set && g.ph && g.ph.status === 'approved' && g.set.price > 0;
  const n = g.items.length;
  const head = `
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <div>
        <div class="muted small">${g.ev ? esc(fmtDate(g.ev.date)) : ''}</div>
        <h2 style="margin:0 0 2px">${g.ev ? `<a href="#/evento/${g.eventId}" style="text-decoration:none">${esc(g.ev.name)}</a>` : 'Evento no disponible'}</h2>
        <div class="muted">📷 ${g.ph ? `<a href="#/f/${esc(g.ph.slug)}">${esc(g.ph.displayName)}</a>` : 'Fotógrafo'}</div>
      </div>
      <button class="btn sm ghost danger" data-rmg="${g.key}">Quitar todo</button>
    </div>
    <div class="cart-thumbs">${g.items.map(i => `
      <div class="cart-thumb"><img src="${esc(i.thumbUrl)}" alt="" loading="lazy"><button data-rm="${i.photoId}" aria-label="Quitar">✕</button></div>`).join('')}
    </div>`;

  if (!available) {
    return `<section class="card stack">${head}<div class="notice warn">Estas fotos ya no están disponibles para compra.</div></section>`;
  }

  const t = computeTotals({ count: n, price: g.set.price, packs: g.set.packs, feeMode: g.set.feeMode, feePercent: settings.feePercent });
  const tip = nextPackTip(n, g.set);
  return `
    <section class="card stack">
      ${head}
      <div class="breakdown">
        ${t.lines.map(l => `<div class="bd-row"><span>${esc(l.label)}${l.times > 1 ? ` × ${l.times}` : ''}</span><span>${fmtMoney(l.amount)}</span></div>`).join('')}
        ${t.savings ? `<div class="bd-row ok"><span>Ahorro por packs</span><span>−${fmtMoney(t.savings)}</span></div>` : ''}
        <div class="bd-row"><span>Subtotal (${n} foto${n > 1 ? 's' : ''})</span><span>${fmtMoney(t.subtotal)}</span></div>
        ${t.serviceFee ? `<div class="bd-row muted"><span>Costo de servicio</span><span>${fmtMoney(t.serviceFee)}</span></div>` : ''}
        <div class="bd-row total"><span>Total</span><span>${fmtMoney(t.total)}</span></div>
      </div>
      ${tip ? `<div class="notice small">💡 ${tip}</div>` : ''}
      ${g.ev.demo ? '<div class="notice warn small">👀 Son fotos de un evento de ejemplo: no se pueden comprar.</div>' : ''}
      <div class="row end">
        ${g.ev.demo
          ? `<button class="btn primary" disabled>Pagar ${fmtMoney(t.total)}</button>`
          : currentUser()
          ? `<span class="muted small">Pagás con Mercado Pago: tarjeta, débito o dinero en cuenta.</span><button class="btn primary" data-pay="${g.key}">Pagar ${fmtMoney(t.total)}</button>`
          : `<span class="muted small">Ingresá para comprar: tus fotos quedan siempre en Mis compras.</span><button class="btn primary" data-login>Ingresar para pagar</button>`}
      </div>
    </section>`;
}

// Sugerencia: si agregando pocas fotos se llega a un pack que cuesta casi lo mismo.
function nextPackTip(n, set) {
  const packs = (set.packs || []).filter(p => p.qty > n).sort((a, b) => a.qty - b.qty);
  const now = bestPrice(n, set.price, set.packs).subtotal;
  for (const p of packs) {
    const extra = p.qty - n;
    if (extra > 3) break;
    const then = bestPrice(p.qty, set.price, set.packs).subtotal;
    if (then - now < set.price * extra) {
      return `Agregá ${extra} foto${extra > 1 ? 's' : ''} más y te llevás ${p.qty} por ${fmtMoney(then)} (solo ${fmtMoney(then - now)} más).`;
    }
  }
  return '';
}
