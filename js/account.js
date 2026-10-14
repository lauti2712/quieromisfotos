// Cuenta del comprador en el sitio público: ingresar (Google / email), Mis compras, salir.
import {
  db, auth, collection, getDocs, query, where, orderBy, limit,
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile,
} from './fb.js';
import { $, esc, fmtMoney, fmtTs, toast, errMsg, initials } from './util.js';

let current = null;
const waiters = [];

onAuthStateChanged(auth, user => {
  current = user;
  drawHeader();
  if (user) waiters.splice(0).forEach(fn => fn(user));
  window.dispatchEvent(new CustomEvent('account:change', { detail: { user } }));
});

export const currentUser = () => current;

function drawHeader() {
  const el = document.getElementById('acct');
  if (!el) return;
  el.innerHTML = current
    ? `<a class="btn sm acct-btn" href="#/cuenta" aria-label="Mi cuenta"><span class="avatar xs">${current.photoURL ? `<img src="${esc(current.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(current.displayName || current.email))}</span><span class="acct-label">Mi cuenta</span></a>`
    : '<button class="btn sm acct-btn" id="acct-login"><span class="acct-label">Ingresar</span><span class="acct-icon" aria-hidden="true">👤</span></button>';
  $('#acct-login')?.addEventListener('click', () => openLogin());
}

// Devuelve el usuario logueado o abre el login y espera.
export function requireLogin(reason) {
  if (current) return Promise.resolve(current);
  return new Promise(resolve => { waiters.push(resolve); openLogin(reason); });
}

export function openLogin(reason = '') {
  document.querySelector('dialog.login')?.close();
  let mode = 'login';
  const dlg = document.createElement('dialog');
  dlg.className = 'login';
  dlg.innerHTML = `
    <div class="dlg-head"><h2 id="l-title">Ingresar</h2><button class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <div class="dlg-body">
      ${reason ? `<p class="muted" style="margin:0">${esc(reason)}</p>` : ''}
      <button class="btn block" id="l-google">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Continuar con Google
      </button>
      <div class="divider">o con email</div>
      <form id="l-form" class="stack">
        <label class="field hidden" id="l-name-f">Nombre<input type="text" id="l-name" autocomplete="name"></label>
        <label class="field">Email<input type="email" id="l-mail" required autocomplete="email"></label>
        <label class="field">Contraseña<input type="password" id="l-pass" required minlength="6" autocomplete="current-password"></label>
        <button class="btn primary block" type="submit" id="l-submit">Ingresar</button>
      </form>
      <div class="row" style="justify-content:space-between">
        <button class="btn ghost sm" id="l-toggle">Crear cuenta</button>
        <button class="btn ghost sm" id="l-reset">Olvidé mi contraseña</button>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.showModal();

  const done = () => { dlg.close(); toast('¡Listo! Ya ingresaste.'); };
  $('#l-google', dlg).onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); done(); } catch (e) { toast(errMsg(e), 'error'); }
  };
  $('#l-toggle', dlg).onclick = () => {
    mode = mode === 'login' ? 'signup' : 'login';
    const su = mode === 'signup';
    $('#l-title', dlg).textContent = su ? 'Crear cuenta' : 'Ingresar';
    $('#l-submit', dlg).textContent = su ? 'Crear cuenta' : 'Ingresar';
    $('#l-toggle', dlg).textContent = su ? 'Ya tengo cuenta' : 'Crear cuenta';
    $('#l-name-f', dlg).classList.toggle('hidden', !su);
    $('#l-pass', dlg).autocomplete = su ? 'new-password' : 'current-password';
  };
  $('#l-form', dlg).onsubmit = async e => {
    e.preventDefault();
    const email = $('#l-mail', dlg).value.trim(), pass = $('#l-pass', dlg).value;
    try {
      if (mode === 'login') await signInWithEmailAndPassword(auth, email, pass);
      else {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        const name = $('#l-name', dlg).value.trim();
        if (name) await updateProfile(cred.user, { displayName: name }).catch(() => {});
        drawHeader();
      }
      done();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
  $('#l-reset', dlg).onclick = async () => {
    const email = $('#l-mail', dlg).value.trim();
    if (!email) return toast('Escribí tu email y volvé a tocar.', 'error');
    try { await sendPasswordResetEmail(auth, email); toast('Te mandamos un mail para crear una nueva contraseña.'); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
}

// ---------------------------------------------------------------- Mi cuenta / Mis compras
const STATUS = {
  pending: ['Pago pendiente', 'warn'], approved: ['Pagado', 'ok'], rejected: ['Pago rechazado', 'danger'], refunded: ['Reembolsado', ''],
};

export async function renderAccount(app) {
  document.title = 'Mi cuenta · Quiero Mis Fotos';
  if (!current) {
    app.innerHTML = `<div class="empty"><h2>Ingresá a tu cuenta</h2><p>Para ver tus compras y descargar tus fotos.</p><button class="btn primary" id="go-login">Ingresar</button></div>`;
    $('#go-login').onclick = () => openLogin();
    return;
  }
  const u = current;
  app.innerHTML = `
    <div class="profile-head" style="margin-bottom:18px">
      <span class="avatar lg">${u.photoURL ? `<img src="${esc(u.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(u.displayName || u.email))}</span>
      <div style="flex:1;min-width:200px">
        <h1 style="margin-bottom:2px">${esc(u.displayName || 'Mi cuenta')}</h1>
        <div class="muted">${esc(u.email || '')}</div>
      </div>
      <button class="btn" id="logout">Salir</button>
    </div>
    <h2>Mis compras</h2>
    <div id="orders"><div class="spinner"></div></div>
    <p class="muted small" style="margin-top:24px">¿Sos fotógrafo? <a href="panel.html">Entrá al panel para vender tus fotos</a>.</p>`;
  $('#logout').onclick = async () => { await signOut(auth); location.hash = '#/'; };

  try {
    const snap = await getDocs(query(collection(db, 'orders'), where('buyerUid', '==', u.uid), orderBy('createdAt', 'desc'), limit(100)));
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    $('#orders').innerHTML = orders.length ? orders.map(o => {
      const [label, cls] = STATUS[o.status] || [o.status, ''];
      return `
        <a class="card order-row" href="#/pedido/${o.id}" style="display:flex;gap:12px;align-items:center;text-decoration:none">
          <div style="flex:1;min-width:0">
            <strong>${esc(o.eventName || 'Pedido')}</strong>
            <div class="muted small">${esc(fmtTs(o.createdAt))} · ${(o.items || []).length} foto${(o.items || []).length === 1 ? '' : 's'} · ${fmtMoney(o.total)}</div>
          </div>
          <span class="pill ${cls}">${label}</span>
        </a>`;
    }).join('') : `<div class="card"><div class="empty">Todavía no compraste fotos.<br><a class="btn primary" href="#/" style="margin-top:12px">Buscar mi evento</a></div></div>`;
  } catch (e) {
    $('#orders').innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`;
  }
}
