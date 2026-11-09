// Cuenta del comprador en el sitio público: ingresar (Google / email), Mis compras, salir.
// Se puede comprar sin cuenta: al pagar se crea un "invitado" (usuario anónimo de Firebase) y después de pagar se le ofrece
// guardar la compra en una cuenta (se vincula: mismo usuario, mismas compras). Si no lo hace, el Worker le crea la cuenta
// con el email que usó en Mercado Pago (guests.js). Al registrarse se pide el WhatsApp (customers/{uid}.whatsapp).
import {
  db, auth, collection, doc, getDoc, getDocs, setDoc, query, where, orderBy, limit, serverTimestamp, Timestamp,
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile,
  signInWithCustomToken, signInAnonymously, linkWithPopup, linkWithCredential, EmailAuthProvider, signInWithCredential,
} from './fb.js';
import { API_BASE, apiPost } from './api.js';
import { $, esc, fmtMoney, fmtTs, toast, errMsg, initials, inAppNotice, bindInAppNotice, waNumber } from './util.js';

let current = null; // cuenta real (Google o email)
let guest = null;   // invitado (compró sin cuenta en este dispositivo)
const waiters = [];

let isPhotographer = false; // la cuenta tiene perfil de fotógrafo (o es superadmin)

onAuthStateChanged(auth, user => applyUser(user));

async function applyUser(user) {
  current = user && !user.isAnonymous ? user : null;
  guest = user && user.isAnonymous ? user : null;
  isPhotographer = false;
  if (current) {
    try {
      const snap = await getDoc(doc(db, 'users', current.uid));
      isPhotographer = snap.exists() && ['photographer', 'superadmin'].includes(snap.data().role);
    } catch { /* sin perfil */ }
  }
  drawHeader();
  if (current) { recordCustomer(current); if (!isPhotographer) ensureWhatsapp(current); }
  if (current) waiters.splice(0).forEach(fn => fn(current));
  window.dispatchEvent(new CustomEvent('account:change', { detail: { user: current } }));
}

export const currentUser = () => current;
export const guestUser = () => guest;

// Para pagar: la cuenta si ingresó; si no, el invitado de este dispositivo (se crea en el momento).
export async function buyerSession() {
  if (current) return current;
  if (auth.currentUser) return auth.currentUser;
  return (await signInAnonymously(auth)).user;
}

// Registro de clientes (customers/{uid}): alta y último ingreso, una vez por sesión del navegador.
function recordCustomer(user, force = false) {
  const k = `qmf.cust.${user.uid}`;
  try { if (!force && sessionStorage.getItem(k)) return; sessionStorage.setItem(k, '1'); } catch { /* modo privado */ }
  const created = Date.parse(user.metadata?.creationTime || '') || Date.now();
  setDoc(doc(db, 'customers', user.uid), {
    name: user.displayName || '', email: user.email || '', ...(user.phoneNumber ? { phone: user.phoneNumber } : {}),
    provider: user.providerData?.[0]?.providerId || 'password',
    createdAt: Timestamp.fromMillis(created), lastLoginAt: serverTimestamp(),
  }, { merge: true }).catch(e => console.warn('customer', e));
}

// WhatsApp obligatorio para los compradores con cuenta: si no lo tiene, se le pide (una vez por sesión si lo cierra).
async function saveWhatsapp(user, raw) {
  const d = waNumber(raw);
  if (d.length < 12) throw new Error('Escribí tu WhatsApp con código de área (ej: 342 555-1234).');
  await setDoc(doc(db, 'customers', user.uid), { whatsapp: d, email: user.email || '', lastLoginAt: serverTimestamp() }, { merge: true });
}
async function ensureWhatsapp(user) {
  try { if (sessionStorage.getItem(`qmf.wa.${user.uid}`)) return; } catch { /* nada */ }
  const s = await getDoc(doc(db, 'customers', user.uid)).catch(() => null);
  if (s?.data()?.whatsapp || current?.uid !== user.uid) return;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `<div class="dlg-head"><h2>📱 Tu WhatsApp</h2><button class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <form class="dlg-body stack" id="wa-f">
      <p class="muted" style="margin:0">Lo usamos para ayudarte si tenés algún problema con tu compra o con la descarga de tus fotos.</p>
      <label class="field">WhatsApp<input type="tel" id="wa-in" inputmode="tel" autocomplete="tel" required placeholder="Ej: 342 555-1234"></label>
      <button class="btn primary block" type="submit">Guardar</button>
    </form>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => { try { sessionStorage.setItem(`qmf.wa.${user.uid}`, '1'); } catch { /* nada */ } dlg.remove(); });
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  $('#wa-f', dlg).onsubmit = async e => {
    e.preventDefault();
    try { await saveWhatsapp(user, $('#wa-in', dlg).value); dlg.close(); toast('¡Gracias!'); } catch (err) { toast(errMsg(err), 'error'); }
  };
  dlg.showModal();
}

function drawHeader() {
  const el = document.getElementById('acct');
  if (!el) return;
  // Los fotógrafos van directo a su panel; "Mi cuenta" (compras) es para clientes.
  document.getElementById('soy-fotografo')?.classList.toggle('hidden', isPhotographer);
  const avatar = current ? `<span class="avatar xs">${current.photoURL ? `<img src="${esc(current.photoURL)}" alt="" referrerpolicy="no-referrer">` : esc(initials(current.displayName || current.email || '?'))}</span>` : '';
  el.innerHTML = current && isPhotographer
    ? `<a class="btn sm acct-btn" href="panel.html" aria-label="Mi panel">${avatar}<span class="acct-label">Mi panel</span></a>`
    : current
    ? `<a class="btn sm acct-btn" href="#/cuenta" aria-label="Mi cuenta">${avatar}<span class="acct-label">Mi cuenta</span></a>`
    : '<button class="btn sm acct-btn" id="acct-login"><span class="acct-label">Ingresar</span><span class="acct-icon" aria-hidden="true">👤</span></button>';
  $('#acct-login')?.addEventListener('click', () => openLogin());
}

// Devuelve el usuario logueado o abre el login y espera.
export function requireLogin(reason) {
  if (current) return Promise.resolve(current);
  return new Promise(resolve => { waiters.push(resolve); openLogin(reason); });
}

// Después de ingresar desde un invitado: sus compras pasan a la cuenta (si se vinculó, ya están; solo se marca).
async function afterLogin(anonToken) {
  await auth.currentUser?.getIdToken(true).catch(() => {}); // al vincular, el token tiene que dejar de ser de invitado
  await applyUser(auth.currentUser);
  if (anonToken !== undefined) await apiPost('/orders/claim', anonToken ? { anonToken } : {}).catch(e => console.warn('claim', e));
  window.dispatchEvent(new CustomEvent('account:change', { detail: { user: current } }));
}

// opts: { mode: 'login' | 'signup', email }
export function openLogin(reason = '', opts = {}) {
  document.querySelector('dialog.login')?.close();
  let mode = opts.mode || 'login';
  const dlg = document.createElement('dialog');
  dlg.className = 'login';
  dlg.innerHTML = `
    <div class="dlg-head"><h2 id="l-title">Ingresar</h2><button class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <div class="dlg-body">
      ${reason ? `<p class="muted" style="margin:0">${esc(reason)}</p>` : ''}
      ${inAppNotice()}
      <button class="btn block" id="l-google">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
        Continuar con Google
      </button>
      <div class="divider">o con email</div>
      <form id="l-form" class="stack">
        <label class="field hidden" id="l-name-f">Nombre<input type="text" id="l-name" autocomplete="name"></label>
        <label class="field">Email<input type="email" id="l-mail" required autocomplete="email" value="${esc(opts.email || '')}"></label>
        <label class="field">Contraseña<input type="password" id="l-pass" required minlength="6" autocomplete="current-password"></label>
        <label class="field hidden" id="l-wa-f">WhatsApp<input type="tel" id="l-wa" inputmode="tel" autocomplete="tel" placeholder="Ej: 342 555-1234"><span class="hint">Por si tenés algún problema con tu compra.</span></label>
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
  bindInAppNotice(dlg);

  const done = () => { dlg.close(); toast('¡Listo! Ya ingresaste.'); };
  // Si es un invitado, el token del invitado: para pasar sus compras a la cuenta con la que ingrese.
  const anonTok = async () => (guest ? guest.getIdToken().catch(() => '') : undefined);
  $('#l-google', dlg).onclick = async () => {
    const tok = await anonTok();
    try {
      const provider = new GoogleAuthProvider();
      if (guest) {
        try { await linkWithPopup(guest, provider); return afterLogin('').then(done); } catch (e) {
          if (e.code !== 'auth/credential-already-in-use') throw e;
          await signInWithCredential(auth, GoogleAuthProvider.credentialFromError(e)); // ya tenía cuenta con ese Google
        }
      } else await signInWithPopup(auth, provider);
      await afterLogin(tok); done();
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  const setMode = m => {
    mode = m;
    const su = mode === 'signup';
    $('#l-title', dlg).textContent = su ? 'Crear cuenta' : 'Ingresar';
    $('#l-submit', dlg).textContent = su ? 'Crear cuenta' : 'Ingresar';
    $('#l-toggle', dlg).textContent = su ? 'Ya tengo cuenta' : 'Crear cuenta';
    $('#l-name-f', dlg).classList.toggle('hidden', !su);
    $('#l-wa-f', dlg).classList.toggle('hidden', !su);
    $('#l-wa', dlg).required = su;
    $('#l-pass', dlg).autocomplete = su ? 'new-password' : 'current-password';
  };
  setMode(mode);
  $('#l-toggle', dlg).onclick = () => setMode(mode === 'login' ? 'signup' : 'login');
  $('#l-form', dlg).onsubmit = async e => {
    e.preventDefault();
    const email = $('#l-mail', dlg).value.trim(), pass = $('#l-pass', dlg).value;
    const tok = await anonTok();
    try {
      if (mode === 'login') {
        try { await signInWithEmailAndPassword(auth, email, pass); }
        catch (err) {
          // Firebase no dice si el mail no existe o la contraseña está mal: se ofrece crear la cuenta y, si el mail ya
          // existía, se avisa que la contraseña no es correcta.
          if (!['auth/invalid-credential', 'auth/user-not-found', 'auth/invalid-login-credentials'].includes(err.code)) throw err;
          if (pass.length < 6) throw new Error('La contraseña tiene que tener al menos 6 caracteres.');
          if (!confirm(`No encontramos una cuenta con ${email} y esa contraseña.\n\n¿Querés crear una cuenta nueva con estos datos?`)) return;
          try { guest ? await linkWithCredential(guest, EmailAuthProvider.credential(email, pass)) : await createUserWithEmailAndPassword(auth, email, pass); }
          catch (e2) {
            if (e2.code === 'auth/email-already-in-use' || e2.code === 'auth/credential-already-in-use') throw new Error('Ya existe una cuenta con ese mail, pero la contraseña no es correcta. Tocá "Olvidé mi contraseña" para crear una nueva.');
            throw e2;
          }
          recordCustomer(auth.currentUser, true);
          await afterLogin(guest ? '' : undefined); // pide el WhatsApp al entrar (ensureWhatsapp)
          return done();
        }
        await afterLogin(tok);
      }
      else {
        if (waNumber($('#l-wa', dlg).value).length < 12) throw new Error('Escribí tu WhatsApp con código de área (ej: 342 555-1234).');
        // Invitado: se vincula (mismo usuario, mismas compras). Si no, cuenta nueva.
        const cred = guest ? await linkWithCredential(guest, EmailAuthProvider.credential(email, pass)) : await createUserWithEmailAndPassword(auth, email, pass);
        const name = $('#l-name', dlg).value.trim();
        if (name) await updateProfile(cred.user, { displayName: name }).catch(() => {});
        await saveWhatsapp(cred.user, $('#l-wa', dlg).value).catch(() => {});
        recordCustomer(cred.user, true);
        await afterLogin(guest ? '' : undefined);
      }
      done();
    } catch (err) {
      toast(err.code === 'auth/email-already-in-use' || err.code === 'auth/credential-already-in-use'
        ? 'Ya hay una cuenta con ese email: tocá "Ya tengo cuenta" e ingresá con tu contraseña.' : errMsg(err), 'error');
    }
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
  pending: ['Pago pendiente', 'warn'], approved: ['Pagado', 'ok'], rejected: ['Pago rechazado', 'danger'], refunded: ['Reembolsado', ''], expired: ['Transferencia vencida', 'danger'],
};

export async function renderAccount(app) {
  document.title = 'Mi cuenta · Quiero Mis Fotos';
  if (!current && !guest) {
    app.innerHTML = `<div class="empty"><h2>Ingresá a tu cuenta</h2><p>Para ver tus compras y descargar tus fotos.</p><button class="btn primary" id="go-login">Ingresar</button></div>`;
    $('#go-login').onclick = () => openLogin();
    return;
  }
  const u = current || guest;
  // Invitado: sus compras de este dispositivo + guardar la cuenta.
  if (!current) {
    app.innerHTML = `${guestSaveHtml()}<h2>Compras en este dispositivo</h2><div id="orders"><div class="spinner"></div></div>`;
    bindGuestSave(app);
  } else app.innerHTML = `
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
    <div id="myface"></div>
    <p class="muted small" style="margin-top:24px" id="photog-hint">¿Sos fotógrafo? <a href="#/soy-fotografo">Mirá cómo vender tus fotos</a>.</p>`;
  if (current) {
    $('#logout').onclick = async () => { await signOut(auth); location.hash = '#/'; };
    drawFollows(u).catch(() => { $('#follows').innerHTML = ''; });
    drawMyFace().catch(() => {});
    // Un fotógrafo que entra a "Mis compras" no ve la invitación a vender.
    if (isPhotographer) $('#photog-hint')?.remove();
  }

  try {
    const snap = await getDocs(query(collection(db, 'orders'), where('buyerUid', '==', u.uid), orderBy('createdAt', 'desc'), limit(100)));
    const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    $('#orders').innerHTML = orders.length ? orders.map(o => {
      // Pendiente hace más de un día: el pago no se hizo (se puede reintentar desde el pedido).
      const stale = o.status === 'pending' && Date.now() - (o.createdAt?.toMillis?.() || 0) > 86400_000;
      const [label, cls] = stale ? ['Sin pagar', ''] : STATUS[o.status] || [o.status, ''];
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

// Cara guardada para los avisos de "aparecés en fotos nuevas" (se guarda desde la búsqueda por selfie).
async function drawMyFace() {
  const { apiGet, apiPost } = await import('./api.js');
  const r = await apiGet('/faces/me');
  const box = $('#myface');
  if (!box || !r.saved) return;
  box.innerHTML = `<div class="card row" style="justify-content:space-between;margin-top:8px"><span style="flex:1;min-width:0"><strong>🤳 Aviso por mi cara</strong><br><span class="muted small">Te avisamos cuando aparezcas en fotos nuevas. Guardamos solo la huella numérica de tu cara, nunca la selfie.</span></span><button class="btn sm ghost" id="face-del">Borrar mi cara</button></div>`;
  $('#face-del').onclick = async () => {
    if (!confirm('¿Borrar la huella de tu cara? Ya no te vamos a avisar cuando aparezcas en fotos nuevas.')) return;
    try { await apiPost('/faces/me/delete'); box.innerHTML = ''; toast('Listo, borramos la huella de tu cara.'); } catch (e) { toast(errMsg(e), 'error'); }
  };
}

// Link de acceso que manda el superadmin cuando no llega el SMS (#/acceso/{t}): entra a la cuenta de ese celular.
export async function useAccessLink(app, t) {
  app.innerHTML = '<div class="empty"><div class="spinner"></div><p class="muted">Entrando a tu cuenta…</p></div>';
  try {
    const res = await fetch(`${API_BASE}/auth/link`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || 'No se pudo entrar con este link.');
    await signInWithCustomToken(auth, d.token);
    toast('¡Listo! Ya ingresaste.');
    location.replace('#/cuenta');
  } catch (e) {
    app.innerHTML = `<div class="empty"><h2>No pudimos entrar</h2><p class="muted">${esc(errMsg(e))}</p><a class="btn primary" href="https://wa.me/5493424856528" target="_blank" rel="noopener">Escribinos por WhatsApp</a></div>`;
  }
}

// Aviso para el invitado: guardar la compra en una cuenta (Google o email con el que pagó en Mercado Pago).
export function guestSaveHtml(email = '') {
  return `<div class="notice warn stack guest-save" style="margin-bottom:16px">
    <strong>⚠️ Guardá tus fotos en una cuenta</strong>
    <span>Compraste sin cuenta: si salís de esta página o cambiás de celular, <strong>no vas a poder volver a descargarlas</strong>. Guardalas ahora, es un paso:</span>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <button class="btn primary" data-gs="google">Continuar con Google</button>
      <button class="btn" data-gs="email" data-email="${esc(email)}">Crear cuenta con mi email</button>
    </div>
  </div>`;
}
export function bindGuestSave(root) {
  root.querySelector('[data-gs="google"]')?.addEventListener('click', () => openLogin('Guardá tu compra en tu cuenta de Google.'));
  root.querySelector('[data-gs="email"]')?.addEventListener('click', e => openLogin('Elegí una contraseña para guardar tu compra.', { mode: 'signup', email: e.currentTarget.dataset.email }));
}
