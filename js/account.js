// Cuenta del comprador en el sitio público: ingresar (Google / email), Mis compras, salir.
import {
  db, auth, collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, serverTimestamp, Timestamp,
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile,
} from './fb.js';
import { $, esc, fmtMoney, fmtTs, toast, errMsg, initials } from './util.js';

let current = null;
const waiters = [];

let isPhotographer = false; // la cuenta tiene perfil de fotógrafo (o es superadmin)

onAuthStateChanged(auth, async user => {
  current = user;
  isPhotographer = false;
  if (user) {
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      isPhotographer = snap.exists() && ['photographer', 'superadmin'].includes(snap.data().role);
    } catch { /* sin perfil */ }
  }
  drawHeader();
  if (user) recordCustomer(user);
  if (user) waiters.splice(0).forEach(fn => fn(user));
  window.dispatchEvent(new CustomEvent('account:change', { detail: { user } }));
});

export const currentUser = () => current;

// Registro de clientes (customers/{uid}): alta y último ingreso, una vez por sesión del navegador.
function recordCustomer(user) {
  const k = `qmf.cust.${user.uid}`;
  try { if (sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* modo privado */ }
  const created = Date.parse(user.metadata?.creationTime || '') || Date.now();
  setDoc(doc(db, 'customers', user.uid), {
    name: user.displayName || '', email: user.email || '',
    provider: user.providerData?.[0]?.providerId || 'password',
    createdAt: Timestamp.fromMillis(created), lastLoginAt: serverTimestamp(),
  }, { merge: true }).catch(e => console.warn('customer', e));
}

function drawHeader() {
  const el = document.getElementById('acct');
  if (!el) return;
  // Los fotógrafos van directo a su panel; "Mi cuenta" (compras) es para clientes.
  document.getElementById('soy-fotografo')?.classList.toggle('hidden', isPhotographer);
  const avatar = current ? `<span class="avatar xs">${current.photoURL ? `<img src="${esc(current.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(current.displayName || current.email))}</span>` : '';
  el.innerHTML = current && isPhotographer
    ? `<a class="btn sm acct-btn" href="panel.html" aria-label="Mi panel">${avatar}<span class="acct-label">Mi panel</span></a>`
    : current
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
    <h2 style="margin-top:26px">🔔 Mis avisos</h2>
    <div id="follows"><div class="spinner"></div></div>
    <p class="muted small" style="margin-top:24px" id="photog-hint">¿Sos fotógrafo? <a href="panel.html">Entrá al panel para vender tus fotos</a>.</p>`;
  $('#logout').onclick = async () => { await signOut(auth); location.hash = '#/'; };

  drawFollows(u).catch(() => { $('#follows').innerHTML = ''; });

  // Un fotógrafo que entra a "Mis compras" no ve la invitación a vender.
  if (isPhotographer) $('#photog-hint')?.remove();

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

// Eventos y fotógrafos que sigue el usuario + estado de las notificaciones en este dispositivo.
async function drawFollows(u) {
  const { myFollows, toggleFollow } = await import('./follows.js');
  const { pushAvailable, pushOn, enablePush, isIos, isStandalone } = await import('./push.js');
  const f = await myFollows();
  const [evs, phs] = await Promise.all([
    Promise.all([...f.events].map(id => getDoc(doc(db, 'events', id)).then(s => (s.exists() ? { id, ...s.data() } : null)).catch(() => null))),
    Promise.all([...f.photographers].map(id => getDoc(doc(db, 'users', id)).then(s => (s.exists() ? { id, ...s.data() } : null)).catch(() => null))),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const box = $('#follows');
  if (!box) return;
  const canPush = await pushAvailable();
  const pushHtml = pushOn() ? '<p class="muted small">✅ Las notificaciones están activadas en este dispositivo.</p>'
    : canPush ? '<div class="notice row" style="justify-content:space-between"><span>Activá las notificaciones para enterarte al instante.</span><button class="btn sm primary" id="push-on">Activar</button></div>'
    : isIos() && !isStandalone() ? '<div class="notice small">En iPhone, para recibir los avisos agregá el sitio a tu pantalla de inicio (Compartir → Agregar a inicio) y abrilo desde ese ícono.</div>' : '';
  const list = [
    ...evs.filter(Boolean).sort((a, b) => (a.date || '').localeCompare(b.date || '')).map(ev => `
      <div class="card row" style="justify-content:space-between;margin-bottom:8px">
        <a href="#/evento/${ev.id}" style="flex:1;min-width:0;text-decoration:none"><strong>${esc(ev.name)}</strong><br>
          <span class="muted small">${ev.date > today ? `📅 Es el ${esc(new Date(ev.date + 'T12:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }))}` : '📷 Ver fotos'}</span></a>
        <button class="btn sm ghost" data-unf-e="${ev.id}">Quitar</button></div>`),
    ...phs.filter(Boolean).map(p => `
      <div class="card row" style="justify-content:space-between;margin-bottom:8px">
        <a href="#/f/${esc(p.slug)}" style="flex:1;min-width:0;text-decoration:none"><strong>📸 ${esc(p.displayName)}</strong><br><span class="muted small">Te avisamos cuando suba fotos nuevas</span></a>
        <button class="btn sm ghost" data-unf-p="${p.id}">Dejar de seguir</button></div>`),
  ];
  box.innerHTML = list.length ? pushHtml + list.join('')
    : '<div class="card"><p class="muted" style="margin:0">Todavía no seguís eventos ni fotógrafos. En cada evento tocá <strong>🔔 Avisarme</strong> y te avisamos cuando suban las fotos. <a href="#/calendario">Ver el calendario</a></p></div>';
  $('#push-on')?.addEventListener('click', async () => { try { await enablePush(u.uid); toast('🔔 Notificaciones activadas'); drawFollows(u); } catch (e) { toast(errMsg(e), 'error'); } });
  box.querySelectorAll('[data-unf-e]').forEach(b => b.onclick = async () => { await toggleFollow('events', b.dataset.unfE); drawFollows(u); });
  box.querySelectorAll('[data-unf-p]').forEach(b => b.onclick = async () => { await toggleFollow('photographers', b.dataset.unfP); drawFollows(u); });
}
