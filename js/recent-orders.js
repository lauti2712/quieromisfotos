// Compras de este dispositivo: antes de ir a Mercado Pago se guarda el link del pedido (con su llave), así el comprador
// —también sin cuenta— vuelve a su compra aunque cierre Mercado Pago, vuelva en otro navegador o el pago tarde
// (efectivo). Se muestra un aviso arriba hasta que abre la compra pagada, y la lista en Mis compras.
// También la página #/recuperar: "Pagué y no veo mis fotos" → le mandamos los links por mail.
import { $, esc, toast, errMsg, fmtMoney } from './util.js';
import { API_BASE } from './api.js';

const KEY = 'qmf.orders';
const KEEP_DAYS = 30, BAR_DAYS = 5;

export function recentOrders() {
  try {
    const l = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(l) ? l.filter(o => o?.id && Date.now() - (o.at || 0) < KEEP_DAYS * 86400000) : [];
  } catch { return []; }
}
function store(l) { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, 15))); } catch { /* nada */ } }

export function saveRecentOrder({ id, k, ev = '', total = 0 }) {
  if (!id) return;
  const l = recentOrders(), old = l.find(o => o.id === id);
  store([{ ...(old || {}), id, k: k || old?.k || '', ev: ev || old?.ev || '', total: total || old?.total || 0, at: old?.at || Date.now() }, ...l.filter(o => o.id !== id)]);
}
// Ya vio la compra pagada: deja de mostrarse el aviso de arriba.
export function markOrderSeen(id, status) {
  const l = recentOrders(), o = l.find(x => x.id === id);
  if (!o || o.status === status) return;
  o.status = status;
  store(l);
}
export const recentKey = id => recentOrders().find(o => o.id === id)?.k || '';
export const orderHref = o => `#/pedido/${o.id}${o.k ? `?k=${encodeURIComponent(o.k)}` : ''}`;

// Aviso arriba de todo (en todas las pantallas menos la del pedido) con las compras recientes que todavía no abrió pagadas.
export function drawRecentBar(route) {
  let bar = document.getElementById('ro-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'ro-bar';
    document.getElementById('app')?.before(bar);
  }
  const l = route === 'pedido' ? [] : recentOrders().filter(o => o.status !== 'approved' && o.status !== 'rejected' && Date.now() - o.at < BAR_DAYS * 86400000);
  bar.className = l.length ? 'container' : '';
  bar.innerHTML = l.length ? `<div class="notice warn row" style="justify-content:space-between;gap:8px;margin:10px 0 0">
    <span>🧾 ${l.length === 1 ? `Tenés una compra${l[0].ev ? ` de <strong>${esc(l[0].ev)}</strong>` : ''}` : `Tenés ${l.length} compras`} en curso.</span>
    <a class="btn sm primary" href="${l.length === 1 ? orderHref(l[0]) : '#/cuenta'}">Ver mi compra</a></div>` : '';
}

// Para Mis compras: las de este dispositivo (sirve aunque haya comprado sin cuenta) y el acceso a recuperar por mail.
export function recentOrdersHtml() {
  const l = recentOrders();
  return `<div class="card stack" style="margin-top:14px">
    ${l.length ? `<h3 style="margin:0">Compras hechas en este dispositivo</h3>
      ${l.map(o => `<a class="row" style="justify-content:space-between;text-decoration:none" href="${orderHref(o)}">
        <span>${esc(o.ev || 'Compra')} <span class="muted small">· ${new Date(o.at).toLocaleDateString('es-AR')}</span></span>
        <span>${o.total ? fmtMoney(o.total) : ''} ›</span></a>`).join('')}` : ''}
    <span class="muted small">¿Pagaste y no ves tus fotos? <a href="#/recuperar">Te mandamos los links por mail</a>.</span>
  </div>`;
}

// #/recuperar: pide el mail con el que pagó y le mandamos los links de sus compras.
export function renderRecover(app) {
  document.title = 'Recuperar mi compra · Quiero Mis Fotos';
  app.innerHTML = `<div class="card stack" style="max-width:560px;margin:0 auto">
    <h1 style="margin:0">¿Pagaste y no ves tus fotos?</h1>
    <p class="muted" style="margin:0">Escribí el mail con el que pagaste en Mercado Pago (o el de tu cuenta) y te mandamos los links de tus compras. Se abren en cualquier celular, sin cuenta.</p>
    <form id="rc-form" class="stack">
      <label class="field">Mail<input id="rc-email" type="email" required maxlength="120" autocomplete="email" inputmode="email"></label>
      <button class="btn primary" id="rc-send">Mandarme mis compras</button>
    </form>
    <div id="rc-done"></div>
    <p class="muted small" style="margin:0">Si pagaste en efectivo (Rapipago o Pago Fácil), la compra se habilita cuando Mercado Pago acredita el pago: puede tardar unas horas. Te avisamos por mail.</p>
  </div>`;
  $('#rc-form').onsubmit = async e => {
    e.preventDefault();
    const b = $('#rc-send');
    b.disabled = true;
    try {
      const res = await fetch(`${API_BASE}/orders/recover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#rc-email').value.trim() }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo enviar');
      $('#rc-form').remove();
      $('#rc-done').innerHTML = `<div class="notice ok">📬 Listo. Si hay compras con ese mail, en unos minutos te llega un mail con los links. Revisá también <strong>Spam</strong> o <strong>Promociones</strong>.</div>`;
    } catch (err) { b.disabled = false; toast(errMsg(err), 'error'); }
  };
}
