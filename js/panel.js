// Panel de fotógrafos y superadmin (secciones según rol).
import {
  db, auth, SUPERADMIN_EMAIL,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch,
  query, where, orderBy, limit, serverTimestamp, arrayUnion, arrayRemove, Timestamp,
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, signOut, updateProfile,
} from './fb.js';
import {
  $, $$, esc, inAppNotice, bindInAppNotice, slugify, SLUG_RE, searchTokens, fmtMoney, fmtDate, fmtTs, todayIso, parseHash,
  toast, errMsg, avatarHtml, coverHtml, SOCIALS, newId, normalize, fmtBytes, setBytes,
} from './util.js';
import { initTheme } from './theme.js';
import { loadTaxonomy, loadSettings, DEFAULT_SETTINGS, INITIAL_TAG_TYPES, ACTIVITY_TYPE, USER_TAG_TYPES, tagPills, SERVICES, isPro, mpPlanOf, GEAR_TYPES, PLANS, planOf, siteUrlOf, setUntil, setDeleteAt, GRACE_DAYS, albumPhotoLimit, feePercentFor, isFreePlan, setActive, planSpec, rulesFor, bibsOn } from './data.js';
import { viewWeb } from './panel-web.js';
import { sellerNet } from './pricing.js';
import { viewPortfolio } from './panel-portfolio.js';
import { drawWatermark, drawSampleScene, DEFAULT_WATERMARK, wantsLogo } from './watermark.js';
import { uploadAsset, apiPost } from './api.js';
import { resizeToJpeg } from './image-proc.js';
import { mountPhotos, uploadsInProgress } from './panel-photos.js';
import { initRefresh } from './refresh.js';
import { pushAvailable, pushOn, pushBlocked, enablePush, disablePush, isIos, isStandalone, listenForeground } from './push.js';
import { shareLink, eventUrl } from './share.js';

const root = $('#root');
const S = { user: null, profile: null, isSuper: false, settings: { ...DEFAULT_SETTINGS }, tax: null };

const isApproved = () => S.profile?.status === 'approved';
// Comisión de la plataforma para este fotógrafo (según su plan).
const myFee = () => feePercentFor(S.profile, S.settings);
// Condiciones que rigen hoy para este fotógrafo (comisión, portfolio, espacio, días, nivel de estadísticas…).
const myRules = () => rulesFor(S.profile, S.settings);

initRefresh({ busy: uploadsInProgress });
initTheme();

// Instalar el panel como app (Android/Chrome avisa con beforeinstallprompt; en iPhone se explica a mano).
let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; document.querySelector('#install-card')?.classList.remove('hidden'); });
function installCardHtml() {
  let dismissed = false;
  try { dismissed = localStorage.getItem('qmf-install-off') === '1'; } catch { /* nada */ }
  if (isStandalone() || dismissed || !matchMedia('(pointer: coarse)').matches) return '';
  const ios = isIos();
  return `<div class="card stack install-card ${ios || installEvt ? '' : 'hidden'}" id="install-card">
    <h2 style="margin:0">📲 Tené el panel como una app</h2>
    <p class="muted small" style="margin:0">${ios
      ? 'En Safari tocá <strong>Compartir</strong> (el cuadrado con la flecha) y después <strong>Agregar a inicio</strong>. Se abre a pantalla completa, como una app.'
      : 'Queda un ícono en tu pantalla de inicio y se abre a pantalla completa, como una app.'}</p>
    <div class="row">${ios ? '' : '<button class="btn primary" id="install-go">Instalar</button>'}<button class="btn" id="install-off">Ahora no</button></div>
  </div>`;
}
function bindInstallCard() {
  $('#install-go')?.addEventListener('click', async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => null);
    installEvt = null;
    $('#install-card')?.remove();
  });
  $('#install-off')?.addEventListener('click', () => { try { localStorage.setItem('qmf-install-off', '1'); } catch { /* nada */ } $('#install-card')?.remove(); });
}
listenForeground();

// ================================================================ auth
onAuthStateChanged(auth, async user => {
  S.user = user;
  $('#logout').style.display = user ? '' : 'none';
  if (!user) $('#public-profile').style.display = 'none';
  $('#who').textContent = user ? (user.displayName || user.email) : '';
  if (!user) { S.profile = null; return renderLogin(); }
  S.isSuper = user.email === SUPERADMIN_EMAIL && user.emailVerified;
  root.innerHTML = '<div class="spinner"></div>';
  try {
    const snap = await getDoc(doc(db, 'users', user.uid));
    S.profile = snap.exists() ? snap.data() : null;
    S.settings = await loadSettings();
    if (S.isSuper) await seedPlatform();
    S.tax = await loadTaxonomy(true);
  } catch (e) {
    root.innerHTML = `<div class="container"><div class="notice danger">${esc(errMsg(e))}</div></div>`;
    return;
  }
  if (!S.profile) return renderOnboarding();
  updateRolePill();
  renderShell();
});

$('#logout').addEventListener('click', () => signOut(auth));

// Botón del header "Ver mi perfil público" (solo si el perfil está publicado).
function updatePublicProfileBtn() {
  const a = $('#public-profile');
  const ok = S.profile?.slug && (S.profile.status === 'approved');
  a.style.display = ok ? '' : 'none';
  if (ok) a.href = `index.html#/f/${encodeURIComponent(S.profile.slug)}`;
}

function updateRolePill() {
  updatePublicProfileBtn();
  const p = $('#role-pill');
  const st = S.profile?.status;
  if (S.isSuper) { p.textContent = 'Superadmin'; p.className = 'pill accent'; }
  else if (st === 'approved') { p.textContent = 'Fotógrafo'; p.className = 'pill ok'; }
  else if (st === 'pending') { p.textContent = 'Pendiente'; p.className = 'pill warn'; }
  else { p.textContent = 'Suspendido'; p.className = 'pill danger'; }
  p.style.display = '';
}

function renderLogin() {
  $('#role-pill').style.display = 'none';
  let mode = 'login';
  root.innerHTML = `
    <div class="container"><div class="auth-box card">
      <h1 id="a-title">Ingresar</h1>
      <p class="muted" id="a-sub">Panel para fotógrafos de Quiero Mis Fotos.</p>
      <div class="stack">
        ${inAppNotice()}
        <button class="btn block" id="g-login">
          <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>
          Continuar con Google
        </button>
        <div class="divider">o con email</div>
        <form id="e-form" class="stack">
          <label class="field">Email<input type="email" id="e-mail" required autocomplete="email"></label>
          <label class="field">Contraseña<input type="password" id="e-pass" required minlength="6" autocomplete="current-password"></label>
          <button class="btn primary block" type="submit" id="e-submit">Ingresar</button>
        </form>
        <div class="row" style="justify-content:space-between">
          <button class="btn ghost sm" id="toggle-mode">Crear cuenta nueva</button>
          <button class="btn ghost sm" id="reset">Olvidé mi contraseña</button>
        </div>
      </div>
    </div></div>`;

  bindInAppNotice();
  $('#g-login').onclick = async () => {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { toast(errMsg(e), 'error'); }
  };
  $('#toggle-mode').onclick = () => {
    mode = mode === 'login' ? 'signup' : 'login';
    $('#a-title').textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    $('#a-sub').textContent = mode === 'login' ? 'Panel para fotógrafos de Quiero Mis Fotos.' : 'Registrate como fotógrafo. Un administrador aprueba tu cuenta.';
    $('#e-submit').textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    $('#toggle-mode').textContent = mode === 'login' ? 'Crear cuenta nueva' : 'Ya tengo cuenta';
    $('#e-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  };
  $('#e-form').onsubmit = async e => {
    e.preventDefault();
    const email = $('#e-mail').value.trim(), pass = $('#e-pass').value;
    try {
      if (mode === 'login') await signInWithEmailAndPassword(auth, email, pass);
      else await createUserWithEmailAndPassword(auth, email, pass);
    } catch (err) { toast(errMsg(err), 'error'); }
  };
  $('#reset').onclick = async () => {
    const email = $('#e-mail').value.trim();
    if (!email) return toast('Escribí tu email arriba y volvé a tocar.', 'error');
    try { await sendPasswordResetEmail(auth, email); toast('Te mandamos un mail para restablecer la contraseña.'); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
}

// ================================================================ alta
function renderOnboarding() {
  const u = S.user;
  const name = u.displayName || '';
  root.innerHTML = `
    <div class="container"><div class="auth-box card" style="max-width:520px">
      <h1>${S.isSuper ? 'Configurá tu perfil' : 'Registro de fotógrafo'}</h1>
      <p class="muted">${S.isSuper ? 'Sos el superadmin de la plataforma.' : 'Completá tus datos. Después un administrador revisa y aprueba tu cuenta.'}</p>
      <form id="ob" class="stack">
        <label class="field">Nombre público<input type="text" id="ob-name" required maxlength="60" value="${esc(name)}" placeholder="Ej: Juan Pérez Fotografía"></label>
        <label class="field">Dirección de tu perfil
          <input type="text" id="ob-slug" required maxlength="40" value="${esc(slugify(name))}">
          <span class="hint" id="ob-slug-hint">quieromisfotos/#/f/<strong>${esc(slugify(name) || '...')}</strong></span>
        </label>
        <label class="field">Zona<input type="text" id="ob-zone" maxlength="60" placeholder="Ej: Rosario, Santa Fe"></label>
        <button class="btn primary" type="submit">Crear perfil</button>
      </form>
    </div></div>`;
  let slugTouched = false;
  $('#ob-name').oninput = e => { if (!slugTouched) { $('#ob-slug').value = slugify(e.target.value); slugHint(); } };
  $('#ob-slug').oninput = () => { slugTouched = true; slugHint(); };
  const slugHint = () => { $('#ob-slug-hint strong').textContent = $('#ob-slug').value || '...'; };

  $('#ob').onsubmit = async e => {
    e.preventDefault();
    const displayName = $('#ob-name').value.trim();
    const slug = slugify($('#ob-slug').value);
    if (!SLUG_RE.test(slug)) return toast('La dirección debe tener entre 3 y 40 letras, números o guiones.', 'error');
    try {
      const taken = await getDoc(doc(db, 'slugs', slug));
      if (taken.exists() && taken.data().uid !== u.uid) return toast('Esa dirección ya está en uso. Probá otra.', 'error');
      const profile = {
        role: S.isSuper ? 'superadmin' : 'photographer',
        status: S.isSuper ? 'approved' : 'pending',
        displayName, slug, zone: $('#ob-zone').value.trim(),
        avatarUrl: u.photoURL || '', bio: '', socials: {},
        mpConnected: false, mpUserId: null,
        defaults: { price: 0, packs: [], feeMode: 'absorb' },
        watermark: { ...DEFAULT_WATERMARK },
        createdAt: serverTimestamp(),
      };
      const b = writeBatch(db);
      if (!taken.exists()) b.set(doc(db, 'slugs', slug), { uid: u.uid });
      b.set(doc(db, 'users', u.uid), profile);
      b.set(doc(db, 'userPrivate', u.uid), { email: u.email || '', createdAt: serverTimestamp() });
      await b.commit();
      if (!u.displayName) updateProfile(u, { displayName }).catch(() => {});
      S.profile = (await getDoc(doc(db, 'users', u.uid))).data();
      updateRolePill();
      location.hash = S.isSuper ? '#/admin/fotografos' : '#/inicio';
      renderShell();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// Primer ingreso del superadmin: settings por defecto + tipos de etiqueta iniciales.
async function seedPlatform() {
  const ps = await getDoc(doc(db, 'settings', 'platform'));
  if (!ps.exists()) await setDoc(doc(db, 'settings', 'platform'), { ...DEFAULT_SETTINGS, updatedAt: serverTimestamp() });
  const tt = await getDocs(query(collection(db, 'tagTypes'), limit(1)));
  if (tt.empty) {
    const b = writeBatch(db);
    // Ids fijos: si esto corre dos veces en paralelo no se duplican los tipos.
    INITIAL_TAG_TYPES.forEach((t, i) => b.set(doc(db, 'tagTypes', t.id), { name: t.name, order: i }));
    await b.commit();
    await rebuildTaxonomy();
  }
}

// ================================================================ shell + router
function navItems() {
  if (S.isSuper) return [
    { group: 'Administración' },
    { href: '#/admin/metricas', label: '📊 Métricas' },
    { href: '#/admin/fotografos', label: '👥 Fotógrafos' },
    { href: '#/admin/clientes', label: '👤 Clientes' },
    { href: '#/admin/eventos', label: '🏟️ Eventos' },
    { href: '#/admin/etiquetas', label: '🏷️ Etiquetas' },
    { href: '#/admin/almacenamiento', label: '💾 Almacenamiento' },
    { href: '#/admin/config', label: '⚙️ Plataforma' },
    { group: 'Mi cuenta' },
    { href: '#/perfil', label: '👤 Perfil' },
    { href: 'index.html#/cuenta', label: '🛒 Mis compras', external: true },
  ];
  return [
    { href: '#/inicio', label: '🏠 Inicio' },
    { href: '#/eventos', label: '🏟️ Mis eventos', need: true },
    { href: '#/ventas', label: '💰 Ventas', need: true },
    { href: '#/portfolio', label: '🖼️ Portfolio' },
    { href: '#/web', label: '⭐ Planes y mi web' },
    { group: 'Cuenta' },
    { href: '#/perfil', label: '👤 Perfil' },
    ...(isApproved() && S.profile.slug ? [{ href: `index.html#/f/${encodeURIComponent(S.profile.slug)}`, label: '👁️ Mi perfil público', external: true, blank: true, mobileOnly: true }] : []),
    { href: '#/config', label: '⚙️ Precios y marca' },
    { href: '#/mp', label: '💳 Mercado Pago' },
    { href: 'index.html#/cuenta', label: '🛒 Mis compras', external: true },
  ];
}

// WhatsApp de ayuda del panel: llega con el nombre y el plan del fotógrafo; Premium, marcado como prioritario.
function updateSupportLink() {
  const fab = document.querySelector('.wa-fab');
  if (!fab || !S.profile) return;
  const r = myRules();
  const label = PLANS[r.plan]?.label || 'Gratis';
  const msg = `${r.priority ? '⭐ ATENCIÓN PRIORITARIA · ' : ''}Hola! Soy ${S.profile.displayName || ''} (fotógrafo, plan ${label}). Les escribo por: `;
  const url = `https://wa.me/5493424856528?text=${encodeURIComponent(msg)}`;
  fab.href = url;
  document.querySelectorAll('.foot-help a').forEach(a => { a.href = url; });
  if (r.priority) fab.querySelector('.wa-tip').innerHTML = '⭐ Tenés atención prioritaria<b>Escribinos por WhatsApp</b>';
}

function renderShell() {
  updateSupportLink();
  if (S.profile.status === 'suspended' && !S.isSuper) {
    root.innerHTML = `<div class="container"><div class="auth-box card"><h1>Cuenta suspendida</h1><p class="muted">Tu cuenta de fotógrafo está suspendida. Si creés que es un error, contactá al administrador.</p></div></div>`;
    return;
  }
  root.innerHTML = `${S.isSuper ? '<div id="alerts" class="alerts-bar"></div>' : ''}<div class="panel ${S.isSuper ? '' : 'has-tabs'}"><nav class="sidenav" id="nav"></nav><main id="view"></main></div>
    ${S.isSuper ? '' : '<nav class="tabbar" id="tabbar" aria-label="Secciones"></nav>'}`;
  document.body.classList.toggle('with-tabbar', !S.isSuper);
  window.onhashchange = route;
  route();
  if (S.isSuper) drawAlerts();
}

// Superadmin: alertas del Worker (pagos que no se pudieron registrar, cobros duplicados).
async function drawAlerts() {
  const box = $('#alerts');
  if (!box) return;
  const snap = await getDocs(query(collection(db, 'alerts'), orderBy('createdAt', 'desc'), limit(20))).catch(() => null);
  const list = (snap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
  box.innerHTML = list.length ? `<div class="notice danger stack" style="max-width:1200px;margin:12px auto 0">
    <strong>⚠️ ${list.length} alerta${list.length > 1 ? 's' : ''} para revisar</strong>
    ${list.map(a => `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px"><span class="small">${esc(fmtTs(a.createdAt))} · ${esc(a.text)}</span><button class="btn sm" data-alert="${esc(a.id)}">Resuelta</button></div>`).join('')}
  </div>` : '';
  $$('[data-alert]', box).forEach(b => b.onclick = async () => {
    try { await deleteDoc(doc(db, 'alerts', b.dataset.alert)); drawAlerts(); } catch (e) { toast(errMsg(e), 'error'); }
  });
}

function route() {
  // Al cambiar de pantalla se cierran los diálogos abiertos.
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
  const { parts } = parseHash();
  let key = parts.join('/');
  if (!key) key = S.isSuper ? 'admin/fotografos' : 'inicio';
  const nav = $('#nav');
  if (!nav) return;
  nav.innerHTML = navItems().map(i => i.group
    ? `<div class="group">${i.group}</div>`
    : (i.need && !isApproved()) ? '' : `<a href="${i.href}" class="${!i.external && ('#/' + key).startsWith(i.href) ? 'on' : ''} ${i.mobileOnly ? 'mobile-only' : ''}" ${i.blank ? 'target="_blank"' : ''}>${i.label}</a>`).join('');
  drawTabbar(key);
  const view = $('#view');
  view.innerHTML = '<div class="spinner"></div>';
  const [a, b] = parts;
  const run = (fn) => Promise.resolve(fn()).catch(e => { console.error(e); view.innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`; });

  if (S.isSuper && a === 'admin') {
    if (b === 'eventos') return run(viewAdminEvents);
    if (b === 'etiquetas') return run(viewAdminTags);
    if (b === 'config') return run(viewAdminConfig);
    if (b === 'almacenamiento') return run(viewAdminStorage);
    if (b === 'metricas') return run(viewAdminMetrics);
    if (b === 'clientes') return run(viewAdminCustomers);
    return run(viewAdminPhotographers);
  }
  if (a === 'perfil') return run(viewProfile);
  if (a === 'config' && !S.isSuper) return run(viewConfig);
  if (a === 'mp' && !S.isSuper) return run(viewMp);
  if (a === 'evento' && b && (isApproved() || S.isSuper)) return run(() => viewEvent(b));
  if (a === 'eventos' && isApproved() && !S.isSuper) return run(viewMyEvents);
  if (a === 'ventas' && isApproved()) return run(viewSales);
  if (a === 'web' && !S.isSuper) return run(() => viewWeb($('#view'), { uid: S.user.uid, profile: S.profile, settings: S.settings }));
  if (a === 'portfolio' && !S.isSuper) return run(() => viewPortfolio($('#view'), { uid: S.user.uid, profile: S.profile, settings: S.settings }));
  if (S.isSuper) return run(viewAdminPhotographers);
  return run(viewHome);
}

// Celular: barra de pestañas abajo (lo más usado) + "Más" abre el resto del menú.
function drawTabbar(key) {
  const bar = $('#tabbar');
  if (!bar) return;
  const nav = $('#nav');
  nav.classList.remove('open');
  const tabs = [
    { href: '#/inicio', icon: '🏠', label: 'Inicio' },
    ...(isApproved() ? [{ href: '#/eventos', icon: '🏟️', label: 'Eventos', also: '#/evento/' }, { href: '#/ventas', icon: '💰', label: 'Ventas' }] : []),
    { href: '#/perfil', icon: '👤', label: 'Perfil' },
  ];
  const cur = '#/' + key;
  const inTabs = tabs.some(t => cur.startsWith(t.href) || (t.also && cur.startsWith(t.also)));
  bar.innerHTML = tabs.map(t => `<a href="${t.href}" class="${cur.startsWith(t.href) || (t.also && cur.startsWith(t.also)) ? 'on' : ''}"><span>${t.icon}</span>${t.label}</a>`).join('')
    + `<button type="button" id="tab-more" class="${inTabs ? '' : 'on'}" aria-expanded="false"><span>☰</span>Más</button>`;
  $('#tab-more').onclick = e => {
    e.stopPropagation();
    const open = nav.classList.toggle('open');
    $('#tab-more').setAttribute('aria-expanded', open);
  };
  if (!drawTabbar.bound) {
    drawTabbar.bound = true;
    document.addEventListener('click', e => { if (!e.target.closest('#nav, #tab-more')) $('#nav')?.classList.remove('open'); });
  }
}

// ================================================================ fotógrafo: inicio
// Guía de primeros pasos + avisos de vencimiento + tablero de ventas + avisos push.
async function viewHome() {
  const p = S.profile;
  const approved = isApproved();
  let evs = [], sets = [], orders = [];
  if (approved) {
    const [es, os] = await Promise.all([
      getDocs(query(collection(db, 'events'), where('photographerUids', 'array-contains', S.user.uid), orderBy('date', 'desc'), limit(100))),
      getDocs(query(collection(db, 'orders'), where('photographerUid', '==', S.user.uid), orderBy('createdAt', 'desc'), limit(500))).catch(() => null),
    ]);
    evs = es.docs.map(d => ({ id: d.id, ...d.data() }));
    sets = await Promise.all(evs.map(ev => getDoc(doc(db, 'events', ev.id, 'sets', S.user.uid)).then(x => x.data() || null).catch(() => null)));
    orders = (os?.docs || []).map(d => ({ id: d.id, ...d.data() })).filter(o => o.status === 'approved');
  }
  const totalPhotos = sets.reduce((a, x) => a + (x?.photoCount || 0), 0);
  const steps = [
    { ok: !!(p.displayName && p.zone && p.bio && p.avatarUrl), label: 'Completá tu perfil', hint: 'Foto, zona y una bio corta: es lo primero que ven los clientes.', href: '#/perfil' },
    { ok: !!p.socials?.whatsapp, label: 'Cargá tu WhatsApp', hint: 'Para que te pidan presupuestos desde tu perfil.', href: '#/perfil' },
    { ok: (p.defaults?.price || 0) > 0, label: 'Definí tu precio y tu marca de agua', hint: 'Precio por foto, packs y tu logo (opcional).', href: '#/config' },
    { ok: !!p.mpConnected, label: 'Vinculá Mercado Pago', hint: 'Obligatorio para vender: la plata te llega directo a tu cuenta.', href: '#/mp' },
    { ok: approved, label: 'Aprobación de tu cuenta', hint: 'La revisamos a mano. Mientras tanto podés completar todo lo demás.', href: '' },
    { ok: evs.length > 0, label: 'Creá tu primer evento o sumate a uno', hint: 'Un evento por partido, torneo o carrera.', href: approved ? '#/eventos' : '' },
    { ok: totalPhotos > 0, label: 'Subí tus fotos', hint: `La marca de agua se aplica sola. Se venden durante ${myRules().days} días.`, href: approved ? (evs[0] ? `#/evento/${evs[0].id}` : '#/eventos') : '' },
    { ok: pushOn(), label: 'Activá los avisos de venta', hint: 'Te llega una notificación cada vez que vendés.', href: '#push' },
  ];
  const done = steps.filter(x => x.ok).length;

  $('#view').innerHTML = `
    <h1>Hola, ${esc(p.displayName)}</h1>
    <div id="home-alerts"></div>
    ${approved && !p.mpConnected && totalPhotos > 0 ? `<div class="notice danger"><strong>💳 Tus fotos se ven pero no se pueden comprar.</strong><br>Falta vincular Mercado Pago: los compradores ven "todavía no está a la venta". <a href="#/mp">Vincular ahora</a></div>` : ''}
    ${installCardHtml()}
    ${p.status === 'pending' ? `<div class="notice warn"><strong>Tu cuenta está pendiente de aprobación.</strong><br>Mientras tanto podés completar tu perfil, subir tu foto y tu portfolio, y configurar precios y marca de agua.</div>` : ''}
    ${done < steps.length ? `<div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">🚀 Primeros pasos</h2><span class="muted small">${done} de ${steps.length}</span></div>
      <div class="meter"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
      ${steps.map((x, i) => `<div class="item-row step ${x.ok ? 'ok' : ''}">
        <span class="step-n">${x.ok ? '✓' : i + 1}</span>
        <span class="grow"><strong>${x.label}</strong>${x.ok ? '' : `<br><span class="muted small">${x.hint}</span>`}</span>
        ${x.ok || !x.href ? '' : x.href === '#push' ? '<button class="btn sm primary" data-push-on>Activar</button>' : `<a class="btn sm ${steps.findIndex(y => !y.ok) === i ? 'primary' : ''}" href="${x.href}">Hacerlo</a>`}
      </div>`).join('')}
    </div>` : ''}
    <div id="home-dash"></div>
    <div id="home-push"></div>
    <div class="card"><h2>Tu perfil público</h2><p class="muted">Así te ven los compradores.</p><a class="btn" target="_blank" href="index.html#/f/${esc(p.slug)}">Ver mi perfil</a></div>`;

  // ---- álbumes por vencer
  const rows = evs.map((ev, i) => ({ ev, r: retentionState(sets[i]) })).filter(({ r }) => (r.k === 'active' && r.days <= 3) || r.k === 'grace');
  bindInstallCard();
  if (rows.length) $('#home-alerts').innerHTML = `<div class="notice ${rows.some(x => x.r.k === 'grace') ? 'danger' : 'warn'} stack">
    <strong>⏳ Álbumes por vencer</strong>
    ${rows.map(({ ev, r }) => `<div class="row" style="justify-content:space-between">
      <span>${esc(ev.name)} — ${r.k === 'active' ? `se vende ${r.days === 1 ? 'hasta mañana' : `${r.days} días más`}` : `<strong>ya no se vende; los originales se borran el ${fmtMs(r.deleteAt)}</strong>`}</span>
      <a class="btn sm" href="#/evento/${ev.id}">Extender</a></div>`).join('')}
  </div>`;

  // ---- tablero (estadísticas según el plan: 1 básicas · 2 por evento · 3 completas · 4 avanzadas). Sin datos de compradores.
  if (approved && (orders.length || totalPhotos)) {
    const lvl = myRules().stats;
    const mp = mpPlanOf(p, S.settings);
    const net = o => (o.total || 0) - (o.platformFee || 0) - Math.round(((o.total || 0) * mp.percent) / 100);
    const ts = o => (o.paidAt || o.createdAt)?.toMillis?.() || 0;
    const now = Date.now(), day = 86400000;
    const since = ms => orders.filter(o => ts(o) >= ms);
    const startMonth = new Date(); startMonth.setDate(1); startMonth.setHours(0, 0, 0, 0);
    const sum = (list, f) => list.reduce((a, o) => a + f(o), 0);
    const block = (title, list) => `<div class="stat"><span class="muted small">${title}</span><strong>${fmtMoney(sum(list, net))}</strong>
      <span class="muted small">${list.length} venta${list.length === 1 ? '' : 's'} · ${sum(list, o => o.count || 0)} fotos</span></div>`;
    const releaseDays = Number(mp.id) || 0;
    const pending = releaseDays ? orders.filter(o => ts(o) + releaseDays * day > now) : [];

    // Visitas (contadores anónimos).
    const [evStats, pfStat] = await Promise.all([
      Promise.all(evs.map(ev => getDoc(doc(db, 'stats', ev.id)).then(x => x.data() || {}).catch(() => ({})))),
      getDoc(doc(db, 'stats', `u_${S.user.uid}`)).then(x => x.data() || {}).catch(() => ({})),
    ]);
    const last30 = Array.from({ length: 30 }, (_, k) => new Date(now - (29 - k) * day).toISOString().slice(0, 10));
    const daysSum = (st, keys) => keys.reduce((a, k) => a + (st.days?.[k] || 0), 0);
    const evVisits30 = evStats.reduce((a, st) => a + daysSum(st, last30), 0);
    const pfVisits30 = daysSum(pfStat, last30);
    const lockNote = (need, what) => `<p class="muted small" style="margin:0">🔒 ${what}: con el plan <a href="#/web">${need}</a>.</p>`;

    const weeks = Array.from({ length: 8 }, (_, k) => {
      const end = now - (7 - k) * 7 * day, start = end - 7 * day;
      return { label: new Date(start + day).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }), v: sum(orders.filter(o => ts(o) > start && ts(o) <= end), net) };
    });
    const maxW = Math.max(1, ...weeks.map(w => w.v));
    const visitsDay = last30.map(k => ({ k, v: evStats.reduce((a, st) => a + (st.days?.[k] || 0), 0) + (pfStat.days?.[k] || 0) }));
    const maxV = Math.max(1, ...visitsDay.map(d => d.v));
    const rows = evs.map((ev, k) => ({ ev, set: sets[k] || {}, st: evStats[k] || {} })).filter(x => x.set.photoCount)
      .map(x => ({ ...x, sold: orders.filter(o => o.eventId === x.ev.id).reduce((a, o) => a + (o.count || 0), 0), net: sum(orders.filter(o => o.eventId === x.ev.id), net),
        views: x.st.views || 0, pv: x.st.pv?.[S.user.uid] || 0, ca: x.st.ca?.[S.user.uid] || 0 }))
      .sort((a, b) => b.sold - a.sold || b.views - a.views).slice(0, 8);
    // Avanzadas: horarios en que se vende (hora del pago) y de dónde llega la gente.
    const hours = Array.from({ length: 24 }, (_, h) => orders.filter(o => new Date(ts(o)).getHours() === h).length);
    const maxH = Math.max(1, ...hours);
    const SRC = { link: 'Link compartido', whatsapp: 'WhatsApp', instagram: 'Instagram', facebook: 'Facebook', google: 'Google', sitio: 'Desde Quiero Mis Fotos', directo: 'Directo', otro: 'Otros sitios' };
    const src = {};
    for (const st of [...evStats, pfStat]) for (const [k, v] of Object.entries(st.src || {})) src[k] = (src[k] || 0) + v;
    const srcTotal = Object.values(src).reduce((a, v) => a + v, 0);

    $('#home-dash').innerHTML = `
      <div class="stats">${block('Últimos 7 días', since(now - 7 * day))}${block('Este mes', since(startMonth.getTime()))}${block('Total', orders)}
        <div class="stat"><span class="muted small">Visitas (30 días)</span><strong>${evVisits30.toLocaleString('es-AR')}</strong><span class="muted small">a tus eventos · ${pfVisits30.toLocaleString('es-AR')} a tu perfil</span></div></div>
      <p class="muted small" style="margin-top:0">Montos netos estimados (después de la comisión de la plataforma y de Mercado Pago, ${mp.percent}%).
        ${pending.length ? `<br>💳 <strong>A acreditar en Mercado Pago: ${fmtMoney(sum(pending, net))}</strong> (cobrás ${mp.label.toLowerCase()}).` : ''}</p>
      ${rows.length ? `<div class="card"><h2>Tus álbumes</h2><div class="table-wrap"><table class="list">
        <tr><th>Evento</th><th>Fotos</th>${lvl >= 2 ? '<th>Visitas</th><th>Fotos vistas</th><th>Al carrito</th>' : ''}<th>Vendidas</th>${lvl >= 2 ? '<th>Ventas c/100 visitas</th>' : ''}<th>Neto</th></tr>
        ${rows.map(x => `<tr><td><a href="#/evento/${x.ev.id}">${esc(x.ev.name)}</a></td><td>${x.set.photoCount}</td>
          ${lvl >= 2 ? `<td>${x.views}</td><td>${x.pv}</td><td>${x.ca}</td>` : ''}<td>${x.sold}</td>
          ${lvl >= 2 ? `<td>${x.views ? ((x.sold / x.views) * 100).toFixed(1) : '—'}</td>` : ''}<td>${fmtMoney(x.net)}</td></tr>`).join('')}
      </table></div>${lvl < 2 ? lockNote('Profesional Lite', 'Visitas, fotos vistas y agregadas al carrito por evento') : ''}</div>` : ''}
      ${lvl >= 3 ? `<div class="card"><h2>Ventas por semana</h2>
        <div class="spark tall">${weeks.map(w => `<span style="height:${Math.max(2, (w.v / maxW) * 100)}%" title="Semana del ${w.label}: ${fmtMoney(w.v)}"></span>`).join('')}</div>
        <div class="spark-labels">${weeks.map(w => `<span>${w.label}</span>`).join('')}</div>
        <p class="muted small" style="margin:8px 0 0">Ticket promedio: <strong>${fmtMoney(orders.length ? sum(orders, o => o.total || 0) / orders.length : 0)}</strong> ·
          Fotos por compra: <strong>${orders.length ? (sum(orders, o => o.count || 0) / orders.length).toFixed(1) : '—'}</strong></p></div>
      <div class="card"><h2>Visitas por día</h2>
        <div class="spark tall">${visitsDay.map(d => `<span style="height:${Math.max(2, (d.v / maxV) * 100)}%" title="${d.k}: ${d.v} visitas"></span>`).join('')}</div>
        <p class="muted small" style="margin:6px 0 0">Últimos 30 días, eventos y perfil.</p></div>`
      : `<div class="card">${lockNote('Profesional', 'Ventas por semana, visitas por día, ticket promedio y fotos por compra')}</div>`}
      ${lvl >= 4 ? `<div class="card"><h2>Cuándo se vende</h2>
        <div class="spark tall">${hours.map((v, h) => `<span style="height:${Math.max(2, (v / maxH) * 100)}%" title="${h}:00 a ${h + 1}:00: ${v} ventas"></span>`).join('')}</div>
        <div class="spark-labels">${hours.map((v, h) => `<span>${h % 3 ? '' : `${h}h`}</span>`).join('')}</div></div>
      <div class="card"><h2>De dónde llega la gente</h2>
        ${srcTotal ? Object.entries(src).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="item-row"><span class="grow">${esc(SRC[k] || k)}</span><strong>${Math.round((v / srcTotal) * 100)}%</strong></div>`).join('')
          : '<p class="muted">Todavía no hay visitas registradas.</p>'}</div>`
      : `<div class="card">${lockNote('Profesional Premium', 'Horarios en que más vendés y de dónde llega la gente')}</div>`}`;
  }

  // ---- avisos push
  renderPushCard();
  $$('[data-push-on]').forEach(b => b.onclick = () => turnPushOn(b));
}

async function renderPushCard() {
  const box = $('#home-push');
  if (!box) return;
  if (!(await pushAvailable())) {
    if (isIos() && !isStandalone()) box.innerHTML = `<div class="card"><h2>🔔 Avisos de venta</h2><p class="muted" style="margin:0">En iPhone, para recibir un aviso cada vez que vendés, primero instalá el panel: tocá <strong>Compartir</strong> → <strong>Agregar a inicio</strong>, abrilo desde ese ícono y activalos acá.</p></div>`;
    return;
  }
  box.innerHTML = `<div class="card row" style="justify-content:space-between">
    <div><h2 style="margin:0 0 4px">🔔 Avisos de venta</h2><span class="muted small">${pushOn() ? 'Activados en este dispositivo: te avisamos cada vez que vendés.' : pushBlocked() ? 'Bloqueaste las notificaciones de este sitio: habilitalas desde la configuración del navegador.' : 'Recibí una notificación en este dispositivo cada vez que vendés.'}</span></div>
    ${pushOn() ? '<button class="btn sm" id="push-off">Desactivar</button>' : pushBlocked() ? '' : '<button class="btn primary sm" data-push-on>Activar</button>'}
  </div>`;
  $('#push-off')?.addEventListener('click', async () => { await disablePush(S.user.uid).catch(() => {}); toast('Avisos desactivados'); renderPushCard(); });
  $$('[data-push-on]', box).forEach(b => b.onclick = () => turnPushOn(b));
}

async function turnPushOn(btn) {
  if (!(await pushAvailable())) return toast(isIos() ? 'En iPhone primero agregá el panel a tu pantalla de inicio (Compartir → Agregar a inicio).' : 'Este navegador no permite notificaciones.', 'error');
  btn.disabled = true;
  try { await enablePush(S.user.uid); toast('🔔 ¡Listo! Te vamos a avisar cuando vendas'); viewHome(); }
  catch (e) { toast(errMsg(e), 'error'); btn.disabled = false; }
}

// ================================================================ perfil
function viewProfile() {
  const p = S.profile;
  $('#view').innerHTML = `
    <h1>Perfil</h1>
    <form class="card stack" id="pf">
      <div class="row"><span id="pf-av">${avatarHtml(p, 'lg')}</span>
        <div class="stack" style="flex:1;min-width:220px">
          <input type="hidden" id="pf-avatar" value="${esc(p.avatarUrl)}">
          <div class="row">
            <label class="btn sm">Subir foto<input type="file" id="pf-avatar-file" accept="image/*" hidden></label>
            ${S.user.photoURL ? `<button type="button" class="btn sm" id="pf-google">Usar mi foto de Google</button>` : ''}
            ${p.avatarUrl ? `<button type="button" class="btn sm ghost" id="pf-av-rm">Quitar</button>` : ''}
          </div>
        </div>
      </div>
      <div class="grid2">
        <label class="field">Nombre público<input type="text" id="pf-name" required maxlength="60" value="${esc(p.displayName)}"></label>
        <label class="field">Dirección del perfil<input type="text" id="pf-slug" required maxlength="40" value="${esc(p.slug)}"><span class="hint">#/f/<span id="pf-slug-prev">${esc(p.slug)}</span></span></label>
      </div>
      <div class="grid2">
        <label class="field">Zona<input type="text" id="pf-zone" maxlength="60" value="${esc(p.zone)}" placeholder="Ciudad, provincia"></label>
        <label class="field">Zonas donde trabajás<input type="text" id="pf-workzones" maxlength="120" value="${esc(p.workZones || '')}" placeholder="Ej: Rosario, Funes, Roldán"></label>
      </div>
      <label class="field">Bio<textarea id="pf-bio" maxlength="600" placeholder="Contá qué actividades cubrís, tu experiencia…">${esc(p.bio)}</textarea></label>
      <div class="field"><span>Actividades que cubrís</span>
        <div class="pills" id="pf-sports">${sportTags().map(t => `<button type="button" class="chip ${(p.specialties || []).includes(t.id) ? 'on' : ''}" data-v="${t.id}">${esc(t.name)}</button>`).join('')}</div>
        ${isApproved() || S.isSuper ? `<div class="row" style="margin-top:6px">
          <input type="text" id="pf-sport-new" maxlength="30" placeholder="¿No está tu actividad? Ej: Softball" style="max-width:260px">
          <button type="button" class="btn sm" id="pf-sport-add">Agregar</button></div>` : ''}</div>
      <div class="field"><span>Tipos de trabajo</span>
        <div class="pills" id="pf-services">${SERVICES.map(v => `<button type="button" class="chip ${(p.services || []).includes(v) ? 'on' : ''}" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div></div>
      <h3 style="margin-top:6px">Personalización del perfil</h3>
      ${myRules().profileCustom ? `<p class="muted small" style="margin:0">Una foto de portada arriba de tu perfil público.</p>
        <input type="hidden" id="pf-pcover" value="${esc(p.profileCoverUrl || '')}">
        <div class="pf-cover-prev" id="pf-pcover-prev" style="${p.profileCoverUrl ? `background-image:url('${esc(p.profileCoverUrl)}')` : ''}">${p.profileCoverUrl ? '' : '<span class="muted small">Sin portada</span>'}</div>
        <div class="row">
          <label class="btn sm">Subir portada<input type="file" id="pf-pcover-file" accept="image/*" hidden></label>
          <button type="button" class="btn sm ghost" id="pf-pcover-rm">Quitar portada</button>
        </div>` : `<p class="muted small" style="margin:0">🔒 Foto de portada en tu perfil: con el plan <a href="#/web">Profesional Lite</a> o superior.</p>`}
      <h3 style="margin-top:6px">Cámaras</h3>
      <p class="muted small" style="margin:0">Contá con qué equipo trabajás: cámaras, lentes, drone, iluminación…</p>
      <div id="pf-gear" class="stack"></div>
      <button type="button" class="btn sm" id="pf-gear-add" style="justify-self:start">+ Agregar equipo</button>
      <h3 style="margin-top:6px">Contacto y redes</h3>
      <p class="muted small" style="margin:0">Con tu WhatsApp aparece el botón <strong>"Pedir presupuesto"</strong> en tu perfil público.</p>
      <div class="grid2">
        ${SOCIALS.map(s => `<label class="field">${s.label}<input type="text" data-social="${s.key}" value="${esc(p.socials?.[s.key] || '')}" placeholder="${s.key === 'instagram' ? '@usuario' : s.key === 'whatsapp' ? 'Ej: 341 555-1234 (con código de área)' : ''}"></label>`).join('')}
      </div>
      <div class="row end"><a class="btn" target="_blank" href="index.html#/f/${esc(p.slug)}">Ver perfil público</a><button class="btn primary" type="submit">Guardar</button></div>
    </form>`;
  const setAvatar = url => { $('#pf-avatar').value = url; $('#pf-av').innerHTML = avatarHtml({ ...p, avatarUrl: url }, 'lg'); };
  const setPCover = url => { $('#pf-pcover').value = url; const pv = $('#pf-pcover-prev'); pv.style.backgroundImage = url ? `url('${url}')` : ''; pv.innerHTML = url ? '' : '<span class="muted small">Sin portada</span>'; };
  $('#pf-pcover-rm')?.addEventListener('click', () => setPCover(''));
  $('#pf-pcover-file')?.addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { toast('Subiendo portada…'); const { url } = await uploadAsset('pcover', await resizeToJpeg(f, 1800, 0.82)); setPCover(url); toast('Portada lista: guardá el perfil'); }
    catch (err) { toast(errMsg(err), 'error'); }
  });
  $('#pf-google')?.addEventListener('click', () => setAvatar(S.user.photoURL));
  $('#pf-av-rm')?.addEventListener('click', () => setAvatar(''));
  $('#pf-avatar-file')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      toast('Subiendo foto…');
      const { url } = await uploadAsset('avatar', await resizeToJpeg(f, 400, 0.85));
      setAvatar(url);
      toast('Foto lista. Tocá Guardar para aplicarla.');
    } catch (err) { toast(errMsg(err), 'error'); }
  });
  $$('#pf-sports .chip, #pf-services .chip').forEach(c => c.onclick = () => c.classList.toggle('on'));
  // Cámaras / equipo
  const gear = (p.gear || []).map(g => ({ ...g }));
  const drawGear = () => {
    $('#pf-gear').innerHTML = gear.length ? gear.map((g, i) => `
      <div class="row gear-row">
        <select data-gi="${i}" data-gk="type" style="width:auto">${GEAR_TYPES.map(t => `<option ${g.type === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
        <input type="text" data-gi="${i}" data-gk="name" maxlength="60" value="${esc(g.name || '')}" placeholder="${g.type === 'Lente' ? 'Ej: Sony FE 70-200mm f/2.8 GM' : g.type === 'Drone' ? 'Ej: DJI Mini 4 Pro' : 'Ej: Sony A7 IV'}" style="flex:1;min-width:180px">
        <button type="button" class="btn sm danger" data-grm="${i}" aria-label="Quitar">✕</button>
      </div>`).join('') : '<p class="muted small" style="margin:0">Todavía no cargaste tu equipo.</p>';
    $$('#pf-gear [data-gi]').forEach(el => el.oninput = () => {
      gear[el.dataset.gi][el.dataset.gk] = el.value;
      if (el.dataset.gk === 'type') drawGear();
    });
    $$('#pf-gear [data-grm]').forEach(b => b.onclick = () => { gear.splice(+b.dataset.grm, 1); drawGear(); });
  };
  drawGear();
  $('#pf-gear-add').onclick = () => {
    if (gear.length >= 20) return toast('Podés cargar hasta 20 equipos.', 'error');
    gear.push({ type: gear.length ? gear.at(-1).type : 'Cámara', name: '' });
    drawGear();
    $$('#pf-gear input').at(-1)?.focus();
  };
  const addSport = async () => {
    const inp = $('#pf-sport-new');
    const name = inp.value.trim();
    if (name.length < 2) return toast('Escribí el nombre de la actividad.', 'error');
    const btn = $('#pf-sport-add'); btn.disabled = true;
    try {
      const { tag, created } = await apiPost('/tags', { type: ACTIVITY_TYPE, name });
      S.tax = await loadTaxonomy(true);
      let chip = $(`#pf-sports .chip[data-v="${tag.id}"]`);
      if (!chip) {
        $('#pf-sports').insertAdjacentHTML('beforeend', `<button type="button" class="chip" data-v="${esc(tag.id)}">${esc(tag.name)}</button>`);
        chip = $(`#pf-sports .chip[data-v="${tag.id}"]`);
        chip.onclick = () => chip.classList.toggle('on');
      }
      chip.classList.add('on');
      inp.value = '';
      toast(created ? `Agregamos "${tag.name}". Tocá Guardar.` : `"${tag.name}" ya existía: lo marcamos.`);
    } catch (err) { toast(errMsg(err), 'error'); }
    btn.disabled = false;
  };
  $('#pf-sport-add')?.addEventListener('click', addSport);
  $('#pf-sport-new')?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSport(); } });
  $('#pf-slug').oninput = e => { $('#pf-slug-prev').textContent = slugify(e.target.value); };
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const slug = slugify($('#pf-slug').value);
    if (!SLUG_RE.test(slug)) return toast('La dirección debe tener entre 3 y 40 letras, números o guiones.', 'error');
    const socials = {};
    $$('[data-social]').forEach(i => { if (i.value.trim()) socials[i.dataset.social] = i.value.trim(); });
    const upd = {
      displayName: $('#pf-name').value.trim(), slug, zone: $('#pf-zone').value.trim(),
      bio: $('#pf-bio').value.trim(), avatarUrl: $('#pf-avatar').value.trim(), socials,
      workZones: $('#pf-workzones').value.trim(),
      specialties: $$('#pf-sports .chip.on').map(c => c.dataset.v),
      services: $$('#pf-services .chip.on').map(c => c.dataset.v),
      gear: gear.map(g => ({ type: GEAR_TYPES.includes(g.type) ? g.type : 'Otro', name: String(g.name || '').trim().slice(0, 60) })).filter(g => g.name),
      ...($('#pf-pcover') ? { profileCoverUrl: $('#pf-pcover').value } : {}),
    };
    try {
      const b = writeBatch(db);
      if (slug !== p.slug) {
        const taken = await getDoc(doc(db, 'slugs', slug));
        if (taken.exists() && taken.data().uid !== S.user.uid) return toast('Esa dirección ya está en uso.', 'error');
        if (!taken.exists()) b.set(doc(db, 'slugs', slug), { uid: S.user.uid });
        b.delete(doc(db, 'slugs', p.slug));
      }
      b.update(doc(db, 'users', S.user.uid), upd);
      await b.commit();
      Object.assign(S.profile, upd);
      toast('Perfil guardado');
      viewProfile();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

function sportTags() {
  const t = S.tax.types.find(x => x.id === ACTIVITY_TYPE) || S.tax.types.find(x => ['deporte', 'actividad'].includes(normalize(x.name)));
  return t ? S.tax.tags.filter(g => g.typeId === t.id) : [];
}

// ================================================================ precios y marca
// getFeeMode: función que devuelve el modo de comisión elegido (para calcular el neto de cada pack).
function packsEditor(el, packs, getFeeMode = () => 'absorb', getUnit = () => 0) {
  let rows = (packs || []).map(p => ({ ...p }));
  const hint = r => {
    if (!(r.qty > 1 && r.price > 0)) return '&nbsp;';
    const unit = getUnit();
    // Un pack que no es más barato que las fotos sueltas no se usa (el carrito cobra lo más barato) ni se muestra.
    if (unit > 0 && r.price >= unit * r.qty) return `<span style="color:var(--danger)">⚠️ Cuesta igual o más que ${r.qty} sueltas (${fmtMoney(unit * r.qty)}): no se va a mostrar ni usar.</span>`;
    return `${fmtMoney(r.price / r.qty)} c/u · te quedan ${fmtMoney(netOf(r.price, getFeeMode()).net)}`;
  };
  const draw = () => {
    el.innerHTML = `
      ${rows.length ? '' : '<p class="muted small" style="margin:0">Sin packs: cada foto se cobra al precio individual.</p>'}
      ${rows.map((r, i) => `
        <div class="pack-row">
          <label class="field">Cantidad de fotos<input type="number" min="2" step="1" data-i="${i}" data-k="qty" value="${r.qty || ''}"></label>
          <label class="field">Precio del pack<input type="number" min="1" step="1" data-i="${i}" data-k="price" value="${r.price || ''}">
            <span class="hint" data-hint="${i}">${hint(r)}</span></label>
          <button type="button" class="btn sm danger" data-del="${i}" title="Quitar">✕</button>
        </div>`).join('')}
      <button type="button" class="btn sm" data-add style="justify-self:start">+ Agregar pack</button>`;
    el.querySelectorAll('input').forEach(inp => inp.oninput = () => {
      const r = rows[inp.dataset.i];
      r[inp.dataset.k] = Number(inp.value);
      el.querySelector(`[data-hint="${inp.dataset.i}"]`).innerHTML = hint(r);
    });
    el.querySelectorAll('[data-del]').forEach(btn => btn.onclick = () => { rows.splice(btn.dataset.del, 1); draw(); });
    el.querySelector('[data-add]').onclick = () => { rows.push({ qty: (rows.at(-1)?.qty || 1) + 2, price: 0 }); draw(); };
  };
  el.classList.add('stack');
  draw();
  return {
    refresh: () => rows.forEach((r, i) => { const h = el.querySelector(`[data-hint="${i}"]`); if (h) h.innerHTML = hint(r); }),
    get() {
      const clean = rows.filter(r => r.qty || r.price).map(r => ({ qty: Math.round(r.qty), price: Math.round(r.price) }));
      for (const r of clean) if (!(r.qty >= 2 && r.price > 0)) throw new Error('Cada pack necesita cantidad (2 o más) y precio.');
      if (new Set(clean.map(r => r.qty)).size !== clean.length) throw new Error('Hay dos packs con la misma cantidad.');
      return clean.sort((a, b) => a.qty - b.qty);
    },
  };
}

// Neto del fotógrafo para un monto (después de la comisión de la plataforma y la de MP).
function netOf(amount, feeMode) {
  return sellerNet(amount, { feeMode, feePercent: myFee(), mpPercent: mpPlanOf(S.profile, S.settings).percent });
}

// Desglose de una venta de `amount` (precio que fijó el fotógrafo).
function breakdownHtml(amount, feeMode) {
  if (!(amount > 0)) return '<p class="muted small" style="margin:0">Poné un precio para ver cuánto te queda.</p>';
  const plan = mpPlanOf(S.profile, S.settings);
  const n = netOf(amount, feeMode);
  return `
    <div class="breakdown">
      <div class="bd-row"><span>Paga el comprador</span><span>${fmtMoney(n.total)}</span></div>
      <div class="bd-row muted"><span>Comisión Quiero Mis Fotos (${myFee()}%)</span><span>−${fmtMoney(n.platformFee)}</span></div>
      <div class="bd-row muted"><span>Comisión Mercado Pago (${plan.percent}% · ${esc(plan.label.toLowerCase())})</span><span>−${fmtMoney(n.mpFee)}</span></div>
      <div class="bd-row total"><span>Te queda</span><span>${fmtMoney(n.net)}</span></div>
    </div>
    <p class="muted small" style="margin:0">La comisión de MP depende del plazo de acreditación que tengas configurado en tu cuenta de Mercado Pago (<a href="#/mp">cambiar</a>). Es una estimación con tarjeta de crédito.</p>`;
}

function feeModeHtml(name, value) {
  const pct = myFee();
  return `
    <label class="check"><input type="radio" name="${name}" value="absorb" ${value !== 'buyer' ? 'checked' : ''}> Absorbo la comisión <span class="muted small">(el comprador paga el precio; se te descuenta ${pct}%)</span></label>
    <label class="check"><input type="radio" name="${name}" value="buyer" ${value === 'buyer' ? 'checked' : ''}> La paga el comprador <span class="muted small">(se suma ${pct}% como "costo de servicio")</span></label>`;
}

function viewConfig() {
  const p = S.profile;
  const d = p.defaults || {};
  const wm = { ...DEFAULT_WATERMARK, ...(p.watermark || {}) };
  $('#view').innerHTML = `
    <h1>Precios y marca de agua</h1>
    <p class="muted">Estos valores se usan por defecto en cada evento nuevo. Después podés cambiarlos por evento.</p>
    <form id="cf">
      <div class="card stack">
        <h2>Precios</h2>
        <label class="field" style="max-width:240px">Precio por foto (ARS)<input type="number" min="0" step="1" id="cf-price" value="${d.price || ''}" required></label>
        <h3>Packs por cantidad</h3>
        <div id="cf-packs"></div>
        <h3>Comisión de la plataforma (${myFee()}%)</h3>
        <div class="stack">${feeModeHtml('cf-fee', d.feeMode)}</div>
        <h3>¿Cuánto te queda por foto?</h3>
        <div id="cf-net"></div>
      </div>
      <div class="card stack">
        <h2>Marca de agua</h2>
        <p class="muted small" style="margin:0">Todas las muestras llevan <strong>www.quieromisfotos.com.ar</strong> en mosaico. Si querés, sumá tu logo en el centro. El original que descarga el comprador va sin marca.</p>
        <div class="grid2">
          <div class="stack">
            <label class="check"><input type="checkbox" id="wm-uselogo" ${wantsLogo(wm) ? 'checked' : ''}> Agregar mi logo en el centro</label>
            <div class="field" id="wm-logo-f">
              <span class="hint">PNG con fondo transparente, idealmente blanco. Máximo 2 MB.</span>
              <div class="row">
                <img id="wm-logo-img" alt="" class="${wm.logoUrl ? '' : 'hidden'}" style="height:48px;max-width:140px;object-fit:contain;background:#3a3f4b;border-radius:8px;padding:4px">
                <label class="btn sm">${wm.logoUrl ? 'Cambiar logo' : 'Subir logo'}<input type="file" id="wm-logo-file" accept="image/png,image/webp" hidden></label>
              </div>
            </div>
            <label class="field">Opacidad <span class="hint" id="wm-op-v">${Math.round(wm.opacity * 100)}%</span>
              <input type="range" id="wm-op" min="0.1" max="0.7" step="0.05" value="${wm.opacity}"></label>
          </div>
          <div><canvas class="wm-preview" id="wm-canvas" width="960" height="640"></canvas>
            <p class="muted small">Vista previa de una muestra.</p></div>
        </div>
      </div>
      <div class="row end" style="margin-top:14px"><button class="btn primary" type="submit">Guardar</button></div>
    </form>`;
  const feeMode = () => $('input[name=cf-fee]:checked').value;
  const packs = packsEditor($('#cf-packs'), d.packs, feeMode, () => Number($('#cf-price').value) || 0);
  const drawNet = () => { $('#cf-net').innerHTML = breakdownHtml(Math.round(Number($('#cf-price').value) || 0), feeMode()); packs.refresh(); };
  $('#cf-price').addEventListener('input', drawNet);
  $$('input[name=cf-fee]').forEach(r => r.addEventListener('change', drawNet));
  drawNet();

  let logo = { key: wm.logoKey || '', url: wm.logoUrl || '', img: null };
  const readWm = () => ({
    useLogo: $('#wm-uselogo').checked && !!logo.key, opacity: Number($('#wm-op').value),
    logoKey: logo.key, logoUrl: logo.url,
  });
  const preview = () => {
    $('#wm-logo-f').classList.toggle('hidden', !$('#wm-uselogo').checked);
    const c = $('#wm-canvas'), ctx = c.getContext('2d');
    drawSampleScene(ctx, c.width, c.height);
    drawWatermark(ctx, c.width, c.height, readWm(), logo.img);
    $('#wm-op-v').textContent = `${Math.round(Number($('#wm-op').value) * 100)}%`;
  };
  const loadLogo = url => {
    if (!url) return;
    const img = new Image();
    img.onload = () => { logo.img = img; preview(); };
    img.src = url;
    const thumb = $('#wm-logo-img'); thumb.src = url; thumb.classList.remove('hidden');
  };
  ['wm-uselogo', 'wm-op'].forEach(id => $('#' + id).addEventListener('input', preview));
  $('#wm-logo-file')?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    if (f.size > 2e6) return toast('El logo debe pesar menos de 2 MB.', 'error');
    try {
      const r = await uploadAsset('logo', f);
      logo = { key: r.key, url: r.url, img: null };
      loadLogo(r.url);
      toast('Logo subido. Tocá Guardar para aplicarlo.');
    } catch (err) { toast(errMsg(err), 'error'); }
  });
  loadLogo(logo.url);
  preview();
  $('#cf').onsubmit = async e => {
    e.preventDefault();
    try {
      if ($('#wm-uselogo').checked && !logo.key) return toast('Subí tu logo o destildá la opción.', 'error');
      const upd = {
        defaults: { price: Math.round(Number($('#cf-price').value) || 0), packs: packs.get(), feeMode: feeMode() },
        watermark: readWm(),
      };
      await updateDoc(doc(db, 'users', S.user.uid), upd);
      Object.assign(S.profile, upd);
      toast('Configuración guardada');
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// ================================================================ Mercado Pago
async function viewMp() {
  const { query: q } = parseHash();
  if (q.get('mp')) {
    // Volvimos de Mercado Pago: refrescar el perfil (el Worker marcó mpConnected).
    const snap = await getDoc(doc(db, 'users', S.user.uid));
    S.profile = snap.data();
    if (q.get('mp') === 'ok') toast('¡Mercado Pago vinculado!');
    else toast(q.get('m') || 'No se pudo vincular Mercado Pago', 'error');
    history.replaceState(null, '', '#/mp');
  }
  const p = S.profile;
  $('#view').innerHTML = `
    <h1>Mercado Pago</h1>
    <div class="card stack">
      <div class="row"><strong>Estado:</strong> ${p.mpConnected ? '<span class="pill ok">Vinculada</span>' : '<span class="pill warn">Sin vincular</span>'}
        ${p.mpConnected && p.mpUserId ? `<span class="muted small">Cuenta MP #${esc(p.mpUserId)}</span>` : ''}</div>
      <p class="muted">Los pagos de tus fotos se acreditan directamente en tu cuenta de Mercado Pago. La plataforma retiene automáticamente su comisión (${myFee()}%). Vincular tu cuenta es obligatorio para vender.</p>
      <div class="row">
        ${p.mpConnected
          ? '<button class="btn" id="mp-connect">Volver a vincular</button><button class="btn ghost danger" id="mp-disconnect">Desvincular</button>'
          : '<button class="btn primary" id="mp-connect">Vincular Mercado Pago</button>'}
      </div>
      <p class="muted small" style="margin:0">Te vamos a llevar a Mercado Pago para que autorices a Quiero Mis Fotos a cobrar en tu nombre. Nunca vemos tu contraseña.</p>
    </div>
    <div class="card stack">
      <h2>¿Cuánto cobrás de cada venta?</h2>
      <p class="muted" style="margin:0">Mercado Pago cobra una comisión que depende de cuándo querés tener la plata disponible. Elegí el plazo que tenés configurado en tu cuenta de MP (en Mercado Pago: <em>Tu negocio → Costos y cuotas</em>) para ver tu neto real.</p>
      <div class="stack" id="mp-plans">
        ${(S.settings.mpFeePlans || []).map(pl => `<label class="check"><input type="radio" name="mp-plan" value="${esc(pl.id)}" ${mpPlanOf(p, S.settings).id === pl.id ? 'checked' : ''}> ${esc(pl.label)} <span class="muted small">(${pl.percent}% con IVA)</span></label>`).join('')}
      </div>
      <h3>Ejemplo con tu precio por foto${p.defaults?.price ? ` (${fmtMoney(p.defaults.price)})` : ''}</h3>
      <div id="mp-net"></div>
    </div>`;
  const drawNet = () => { $('#mp-net').innerHTML = breakdownHtml(p.defaults?.price || 0, p.defaults?.feeMode || 'absorb'); };
  drawNet();
  $('#mp-plans').addEventListener('change', async e => {
    const mpReleasePlan = e.target.value;
    try { await updateDoc(doc(db, 'users', S.user.uid), { mpReleasePlan }); S.profile.mpReleasePlan = mpReleasePlan; drawNet(); toast('Plazo guardado'); }
    catch (err) { toast(errMsg(err), 'error'); }
  });
  $('#mp-connect').onclick = async e => {
    e.target.disabled = true;
    try { const { url } = await apiPost('/mp/connect-url'); location.href = url; }
    catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  };
  $('#mp-disconnect')?.addEventListener('click', async e => {
    if (!confirm('¿Desvincular tu cuenta de Mercado Pago? No vas a poder vender hasta volver a vincularla.')) return;
    e.target.disabled = true;
    try { await apiPost('/mp/disconnect'); S.profile.mpConnected = false; toast('Mercado Pago desvinculado'); viewMp(); }
    catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  });
}

async function viewSales() {
  const snap = await getDocs(query(collection(db, 'orders'), where('photographerUid', '==', S.user.uid), orderBy('createdAt', 'desc'), limit(300)));
  const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const paid = orders.filter(o => o.status === 'approved');
  const mpPct = mpPlanOf(S.profile, S.settings).percent;
  const net = o => (o.total || 0) - (o.platformFee || 0) - Math.round(((o.total || 0) * mpPct) / 100);
  const byEvent = new Map();
  for (const o of paid) {
    const e = byEvent.get(o.eventId) || { name: o.eventName, count: 0, photos: 0, total: 0, net: 0 };
    e.count++; e.photos += o.count || 0; e.total += o.total || 0; e.net += net(o);
    byEvent.set(o.eventId, e);
  }
  const STATUS = { approved: ['Pagado', 'ok'], pending: ['Pendiente', 'warn'], rejected: ['Rechazado', 'danger'], refunded: ['Reembolsado', ''] };
  $('#view').innerHTML = `
    <h1>Ventas</h1>
    <div class="stats">
      <div class="stat"><span class="muted small">Ventas pagadas</span><strong>${paid.length}</strong></div>
      <div class="stat"><span class="muted small">Fotos vendidas</span><strong>${paid.reduce((a, o) => a + (o.count || 0), 0)}</strong></div>
      <div class="stat"><span class="muted small">Neto para vos</span><strong>${fmtMoney(paid.reduce((a, o) => a + net(o), 0))}</strong></div>
    </div>
    <p class="muted small">Neto estimado: descuenta la comisión de la plataforma y la de Mercado Pago (${mpPct}%, <a href="#/mp">según tu plazo de acreditación</a>). El detalle exacto lo ves en tu cuenta de MP.</p>
    ${byEvent.size ? `<div class="card"><h2>Por evento</h2><div class="table-wrap"><table class="list">
      <tr><th>Evento</th><th>Ventas</th><th>Fotos</th><th>Cobrado</th><th>Neto</th></tr>
      ${[...byEvent.values()].map(e => `<tr><td>${esc(e.name)}</td><td>${e.count}</td><td>${e.photos}</td><td>${fmtMoney(e.total)}</td><td>${fmtMoney(e.net)}</td></tr>`).join('')}
    </table></div></div>` : ''}
    <div class="card"><h2>Últimos pedidos</h2>
      ${orders.length ? `<div class="table-wrap"><table class="list">
        <tr><th>Fecha</th><th>Evento</th><th>Fotos</th><th>Total</th><th>Estado</th></tr>
        ${orders.map(o => { const [l, c] = STATUS[o.status] || [o.status, '']; return `<tr><td>${esc(fmtTs(o.createdAt))}</td><td>${esc(o.eventName)}</td><td>${o.count}</td><td>${fmtMoney(o.total)}</td><td><span class="pill ${c}">${l}</span></td></tr>`; }).join('')}
      </table></div>` : '<div class="empty">Todavía no tenés ventas.</div>'}
    </div>`;
}

// ================================================================ eventos (fotógrafo)
async function viewMyEvents() {
  const snap = await getDocs(query(collection(db, 'events'), where('photographerUids', 'array-contains', S.user.uid), orderBy('date', 'desc'), limit(200)));
  const evs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Mi set en cada evento: fotos, vendidas y vencimiento.
  const [sets, sales] = await Promise.all([
    Promise.all(evs.map(ev => getDoc(doc(db, 'events', ev.id, 'sets', S.user.uid)).then(s => s.data() || null).catch(() => null))),
    getDocs(query(collection(db, 'salesStats'), where('photographerUid', '==', S.user.uid))).catch(() => null),
  ]);
  const sold = new Map((sales?.docs || []).map(d => [d.data().eventId, d.data().soldPhotos || 0]));
  evs.forEach((ev, i) => { ev.mySet = sets[i] && { ...sets[i], soldPhotos: sold.get(ev.id) || 0 }; });
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Mis eventos</h1>
      <div class="row"><button class="btn" id="join">Sumarme a un evento</button><button class="btn primary" id="new">+ Crear evento</button></div>
    </div>
    ${evs.length ? `<div class="events-grid">${evs.map(ev => panelEventCard(ev)).join('')}</div>`
      : `<div class="card"><div class="empty">Todavía no estás en ningún evento.<br>Creá uno nuevo o sumate a un evento general.</div></div>`}`;
  $('#new').onclick = () => eventDialog(null);
  $('#join').onclick = joinDialog;
  $$('[data-share]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); shareEvent(evs.find(x => x.id === b.dataset.share)); });
}

function statusPill(ev) {
  return ev.status === 'published' ? '<span class="pill ok">Publicado</span>' : '<span class="pill warn">Borrador</span>';
}

function panelEventCard(ev) {
  const mine = ev.createdBy === S.user.uid && ev.kind === 'own';
  return `
    <a class="event-card" href="#/evento/${ev.id}">
      <button class="card-share" data-share="${ev.id}" title="Compartir" aria-label="Compartir">🔗</button>
      ${coverHtml(ev, statusPill(ev))}
      <div class="body">
        <span class="date">${esc(fmtDate(ev.date))}</span>
        <span class="name">${esc(ev.name)}</span>
        <div class="pills">
          ${ev.kind === 'general' ? '<span class="pill accent">Evento general</span>' : mine ? '<span class="pill">Creado por mí</span>' : '<span class="pill">Compartido</span>'}
          <span class="pill">👥 ${(ev.photographerUids || []).length}</span>
          ${ev.date > todayIso() ? '<span class="pill accent">📅 Próximamente</span>' : ''}
        </div>
        ${ev.mySet ? setStatsHtml(ev.mySet) : ''}
      </div>
    </a>`;
}

// Estado del plazo de venta de un álbum: notstarted | active | grace (no se vende, todavía se puede extender) | deleted.
function retentionState(set) {
  if (set?.originalsDeleted) return { k: 'deleted', at: set.originalsDeletedAt?.toMillis?.() || 0 };
  const until = setUntil(set);
  if (!until) return { k: 'notstarted' };
  const days = Math.ceil((until - Date.now()) / 86400000);
  if (days > 0) return { k: 'active', until, days };
  const deleteAt = setDeleteAt(set);
  return { k: 'grace', until, deleteAt, ddays: Math.max(0, Math.ceil((deleteAt - Date.now()) / 86400000)) };
}
const fmtMs = ms => new Date(ms).toLocaleDateString('es-AR', { day: 'numeric', month: 'long' });

// Explicación del plazo + botón Extender (editor del álbum).
function retentionHtml(set) {
  const r = retentionState(set);
  const btn = '<button class="btn primary sm" id="ext-btn">⏳ Extender plazo</button>';
  if (r.k === 'deleted') return `<div class="notice">🗑️ Los originales se eliminaron${r.at ? ` el ${fmtMs(r.at)}` : ''}. Las fotos se siguen viendo con marca de agua, pero ya no se pueden vender.</div>`;
  if (r.k === 'notstarted') return `<p class="muted small" style="margin:0">⏳ Tus fotos se venden durante ${myRules().days} días desde que subís la primera. Después podés extender el plazo.</p>`;
  if (r.k === 'active') return `<div class="notice ${r.days <= 3 ? 'warn' : ''} row" style="justify-content:space-between">
      <span>⏳ Se vende hasta el <strong>${fmtMs(r.until)}</strong> (${r.days} día${r.days === 1 ? '' : 's'}). Después tenés ${GRACE_DAYS} días para extender antes de que se borren los originales.</span>${btn}</div>`;
  return `<div class="notice danger row" style="justify-content:space-between">
      <span>⛔ Este álbum dejó de venderse el ${fmtMs(r.until)}. <strong>Los originales se borran el ${fmtMs(r.deleteAt)}</strong>: extendé el plazo para volver a venderlo.</span>${btn}</div>`;
}

// Tope del álbum en cantidad de fotos (según el plan + packs comprados).
function capOf(set) {
  const max = albumPhotoLimit(set, S.settings, S.profile);
  return { max, used: set?.photoCount || 0, fmt: n => `${Number(n).toLocaleString('es-AR')} fotos`, photos: true };
}

// Elegir plan y pagar con Mercado Pago (a la plataforma): kind 'time' = más días de venta, 'space' = más fotos (o GB) en el álbum.
function extensionDialog(ev, set, kind = 'time') {
  const space = kind === 'space';
  const cap = capOf(set);
  const plans = (space ? S.settings.storagePlans : S.settings.extensionPlans || []).filter(p => (space ? (cap.photos ? p.photos : p.gb) : p.days) > 0 && p.price > 0);
  if (!plans.length) return toast(`Todavía no hay planes de ${space ? 'espacio' : 'extensión'}. Escribinos por WhatsApp.`, 'error');
  const from = Math.max(setUntil(set), Date.now());
  const dlg = openDialog(space ? 'Más espacio para el álbum' : 'Extender plazo', `
    <p class="muted" style="margin-top:0">${space
      ? `Tu álbum de <strong>${esc(ev.name)}</strong> tiene ${cap.fmt(cap.used)} de ${cap.fmt(cap.max)}. Sumá lugar para seguir subiendo.`
      : `Tus fotos de <strong>${esc(ev.name)}</strong> se siguen vendiendo y los originales no se borran.`}</p>
    <div class="stack">${plans.map((p, i) => `
      <label class="check card" style="margin:0;padding:12px"><input type="radio" name="ext-plan" value="${esc(p.id)}" ${i === 0 ? 'checked' : ''}>
        <span class="grow"><strong>${esc(cap.photos ? `+${p.photos} fotos` : (p.label || `+${p.gb} GB`))}</strong> · ${fmtMoney(p.price)}<br><span class="muted small">${space
          ? `El álbum queda con ${cap.fmt(cap.max + (cap.photos ? p.photos : p.gb * 1e9))}`
          : `Se vende hasta el ${fmtMs(from + p.days * 86400000)}`}</span></span></label>`).join('')}
    </div>`, '<button class="btn primary" id="ext-pay">Pagar con Mercado Pago</button>');
  $('#ext-pay', dlg).onclick = async () => {
    const b = $('#ext-pay', dlg); b.disabled = true; b.textContent = 'Abriendo Mercado Pago…';
    try {
      const planId = $('input[name="ext-plan"]:checked', dlg).value;
      const { initPoint } = await apiPost('/extensions/checkout', { eventId: ev.id, planId, kind });
      location.href = initPoint;
    } catch (e) { toast(errMsg(e), 'error'); b.disabled = false; b.textContent = 'Pagar con Mercado Pago'; }
  };
}

// Fotos subidas, fotos vendidas y días hasta que se borren los originales.
function setStatsHtml(set) {
  const r = retentionState(set);
  const exp = {
    deleted: '<span class="stat-chip danger" title="Los originales ya se eliminaron">🗑️ Originales eliminados</span>',
    notstarted: `<span class="stat-chip" title="El plazo arranca cuando subís la primera foto">⏳ ${myRules().days} días al subir</span>`,
    active: `<span class="stat-chip ${r.days <= 3 ? 'warn' : ''}" title="Días que le quedan a la venta">⏳ ${r.days} día${r.days === 1 ? '' : 's'}</span>`,
    grace: `<span class="stat-chip danger" title="Ya no se vende. Extendé el plazo antes de que se borren los originales">⛔ Sin venta · se borra en ${r.ddays} día${r.ddays === 1 ? '' : 's'}</span>`,
  }[r.k] || '';
  return `
    <div class="set-stats">
      <span class="stat-chip" title="Fotos en el álbum">📷 ${set.photoCount || 0}</span>
      ${(c => c.photos ? (c.max ? `<span class="stat-chip ${c.used >= c.max * 0.9 ? 'warn' : ''}" title="Fotos del álbum y tope del plan">🗂️ ${c.used} / ${c.fmt(c.max)}</span>` : '')
        : `<span class="stat-chip ${c.max && c.used >= c.max * 0.9 ? 'warn' : ''}" title="Espacio que ocupa el álbum (originales + muestras)">💾 ${fmtBytes(c.used)}${c.max ? ` / ${fmtBytes(c.max)}` : ''}</span>`)(capOf(set))}
      <span class="stat-chip ${set.soldPhotos ? 'ok' : ''}" title="Fotos vendidas">🛒 ${set.soldPhotos || 0} vendida${set.soldPhotos === 1 ? '' : 's'}</span>
      ${exp}
    </div>`;
}

// Compartir: el fotógrafo comparte su álbum (galería filtrada por él); el superadmin, el evento completo.
function shareEvent(ev) {
  if (!ev) return;
  if (ev.status !== 'published') toast('Ojo: el evento está en borrador. Publicalo para que el link funcione.', 'error');
  const mine = !S.isSuper && (ev.photographerUids || []).includes(S.user.uid);
  const url = eventUrl(ev.id, mine && (ev.photographerUids || []).length > 1 ? S.user.uid : '');
  shareLink({ title: ev.name, text: `📸 Ya están las fotos de ${ev.name}. Buscate y descargalas acá:`, url });
}

async function joinDialog() {
  const dlg = openDialog('Sumarme a un evento', `<input type="text" id="jq" placeholder="Buscar…"><div id="jl"><div class="spinner"></div></div>`, '');
  try {
    const snap = await getDocs(query(collection(db, 'events'), where('openToJoin', '==', true), orderBy('date', 'desc'), limit(200)));
    const evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(ev => !(ev.photographerUids || []).includes(S.user.uid));
    const draw = () => {
      const q = normalize($('#jq', dlg).value);
      const list = evs.filter(ev => !q || normalize(`${ev.name} ${ev.location}`).includes(q));
      $('#jl', dlg).innerHTML = list.length ? list.map(ev => `
        <div class="item-row">
          <div class="grow"><strong>${esc(ev.name)}</strong><br><span class="muted small">${esc(fmtDate(ev.date))}${ev.location ? ' · ' + esc(ev.location) : ''}</span>
            ${ev.kind === 'general' ? ' <span class="pill accent">General</span>' : ''}</div>
          <button class="btn sm primary" data-join="${ev.id}">Sumarme</button>
        </div>`).join('') : '<div class="empty">No hay eventos abiertos para sumarse.</div>';
      $$('[data-join]', dlg).forEach(b => b.onclick = async () => {
        b.disabled = true;
        try {
          const bt = writeBatch(db);
          bt.update(doc(db, 'events', b.dataset.join), { photographerUids: arrayUnion(S.user.uid) });
          bt.set(doc(db, 'events', b.dataset.join, 'sets', S.user.uid), newSetData());
          await bt.commit();
          dlg.close();
          toast('Te sumaste al evento');
          location.hash = `#/evento/${b.dataset.join}`;
        } catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
      });
    };
    $('#jq', dlg).oninput = draw;
    draw();
  } catch (e) { $('#jl', dlg).innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`; }
}

function newSetData() {
  const d = S.profile.defaults || {};
  return {
    price: d.price || 0, packs: d.packs || [], feeMode: d.feeMode || 'absorb',
    subalbums: [], photoCount: 0, bytesOriginal: 0, createdAt: serverTimestamp(),
  };
}

// Crear/editar evento. Superadmin crea eventos generales; el fotógrafo, propios.
function eventDialog(ev, onSaved) {
  const isNew = !ev;
  const general = isNew ? S.isSuper : ev.kind === 'general';
  ev = ev || { name: '', date: todayIso(), location: '', tagIds: [], status: 'draft', openToJoin: general, coverUrl: '' };
  const tax = S.tax;
  const sel = new Set(ev.tagIds || []);
  const dlg = openDialog(isNew ? (general ? 'Nuevo evento general' : 'Nuevo evento') : 'Editar evento', `
    <label class="field">Nombre<input type="text" id="ev-name" required maxlength="100" value="${esc(ev.name)}" placeholder="Ej: Torneo Apertura Sub-14 — Fecha 3"></label>
    <div class="grid2">
      <label class="field">Fecha<input type="date" id="ev-date" required value="${esc(ev.date)}">
        <span class="hint">Podés crear eventos futuros: aparecen en "Próximos eventos" y en el calendario, y la gente puede activar 🔔 para que le avisemos cuando subas las fotos.</span></label>
      <label class="field">Sede / dirección<input type="text" id="ev-loc" maxlength="100" value="${esc(ev.location)}" placeholder="Ej: Cancha de Querandí, Santa Fe"></label>
    </div>
    ${tax.types.map(t => {
      const tags = tax.tags.filter(g => g.typeId === t.id);
      const canAdd = USER_TAG_TYPES.includes(t.id);
      return `<div class="field"><span>${esc(t.name)}</span>
        <div class="pills" data-type-pills="${t.id}">${tags.map(g => `<button type="button" class="chip ${sel.has(g.id) ? 'on' : ''}" data-tag="${g.id}">${esc(g.name)}</button>`).join('') || (canAdd ? '' : '<span class="muted small">Sin etiquetas cargadas</span>')}</div>
        ${canAdd ? `<div class="row" style="margin-top:4px"><input type="text" data-newtag="${t.id}" maxlength="40" placeholder="${tags.length ? '¿No está? Agregá' : 'Agregá'} ${esc(t.name.toLowerCase())}…" style="max-width:260px"><button type="button" class="btn sm" data-addtag="${t.id}">Agregar</button></div>` : ''}
      </div>`;
    }).join('')}
    <input type="hidden" id="ev-cover" value="${esc(ev.coverUrl)}">
    <div class="field"><span>Portada</span>
      ${isNew ? '<span class="muted small">Podés subir la portada después de crear el evento.</span>' : `
        <div class="row"><img id="ev-cover-img" src="${esc(ev.coverUrl)}" alt="" class="${ev.coverUrl ? '' : 'hidden'}" style="width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:8px">
          <label class="btn sm">Subir imagen<input type="file" id="ev-cover-file" accept="image/*" hidden></label>
          ${ev.coverUrl ? '<button type="button" class="btn sm ghost" id="ev-cover-rm">Quitar</button>' : ''}</div>`}
    </div>
    <label class="field">Estado<select id="ev-status"><option value="draft" ${ev.status !== 'published' ? 'selected' : ''}>Borrador (no visible al público)</option><option value="published" ${ev.status === 'published' ? 'selected' : ''}>Publicado</option></select></label>
    ${general ? '<p class="muted small" style="margin:0">Los eventos generales siempre están abiertos para que se sumen fotógrafos.</p>'
      : `<label class="check"><input type="checkbox" id="ev-open" ${ev.openToJoin ? 'checked' : ''}> Permitir que otros fotógrafos se sumen a este evento</label>`}
  `, `<button class="btn" data-close>Cancelar</button><button class="btn primary" id="ev-save">${isNew ? 'Crear' : 'Guardar'}</button>`);

  $('#ev-cover-file', dlg)?.addEventListener('change', async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      toast('Subiendo portada…');
      const { url } = await uploadAsset('cover', await resizeToJpeg(f, 1600, 0.82), ev.id);
      $('#ev-cover', dlg).value = url;
      const img = $('#ev-cover-img', dlg); img.src = url; img.classList.remove('hidden');
    } catch (err) { toast(errMsg(err), 'error'); }
  });
  $('#ev-cover-rm', dlg)?.addEventListener('click', () => { $('#ev-cover', dlg).value = ''; $('#ev-cover-img', dlg).classList.add('hidden'); });
  const bindChip = c => { c.onclick = () => { c.classList.toggle('on'); c.classList.contains('on') ? sel.add(c.dataset.tag) : sel.delete(c.dataset.tag); }; };
  $$('[data-tag]', dlg).forEach(bindChip);
  // Etiquetas nuevas escritas por el fotógrafo (actividad, club, lugar): se crean sin duplicados y quedan para todos.
  const addTag = async typeId => {
    const inp = dlg.querySelector(`[data-newtag="${typeId}"]`);
    const btn = dlg.querySelector(`[data-addtag="${typeId}"]`);
    const name = inp.value.trim();
    if (name.length < 2) return toast('Escribí el nombre.', 'error');
    btn.disabled = true;
    try {
      const { tag, created } = await apiPost('/tags', { type: typeId, name });
      S.tax = await loadTaxonomy(true);
      let chip = dlg.querySelector(`[data-tag="${tag.id}"]`);
      if (!chip) {
        dlg.querySelector(`[data-type-pills="${typeId}"]`).insertAdjacentHTML('beforeend', `<button type="button" class="chip" data-tag="${esc(tag.id)}">${esc(tag.name)}</button>`);
        chip = dlg.querySelector(`[data-tag="${tag.id}"]`);
        bindChip(chip);
      }
      chip.classList.add('on'); sel.add(tag.id);
      inp.value = '';
      if (!created) toast(`"${tag.name}" ya existía: lo marcamos.`);
    } catch (err) { toast(errMsg(err), 'error'); }
    btn.disabled = false;
  };
  $$('[data-addtag]', dlg).forEach(b => b.onclick = () => addTag(b.dataset.addtag));
  $$('[data-newtag]', dlg).forEach(i => i.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); addTag(i.dataset.newtag); } });
  $('#ev-save', dlg).onclick = async () => {
    const name = $('#ev-name', dlg).value.trim(), date = $('#ev-date', dlg).value, loc = $('#ev-loc', dlg).value.trim();
    if (!name || !date) return toast('Completá nombre y fecha.', 'error');
    const tagNames = [...sel].map(id => tax.tagById.get(id)?.name || '');
    const data = {
      name, date, location: loc, tagIds: [...sel].filter(id => tax.tagById.has(id)),
      coverUrl: $('#ev-cover', dlg).value.trim(),
      status: $('#ev-status', dlg).value,
      openToJoin: general ? true : $('#ev-open', dlg).checked,
      searchTokens: searchTokens(name, loc, ...tagNames),
      updatedAt: serverTimestamp(),
    };
    const btn = $('#ev-save', dlg); btn.disabled = true;
    try {
      if (isNew) {
        const ref = doc(collection(db, 'events'));
        const b = writeBatch(db);
        b.set(ref, {
          ...data, kind: general ? 'general' : 'own', createdBy: S.user.uid,
          photographerUids: general ? [] : [S.user.uid], createdAt: serverTimestamp(),
        });
        if (!general) b.set(doc(db, 'events', ref.id, 'sets', S.user.uid), newSetData());
        await b.commit();
        dlg.close();
        toast('Evento creado');
        location.hash = `#/evento/${ref.id}`;
      } else {
        await updateDoc(doc(db, 'events', ev.id), data);
        dlg.close();
        toast('Evento guardado');
        onSaved?.();
      }
    } catch (e) { btn.disabled = false; toast(errMsg(e), 'error'); }
  };
}

// Detalle de evento: datos + set propio (fotógrafo) o lista de sets (superadmin).
async function viewEvent(id) {
  const snap = await getDoc(doc(db, 'events', id));
  if (!snap.exists()) { $('#view').innerHTML = '<div class="empty">Evento no encontrado.</div>'; return; }
  const ev = { id, ...snap.data() };
  const me = S.user.uid;
  const member = (ev.photographerUids || []).includes(me);
  const canEdit = S.isSuper || (ev.kind === 'own' && ev.createdBy === me);
  const tags = tagPills(ev.tagIds, S.tax);
  const back = S.isSuper ? '#/admin/eventos' : '#/eventos';

  $('#view').innerHTML = `
    <a href="${back}" class="muted small" style="text-decoration:none">← Volver</a>
    <div class="card" style="margin-top:10px">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <div class="row" style="margin-bottom:6px">${statusPill(ev)} ${ev.kind === 'general' ? '<span class="pill accent">Evento general</span>' : ''} ${ev.openToJoin ? '<span class="pill">Abierto a fotógrafos</span>' : ''}</div>
          <h1 style="margin-bottom:4px">${esc(ev.name)}</h1>
          <div class="muted">${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}</div>
          ${tags.length ? `<div class="pills" style="margin-top:8px">${tags.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="row">
          ${ev.status === 'published' ? `<a class="btn sm" target="_blank" href="index.html#/evento/${ev.id}">Ver público</a>` : ''}
          <button class="btn sm share-btn" id="ev-share">🔗 Compartir</button>
          ${canEdit ? `<button class="btn sm" id="ev-edit">Editar</button>` : ''}
          ${canEdit ? `<button class="btn sm" id="ev-toggle">${ev.status === 'published' ? 'Despublicar' : 'Publicar'}</button>` : ''}
        </div>
      </div>
    </div>
    <div id="ev-sets"></div>
    <div class="row end" style="margin-top:14px" id="ev-danger"></div>`;

  const reload = () => viewEvent(id);
  $('#ev-share').onclick = () => shareEvent(ev);
  if (canEdit) {
    $('#ev-edit').onclick = () => eventDialog(ev, reload);
    $('#ev-toggle').onclick = async () => {
      try { await updateDoc(doc(db, 'events', id), { status: ev.status === 'published' ? 'draft' : 'published', updatedAt: serverTimestamp() }); reload(); }
      catch (e) { toast(errMsg(e), 'error'); }
    };
  }

  const setsSnap = await getDocs(collection(db, 'events', id, 'sets'));
  const sets = new Map(setsSnap.docs.map(d => [d.id, d.data()]));

  if (S.isSuper) {
    const users = await Promise.all((ev.photographerUids || []).map(uid => getDoc(doc(db, 'users', uid)).then(s => ({ uid, ...(s.data() || {}) }))));
    $('#ev-sets').innerHTML = `<div class="card"><h2>Fotógrafos en el evento (${users.length})</h2>
      ${users.length ? users.map(u => {
        const st = sets.get(u.uid) || {};
        return `<div class="item-row">${avatarHtml(u)}<div class="grow"><strong>${esc(u.displayName || u.uid)}</strong><br><span class="muted small">${fmtMoney(st.price)} por foto · ${st.photoCount || 0} fotos · 💾 ${fmtBytes(setBytes(st))} · ${(st.subalbums || []).length} sub-álbumes</span></div></div>`;
      }).join('') : '<p class="muted">Todavía no se sumó ningún fotógrafo.</p>'}</div>`;
    $('#ev-danger').innerHTML = `<button class="btn danger" id="ev-del">Eliminar evento</button>`;
    $('#ev-del').onclick = async () => {
      // Con ventas no se borra: los compradores tienen que poder descargar (la limpieza borraría los originales).
      const sales = await getDocs(query(collection(db, 'salesStats'), where('eventId', '==', id))).catch(() => null);
      if (setsSnap.docs.some(d => (d.data().soldOrders || 0) > 0) || (sales?.docs || []).some(d => (d.data().soldOrders || 0) > 0)) return toast('Este evento tiene ventas: no se puede eliminar. Pasalo a borrador para ocultarlo.', 'error');
      if (!confirm(`¿Eliminar "${ev.name}"? Se borran también los sets de los fotógrafos.`)) return;
      try {
        const b = writeBatch(db);
        setsSnap.docs.forEach(d => b.delete(d.ref));
        b.delete(doc(db, 'events', id));
        await b.commit();
        toast('Evento eliminado');
        location.hash = back;
      } catch (e) { toast(errMsg(e), 'error'); }
    };
    return;
  }

  if (!member) {
    $('#ev-sets').innerHTML = `<div class="card"><p class="muted">No participás en este evento.</p></div>`;
    return;
  }
  renderSetEditor(ev, sets.get(me) || null, reload);
  const mySet = sets.get(me);
  $('#ext-btn')?.addEventListener('click', () => extensionDialog(ev, mySet));
  $('#space-btn')?.addEventListener('click', () => extensionDialog(ev, mySet, 'space'));
  // La subida avisa cuando el álbum se llenó.
  window.onqmfAlbumFull = () => (isFreePlan(S.profile) ? (location.hash = '#/web') : extensionDialog(ev, mySet, 'space'));
  // Plan Gratis: 1 álbum activo a la vez. Si ya tiene otro, no puede subir acá.
  if (isFreePlan(S.profile) && !setActive(mySet)) {
    getDocs(query(collection(db, 'events'), where('photographerUids', 'array-contains', me), limit(300))).then(async snap => {
      const others = snap.docs.filter(d => d.id !== id);
      const sets = await Promise.all(others.map(d => getDoc(doc(db, 'events', d.id, 'sets', me)).then(x => x.data() || null).catch(() => null)));
      const i = sets.findIndex(setActive);
      if (i < 0 || !$('#dz')) return;
      const other = others[i].data(), del = setDeleteAt(sets[i]);
      $('#dz').classList.add('hidden');
      $('#dz').insertAdjacentHTML('beforebegin', `<div class="notice warn">Con el plan <strong>Gratis</strong> podés tener <strong>1 álbum activo a la vez</strong>, y ya tenés <a href="#/evento/${others[i].id}">${esc(other.name)}</a>${del ? ` (se libera el ${fmtMs(del)})` : ''}.
        <div class="row" style="margin-top:8px"><a class="btn primary sm" href="#/web">⭐ Pasarme a Profesional</a></div></div>`);
    }).catch(() => {});
  }
  // Vuelta de Mercado Pago después de pagar una extensión.
  const extId = parseHash().query.get('ext');
  if (extId) {
    history.replaceState(null, '', `#/evento/${id}`);
    apiPost(`/extensions/${encodeURIComponent(extId)}/sync`).then(r => {
      if (r.status === 'approved') { toast('¡Listo! Pago acreditado'); reload(); }
      else if (r.status === 'rejected') toast('El pago fue rechazado', 'error');
      else toast('El pago todavía se está procesando. Se aplica solo cuando se acredite.');
    }).catch(e => toast(errMsg(e), 'error'));
  }

  const isCreator = ev.createdBy === me && ev.kind === 'own';
  const set = sets.get(me);
  if (isCreator && ev.photographerUids.length === 1) {
    $('#ev-danger').innerHTML = `<button class="btn danger" id="ev-del">Eliminar evento</button>`;
    $('#ev-del').onclick = async () => {
      if ((set?.photoCount || 0) > 0) return toast('Primero borrá las fotos del evento.', 'error');
      if (!confirm(`¿Eliminar "${ev.name}"?`)) return;
      try {
        const b = writeBatch(db);
        if (set) b.delete(doc(db, 'events', id, 'sets', me));
        b.delete(doc(db, 'events', id));
        await b.commit();
        toast('Evento eliminado');
        location.hash = '#/eventos';
      } catch (e) { toast(errMsg(e), 'error'); }
    };
  } else if (!isCreator) {
    $('#ev-danger').innerHTML = `<button class="btn danger" id="ev-leave">Salir del evento</button>`;
    $('#ev-leave').onclick = async () => {
      if ((set?.photoCount || 0) > 0) return toast('Primero borrá tus fotos de este evento.', 'error');
      if (!confirm('¿Salir de este evento?')) return;
      try {
        const b = writeBatch(db);
        if (set) b.delete(doc(db, 'events', id, 'sets', me));
        b.update(doc(db, 'events', id), { photographerUids: arrayRemove(me) });
        await b.commit();
        toast('Saliste del evento');
        location.hash = '#/eventos';
      } catch (e) { toast(errMsg(e), 'error'); }
    };
  }
}

// Link corto propio para el álbum del fotógrafo: quieromisfotos.com.ar/{alias} (Profesional y Premium).
async function drawShortLink(ev) {
  const box = $('#short-link');
  if (!box) return;
  if (!myRules().shortLinks) {
    box.innerHTML = `<p class="muted small" style="margin:0">🔒 Link corto propio (ej: quieromisfotos.com.ar/torneo-apertura): con el plan <a href="#/web">Profesional</a>.</p>`;
    return;
  }
  const snap = await getDocs(query(collection(db, 'aliases'), where('uid', '==', S.user.uid), where('eventId', '==', ev.id))).catch(() => null);
  const mine = snap?.docs[0];
  const base = location.hostname.startsWith('prueba.') ? 'https://prueba.quieromisfotos.com.ar' : 'https://quieromisfotos.com.ar';
  if (mine) {
    const url = `${base}/${mine.id}`;
    box.innerHTML = `<div class="row"><span>🔗 Link corto: <a href="${esc(url)}" target="_blank"><strong>${esc(url.replace('https://', ''))}</strong></a></span>
      <button type="button" class="btn sm" id="sl-copy">Copiar</button><button type="button" class="btn sm ghost" id="sl-del">Quitar</button></div>`;
    $('#sl-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { toast(url); } };
    $('#sl-del').onclick = async () => { if (!confirm('¿Quitar el link corto? Deja de funcionar.')) return; await deleteDoc(mine.ref).catch(e => toast(errMsg(e), 'error')); drawShortLink(ev); };
    return;
  }
  box.innerHTML = `<form class="row" id="sl-form"><span class="muted small">🔗 Link corto:</span><span class="small">quieromisfotos.com.ar/</span>
    <input type="text" id="sl-alias" maxlength="40" placeholder="${esc(slugify(ev.name).slice(0, 30))}" style="max-width:220px"><button class="btn sm">Crear</button></form>`;
  $('#sl-form').onsubmit = async e => {
    e.preventDefault();
    const alias = slugify($('#sl-alias').value || ev.name).slice(0, 40);
    if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(alias)) return toast('Usá entre 3 y 40 letras, números o guiones.', 'error');
    const taken = await getDoc(doc(db, 'aliases', alias)).catch(() => null);
    if (taken?.exists()) return toast('Ese link ya está en uso. Probá con otro.', 'error');
    try { await setDoc(doc(db, 'aliases', alias), { uid: S.user.uid, eventId: ev.id, createdAt: serverTimestamp() }); toast('Link corto creado'); drawShortLink(ev); }
    catch (err) { toast(err.code === 'permission-denied' ? 'Ese nombre no está disponible.' : errMsg(err), 'error'); }
  };
}

function renderSetEditor(ev, set, reload) {
  const box = $('#ev-sets');
  if (!set) {
    box.innerHTML = `<div class="card"><p>No tenés un set en este evento.</p><button class="btn primary" id="mk-set">Crear mi set</button></div>`;
    $('#mk-set').onclick = async () => { try { await setDoc(doc(db, 'events', ev.id, 'sets', S.user.uid), newSetData()); reload(); } catch (e) { toast(errMsg(e), 'error'); } };
    return;
  }
  let subs = (set.subalbums || []).map(s => ({ ...s })).sort((a, b) => a.order - b.order);
  setTimeout(() => drawShortLink(ev), 0);

  box.innerHTML = `
    <div class="card stack">
      <h2>Mi set en este evento</h2>
      ${S.profile.mpConnected ? '' : '<div class="notice danger"><strong>Tus fotos todavía no se pueden comprar:</strong> los compradores ven "todavía no está a la venta" hasta que <a href="#/mp">vincules Mercado Pago</a>.</div>'}
      <div class="row">
        <span class="pill">📷 ${set.photoCount || 0} fotos</span>
        ${(c => c.photos ? `<span class="pill">🗂️ ${c.max ? `${c.used} de ${c.fmt(c.max)}` : 'Sin tope de fotos'}</span>` : `<span class="pill">💾 ${fmtBytes(c.used)}${c.max ? ` de ${fmtBytes(c.max)}` : ''}</span>`)(capOf(set))}
        ${isFreePlan(S.profile) ? '<a class="btn sm" href="#/web">⭐ Más fotos por álbum con un plan pago</a>' : capOf(set).max ? `<button class="btn sm" id="space-btn">➕ ${capOf(set).photos ? 'Más fotos' : 'Más espacio'}</button>` : ''}
      </div>
      ${(c => c.max ? `<div class="meter"><span class="${c.used >= c.max ? 'danger' : c.used >= c.max * 0.9 ? 'warn' : ''}" style="width:${Math.min(100, (c.used / c.max) * 100).toFixed(1)}%"></span></div>` : '')(capOf(set))}
      ${retentionHtml(set)}
      <div id="short-link"></div>
    </div>
    <form class="card stack" id="set-form">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Precios</h2><button type="button" class="btn sm" id="use-def">Usar mis valores por defecto</button></div>
      <label class="field" style="max-width:240px">Precio por foto (ARS)<input type="number" min="0" step="1" id="st-price" value="${set.price || ''}"></label>
      <h3>Packs</h3>
      <div id="st-packs"></div>
      <h3>Comisión</h3>
      <div class="stack" id="st-fee">${feeModeHtml('st-fee', set.feeMode)}</div>
      <h3>¿Cuánto te queda por foto?</h3>
      <div id="st-net"></div>
      <h2 style="margin-top:8px">Sub-álbumes</h2>
      <p class="muted small" style="margin:0">Ej: categorías, partidos o turnos. Ayudan al comprador a encontrar sus fotos.</p>
      <div id="st-subs" class="stack"></div>
      <div class="row"><input type="text" id="st-sub-new" placeholder="Nombre del sub-álbum" style="max-width:300px"><button type="button" class="btn" id="st-sub-add">Agregar</button></div>
      <h2 style="margin-top:8px">Galería</h2>
      <label class="check"><input type="checkbox" id="st-hours" ${set.showHours !== false ? 'checked' : ''}> Mostrar el filtro por horario</label>
      <p class="muted small" style="margin:0">Botones por hora (ej: “15:00 a 16:00”) según la hora en que sacaste cada foto, para que cada uno encuentre la suya más rápido. Desactivalo si la hora de tu cámara no está bien configurada.</p>
      ${S.settings.bibsEnabled === false ? '' : `<label class="check"><input type="checkbox" id="st-bibs" ${bibsOn(set, ev, S.tax) ? 'checked' : ''}> 🔢 Leer los dorsales automáticamente al subir</label>
      <p class="muted small" style="margin:0">Para carreras (running, ciclismo, triatlón…): cada participante busca su número y ve solo sus fotos. Se aplica a las fotos que subas desde ahora; si alguno no se leyó bien, lo corregís con “🔢 Dorsales” en tus fotos.</p>
      <p class="muted small" style="margin:0">🔗 Link directo para cada corredor (cambiá el número al final): <code style="word-break:break-all">${esc(`${location.origin}/e/${ev.id}/?s=1&dorsal=123`)}</code></p>`}
      <div class="row end"><button class="btn primary" type="submit">Guardar set</button></div>
    </form>
    <div id="set-photos"></div>`;
  mountPhotos($('#set-photos'), { ev, set, uid: S.user.uid, profile: S.profile, settings: S.settings, bibs: bibsOn(set, ev, S.tax) })
    .catch(e => { $('#set-photos').innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`; });

  const stFee = () => $('input[name=st-fee]:checked')?.value || 'absorb';
  let packs = packsEditor($('#st-packs'), set.packs, stFee, () => Number($('#st-price').value) || 0);
  const drawNet = () => { $('#st-net').innerHTML = breakdownHtml(Math.round(Number($('#st-price').value) || 0), stFee()); packs.refresh(); };
  $('#st-price').addEventListener('input', drawNet);
  $('#st-fee').addEventListener('change', drawNet);
  drawNet();
  const drawSubs = () => {
    $('#st-subs').innerHTML = subs.length ? subs.map((s, i) => `
      <div class="row">
        <input type="text" data-sub="${i}" value="${esc(s.name)}" style="flex:1;min-width:160px">
        <button type="button" class="btn sm" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="btn sm" data-down="${i}" ${i === subs.length - 1 ? 'disabled' : ''}>↓</button>
        <button type="button" class="btn sm danger" data-rm="${i}">✕</button>
      </div>`).join('') : '<p class="muted small" style="margin:0">Sin sub-álbumes: todas las fotos van juntas.</p>';
    $$('[data-sub]').forEach(inp => inp.oninput = () => { subs[inp.dataset.sub].name = inp.value; });
    $$('[data-up]').forEach(b => b.onclick = () => { const i = +b.dataset.up; [subs[i - 1], subs[i]] = [subs[i], subs[i - 1]]; drawSubs(); });
    $$('[data-down]').forEach(b => b.onclick = () => { const i = +b.dataset.down; [subs[i + 1], subs[i]] = [subs[i], subs[i + 1]]; drawSubs(); });
    $$('[data-rm]').forEach(b => b.onclick = () => {
      subs.splice(+b.dataset.rm, 1); drawSubs();
    });
  };
  drawSubs();
  $('#st-sub-add').onclick = () => {
    const name = $('#st-sub-new').value.trim();
    if (!name) return;
    subs.push({ id: newId(), name, order: subs.length });
    $('#st-sub-new').value = '';
    drawSubs();
  };
  $('#use-def').onclick = () => {
    const d = S.profile.defaults || {};
    $('#st-price').value = d.price || '';
    packs = packsEditor($('#st-packs'), d.packs, stFee, () => Number($('#st-price').value) || 0);
    $('#st-fee').innerHTML = feeModeHtml('st-fee', d.feeMode);
    drawNet();
  };
  $('#set-form').onsubmit = async e => {
    e.preventDefault();
    try {
      const clean = subs.map((s, i) => ({ id: s.id, name: s.name.trim(), order: i })).filter(s => s.name);
      // Las fotos de sub-álbumes eliminados pasan a "Sin sub-álbum".
      const removed = (set.subalbums || []).map(s => s.id).filter(id => !clean.some(c => c.id === id));
      for (const sid of removed) {
        const ps = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', S.user.uid), where('subalbumId', '==', sid)));
        for (let i = 0; i < ps.docs.length; i += 400) {
          const b = writeBatch(db);
          ps.docs.slice(i, i + 400).forEach(d => b.update(d.ref, { subalbumId: '' }));
          await b.commit();
        }
      }
      await updateDoc(doc(db, 'events', ev.id, 'sets', S.user.uid), {
        price: Math.round(Number($('#st-price').value) || 0),
        packs: packs.get(),
        feeMode: $('input[name=st-fee]:checked').value,
        subalbums: clean,
        showHours: $('#st-hours').checked,
        ...($('#st-bibs') ? { detectBibs: $('#st-bibs').checked } : {}),
        updatedAt: serverTimestamp(),
      });
      toast('Set guardado');
      reload();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// ================================================================ superadmin: fotógrafos
let photogTab = 'pending';
async function viewAdminPhotographers() {
  const view = $('#view');
  const tabs = [['pending', 'Pendientes'], ['approved', 'Aprobados'], ['suspended', 'Suspendidos']];
  view.innerHTML = `
    <h1>Fotógrafos</h1>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="chip ${photogTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="card" id="pl"><div class="spinner"></div></div>`;
  $$('[data-tab]').forEach(b => b.onclick = () => { photogTab = b.dataset.tab; viewAdminPhotographers(); });

  const snap = await getDocs(query(collection(db, 'users'), where('status', '==', photogTab)));
  const users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role === 'photographer')
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  const privs = await Promise.all(users.map(u => getDoc(doc(db, 'userPrivate', u.uid)).then(s => s.data() || {}).catch(() => ({}))));
  const reqs = await Promise.all(users.map(u => getDoc(doc(db, 'planRequests', u.uid)).then(s => s.data() || null).catch(() => null)));
  $('#pl').innerHTML = users.length ? users.map((u, i) => `
    <div class="item-row">
      ${avatarHtml(u)}
      <div class="grow">
        <strong>${esc(u.displayName)}</strong> <span class="muted small">/${esc(u.slug)}</span><br>
        <span class="muted small">${esc(privs[i].email || '')}${u.zone ? ' · ' + esc(u.zone) : ''} · alta ${esc(fmtTs(u.createdAt))}</span><br>
        ${u.mpConnected ? '<span class="pill ok">MP vinculado</span>' : `<span class="pill ${u.status === 'approved' ? 'danger' : ''}">MP sin vincular</span>`}
        ${planOf(u) !== 'free' ? `<span class="pill accent">⭐ ${esc(PLANS[planOf(u)].label)} ${u.courtesy ? '· cortesía, sin vencimiento' : `hasta ${esc(fmtTs(u.proUntil))}`}</span>` : '<span class="pill">Gratis</span>'}
        ${reqs[i] && reqs[i].plan !== planOf(u) ? `<span class="pill warn">Pidió: ${esc(PLANS[reqs[i].plan]?.label || reqs[i].plan)}</span>` : ''}
        ${u.site?.requestedDomain && !u.domainActive ? `<span class="pill warn">Dominio pedido: ${esc(u.site.requestedDomain)}</span>` : ''}
        ${u.domainActive ? `<span class="pill ok">🌐 ${esc(u.siteDomain)}</span>` : ''}
      </div>
      <div class="row">
        <a class="btn sm" target="_blank" href="index.html#/f/${esc(u.slug)}">Perfil</a>
        ${u.status !== 'approved' ? `<button class="btn sm ok" data-st="approved" data-uid="${u.uid}">Aprobar</button>` : ''}
        ${u.status !== 'suspended' ? `<button class="btn sm danger" data-st="suspended" data-uid="${u.uid}">Suspender</button>` : ''}
        ${u.status === 'suspended' ? `<button class="btn sm" data-st="pending" data-uid="${u.uid}">Volver a pendiente</button>` : ''}
        ${u.status === 'approved' ? `<select data-plan-sel="${u.uid}" style="width:auto">${Object.entries(PLANS).filter(([k]) => k !== 'free').map(([k, p]) => `<option value="${k}" ${(reqs[i]?.plan || planOf(u)) === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>
          <button class="btn sm" data-pro="${u.uid}">+30 días</button>
          <button class="btn sm" data-courtesy="${u.uid}" title="Plan sin costo y sin vencimiento, hasta que lo quites">🎁 Cortesía</button>` : ''}
        ${isPro(u) ? `<button class="btn sm ghost" data-unpro="${u.uid}">Quitar plan</button>` : ''}
        ${planOf(u) === 'webdomain' && u.site?.requestedDomain && !u.domainActive ? `<button class="btn sm ok" data-dom="${u.uid}">Activar dominio</button>` : ''}
        ${planOf(u) !== 'free' && PLANS[planOf(u)].web ? `<a class="btn sm" target="_blank" href="${esc(siteUrlOf(u))}">Web</a>` : ''}
      </div>
    </div>`).join('') : '<div class="empty">No hay fotógrafos en esta lista.</div>';
  $$('[data-pro]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.pro);
    const plan = $(`[data-plan-sel="${u.uid}"]`).value;
    const from = isPro(u) ? u.proUntil.toMillis() : Date.now();
    try {
      await updateDoc(doc(db, 'users', u.uid), { plan, proUntil: Timestamp.fromMillis(from + 30 * 86400000), courtesy: false });
      await deleteDoc(doc(db, 'planRequests', u.uid)).catch(() => {});
      toast(`Plan ${PLANS[plan].label} activo por 30 días más`);
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  // Cortesía: el plan elegido, sin costo y sin vencimiento (ej. familia, socios, prensa).
  $$('[data-courtesy]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.courtesy);
    const plan = $(`[data-plan-sel="${u.uid}"]`).value;
    if (!confirm(`¿Dar a ${u.displayName} el plan ${PLANS[plan].label} de cortesía, sin costo y sin vencimiento?`)) return;
    try {
      await updateDoc(doc(db, 'users', u.uid), { plan, proUntil: Timestamp.fromDate(new Date('2099-12-31T00:00:00Z')), courtesy: true, trial: false });
      await deleteDoc(doc(db, 'planRequests', u.uid)).catch(() => {});
      toast(`${u.displayName}: plan ${PLANS[plan].label} de cortesía`);
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  $$('[data-unpro]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Quitar el plan? Las fotos de portfolio que superen el límite gratis se ocultan (no se borran) y su web deja de estar disponible.')) return;
    try { await updateDoc(doc(db, 'users', b.dataset.unpro), { plan: 'free', proUntil: null, courtesy: false }); viewAdminPhotographers(); }
    catch (e) { toast(errMsg(e), 'error'); }
  });
  $$('[data-dom]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.dom);
    const d = u.site.requestedDomain;
    if (!confirm(`¿Activar ${d} para ${u.displayName}?\n\nAntes agregalo en Cloudflare (quieromisfotos.com.ar → SSL/TLS → Custom Hostnames) como ${d} y www.${d}, y verificá que el fotógrafo apuntó su DNS.`)) return;
    try {
      const bt = writeBatch(db);
      bt.set(doc(db, 'domains', d), { uid: u.uid, createdAt: serverTimestamp() });
      bt.set(doc(db, 'domains', `www.${d}`), { uid: u.uid, createdAt: serverTimestamp() });
      bt.update(doc(db, 'users', u.uid), { domainActive: true, siteDomain: d });
      await bt.commit();
      toast('Dominio activado');
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  $$('[data-st]').forEach(b => b.onclick = async () => {
    try {
      const upd = { status: b.dataset.st, statusChangedAt: serverTimestamp() };
      // Prueba gratis del plan Profesional al aprobar (una sola vez por fotógrafo, con planes nuevos).
      const u = users.find(x => x.uid === b.dataset.uid);
      const trialDays = Number(S.settings.trialDays ?? 30);
      const gaveTrial = b.dataset.st === 'approved' && trialDays > 0 && u && !u.trialUsed && planOf(u) === 'free';
      if (gaveTrial) Object.assign(upd, { plan: 'web', proUntil: Timestamp.fromMillis(Date.now() + trialDays * 86400000), trial: true, trialUsed: true });
      await updateDoc(doc(db, 'users', b.dataset.uid), upd);
      toast(b.dataset.st === 'approved' ? `Fotógrafo aprobado${gaveTrial ? ` con ${trialDays} días de Profesional gratis` : ''}` : 'Estado actualizado');
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  });
}

// ================================================================ superadmin: eventos
let adminEvFilter = 'all';
async function viewAdminEvents() {
  const snap = await getDocs(query(collection(db, 'events'), orderBy('date', 'desc'), limit(300)));
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const evs = all.filter(e => adminEvFilter === 'all' || e.kind === adminEvFilter);
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Eventos</h1>
      <button class="btn primary" id="new">+ Evento general</button>
    </div>
    <div class="tabs">${[['all', 'Todos'], ['general', 'Generales'], ['own', 'De fotógrafos']].map(([k, l]) => `<button class="chip ${adminEvFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    ${evs.length ? `<div class="events-grid">${evs.map(ev => panelEventCard(ev)).join('')}</div>` : '<div class="card"><div class="empty">No hay eventos.</div></div>'}`;
  $('#new').onclick = () => eventDialog(null);
  $$('[data-f]').forEach(b => b.onclick = () => { adminEvFilter = b.dataset.f; viewAdminEvents(); });
  $$('[data-share]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); shareEvent(evs.find(x => x.id === b.dataset.share)); });
}

// ================================================================ superadmin: clientes
let custFilter = 'all', custQ = '';
async function viewAdminCustomers() {
  const [cs, os, us, ps] = await Promise.all([
    getDocs(query(collection(db, 'customers'), limit(5000))).catch(() => null),
    getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(5000))),
    getDocs(query(collection(db, 'users'), where('role', '==', 'photographer'))),
    getDocs(query(collection(db, 'orderPrivate'), limit(5000))).catch(() => null),
  ]);
  const photogs = new Set(us.docs.map(d => d.id));
  const priv = new Map((ps?.docs || []).map(d => [d.id, d.data()]));
  const ts = t => t?.toMillis?.() || 0;
  const map = new Map();
  const get = (uid, base = {}) => { if (!map.has(uid)) map.set(uid, { uid, name: '', email: '', createdAt: 0, lastLoginAt: 0, orders: 0, photos: 0, spent: 0, lastBuy: 0, events: new Set(), ...base }); return map.get(uid); };
  for (const d of cs?.docs || []) {
    const c = d.data();
    Object.assign(get(d.id), { name: c.name || '', email: c.email || '', provider: c.provider || '', createdAt: ts(c.createdAt), lastLoginAt: ts(c.lastLoginAt) });
  }
  // Los que compraron antes de existir el registro salen de sus pedidos.
  for (const d of os.docs) {
    const o = d.data();
    if (!o.buyerUid || o.status !== 'approved') continue;
    const c = get(o.buyerUid);
    const pv = priv.get(d.id) || {};
    if (!c.email) c.email = pv.buyerEmail || o.buyerEmail || '';
    if (!c.name) c.name = pv.buyerName || o.buyerName || '';
    c.orders++; c.photos += o.count || 0; c.spent += o.total || 0;
    c.lastBuy = Math.max(c.lastBuy, ts(o.paidAt || o.createdAt));
    if (!c.createdAt) c.createdAt = ts(o.createdAt);
    c.events.add(o.eventName || o.eventId);
  }
  const all = [...map.values()].map(c => ({ ...c, photographer: photogs.has(c.uid) }));
  const q = normalize(custQ);
  const list = all
    .filter(c => custFilter === 'all' || (custFilter === 'buyers' ? c.orders > 0 : c.orders === 0))
    .filter(c => !q || normalize(`${c.name} ${c.email}`).includes(q))
    .sort((a, b) => (b.lastBuy || b.lastLoginAt || b.createdAt) - (a.lastBuy || a.lastLoginAt || a.createdAt));
  const d = ms => (ms ? new Date(ms).toLocaleDateString('es-AR') : '—');
  const buyers = all.filter(c => c.orders > 0);

  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Clientes</h1><button class="btn" id="cu-csv">⬇️ Exportar CSV</button>
    </div>
    <div class="stats">
      <div class="stat"><span class="muted small">Registrados</span><strong>${all.length}</strong></div>
      <div class="stat"><span class="muted small">Compraron</span><strong>${buyers.length}</strong><span class="muted small">${all.length ? Math.round((buyers.length / all.length) * 100) : 0}% de los registrados</span></div>
      <div class="stat"><span class="muted small">Volvieron a comprar</span><strong>${buyers.filter(c => c.orders > 1).length}</strong></div>
      <div class="stat"><span class="muted small">Gasto promedio</span><strong>${fmtMoney(buyers.length ? buyers.reduce((a, c) => a + c.spent, 0) / buyers.length : 0)}</strong></div>
    </div>
    <div class="row" style="margin-bottom:12px">
      <input type="search" id="cu-q" placeholder="Buscar por nombre o email" value="${esc(custQ)}" style="max-width:320px">
      <div class="tabs" style="margin:0">${[['all', 'Todos'], ['buyers', 'Compraron'], ['none', 'Nunca compraron']].map(([k, l]) => `<button class="chip ${custFilter === k ? 'on' : ''}" data-cf="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="card">${list.length ? `<div class="table-wrap"><table class="list">
      <tr><th>Cliente</th><th>Alta</th><th>Último ingreso</th><th>Compras</th><th>Fotos</th><th>Gastó</th><th>Última compra</th><th>Eventos</th></tr>
      ${list.slice(0, 500).map(c => `<tr>
        <td><strong>${esc(c.name || '—')}</strong>${c.photographer ? ' <span class="pill">Fotógrafo</span>' : ''}<br><span class="muted small">${esc(c.email)}</span></td>
        <td>${d(c.createdAt)}</td><td>${d(c.lastLoginAt)}</td><td>${c.orders}</td><td>${c.photos}</td><td>${c.spent ? fmtMoney(c.spent) : '—'}</td>
        <td>${d(c.lastBuy)}</td><td class="small">${esc([...c.events].slice(0, 3).join(', '))}${c.events.size > 3 ? ` +${c.events.size - 3}` : ''}</td></tr>`).join('')}
    </table></div>${list.length > 500 ? '<p class="muted small">Se muestran los primeros 500: usá la búsqueda o exportá el CSV.</p>' : ''}`
      : '<div class="empty">No hay clientes con ese filtro.</div>'}</div>
    <p class="muted small">Desde el 14/10/2026 se registra a todos los que ingresan al sitio. Antes, solo figuran los que compraron.</p>`;

  let t;
  $('#cu-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { custQ = e.target.value; viewAdminCustomers().then(() => { const i = $('#cu-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); };
  $$('[data-cf]').forEach(b => b.onclick = () => { custFilter = b.dataset.cf; viewAdminCustomers(); });
  $('#cu-csv').onclick = () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Nombre', 'Email', 'Fotógrafo', 'Alta', 'Último ingreso', 'Compras', 'Fotos', 'Gastó', 'Última compra', 'Eventos'],
      ...list.map(c => [c.name, c.email, c.photographer ? 'sí' : '', d(c.createdAt), d(c.lastLoginAt), c.orders, c.photos, c.spent, d(c.lastBuy), [...c.events].join(' | ')])];
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `clientes-quieromisfotos-${todayIso()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// ================================================================ superadmin: métricas
let metricsRange = 30;
async function viewAdminMetrics() {
  const [os, xs, us] = await Promise.all([
    getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(2000))),
    getDocs(query(collection(db, 'extensions'), where('status', '==', 'approved'))).catch(() => null),
    getDocs(query(collection(db, 'users'), where('role', '==', 'photographer'))),
  ]);
  const ts = o => (o.paidAt || o.createdAt)?.toMillis?.() || 0;
  const all = os.docs.map(d => ({ id: d.id, ...d.data() })).filter(o => o.status === 'approved');
  const exts = (xs?.docs || []).map(d => d.data());
  const users = us.docs.map(d => ({ uid: d.id, ...d.data() }));
  const from = metricsRange ? Date.now() - metricsRange * 86400000 : 0;
  const orders = all.filter(o => ts(o) >= from);
  const extIn = exts.filter(x => (x.paidAt?.toMillis?.() || 0) >= from);
  const sum = (l, f) => l.reduce((a, x) => a + (f(x) || 0), 0);
  const commission = sum(orders, o => o.platformFee);
  const extRevenue = sum(extIn, x => x.price);
  // Planes vigentes: ingreso mensual recurrente estimado.
  const active = users.filter(u => planOf(u) !== 'free');
  const mrr = sum(active, u => planSpec(planOf(u), S.settings).price || 0);
  const buyers = new Set(orders.map(o => o.buyerUid)).size;
  const approvedPh = users.filter(u => u.status === 'approved');
  const selling = new Set(orders.map(o => o.photographerUid));
  // Por mes (últimos 12).
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); d.setMonth(d.getMonth() - 11 + i); return d; });
  const byMonth = months.map((d, i) => {
    const end = months[i + 1]?.getTime() || Infinity;
    const l = all.filter(o => ts(o) >= d.getTime() && ts(o) < end);
    const e = exts.filter(x => { const t = x.paidAt?.toMillis?.() || 0; return t >= d.getTime() && t < end; });
    return { label: d.toLocaleDateString('es-AR', { month: 'short' }), v: sum(l, o => o.platformFee) + sum(e, x => x.price), gmv: sum(l, o => o.total) };
  });
  const maxM = Math.max(1, ...byMonth.map(m => m.v));
  const group = (key, name) => {
    const m = new Map();
    for (const o of orders) {
      const g = m.get(o[key]) || { name: o[name] || o[key], n: 0, photos: 0, gmv: 0, fee: 0 };
      g.n++; g.photos += o.count || 0; g.gmv += o.total || 0; g.fee += o.platformFee || 0;
      m.set(o[key], g);
    }
    return [...m.values()].sort((a, b) => b.gmv - a.gmv).slice(0, 15);
  };
  const table = (rows, first) => rows.length ? `<div class="table-wrap"><table class="list"><tr><th>${first}</th><th>Ventas</th><th>Fotos</th><th>Vendido</th><th>Tu comisión</th></tr>
    ${rows.map(r => `<tr><td>${esc(r.name)}</td><td>${r.n}</td><td>${r.photos}</td><td>${fmtMoney(r.gmv)}</td><td>${fmtMoney(r.fee)}</td></tr>`).join('')}</table></div>` : '<p class="muted">Sin ventas en el período.</p>';

  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Métricas</h1>
      <div class="tabs" style="margin:0">${[[7, '7 días'], [30, '30 días'], [90, '90 días'], [0, 'Todo']].map(([k, l]) => `<button class="chip ${metricsRange === k ? 'on' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="stats">
      <div class="stat"><span class="muted small">Tus ingresos</span><strong>${fmtMoney(commission + extRevenue)}</strong><span class="muted small">comisiones ${fmtMoney(commission)} · extensiones ${fmtMoney(extRevenue)}</span></div>
      <div class="stat"><span class="muted small">Vendido por los fotógrafos</span><strong>${fmtMoney(sum(orders, o => o.total))}</strong><span class="muted small">${orders.length} ventas · ${sum(orders, o => o.count)} fotos</span></div>
      <div class="stat"><span class="muted small">Compradores</span><strong>${buyers}</strong><span class="muted small">ticket promedio ${fmtMoney(orders.length ? sum(orders, o => o.total) / orders.length : 0)}</span></div>
      <div class="stat"><span class="muted small">Fotógrafos</span><strong>${approvedPh.length}</strong><span class="muted small">${selling.size} con ventas en el período · ${users.filter(u => u.status === 'pending').length} pendientes</span></div>
      <div class="stat"><span class="muted small">Planes activos</span><strong>${active.length}</strong><span class="muted small">≈ ${fmtMoney(mrr)}/mes</span></div>
    </div>
    <div class="card"><h2>Tus ingresos por mes</h2>
      <div class="spark tall">${byMonth.map(m => `<span style="height:${Math.max(2, (m.v / maxM) * 100)}%" title="${m.label}: ${fmtMoney(m.v)} (vendido ${fmtMoney(m.gmv)})"></span>`).join('')}</div>
      <div class="spark-labels">${byMonth.map(m => `<span>${m.label}</span>`).join('')}</div>
      <p class="muted small">Comisiones + extensiones. Los planes (Pro/Web) se suman cuando se cobren por Mercado Pago.</p></div>
    <div class="card"><h2>Por fotógrafo</h2>${table(group('photographerUid', 'photographerName'), 'Fotógrafo')}</div>
    <div class="card"><h2>Por evento</h2>${table(group('eventId', 'eventName'), 'Evento')}</div>`;
  $$('[data-r]').forEach(b => b.onclick = () => { metricsRange = Number(b.dataset.r); viewAdminMetrics(); });
}

// ================================================================ superadmin: almacenamiento (R2)
// Precios de Cloudflare R2 (clase estándar). Revisar si Cloudflare los cambia.
const R2 = { freeGB: 10, usdPerGB: 0.015, freeA: 1e6, freeB: 1e7 };

function r2Cost(bytes) {
  return Math.max(0, bytes / 1e9 - R2.freeGB) * R2.usdPerGB;
}
const fmtUsd = n => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function viewAdminStorage() {
  const [snap, bsnap] = await Promise.all([getDoc(doc(db, 'adminStats', 'storage')), getDoc(doc(db, 'adminStats', 'backup')).catch(() => null)]);
  const st = snap.exists() ? snap.data() : null;
  const bk = bsnap?.exists() ? bsnap.data() : null;
  const scanBtn = '<button class="btn primary" id="st-scan">🔄 Recalcular ahora</button>';
  if (!st) {
    $('#view').innerHTML = `<h1>Almacenamiento</h1><div class="card stack"><p class="muted">Todavía no se calculó el uso. Se calcula solo todos los días; podés hacerlo ahora.</p><div>${scanBtn}</div></div>`;
    bindScan();
    return;
  }
  const total = st.total || 0;
  const pct = Math.min(100, (total / (R2.freeGB * 1e9)) * 100);
  // Cloudflare cobra el promedio del mes: se estima con las mediciones diarias del mes en curso.
  const month = new Date().toISOString().slice(0, 7);
  const monthH = (st.history || []).filter(h => h.d.startsWith(month));
  const avg = monthH.length ? monthH.reduce((a, h) => a + h.b, 0) / monthH.length : total;
  const users = Object.entries(st.byUser || {}).map(([uid, u]) => ({ uid, ...u, bytes: (u.albumsBytes || 0) + (u.profile || 0) })).sort((a, b) => b.bytes - a.bytes);
  const top = st.topSets || [];
  const uids = [...new Set([...users.map(u => u.uid), ...top.map(t => t.uid), ...(st.retention ? [...(st.retention.due || []), ...(st.retention.upcoming || []), ...(st.retention.lastDeleted || [])].map(t => t.uid) : [])])];
  const ret = st.retention || { upcoming: [], due: [], lastDeleted: [] };
  const retRows = [...(ret.due || []), ...(ret.upcoming || []), ...(ret.lastDeleted || [])];
  const eids = [...new Set([...top.map(t => t.eid), ...retRows.map(t => t.eid)])];
  const [uDocs, eDocs] = await Promise.all([
    Promise.all(uids.map(id => getDoc(doc(db, 'users', id)).then(s => [id, s.data() || {}]).catch(() => [id, {}]))),
    Promise.all(eids.map(id => getDoc(doc(db, 'events', id)).then(s => [id, s.data() || {}]).catch(() => [id, {}]))),
  ]);
  const uMap = new Map(uDocs), eMap = new Map(eDocs);
  const uName = id => uMap.get(id)?.displayName || id;
  const hist = (st.history || []).slice(-30);
  const maxH = Math.max(1, ...hist.map(h => h.b));

  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Almacenamiento (R2)</h1>${scanBtn}
    </div>
    <div class="card stack">
      <div class="stat-grid">
        <div><span class="muted small">Usado ahora</span><strong class="big">${fmtBytes(total)}</strong></div>
        <div><span class="muted small">Gratis hasta</span><strong class="big">${R2.freeGB} GB</strong></div>
        <div><span class="muted small">Te queda gratis</span><strong class="big">${fmtBytes(Math.max(0, R2.freeGB * 1e9 - total))}</strong></div>
        <div><span class="muted small">Costo estimado del mes</span><strong class="big">${fmtUsd(r2Cost(avg))}</strong></div>
      </div>
      <div class="meter"><span style="width:${pct.toFixed(1)}%" class="${pct > 90 ? 'danger' : pct > 70 ? 'warn' : ''}"></span></div>
      <p class="muted small" style="margin:0">${pct.toFixed(1)}% del espacio gratis · originales ${fmtBytes(st.privateBytes)} · muestras, miniaturas y perfiles ${fmtBytes(st.publicBytes)} · ${(st.objects || 0).toLocaleString('es-AR')} archivos.
        ${st.orphanBytes ? `<br>⚠️ ${fmtBytes(st.orphanBytes)} de archivos de álbumes ya borrados (se pueden limpiar).` : ''}</p>
      <p class="muted small" style="margin:0">Cloudflare cobra <strong>US$ ${String(R2.usdPerGB).replace('.', ',')}</strong> por GB por mes pasando los ${R2.freeGB} GB (promedio del mes). Descargar no cuesta nada. Las operaciones (subir/leer) son gratis hasta 1 millón y 10 millones por mes: con este uso no se llega.
        Ejemplo: 100 GB ≈ ${fmtUsd(r2Cost(100e9))}/mes · 500 GB ≈ ${fmtUsd(r2Cost(500e9))}/mes.</p>
      <p class="muted small" style="margin:0">Última medición: ${st.scannedAt ? st.scannedAt.toDate().toLocaleString('es-AR') : '—'} (se recalcula sola todos los días).</p>
    </div>
    <form class="card stack" id="lim-form"><h2 style="margin:0">Subida de fotos</h2>
      <p class="muted small" style="margin:0">La cantidad de fotos por álbum de cada plan se define en Plataforma → Planes. Referencia: una foto ocupa ~${fmtBytes(top.length ? top.reduce((a, t) => a + t.bytes, 0) / Math.max(1, top.reduce((a, t) => a + (t.photos || 0), 0)) : 12e6)}.</p>
      <label class="check"><input type="checkbox" id="lim-opt" ${S.settings.optimizeOriginals !== false ? 'checked' : ''}> Optimizar los originales al subir (todos los fotógrafos)</label>
      <p class="muted small" style="margin:0">Se guardan a la misma resolución con calidad JPEG 92%: no se nota a simple vista ni impresa, ocupan ~40-50% y la subida es más rápida. Si lo destildás, se guarda el archivo exacto de la cámara.</p>
      <label class="check"><input type="checkbox" id="lim-bibs" ${S.settings.bibsEnabled !== false ? 'checked' : ''}> 🔢 Lectura automática de dorsales (todos los fotógrafos)</label>
      <p class="muted small" style="margin:0">Con IA de Cloudflare (Workers AI): las primeras ~200 fotos por día son gratis; después cuesta ~US$ 0,55 cada 1.000 fotos. Cada fotógrafo la activa en su álbum (viene activada en running, ciclismo, triatlón…).</p>
      <h3 style="margin:4px 0 0">Packs adicionales para un álbum</h3>
      <p class="muted small" style="margin:0">Fotos extra para un álbum. Solo planes pagos (el Gratis tiene tope fijo).</p>
      <div id="lim-plans" class="stack"></div>
      <div class="row"><button type="button" class="btn sm" id="lim-add">+ Agregar pack</button><span class="spacer" style="flex:1"></span><button class="btn primary">Guardar</button></div>
    </form>
    <div class="card stack"><h2 style="margin:0">Borrado de originales</h2>
      <p class="muted small" style="margin:0">Los álbumes se venden ${S.settings.retentionDays} días desde la primera foto (más las extensiones pagas). Después quedan ${GRACE_DAYS} días para descargas y para extender, y se borran los originales (las muestras quedan).
        ${ret.mode === 'on' ? '<strong>Borrado activo.</strong>' : '<strong>Modo simulación:</strong> todavía no borra nada, solo informa.'}</p>
      ${retTable('Para borrar ahora', ret.due || [], 'deleteAt')}
      ${retTable('Próximos a borrarse', ret.upcoming || [], 'deleteAt')}
      ${retTable('Último borrado', ret.lastDeleted || [], 'deleteAt')}
    </div>
    <div class="card stack"><h2 style="margin:0">Limpieza de archivos sueltos</h2>
      <p class="muted small" style="margin:0">Todos los días se borran de R2 los archivos que ya no se usan (álbumes o eventos borrados, subidas cortadas, portadas, avatares y fotos de portfolio reemplazados), con más de 2 días de antigüedad.
        ${st.cleanup?.mode === 'on' ? '' : '<strong>Modo simulación.</strong>'}</p>
      ${st.cleanup?.count ? `<p style="margin:0">${st.cleanup.mode === 'on' ? 'Último borrado' : 'Se borrarían'}: <strong>${st.cleanup.count} archivos (${fmtBytes(st.cleanup.bytes)})</strong></p>
        <ul class="small" style="margin:0">${Object.entries(st.cleanup.byReason || {}).map(([r, v]) => `<li>${esc(r)}: ${v.count} (${fmtBytes(v.bytes)})</li>`).join('')}</ul>`
        : `<p class="muted small" style="margin:0">${st.cleanup?.error ? `Error: ${esc(st.cleanup.error)}` : '✅ No hay archivos sueltos.'}</p>`}
    </div>
    <div class="card row" style="justify-content:space-between">
      <div><h2 style="margin:0 0 4px">Respaldo de la base de datos</h2>
        <span class="muted small">${bk ? `Último: ${bk.at.toDate().toLocaleString('es-AR')} · ${fmtBytes(bk.total)} · se guardan las últimas 8 semanas` : 'Todavía no hay respaldos.'} Se hace solo todos los lunes en el almacenamiento privado.</span></div>
      <button class="btn sm" id="bk-now">💾 Respaldar ahora</button>
    </div>
    ${hist.length > 1 ? `<div class="card"><h2>Últimos ${hist.length} días</h2>
      <div class="spark">${hist.map(h => `<span style="height:${Math.max(2, (h.b / maxH) * 100)}%" title="${esc(h.d)}: ${fmtBytes(h.b)}"></span>`).join('')}</div></div>` : ''}
    <div class="card"><h2>Por fotógrafo</h2>
      ${users.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Fotógrafo</th><th>Álbumes</th><th>Fotos</th><th>En álbumes</th><th>Perfil y portfolio</th><th>Total</th><th>Costo/mes*</th></tr></thead><tbody>
        ${users.map(u => `<tr><td>${esc(uName(u.uid))}</td><td>${u.albums}</td><td>${(u.photos || 0).toLocaleString('es-AR')}</td><td>${fmtBytes(u.albumsBytes)}</td><td>${fmtBytes(u.profile)}</td><td><strong>${fmtBytes(u.bytes)}</strong></td><td>${fmtUsd((u.bytes / 1e9) * R2.usdPerGB)}</td></tr>`).join('')}
      </tbody></table></div><p class="muted small">* Lo que costaría ese espacio si ya pasaste los ${R2.freeGB} GB gratis.</p>` : '<p class="muted">Sin datos.</p>'}
    </div>
    <div class="card"><h2>Álbumes más pesados</h2>
      ${top.length ? `<div class="table-wrap"><table class="list"><thead><tr><th>Evento</th><th>Fotógrafo</th><th>Fotos</th><th>Tamaño</th><th>Promedio por foto</th></tr></thead><tbody>
        ${top.map(t => `<tr><td><a href="#/evento/${esc(t.eid)}">${esc(eMap.get(t.eid)?.name || t.eid)}</a></td><td>${esc(uName(t.uid))}</td><td>${(t.photos || 0).toLocaleString('es-AR')}</td><td><strong>${fmtBytes(t.bytes)}</strong></td><td>${t.photos ? fmtBytes(t.bytes / t.photos) : '—'}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="muted">Sin álbumes.</p>'}
    </div>`;
  bindScan();
  $('#bk-now').onclick = async e => {
    const b = e.target; b.disabled = true; b.textContent = 'Respaldando…';
    try { const r = await apiPost('/admin/backup'); toast(`Respaldo listo (${fmtBytes(r.total)})`); viewAdminStorage(); }
    catch (err) { toast(errMsg(err), 'error'); b.disabled = false; b.textContent = '💾 Respaldar ahora'; }
  };

  // ---- límite por álbum + packs de espacio
  let sp = (S.settings.storagePlans || []).map(p => ({ ...p }));
  const drawPlans = () => {
    $('#lim-plans').innerHTML = sp.length ? sp.map((p, i) => `
      <div class="row">
        <input type="text" data-i="${i}" data-k="label" value="${esc(p.label || '')}" placeholder="Nombre (ej: +5 GB)" style="flex:2;min-width:140px">
        <input type="number" data-i="${i}" data-k="photos" value="${p.photos || ''}" placeholder="Fotos" min="50" step="50" style="flex:1;min-width:80px" title="Fotos extra (planes nuevos)">
        <input type="number" data-i="${i}" data-k="price" value="${p.price || ''}" placeholder="Precio ARS" min="1" style="flex:1;min-width:100px">
        <button type="button" class="btn sm danger" data-rm="${i}">✕</button>
      </div>`).join('') : '<p class="muted small" style="margin:0">Sin packs: si un álbum se llena, el fotógrafo no puede comprar más.</p>';
    $$('#lim-plans input').forEach(inp => inp.oninput = () => { sp[inp.dataset.i][inp.dataset.k] = inp.type === 'number' ? Number(inp.value) : inp.value; });
    $$('#lim-plans [data-rm]').forEach(b => b.onclick = () => { sp.splice(+b.dataset.rm, 1); drawPlans(); });
  };
  drawPlans();
  $('#lim-add').onclick = () => { sp.push({ id: newId(), label: '', photos: 500, price: 0 }); drawPlans(); };
  $('#lim-form').onsubmit = async e => {
    e.preventDefault();
    const clean = sp.filter(p => p.label || p.price).map(p => ({ id: p.id || newId(), label: (p.label || '').trim() || `+${p.photos} fotos`,
      photos: Math.round(Number(p.photos) || 0), price: Math.round(p.price) }));
    if (clean.some(p => !(p.photos > 0) || !(p.price > 0))) return toast('Cada pack necesita cantidad de fotos y precio.', 'error');
    try {
      await setDoc(doc(db, 'settings', 'platform'), { optimizeOriginals: $('#lim-opt').checked, bibsEnabled: $('#lim-bibs').checked, storagePlans: clean, updatedAt: serverTimestamp() }, { merge: true });
      S.settings = await loadSettings();
      toast('Límite guardado');
    } catch (err) { toast(errMsg(err), 'error'); }
  };

  function retTable(title, rows, key) {
    if (!rows.length) return '';
    return `<h3 style="margin:6px 0 0">${title}</h3><div class="table-wrap"><table class="list"><thead><tr><th>Evento</th><th>Fotógrafo</th><th>Fotos</th><th>Originales</th><th>Se vendía hasta</th><th>Borrado</th></tr></thead><tbody>
      ${rows.map(t => `<tr><td><a href="#/evento/${esc(t.eid)}">${esc(eMap.get(t.eid)?.name || t.eid)}</a></td><td>${esc(uName(t.uid))}</td><td>${t.photos || 0}</td><td>${fmtBytes(t.bytes)}</td><td>${t.until?.toDate ? t.until.toDate().toLocaleDateString('es-AR') : '—'}</td><td>${t[key]?.toDate ? t[key].toDate().toLocaleDateString('es-AR') : '—'}</td></tr>`).join('')}
    </tbody></table></div>`;
  }

  function bindScan() {
    $('#st-scan').onclick = async () => {
      const b = $('#st-scan'); b.disabled = true; b.textContent = 'Calculando…';
      try { await apiPost('/admin/storage/scan'); toast('Uso actualizado'); viewAdminStorage(); }
      catch (e) { toast(errMsg(e), 'error'); b.disabled = false; b.textContent = '🔄 Recalcular ahora'; }
    };
  }
}

// ================================================================ superadmin: etiquetas
async function rebuildTaxonomy() {
  const [ts, gs] = await Promise.all([getDocs(collection(db, 'tagTypes')), getDocs(collection(db, 'tags'))]);
  await setDoc(doc(db, 'settings', 'tags'), {
    types: ts.docs.map(d => ({ id: d.id, name: d.data().name, order: d.data().order ?? 0 })),
    tags: gs.docs.map(d => ({ id: d.id, typeId: d.data().typeId, name: d.data().name, slug: d.data().slug })),
    updatedAt: serverTimestamp(),
  });
  S.tax = await loadTaxonomy(true);
}

async function viewAdminTags() {
  const [ts, gs] = await Promise.all([getDocs(collection(db, 'tagTypes')), getDocs(collection(db, 'tags'))]);
  const types = ts.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.order - b.order);
  const tags = gs.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  $('#view').innerHTML = `
    <h1>Etiquetas</h1>
    <p class="muted">Se usan para clasificar eventos y como filtros en el sitio público.</p>
    ${types.map((t, i) => `
      <div class="card stack">
        <div class="row" style="justify-content:space-between">
          <h2 style="margin:0">${esc(t.name)}</h2>
          <div class="row">
            <button class="btn sm" data-tup="${i}" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="btn sm" data-tdown="${i}" ${i === types.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="btn sm" data-trename="${t.id}">Renombrar</button>
            <button class="btn sm danger" data-tdel="${t.id}">Eliminar</button>
          </div>
        </div>
        <div class="pills">${tags.filter(g => g.typeId === t.id).map(g => `
          <span class="chip" style="cursor:default">${esc(g.name)}
            <button class="btn ghost sm" style="padding:0 4px" data-grename="${g.id}" title="Renombrar">✎</button>
            <button class="btn ghost sm danger" style="padding:0 4px" data-gdel="${g.id}" title="Eliminar">✕</button></span>`).join('') || '<span class="muted small">Sin etiquetas</span>'}</div>
        <form class="row" data-gadd="${t.id}"><input type="text" placeholder="Nueva etiqueta de ${esc(t.name)}" style="max-width:300px" required><button class="btn">Agregar</button></form>
      </div>`).join('')}
    <form class="card row" id="tadd"><input type="text" placeholder="Nuevo tipo de etiqueta" style="max-width:300px" required><button class="btn primary">Agregar tipo</button></form>`;

  const done = async (msg) => { await rebuildTaxonomy(); if (msg) toast(msg); viewAdminTags(); };
  const guard = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(errMsg(e), 'error'); } };

  $('#tadd').onsubmit = guard(async e => {
    e.preventDefault();
    await addDoc(collection(db, 'tagTypes'), { name: e.target[0].value.trim(), order: types.length });
    await done('Tipo agregado');
  });
  $$('[data-gadd]').forEach(f => f.onsubmit = guard(async e => {
    e.preventDefault();
    const name = f[0].value.trim();
    const typeId = f.dataset.gadd;
    if (tags.some(g => g.typeId === typeId && normalize(g.name) === normalize(name))) return toast('Esa etiqueta ya existe.', 'error');
    await addDoc(collection(db, 'tags'), { typeId, name, slug: slugify(name) });
    await done();
  }));
  $$('[data-trename]').forEach(b => b.onclick = guard(async () => {
    const t = types.find(x => x.id === b.dataset.trename);
    const name = prompt('Nuevo nombre', t.name)?.trim();
    if (!name || name === t.name) return;
    await updateDoc(doc(db, 'tagTypes', t.id), { name });
    await done('Tipo renombrado');
  }));
  $$('[data-tdel]').forEach(b => b.onclick = guard(async () => {
    const t = types.find(x => x.id === b.dataset.tdel);
    const n = tags.filter(g => g.typeId === t.id).length;
    if (!confirm(`¿Eliminar el tipo "${t.name}"${n ? ` y sus ${n} etiquetas` : ''}?`)) return;
    const bt = writeBatch(db);
    tags.filter(g => g.typeId === t.id).forEach(g => bt.delete(doc(db, 'tags', g.id)));
    bt.delete(doc(db, 'tagTypes', t.id));
    await bt.commit();
    await done('Tipo eliminado');
  }));
  const swap = guard(async (i, j) => {
    const bt = writeBatch(db);
    types.forEach((t, k) => { const ord = k === i ? j : k === j ? i : k; if (t.order !== ord) bt.update(doc(db, 'tagTypes', t.id), { order: ord }); });
    await bt.commit();
    await done();
  });
  $$('[data-tup]').forEach(b => b.onclick = () => swap(+b.dataset.tup, +b.dataset.tup - 1));
  $$('[data-tdown]').forEach(b => b.onclick = () => swap(+b.dataset.tdown, +b.dataset.tdown + 1));
  $$('[data-grename]').forEach(b => b.onclick = guard(async () => {
    const g = tags.find(x => x.id === b.dataset.grename);
    const name = prompt('Nuevo nombre', g.name)?.trim();
    if (!name || name === g.name) return;
    await updateDoc(doc(db, 'tags', g.id), { name, slug: slugify(name) });
    await done('Etiqueta renombrada');
  }));
  $$('[data-gdel]').forEach(b => b.onclick = guard(async () => {
    const g = tags.find(x => x.id === b.dataset.gdel);
    if (!confirm(`¿Eliminar la etiqueta "${g.name}"? Los eventos que la usan la pierden.`)) return;
    await deleteDoc(doc(db, 'tags', g.id));
    await done('Etiqueta eliminada');
  }));
}

// ================================================================ superadmin: plataforma
// Tabla de condiciones por plan (Plataforma) -> campos de settings/platform.
const PLAN_KEYS = {
  free: { fee: 'freeFeePercent', portfolio: 'freePortfolioLimit', albumPhotos: 'freeAlbumPhotos', days: 'freeRetentionDays' },
  lite: { price: 'litePrice', year: 'liteYearPrice', fee: 'liteFeePercent', portfolio: 'litePortfolioLimit', albumPhotos: 'liteAlbumPhotos', days: 'liteRetentionDays', featured: 'liteFeatured' },
  web: { price: 'webPrice', year: 'webYearPrice', fee: 'webFeePercent', portfolio: 'webPortfolioLimit', albumPhotos: 'webAlbumPhotos', days: 'webRetentionDays', featured: 'webFeatured' },
  webdomain: { price: 'webDomainPrice', first: 'webDomainFirstPrice', year: 'webDomainYearPrice', fee: 'webDomainFeePercent', portfolio: 'webDomainPortfolioLimit',
    albumPhotos: 'webDomainAlbumPhotos', days: 'webDomainRetentionDays', featured: 'webDomainFeatured' },
};
function readPlanCfg() {
  const out = {};
  $$('.plan-cfg tr[data-plan]').forEach(tr => {
    const keys = PLAN_KEYS[tr.dataset.plan];
    tr.querySelectorAll('[data-k]').forEach(inp => {
      const k = keys[inp.dataset.k];
      if (k) out[k] = inp.type === 'checkbox' ? inp.checked : inp.dataset.k === 'fee' ? Number(inp.value) || 0 : Math.round(Number(inp.value) || 0);
    });
  });
  return out;
}
async function viewAdminConfig() {
  S.settings = await loadSettings();
  const st = S.settings;
  let plans = (st.extensionPlans || []).map(p => ({ ...p }));
  $('#view').innerHTML = `
    <h1>Configuración de la plataforma</h1>
    <div class="card row" style="justify-content:space-between">
      <div><strong>Refrescar todos los dispositivos</strong><br><span class="muted small">Recarga el sitio y el panel en todos los navegadores abiertos (oficial y prueba). Los que están subiendo fotos ven un aviso y no se cortan.</span></div>
      <button class="btn" id="a-reload">🔄 Refrescar todos</button>
    </div>
    <form id="acf">
      <div class="card stack">
        <h2 style="margin:0">Sitio público</h2>
        <label class="check"><input type="checkbox" id="a-dir" ${st.showDirectory ? 'checked' : ''}> Mostrar <strong>Fotógrafos</strong> (el directorio) en el menú y en el pie</label>
        <p class="muted small" style="margin:0">Conviene activarlo cuando haya varios fotógrafos. Apagado, el directorio sigue existiendo pero no aparece en el menú.</p>
      </div>
      <div class="card stack">
        <div class="grid2">
          <label class="field">Días de retención de originales<input type="number" id="a-ret" min="1" max="365" step="1" value="${st.retentionDays}" required>
            <span class="hint">Desde que el fotógrafo sube las fotos de un evento.</span></label>
        </div>
      </div>
      <div class="card stack">
        <h2>Comisiones de Mercado Pago</h2>
        <p class="muted small" style="margin:0">Se usan solo para mostrarle al fotógrafo su neto estimado. Porcentaje con IVA incluido, según el plazo de acreditación. Revisalas cuando MP cambie sus tarifas.</p>
        <div id="a-mp" class="stack">${(st.mpFeePlans || DEFAULT_SETTINGS.mpFeePlans).map(pl => `
          <div class="row"><span style="flex:1;min-width:120px">${esc(pl.label)}</span>
            <input type="number" data-mp="${esc(pl.id)}" data-label="${esc(pl.label)}" value="${pl.percent}" min="0" max="30" step="0.01" style="max-width:110px"> <span class="muted small">%</span></div>`).join('')}
        </div>
      </div>
      <div class="card stack">
        <h2>Planes</h2>
        <p class="muted small" style="margin:0">Gratis: 1 álbum activo a la vez y sin packs. Los planes pagos tienen álbumes ilimitados y pueden comprar packs de fotos (en Almacenamiento).</p>
        <div class="table-wrap"><table class="list plan-cfg">
          <tr><th>Plan</th><th>Precio</th><th>Comisión %</th><th>Portfolio</th><th>Fotos por álbum</th><th>Días de venta</th><th>Destacado</th></tr>
          ${[['free', 'Gratis'], ['lite', 'Profesional Lite'], ['web', 'Profesional'], ['webdomain', 'Profesional Premium']].map(([id, label]) => {
            const p = planSpec(id, st);
            const num = (k, v, step = 1) => `<input type="number" data-k="${k}" min="0" step="${step}" value="${v ?? ''}">`;
            return `<tr data-plan="${id}"><td><strong>${label}</strong>${id === 'free' ? '<br><span class="muted small">1 álbum activo</span>' : id === 'web' ? '<br><span class="muted small">con web</span>' : id === 'webdomain' ? '<br><span class="muted small">web + dominio</span>' : ''}</td>
              <td>${id === 'free' ? '—' : `<span class="hint">Mensual</span>${num('price', p.price)}
                ${id === 'webdomain' ? `<span class="hint">Primer mes</span>${num('first', p.first)}` : ''}
                <span class="hint">Anual</span>${num('year', p.year)}`}</td>
              <td>${num('fee', p.fee, 0.1)}</td>
              <td>${num('portfolio', p.portfolio)}</td>
              <td>${num('albumPhotos', p.albumPhotos, 50)}</td>
              <td>${num('days', p.days)}</td>
              <td>${id === 'free' ? '—' : `<input type="checkbox" data-k="featured" ${p.featured ? 'checked' : ''}>`}</td></tr>`;
          }).join('')}
        </table></div>
        <label class="field" style="max-width:320px">Prueba gratis de Profesional para fotógrafos nuevos (días)<input type="number" id="a-trial" min="0" max="90" step="1" value="${st.trialDays ?? 30}">
          <span class="hint">Se da al aprobar al fotógrafo, una sola vez. 0 = sin prueba. Rige con los planes nuevos.</span></label>
        </div>
      </div>
      <div class="card stack">
        <h2>Planes de extensión de retención</h2>
        <p class="muted small" style="margin:0">El fotógrafo los paga para mantener sus originales disponibles por más tiempo.</p>
        <div id="a-plans" class="stack"></div>
        <button type="button" class="btn sm" id="a-plan-add" style="justify-self:start">+ Agregar plan</button>
      </div>
      <div class="row end" style="margin-top:14px"><button class="btn primary">Guardar</button></div>
    </form>`;
  const draw = () => {
    $('#a-plans').innerHTML = plans.length ? plans.map((p, i) => `
      <div class="row">
        <input type="text" data-i="${i}" data-k="label" value="${esc(p.label)}" placeholder="Nombre (ej: +30 días)" style="flex:2;min-width:150px">
        <input type="number" data-i="${i}" data-k="days" value="${p.days || ''}" placeholder="Días" min="1" style="flex:1;min-width:80px">
        <input type="number" data-i="${i}" data-k="price" value="${p.price || ''}" placeholder="Precio ARS" min="1" style="flex:1;min-width:100px">
        <button type="button" class="btn sm danger" data-rm="${i}">✕</button>
      </div>`).join('') : '<p class="muted small" style="margin:0">Sin planes definidos.</p>';
    $$('#a-plans input').forEach(inp => inp.oninput = () => { plans[inp.dataset.i][inp.dataset.k] = inp.type === 'number' ? Number(inp.value) : inp.value; });
    $$('#a-plans [data-rm]').forEach(b => b.onclick = () => { plans.splice(+b.dataset.rm, 1); draw(); });
  };
  draw();
  $('#a-reload').onclick = async () => {
    if (!confirm('¿Recargar el sitio en todos los dispositivos abiertos?')) return;
    try { await setDoc(doc(db, 'settings', 'app'), { reloadAt: serverTimestamp() }, { merge: true }); toast('Listo: se están recargando'); }
    catch (err) { toast(errMsg(err), 'error'); }
  };
  $('#a-plan-add').onclick = () => { plans.push({ id: newId(), label: '', days: 30, price: 0 }); draw(); };
  $('#acf').onsubmit = async e => {
    e.preventDefault();
    const clean = plans.filter(p => p.label || p.price).map(p => ({ id: p.id || newId(), label: p.label.trim(), days: Math.round(p.days), price: Math.round(p.price) }));
    if (clean.some(p => !p.label || !(p.days > 0) || !(p.price > 0))) return toast('Cada plan necesita nombre, días y precio.', 'error');
    try {
      await setDoc(doc(db, 'settings', 'platform'), {
        showDirectory: $('#a-dir').checked, trialDays: Math.round(Number($('#a-trial').value) || 0), ...readPlanCfg(),
        retentionDays: Math.round(Number($('#a-ret').value)),
        extensionPlans: clean,
        mpFeePlans: $$('#a-mp [data-mp]').map(i => ({ id: i.dataset.mp, label: i.dataset.label, percent: Math.round(Number(i.value) * 100) / 100 })),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      S.settings = await loadSettings();
      toast('Configuración guardada');
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// ================================================================ dialog helper
function openDialog(title, body, foot) {
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <div class="dlg-head"><h2>${esc(title)}</h2><button class="btn ghost sm" data-close>✕</button></div>
    <div class="dlg-body">${body}</div>
    ${foot ? `<div class="dlg-foot">${foot}</div>` : ''}`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  $$('[data-close]', dlg).forEach(b => b.onclick = () => dlg.close());
  dlg.showModal();
  return dlg;
}
