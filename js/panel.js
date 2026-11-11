// Panel de fotógrafos y superadmin (secciones según rol).
import {
  db, auth, SUPERADMIN_EMAIL,
  collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, addDoc, writeBatch,
  query, where, orderBy, limit, serverTimestamp, arrayUnion, arrayRemove, Timestamp,
  onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, sendPasswordResetEmail, sendEmailVerification, signOut, updateProfile,
  RecaptchaVerifier, signInWithPhoneNumber,
  collectionGroup,
} from './fb.js';
import {
  $, $$, esc, inAppNotice, bindInAppNotice, slugify, SLUG_RE, searchTokens, fmtMoney, fmtDate, fmtTs, todayIso, parseHash,
  toast, errMsg, avatarHtml, coverHtml, SOCIALS, newId, normalize, fmtBytes, setBytes, waLink, waNumber,
} from './util.js';
const waOf = (u, priv) => priv?.whatsapp || u.socials?.whatsapp || '';
import { initTheme } from './theme.js';
import { activeAlbumLimit, albumBonusOf, photoBonusOf } from './plans-core.js';
import { loadTaxonomy, loadSettings, DEFAULT_SETTINGS, INITIAL_TAG_TYPES, ACTIVITY_TYPE, USER_TAG_TYPES, tagPills, SERVICES, isPro, mpPlanOf, GEAR_TYPES, PLANS, planOf, siteUrlOf, setUntil, setDeleteAt, GRACE_DAYS, albumPhotoLimit, feePercentFor, isFreePlan, setActive, planSpec, rulesFor, bibsOn } from './data.js';
import { viewWeb } from './panel-web.js';
import { sellerNet } from './pricing.js';
import { viewPortfolio } from './panel-portfolio.js';
import { drawWatermark, drawSampleScene, DEFAULT_WATERMARK, wantsLogo, strengthOf } from './watermark.js';
import { uploadAsset, apiPost, apiGet, uploadSession, postWithToken, API_BASE } from './api.js';
import { resizeToJpeg } from './image-proc.js';
import { mountPhotos, uploadsInProgress } from './panel-photos.js';
import { loadMyTeams, viewTeam, viewTeams, viewTeamEvent, viewJoin, teamSalesHtml } from './panel-team.js';
import { initRefresh } from './refresh.js';
import { pushAvailable, pushOn, pushBlocked, enablePush, disablePush, isIos, isStandalone, listenForeground } from './push.js';
import { shareLink, eventUrl } from './share.js';
import { mountShareCard } from './panel-share.js';
import { cropImage } from './cropper.js';
import { placeInput, canonicalPlace, multiPlaceInput, guessPlaces } from './places.js';

const root = $('#root');
const S = { user: null, profile: null, isSuper: false, settings: { ...DEFAULT_SETTINGS }, tax: null };

const isApproved = () => S.profile?.status === 'approved';
// Comisión de la plataforma para este fotógrafo (según su plan).
const myFee = () => feePercentFor(S.profile, S.settings);
// Condiciones que rigen hoy para este fotógrafo (comisión, portfolio, espacio, días, nivel de estadísticas…).
const myRules = () => rulesFor(S.profile, S.settings);

initRefresh({ busy: uploadsInProgress });

// Llegada desde "Soy fotógrafo" (panel.html?plan=…): se crea la cuenta y, si eligió un plan pago, se abre la suscripción.
const WANT_KEY = 'qmf-want-plan';
const wantParam = new URLSearchParams(location.search).get('plan');
if (wantParam) {
  try { sessionStorage.setItem(WANT_KEY, wantParam); } catch { /* nada */ }
  history.replaceState(null, '', location.pathname + location.hash);
}
const wantedPlan = () => { try { return sessionStorage.getItem(WANT_KEY) || ''; } catch { return ''; } };
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
  $('#who').textContent = user ? (user.displayName || user.email || user.phoneNumber || '') : '';
  if (!user) { S.profile = null; return renderLogin(); }
  S.isSuper = user.email === SUPERADMIN_EMAIL && user.emailVerified;
  root.innerHTML = '<div class="spinner"></div>';
  try {
    // Todo a la vez: cada pedido es un viaje a Firestore.
    const [snap, settings, tax, teams] = await Promise.all([
      getDoc(doc(db, 'users', user.uid)), loadSettings(), loadTaxonomy(true),
      loadMyTeams(user.uid), // empresas de las que es colaborador (plan Empresas)
    ]);
    S.profile = snap.exists() ? snap.data() : null;
    S.settings = settings;
    S.tax = tax;
    S.teams = teams;
    if (S.isSuper) await seedPlatform();
  } catch (e) {
    root.innerHTML = `<div class="container"><div class="notice danger">${esc(errMsg(e))}</div></div>`;
    return;
  }
  if (!S.profile) return renderOnboarding();
  if (!S.isSuper) {
    if (isVerified(user)) markVerified();
    else setDoc(doc(db, 'userPrivate', user.uid), { provider: providerOf(user) }, { merge: true }).catch(() => {});
  }
  await autoApprove();
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

// Plan vigente del fotógrafo, para mostrarlo arriba, en Inicio y en Perfil.
function planLine(p) {
  const id = planOf(p);
  const label = PLANS[id]?.label || 'Gratis';
  const until = p.proUntil?.toDate?.();
  const when = until && !p.courtesy && until.getFullYear() < 2090 ? ` hasta el ${until.toLocaleDateString('es-AR')}` : '';
  const kind = p.courtesy ? ' (cortesía)' : p.trial && id !== 'free' ? ' (prueba gratis)' : '';
  return { id, label, text: `${label}${kind}${id === 'free' ? '' : when}` };
}
function planCardHtml(p) {
  const l = planLine(p);
  const bonus = albumBonusOf(p);
  return `<div class="notice ${l.id === 'free' ? '' : 'ok'} row" style="justify-content:space-between;gap:8px">
    <span>⭐ Tu plan: <strong>${esc(l.text)}</strong>${bonus && l.id === 'free' ? `<br>🎁 Tenés <strong>${bonus.count} álbum${bonus.count === 1 ? '' : 'es'} extra</strong> de prueba hasta el ${esc(new Date(bonus.until).toLocaleDateString('es-AR'))}` : ''}</span><a class="btn sm" href="#/web">${l.id === 'free' ? 'Ver planes' : 'Ver o cambiar'}</a></div>`;
}

// Plan / estado al día: el perfil se lee al abrir el panel; si cambia después (se acreditó una suscripción, el superadmin
// le dio un plan, lo aprobaron) se vuelve a leer al volver a la app (cada 1 minuto como mucho) o cuando lo pide una vista.
let profileCheckedAt = Date.now();
async function refreshProfile(force = false) {
  if (!S.user || S.isSuper || !S.profile || (!force && Date.now() - profileCheckedAt < 60000)) return;
  profileCheckedAt = Date.now();
  try {
    const fresh = (await getDoc(doc(db, 'users', S.user.uid))).data();
    if (!fresh) return;
    const key = p => `${p.status}|${planOf(p)}|${p.proUntil?.toMillis?.() || 0}|${p.courtesy ? 1 : 0}`;
    const changed = key(fresh) !== key(S.profile);
    Object.assign(S.profile, fresh);
    if (!changed) return;
    updateRolePill();
    if (planOf(S.profile) !== 'free') toast(`⭐ Tu plan ${PLANS[planOf(S.profile)]?.label || ''} ya está activo`);
    // Solo se redibuja Inicio o Planes (nunca a mitad de una subida o de un formulario).
    if (['', '#', '#/', '#/inicio', '#/web'].includes(location.hash.split('?')[0])) route();
  } catch { /* sin conexión: se reintenta la próxima vez */ }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshProfile(); });
window.addEventListener('qmf-profile-refresh', () => refreshProfile(true));

function updateRolePill() {
  updatePublicProfileBtn();
  const p = $('#role-pill');
  const st = S.profile?.status;
  if (S.isSuper) { p.textContent = 'Superadmin'; p.className = 'pill accent'; }
  else if (st === 'approved') { p.textContent = planLine(S.profile).label; p.className = `pill ${planOf(S.profile) === 'free' ? '' : 'ok'}`; }
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
        <button class="btn block" id="ph-login">📱 Entrar con mi celular</button>
        <form id="ph-form" class="stack hidden">
          <label class="field">Tu celular (con código de área)<input type="tel" id="ph-num" inputmode="tel" autocomplete="tel" placeholder="Ej: 342 555-1234"><span class="hint">Te mandamos un código por SMS. No hace falta tener mail.</span></label>
          <label class="field hidden" id="ph-code-f">Código que te llegó por SMS<input type="text" id="ph-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></label>
          <button class="btn primary block" type="submit" id="ph-send">Enviarme el código</button>
        </form>
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
  // Celular: código por SMS (Firebase Auth). El reCAPTCHA es invisible y va atado al botón.
  let confirmation = null, verifier = null;
  $('#ph-login').onclick = () => { $('#ph-form').classList.remove('hidden'); $('#ph-login').classList.add('hidden'); $('#ph-num').focus(); };
  $('#ph-form').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#ph-send');
    btn.disabled = true;
    try {
      if (!confirmation) {
        const d = waNumber($('#ph-num').value);
        if (d.length < 12) throw new Error('Escribí tu celular con código de área (ej: 342 555-1234).');
        verifier ||= new RecaptchaVerifier(auth, 'ph-send', { size: 'invisible' });
        auth.languageCode = 'es';
        confirmation = await signInWithPhoneNumber(auth, `+${d}`, verifier);
        $('#ph-code-f').classList.remove('hidden'); $('#ph-num').disabled = true;
        btn.textContent = 'Entrar'; $('#ph-code').focus();
        toast('Te mandamos el código por SMS');
      } else {
        await confirmation.confirm($('#ph-code').value.trim());
      }
    } catch (err) {
      toast(errMsg(err), 'error');
      if (!confirmation) { try { verifier?.clear(); } catch { /* nada */ } verifier = null; }
    }
    btn.disabled = false;
  };
  $('#toggle-mode').onclick = () => {
    mode = mode === 'login' ? 'signup' : 'login';
    $('#a-title').textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    $('#a-sub').textContent = mode === 'login' ? 'Panel para fotógrafos de Quiero Mis Fotos.' : 'Registrate como fotógrafo.';
    $('#e-submit').textContent = mode === 'login' ? 'Ingresar' : 'Crear cuenta';
    $('#toggle-mode').textContent = mode === 'login' ? 'Crear cuenta nueva' : 'Ya tengo cuenta';
    $('#e-pass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    if (mode === 'signup') signupSupport(); else document.querySelector('.wa-bubble')?.remove();
  };
  const want = wantedPlan();
  if (want) {
    $('#toggle-mode').onclick();
    if (PLANS[want] && want !== 'free') $('#a-sub').textContent = `Creá tu cuenta de fotógrafo y después pagás el plan ${PLANS[want].label} con Mercado Pago.`;
  }
  $('#e-form').onsubmit = async e => {
    e.preventDefault();
    const email = $('#e-mail').value.trim(), pass = $('#e-pass').value;
    try {
      if (mode === 'login') await signInWithEmailAndPassword(auth, email, pass);
      else {
        const cred = await createUserWithEmailAndPassword(auth, email, pass);
        sendVerification(cred.user, true);
      }
    } catch (err) { toast(errMsg(err), 'error'); }
  };
  $('#reset').onclick = async () => {
    const email = $('#e-mail').value.trim();
    if (!email) return toast('Escribí tu email arriba y volvé a tocar.', 'error');
    try { await sendPasswordResetEmail(auth, email); toast('Te mandamos un mail para restablecer la contraseña.'); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
}

// Con la aprobación manual apagada (Plataforma → Fotógrafos), la cuenta pendiente se aprueba sola al entrar.
async function autoApprove() {
  // El Worker también avisa al superadmin del registro (una sola vez).
  if (S.isSuper || S.profile?.status !== 'pending') return;
  try {
    const r = await apiPost('/photographers/activate');
    if (r.status !== 'approved') return;
    S.profile = (await getDoc(doc(db, 'users', S.user.uid))).data();
    toast(r.trialDays ? `🎉 Tu cuenta está activa, con ${r.trialDays} días de Profesional gratis` : '🎉 Tu cuenta está activa');
  } catch (e) { console.error('aprobación', e); }
}

// Cuentas con email y contraseña: hasta confirmar el correo no pueden publicar eventos, sumarse a eventos ni vincular
// Mercado Pago (lo controlan las reglas y el Worker). Las de Google ya vienen confirmadas.
const PANEL_URL = `${location.origin}${location.pathname}`;
const isVerified = u => !!(u?.emailVerified || u?.phoneNumber);
const needsVerify = () => !!S.user && !isVerified(S.user) && !S.isSuper;
async function sendVerification(user, silent) {
  try {
    auth.languageCode = 'es';
    await sendEmailVerification(user, { url: PANEL_URL });
    if (!silent) toast(`Te mandamos el mail a ${user.email}. Revisá también Spam o Promociones.`);
  } catch (e) { if (!silent) toast(e.code === 'auth/too-many-requests' ? 'Ya te lo mandamos hace un ratito. Esperá unos minutos y revisá Spam.' : errMsg(e), 'error'); }
}
// Vuelve a leer la cuenta (y el token) por si ya confirmó el correo en otra pestaña o en el celular.
async function refreshVerified() {
  if (!S.user || isVerified(S.user)) return true;
  // Puede haberla confirmado el superadmin a mano: se relee la cuenta y se pide un token nuevo.
  try { await S.user.reload(); if (auth.currentUser?.emailVerified) await auth.currentUser.getIdToken(true); } catch { /* nada */ }
  S.user = auth.currentUser;
  if (S.user?.emailVerified) markVerified();
  return !!S.user?.emailVerified;
}
// Para la lista de Fotógrafos del superadmin.
function markVerified() {
  setDoc(doc(db, 'userPrivate', S.user.uid), { emailVerified: true, provider: providerOf(S.user) }, { merge: true }).catch(() => {});
}
const providerOf = u => (u.providerData || []).some(p => p.providerId === 'google.com') ? 'google' : u.phoneNumber ? 'phone' : 'password';
function verifyBarHtml() {
  if (!needsVerify()) return '';
  return `<div class="notice warn row" id="verify-bar" style="justify-content:space-between;gap:8px;margin:12px 16px 0">
    <span>✉️ <strong>Confirmá tu correo</strong> (${esc(S.user.email)}): tocá el link del mail que te mandamos. Hasta entonces podés armar tu perfil y subir fotos, pero no publicar eventos ni vincular Mercado Pago. ¿No te llega? Escribinos por WhatsApp y la confirmamos nosotros.</span>
    <span class="row" style="gap:6px"><button class="btn sm" id="vb-check">Ya lo confirmé</button><button class="btn sm ghost" id="vb-send">Reenviar mail</button></span></div>`;
}
function bindVerifyBar() {
  $('#vb-send')?.addEventListener('click', () => sendVerification(S.user));
  $('#vb-check')?.addEventListener('click', async () => {
    if (await refreshVerified()) { toast('✅ Correo confirmado'); $('#verify-bar')?.remove(); route(); }
    else toast('Todavía no figura confirmado. Abrí el link del mail y volvé a tocar.', 'error');
  });
}
// Antes de publicar o sumarse: true si puede seguir; si no, avisa.
async function requireVerified() {
  if (!needsVerify() || await refreshVerified()) return true;
  toast('Primero confirmá tu correo: tocá el link del mail que te mandamos (o reenvialo desde el aviso de arriba).', 'error');
  return false;
}

// ================================================================ alta
function renderOnboarding() {
  signupSupport();
  const u = S.user;
  const name = u.displayName || '';
  root.innerHTML = `
    <div class="container"><div class="auth-box card" style="max-width:520px">
      <h1>${S.isSuper ? 'Configurá tu perfil' : 'Registro de fotógrafo'}</h1>
      <p class="muted">${S.isSuper ? 'Sos el superadmin de la plataforma.' : (S.settings.autoApprove ? 'Completá tus datos y empezá a vender.' : 'Completá tus datos. Después un administrador revisa y aprueba tu cuenta.')}</p>
      <form id="ob" class="stack">
        <label class="field">Nombre público<input type="text" id="ob-name" required maxlength="60" value="${esc(name)}" placeholder="Ej: Juan Pérez Fotografía"></label>
        <label class="field">Dirección de tu perfil
          <input type="text" id="ob-slug" required maxlength="40" value="${esc(slugify(name))}">
          <span class="hint" id="ob-slug-hint">quieromisfotos/#/f/<strong>${esc(slugify(name) || '...')}</strong></span>
        </label>
        <label class="field">Localidad<input type="text" id="ob-zone" maxlength="80" required placeholder="Empezá a escribir y elegí de la lista"></label>
        ${S.isSuper ? '' : `<label class="field">WhatsApp<input type="tel" id="ob-wa" required maxlength="30" inputmode="tel" autocomplete="tel" placeholder="Ej: 341 555-1234 (con código de área)" value="${esc((u.phoneNumber || '').replace(/^\+549?/, ''))}">
          <span class="hint">Para avisarte novedades de tu cuenta. También se muestra en tu perfil para que te pidan presupuestos (lo podés sacar después).</span></label>`}
        <button class="btn primary" type="submit">Crear perfil</button>
      </form>
    </div></div>`;
  let slugTouched = false;
  $('#ob-name').oninput = e => { if (!slugTouched) { $('#ob-slug').value = slugify(e.target.value); slugHint(); } };
  $('#ob-slug').oninput = () => { slugTouched = true; slugHint(); };
  const slugHint = () => { $('#ob-slug-hint strong').textContent = $('#ob-slug').value || '...'; };
  placeInput($('#ob-zone'));

  $('#ob').onsubmit = async e => {
    e.preventDefault();
    const displayName = $('#ob-name').value.trim();
    const slug = slugify($('#ob-slug').value);
    if (!SLUG_RE.test(slug)) return toast('La dirección debe tener entre 3 y 40 letras, números o guiones.', 'error');
    const wa = $('#ob-wa')?.value.trim() || '';
    const zone = await canonicalPlace($('#ob-zone').value);
    if (!zone && !S.isSuper) return toast('Elegí tu localidad de la lista (empezá a escribir y tocá una opción).', 'error');
    if (!S.isSuper && wa.replace(/\D/g, '').length < 8) return toast('Escribí tu WhatsApp con código de área (ej: 341 555-1234).', 'error');
    try {
      const taken = await getDoc(doc(db, 'slugs', slug));
      if (taken.exists() && taken.data().uid !== u.uid) return toast('Esa dirección ya está en uso. Probá otra.', 'error');
      const profile = {
        role: S.isSuper ? 'superadmin' : 'photographer',
        status: S.isSuper ? 'approved' : 'pending',
        displayName, slug, zone: zone || $('#ob-zone').value.trim(),
        avatarUrl: u.photoURL || '', bio: '', socials: wa ? { whatsapp: wa } : {},
        mpConnected: false, mpUserId: null,
        defaults: { price: 0, packs: [], feeMode: 'absorb' },
        watermark: { ...DEFAULT_WATERMARK },
        createdAt: serverTimestamp(),
      };
      const b = writeBatch(db);
      if (!taken.exists()) b.set(doc(db, 'slugs', slug), { uid: u.uid });
      b.set(doc(db, 'users', u.uid), profile);
      b.set(doc(db, 'userPrivate', u.uid), { email: u.email || '', ...(u.phoneNumber ? { phone: u.phoneNumber } : {}), ...(wa ? { whatsapp: wa } : {}), ...(isVerified(u) ? { emailVerified: true } : {}), provider: providerOf(u), createdAt: serverTimestamp() });
      await b.commit();
      if (!u.displayName) updateProfile(u, { displayName }).catch(() => {});
      S.profile = (await getDoc(doc(db, 'users', u.uid))).data();
      await autoApprove();
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

// Tablas en el celular: cada celda lleva la etiqueta de su columna (el CSS las muestra como fichas).
function labelTables() {
  document.querySelectorAll('table.list:not(.plan-cfg)').forEach(t => {
    const head = [...t.rows].find(r => r.querySelector('th'));
    if (!head) return;
    const labels = [...head.cells].map(c => c.textContent.trim());
    [...t.rows].forEach(r => { if (r !== head) [...r.cells].forEach((c, i) => {
      if (c.tagName !== 'TD' || c.dataset.label || !labels[i]) return;
      c.dataset.label = labels[i];
      // Varias cosas en la celda (estado + "Ver", monto + 🏦): juntas, para que la ficha no las separe.
      if (i > 0 && c.childNodes.length > 1) { const w = document.createElement('span'); w.className = 'td-v'; w.append(...c.childNodes); c.append(w); }
    }); });
  });
}
let labelQueued = false;
new MutationObserver(() => { if (labelQueued) return; labelQueued = true; requestAnimationFrame(() => { labelQueued = false; labelTables(); }); })
  .observe(document.body, { childList: true, subtree: true });

// ================================================================ shell + router
function navItems() {
  if (S.isSuper) return [
    { group: 'Administración' },
    { href: '#/admin/metricas', label: '📊 Métricas' },
    { href: '#/admin/fotografos', label: '👥 Fotógrafos' },
    { href: '#/admin/compras', label: '🧾 Compras' },
    { href: '#/admin/clientes', label: '👤 Clientes' },
    { href: '#/admin/eventos', label: '🏟️ Eventos' },
    { href: '#/admin/etiquetas', label: '🏷️ Etiquetas' },
    { href: '#/admin/almacenamiento', label: '💾 Almacenamiento' },
    { href: '#/admin/costos', label: '🧾 Costos' },
    { href: '#/admin/config', label: '⚙️ Plataforma' },
    { group: 'Mi cuenta' },
    { href: '#/perfil', label: '👤 Perfil' },
    { href: 'index.html#/cuenta', label: '🛒 Mis compras', external: true },
  ];
  return [
    { href: '#/inicio', label: '🏠 Inicio' },
    { href: '#/eventos', label: '🏟️ Mis álbumes', need: true },
    { href: '#/subir', label: '＋ Subir fotos', need: true },
    ...(PLANS[planOf(S.profile)]?.team ? [{ href: '#/equipo', label: '👥 Mi equipo' }] : []),
    ...((S.teams || []).length ? [{ href: '#/equipos', label: '🤝 Equipos' }] : []),
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
// Mientras se registra o completa lo básico (perfil, WhatsApp, precio, Mercado Pago), el botón de WhatsApp muestra
// un globito fijo "¿Tenés algún inconveniente?" (se puede cerrar).
const SUPPORT_WA = '5493424856528';
const WA_BUBBLE_OFF = 'qmf-wa-bubble-off';
const setupPending = p => !p || !(p.displayName && p.zone && p.bio && p.avatarUrl) || !p.socials?.whatsapp || !((p.defaults?.price || 0) > 0) || !p.mpConnected;
function setupBubble(on) {
  const fab = document.querySelector('.wa-fab');
  if (!fab) return;
  let off = false;
  try { off = !!sessionStorage.getItem(WA_BUBBLE_OFF); } catch { /* nada */ }
  const show = on && !off && !S.isSuper;
  let b = document.querySelector('.wa-bubble');
  if (!show) { b?.remove(); return; }
  if (b) return;
  b = document.createElement('div');
  b.className = 'wa-bubble';
  b.innerHTML = '<a target="_blank" rel="noopener">¿Tenés algún inconveniente?<b>Escribinos por WhatsApp</b></a><button type="button" aria-label="Cerrar">×</button>';
  b.querySelector('a').href = fab.href;
  b.querySelector('button').onclick = () => { try { sessionStorage.setItem(WA_BUBBLE_OFF, '1'); } catch { /* nada */ } b.remove(); };
  fab.after(b);
  // En el celular tapa contenido: se va solo a los 10 segundos y no vuelve en esta sesión (el botón verde sigue).
  if (matchMedia('(max-width: 760px)').matches) setTimeout(() => { try { sessionStorage.setItem(WA_BUBBLE_OFF, '1'); } catch { /* nada */ } b.remove(); }, 10000);
}
// Antes de tener perfil (registro): mensaje genérico de alta.
function signupSupport() {
  const fab = document.querySelector('.wa-fab');
  if (!fab) return;
  fab.href = `https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent('Hola! Me estoy registrando como fotógrafo en Quiero Mis Fotos y tengo un inconveniente: ')}`;
  document.querySelector('.wa-bubble')?.remove();
  setupBubble(true);
}

function updateSupportLink() {
  const fab = document.querySelector('.wa-fab');
  if (!fab || !S.profile) return;
  const r = myRules();
  const label = PLANS[r.plan]?.label || 'Gratis';
  const setup = setupPending(S.profile);
  const msg = setup
    ? `Hola! Soy ${S.profile.displayName || ''} (fotógrafo, plan ${label}). Estoy configurando mi cuenta y tengo un inconveniente: `
    : `${r.priority ? '⭐ ATENCIÓN PRIORITARIA · ' : ''}Hola! Soy ${S.profile.displayName || ''} (fotógrafo, plan ${label}). Les escribo por: `;
  const url = `https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent(msg)}`;
  fab.href = url;
  document.querySelectorAll('.foot-help a').forEach(a => { a.href = url; });
  if (r.priority) fab.querySelector('.wa-tip').innerHTML = '⭐ Tenés atención prioritaria<b>Escribinos por WhatsApp</b>';
  const bubble = document.querySelector('.wa-bubble a');
  if (bubble && bubble.getAttribute('href') !== url) bubble.href = url;
  setupBubble(setup);
}

function renderShell() {
  updateSupportLink();
  if (S.profile.status === 'suspended' && !S.isSuper) {
    root.innerHTML = `<div class="container"><div class="auth-box card"><h1>Cuenta suspendida</h1><p class="muted">Tu cuenta de fotógrafo está suspendida. Si creés que es un error, contactá al administrador.</p></div></div>`;
    return;
  }
  root.innerHTML = `${S.isSuper ? '<div id="alerts" class="alerts-bar"></div>' : ''}${verifyBarHtml()}<div class="panel ${S.isSuper ? '' : 'has-tabs'}"><nav class="sidenav" id="nav"></nav><main id="view"></main></div>
    ${S.isSuper ? '' : '<nav class="tabbar" id="tabbar" aria-label="Secciones"></nav>'}`;
  document.body.classList.toggle('with-tabbar', !S.isSuper);
  const want = wantedPlan();
  if (want) {
    try { sessionStorage.removeItem(WANT_KEY); } catch { /* nada */ }
    if (!S.isSuper && PLANS[want] && want !== 'free' && want !== planOf(S.profile)) history.replaceState(null, '', `#/web?elegir=${want}`);
  }
  window.onhashchange = route;
  route();
  bindVerifyBar();
  if (S.isSuper) drawAlerts();
}

// Superadmin: alertas del Worker (pagos que no se pudieron registrar, cobros duplicados).
async function drawAlerts() {
  const box = $('#alerts');
  if (!box) return;
  const [snap, cx] = await Promise.all([
    getDocs(query(collection(db, 'alerts'), orderBy('createdAt', 'desc'), limit(20))).catch(() => null),
    getDocs(query(collection(db, 'cancelRequests'), orderBy('createdAt', 'desc'), limit(20))).catch(() => null),
  ]);
  // Pedidos del botón de arrepentimiento: hay que responder dentro de las 24 h.
  const list = [
    ...(cx?.docs || []).map(d => ({ id: d.id, coll: 'cancelRequests', createdAt: d.data().createdAt,
      text: `🔙 Botón de arrepentimiento — código ${d.id.slice(0, 8).toUpperCase()}: ${d.data().name} <${d.data().email}>${d.data().orderRef ? `, pedido ${d.data().orderRef}` : ''}${d.data().reason ? `. Motivo: ${d.data().reason}` : ''}. Responder dentro de las 24 h.` })),
    ...(snap?.docs || []).map(d => ({ id: d.id, coll: 'alerts', ...d.data() })),
  ];
  box.innerHTML = list.length ? `<div class="notice danger stack" style="max-width:1200px;margin:12px auto 0">
    <strong>⚠️ ${list.length} alerta${list.length > 1 ? 's' : ''} para revisar</strong>
    ${list.map(a => `<div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px"><span class="small">${esc(fmtTs(a.createdAt))} · ${esc(a.text)}</span><button class="btn sm" data-alert="${esc(a.id)}" data-coll="${a.coll}">Resuelta</button></div>`).join('')}
  </div>` : '';
  $$('[data-alert]', box).forEach(b => b.onclick = async () => {
    try { await deleteDoc(doc(db, b.dataset.coll, b.dataset.alert)); drawAlerts(); } catch (e) { toast(errMsg(e), 'error'); }
  });
}

function route() {
  updateSupportLink(); // el globito de ayuda se va solo cuando completa lo básico
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
    if (b === 'costos') return run(viewAdminCosts);
    if (b === 'metricas') return run(viewAdminMetrics);
    if (b === 'clientes') return run(viewAdminCustomers);
    if (b === 'compras') return run(viewAdminPurchases);
    return run(viewAdminPhotographers);
  }
  // Plan Empresas: invitación, equipo de la empresa y álbumes donde sube un colaborador (también con cuenta pendiente).
  if (a === 'unirse' && b) return run(() => viewJoin(view, { token: b, onJoined: async () => { S.teams = await loadMyTeams(S.user.uid); } }));
  if (a === 'equipo' && !S.isSuper) return run(() => viewTeam(view, { uid: S.user.uid, profile: S.profile, settings: S.settings }));
  if (a === 'equipos') return run(() => viewTeams(view, { uid: S.user.uid, teams: S.teams || [] }));
  if (a === 'equipo-evento' && b && parts[2]) return run(() => viewTeamEvent(view, { owner: b, eid: parts[2], uid: S.user.uid, settings: S.settings, tax: S.tax }));
  if (a === 'perfil') return run(viewProfile);
  if (a === 'config' && !S.isSuper) return run(viewConfig);
  if (a === 'mp' && !S.isSuper) return run(viewMp);
  if (a === 'evento' && b && (isApproved() || S.isSuper)) return run(() => viewEvent(b));
  if (a === 'eventos' && isApproved() && !S.isSuper) return run(viewMyEvents);
  if (a === 'subir' && isApproved() && !S.isSuper) return run(viewUploadPicker);
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
  // Inicio · Álbumes · ＋ Subir (central) · Ventas · Más (el resto de las secciones: perfil, precios, MP, web…).
  const tabs = [
    { href: '#/inicio', icon: '🏠', label: 'Inicio' },
    ...(isApproved()
      ? [{ href: '#/eventos', icon: '🏟️', label: 'Álbumes', also: '#/evento/' }, { href: '#/subir', icon: '＋', label: 'Subir', cls: 'tab-up' }, { href: '#/ventas', icon: '💰', label: 'Ventas' }]
      : [{ href: '#/perfil', icon: '👤', label: 'Perfil' }]),
  ];
  const cur = '#/' + key;
  const inTabs = tabs.some(t => cur.startsWith(t.href) || (t.also && cur.startsWith(t.also)));
  bar.innerHTML = tabs.map(t => `<a href="${t.href}" class="${t.cls || ''} ${cur.startsWith(t.href) || (t.also && cur.startsWith(t.also)) ? 'on' : ''}"><span>${t.icon}</span>${t.label}</a>`).join('')
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

// Novedades para los fotógrafos en Inicio, hasta que la cierra (por dispositivo) o vence.
const NEWS = { id: '2026-11-video-portada-selfie', until: '2026-12-03', items: [
  ['🎬', 'Video para historias', 'En cada álbum, en <strong>Compartir</strong>, se arma solo un video con tus mejores fotos, más texto para WhatsApp, QR y cartel para la cancha.'],
  ['🖼️', 'Elegí la portada de tu evento', 'Usá una de tus fotos (sin marca de agua) o subí una imagen, y encuadrala. Ahora tu nombre aparece en cada evento.'],
  ['🤳', 'Búsqueda por selfie', 'Tus clientes se buscan con una selfie. En álbumes subidos antes, tocá <strong>Prepararlas ahora</strong>.'],
  ['💡', 'Tip: precio especial', 'Una foto del equipo completo la compra uno y la comparte con todos: subile el precio. Elegí esas fotos en el álbum y tocá <strong>💲 Precio</strong>.'],
] };
function newsCardHtml() {
  let seen = false;
  try { seen = localStorage.getItem('qmf-news') === NEWS.id; } catch { /* nada */ }
  if (seen || todayIso() > NEWS.until) return '';
  return `<div class="card stack news-card" id="news-card">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">✨ Novedades</h2><button class="btn ghost sm" type="button" aria-label="Cerrar novedades" onclick="try{localStorage.setItem('qmf-news','${NEWS.id}')}catch{};this.closest('#news-card').remove()">✕</button></div>
    ${NEWS.items.map(([i, t, d]) => `<div class="item-row"><span style="font-size:1.3rem">${i}</span><span class="grow"><strong>${t}</strong><br><span class="muted small">${d}</span></span></div>`).join('')}
  </div>`;
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
  // Primero lo que deja vender (Mercado Pago, precio, álbum, fotos); después lo que ayuda a vender más.
  const steps = [
    { ok: !!p.mpConnected, label: 'Vinculá Mercado Pago', hint: 'Obligatorio para vender: la plata te llega directo a tu cuenta.', href: '#/mp', sell: true },
    { ok: (p.defaults?.price || 0) > 0, label: 'Definí tu precio y tu marca de agua', hint: 'Precio por foto, packs y tu logo (opcional).', href: '#/config', sell: true },
    // La aprobación solo aparece si está activada la revisión manual y la cuenta todavía espera.
    ...(approved || S.settings.autoApprove ? [] : [{ ok: false, label: 'Aprobación de tu cuenta', hint: 'La revisamos a mano. Mientras tanto podés completar todo lo demás.', href: '', sell: true }]),
    { ok: evs.length > 0, label: 'Creá tu primer álbum', hint: 'Un álbum por partido, torneo o carrera (o sumate a un evento general).', href: approved ? '#/eventos' : '', sell: true },
    { ok: totalPhotos > 0, label: 'Subí tus fotos', hint: `La marca de agua se aplica sola. Se venden durante ${myRules().days} días.`, href: approved ? (evs[0] ? `#/evento/${evs[0].id}` : '#/eventos') : '', sell: true },
    { ok: !!p.socials?.whatsapp, label: 'Cargá tu WhatsApp', hint: 'Para que te pidan presupuestos desde tu perfil.', href: '#/perfil' },
    { ok: !!(p.displayName && p.zone && p.bio && p.avatarUrl), label: 'Completá tu perfil', hint: 'Foto, zona y una bio corta: es lo primero que ven los clientes.', href: '#/perfil' },
    { ok: pushOn(), label: 'Activá los avisos de venta', hint: 'Te llega una notificación cada vez que vendés.', href: '#push' },
  ];
  const done = steps.filter(x => x.ok).length;

  $('#view').innerHTML = `
    <h1>Hola, ${esc(p.displayName)}</h1>
    ${planCardHtml(p)}
    ${newsCardHtml()}
    <div id="home-alerts"></div>
    ${approved && !p.mpConnected && totalPhotos > 0 ? `<div class="notice danger"><strong>💳 Tus fotos se ven pero no se pueden comprar.</strong><br>Falta vincular Mercado Pago: los compradores ven "todavía no está a la venta". <a href="#/mp">Vincular ahora</a></div>` : ''}
    ${p.status === 'approved' && (S.settings.transfer?.plans || []).includes(planOf(p)) && !p.transferOn && !p.transferBlocked ? `<div class="notice ok row" style="justify-content:space-between;gap:8px">
      <span>🏦 <strong>Tu plan incluye cobrar por transferencia</strong> (sin la comisión de Mercado Pago). Activalo cargando el alias de tu Mercado Pago.</span>
      <a class="btn sm primary" href="#/mp?ver=transfer">Activar</a></div>` : ''}
    ${(np => np.length ? `<div class="notice danger"><strong>💲 Álbumes sin precio: nadie puede comprar esas fotos.</strong><br>${np.map(ev => `<a href="#/evento/${ev.id}">${esc(ev.name)}</a>`).join(' · ')}</div>` : '')(evs.filter((ev, i) => sets[i] && (sets[i].photoCount || 0) > 0 && !(sets[i].price > 0) && !sets[i].originalsDeleted))}
    ${installCardHtml()}
    ${p.status === 'pending' ? `<div class="notice warn"><strong>Tu cuenta está pendiente de aprobación.</strong><br>Mientras tanto podés completar tu perfil, subir tu foto y tu portfolio, y configurar precios y marca de agua.</div>` : ''}
    ${done < steps.length ? `<div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">🚀 Primeros pasos</h2><strong class="small">${done} de ${steps.length} listos</strong></div>
      ${steps.filter(x => x.sell).every(x => x.ok) ? '<div class="notice ok small" style="margin:0">✅ Ya podés vender. Lo que falta te ayuda a vender más.</div>' : ''}
      <div class="meter"><span style="width:${Math.round((done / steps.length) * 100)}%"></span></div>
      ${steps.map((x, i) => `${i === 0 ? '<div class="muted small" style="font-weight:700">Para empezar a vender</div>' : !x.sell && steps[i - 1].sell ? '<div class="muted small" style="font-weight:700;margin-top:6px">Para vender más</div>' : ''}<div class="item-row step ${x.ok ? 'ok' : ''}">
        <span class="step-n">${x.ok ? '✓' : i + 1}</span>
        <span class="grow"><strong>${x.label}</strong>${x.ok ? '' : `<br><span class="muted small">${x.hint}</span>`}</span>
        ${x.ok || !x.href ? '' : x.href === '#push' ? '<button class="btn sm primary" data-push-on>Activar</button>' : `<a class="btn sm ${steps.findIndex(y => !y.ok) === i ? 'primary' : ''}" href="${x.href}">Hacerlo</a>`}
      </div>`).join('')}
    </div>` : ''}
    <div id="home-dash"></div>
    <div id="home-push"></div>
    <div class="card"><h2>Tu perfil público</h2><p class="muted">Así te ven los compradores.</p><a class="btn" target="_blank" href="index.html#/f/${esc(p.slug)}">Ver mi perfil</a></div>`;

  // ---- localidad escrita a mano (antes de la lista oficial): se pide elegirla de la lista
  if (p.zone !== undefined && !S.isSuper) canonicalPlace(p.zone).then(c => {
    if (!c) $('#home-alerts')?.insertAdjacentHTML('beforebegin', `<div class="notice warn row" style="justify-content:space-between"><span>📍 Elegí tu localidad de la lista para aparecer en "Fotógrafos en tu zona".</span><a class="btn sm" href="#/perfil">Elegir</a></div>`);
  }).catch(() => {});

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
    const mpFee = o => (o.payMethod === 'transfer' ? 0 : Math.round(((o.total || 0) * mp.percent) / 100));
    const net = o => (o.total || 0) - (o.platformFee || 0) - mpFee(o);
    const ts = o => (o.paidAt || o.createdAt)?.toMillis?.() || 0;
    const startDay = new Date(); startDay.setHours(0, 0, 0, 0);
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
    const soldBy = new Map();
    for (const o of orders) for (const it of o.items || []) soldBy.set(it.photoId, { n: (soldBy.get(it.photoId)?.n || 0) + 1, thumb: it.thumbUrl, ev: o.eventId });
    const topPhotos = [...soldBy.entries()].filter(([, v]) => v.n > 1).sort((a, b) => b[1].n - a[1].n).slice(0, 8);

    $('#home-dash').innerHTML = `
      <div class="stats">${block('Hoy', since(startDay.getTime()))}${block('Últimos 7 días', since(now - 7 * day))}${block('Este mes', since(startMonth.getTime()))}${block('Total', orders)}
        <div class="stat"><span class="muted small">Visitas (30 días)</span><strong>${evVisits30.toLocaleString('es-AR')}</strong><span class="muted small">a tus eventos · ${pfVisits30.toLocaleString('es-AR')} a tu perfil</span></div></div>
      <p class="muted small" style="margin-top:0">Montos netos estimados (después de la comisión de la plataforma y de Mercado Pago, ${mp.percent}%).
        ${pending.length ? `<br>💳 <strong>A acreditar en Mercado Pago: ${fmtMoney(sum(pending, net))}</strong> (cobrás ${mp.label.toLowerCase()}).` : ''}</p>
      <div id="home-transfer"></div>
      ${rows.length ? `<div class="card"><h2>Tus álbumes</h2><div class="table-wrap"><table class="list">
        <tr><th>Evento</th><th>Se vende</th><th>Fotos</th>${lvl >= 2 ? '<th>Visitas</th><th>Fotos vistas</th><th>Al carrito</th>' : ''}<th>Vendidas</th>${lvl >= 2 ? '<th>Ventas c/100 visitas</th>' : ''}<th>Neto</th></tr>
        ${rows.map(x => `<tr><td><a href="#/evento/${x.ev.id}">${esc(x.ev.name)}</a></td><td>${countdownHtml(x.ev, x.set)}</td><td>${x.set.photoCount}</td>
          ${lvl >= 2 ? `<td>${x.views}</td><td>${x.pv}</td><td>${x.ca}</td>` : ''}<td>${x.sold}</td>
          ${lvl >= 2 ? `<td>${x.views ? ((x.sold / x.views) * 100).toFixed(1) : '—'}</td>` : ''}<td>${fmtMoney(x.net)}</td></tr>`).join('')}
      </table></div>${lvl < 2 ? lockNote('Profesional Lite', 'Visitas, fotos vistas y agregadas al carrito por evento') : ''}</div>` : ''}
      ${topPhotos.length ? `<div class="card"><h2>📈 Tus fotos más vendidas</h2><p class="muted small" style="margin-top:0">Fijate qué tomas funcionan para repetirlas en el próximo evento.</p>
        <div class="top-photos">${topPhotos.map(([, v]) => `<a href="#/evento/${v.ev}" class="top-photo"><img src="${esc(v.thumb)}" alt="" loading="lazy"><span>×${v.n}</span></a>`).join('')}</div></div>` : ''}
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

  // ---- cobro por transferencia: saldo de comisiones, o la invitación a activarlo / a subir de plan
  if (approved) drawHomeTransfer(orders).catch(() => {});
  // ---- avisos push
  renderPushCard();
  $$('[data-push-on]').forEach(b => b.onclick = () => turnPushOn(b));
}

// Días que le quedan de venta al álbum + Extender (en la tabla de Inicio).
function countdownHtml(ev, set) {
  const r = retentionState(set);
  if (r.k === 'active') return `<span class="pill ${r.days <= 3 ? 'warn' : ''}">${r.days === 1 ? 'hasta mañana' : `${r.days} días`}</span>${r.days <= 7 ? ` <a class="small" href="#/evento/${ev.id}">Extender</a>` : ''}`;
  if (r.k === 'grace') return `<span class="pill danger">vencido</span> <a class="small" href="#/evento/${ev.id}">Extender</a>`;
  if (r.k === 'deleted') return '<span class="pill">terminado</span>';
  return '—';
}

// Tarjeta de cobro por transferencia en Inicio: saldo a pagar si lo usa; si su plan no lo tiene, cuánto se ahorraría.
async function drawHomeTransfer(orders) {
  const box = $('#home-transfer');
  const plans = S.settings.transfer?.plans || [];
  if (!box || !plans.length) return;
  const p = S.profile, mp = mpPlanOf(p, S.settings);
  const names = plans.map(id => PLANS[id]?.label || id).join(', ');
  if (!plans.includes(planOf(p))) {
    // Lo que pagó de comisión de Mercado Pago este mes: lo que se hubiera ahorrado cobrando por transferencia.
    const m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0);
    const fee = orders.filter(o => o.payMethod !== 'transfer' && ((o.paidAt || o.createdAt)?.toMillis?.() || 0) >= m.getTime()).reduce((a, o) => a + Math.round(((o.total || 0) * mp.percent) / 100), 0);
    box.innerHTML = `<div class="card stack upsell">
      <h2 style="margin:0">🏦 Cobrá por transferencia y ahorrate la comisión de Mercado Pago</h2>
      <p style="margin:0">${fee ? `Este mes pagaste <strong>${fmtMoney(fee)}</strong> de comisión de Mercado Pago (${mp.percent}%). ` : ''}Con el cobro por transferencia tus clientes te pagan a tu alias y la venta se acredita sola, <strong>sin la comisión de MP</strong>.</p>
      <div class="row" style="justify-content:space-between"><span class="muted small">Incluido en ${esc(names)}.</span><a class="btn primary sm" href="#/web">⭐ Ver planes</a></div></div>`;
    return;
  }
  if (!p.transferOn) {
    box.innerHTML = `<div class="card row" style="justify-content:space-between;gap:8px"><span>🏦 Tu plan incluye <strong>cobro por transferencia</strong>: tus clientes te pagan a tu alias, sin la comisión de Mercado Pago.</span><a class="btn primary sm" href="#/mp">Activarlo</a></div>`;
    return;
  }
  const bal = (await getDoc(doc(db, 'feeBalance', S.user.uid)).catch(() => null))?.data() || {};
  const owed = Math.max(0, Math.round(((bal.accrued || 0) - (bal.paid || 0)) * 100) / 100);
  box.innerHTML = `<div class="card row" style="justify-content:space-between;gap:8px">
    <span>🏦 Cobro por transferencia activo${bal.orders ? ` · ${bal.orders} venta${bal.orders === 1 ? '' : 's'}` : ''}. ${owed > 0 ? `Saldo de comisiones a pagar: <strong>${fmtMoney(owed)}</strong>` : '<span class="muted">No debés comisiones.</span>'}</span>
    ${owed > 0 ? '<a class="btn primary sm" href="#/mp">Pagar saldo</a>' : '<a class="btn sm" href="#/mp">Ver</a>'}</div>`;
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
    ${p.role === 'photographer' ? planCardHtml(p) : ''}
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
        <label class="field">Localidad<input type="text" id="pf-zone" maxlength="80" required value="${esc(p.zone)}" placeholder="Empezá a escribir y elegí de la lista"><span class="hint">Elegila de la lista: así te encuentran en "Fotógrafos en tu zona".</span></label>
        <div class="field"><span>Zonas donde trabajás</span><input type="text" id="pf-workzones" maxlength="80">
          <div class="pills" id="pf-workchips" style="margin-top:6px"></div>
          <span class="hint" id="pf-workhint">Localidades donde cubrís eventos. Te encuentran también en esas zonas.</span></div>
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
  placeInput($('#pf-zone'));
  // Zonas de trabajo: de la lista oficial. Si había texto escrito a mano, se reconocen las que se puedan.
  const oldWork = !p.workPlaces && p.workZones ? p.workZones : '';
  let work = null;
  (async () => {
    const init = p.workPlaces || (oldWork ? await guessPlaces(oldWork, (p.zone || '').split(',').pop()).catch(() => []) : []);
    work = multiPlaceInput($('#pf-workzones'), $('#pf-workchips'), init);
    if (oldWork) $('#pf-workhint').textContent = `Antes decía: "${oldWork}". Revisá las localidades y sumá las que falten; se guardan al tocar Guardar.`;
  })();
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    const zone = await canonicalPlace($('#pf-zone').value);
    if (!zone) return toast('Elegí tu localidad de la lista (empezá a escribir y tocá una opción).', 'error');
    const slug = slugify($('#pf-slug').value);
    if (!SLUG_RE.test(slug)) return toast('La dirección debe tener entre 3 y 40 letras, números o guiones.', 'error');
    const socials = {};
    $$('[data-social]').forEach(i => { if (i.value.trim()) socials[i.dataset.social] = i.value.trim(); });
    const upd = {
      displayName: $('#pf-name').value.trim(), slug, zone,
      bio: $('#pf-bio').value.trim(), avatarUrl: $('#pf-avatar').value.trim(), socials,
      ...(work ? { workPlaces: work.get(), workZones: work.get().map(x => x.split(',')[0]).join(', ') } : {}),
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
      <div class="row"><button type="button" class="btn sm" data-add>+ Agregar pack</button>
        <button type="button" class="btn sm" data-suggest title="5 fotos con 20% de descuento y 10 con 30%">✨ Usar packs sugeridos</button></div>`;
    el.querySelectorAll('input').forEach(inp => inp.oninput = () => {
      const r = rows[inp.dataset.i];
      r[inp.dataset.k] = Number(inp.value);
      el.querySelector(`[data-hint="${inp.dataset.i}"]`).innerHTML = hint(r);
    });
    el.querySelectorAll('[data-del]').forEach(btn => btn.onclick = () => { rows.splice(btn.dataset.del, 1); draw(); });
    el.querySelector('[data-add]').onclick = () => { rows.push({ qty: (rows.at(-1)?.qty || 1) + 2, price: 0 }); draw(); };
    // Packs típicos según el precio por foto: 5 con 20% menos y 10 con 30% menos (redondeado).
    el.querySelector('[data-suggest]')?.addEventListener('click', () => {
      const unit = getUnit(), step = unit >= 1000 ? 500 : 100;
      if (!(unit > 0)) return toast('Primero poné tu precio por foto.', 'error');
      const r = (n, off) => Math.max(step, Math.round((unit * n * (1 - off)) / step) * step);
      rows = [{ qty: 5, price: r(5, 0.2) }, { qty: 10, price: r(10, 0.3) }];
      draw();
    });
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
      ${n.total > amount ? `<div class="bd-row"><span>Tu precio</span><span>${fmtMoney(amount)}</span></div><div class="bd-row muted"><span>+ Tasa de servicio (la paga el comprador)</span><span>${fmtMoney(n.total - amount)}</span></div>` : ''}
      <div class="bd-row"><span>Paga el comprador</span><span>${fmtMoney(n.total)}</span></div>
      <div class="bd-row muted"><span>Comisión Quiero Mis Fotos (${myFee()}%)</span><span>−${fmtMoney(n.platformFee)}</span></div>
      <div class="bd-row muted"><span>Comisión Mercado Pago (${plan.percent}% · ${esc(plan.label.toLowerCase())})</span><span>−${fmtMoney(n.mpFee)}</span></div>
      <div class="bd-row total"><span>Te queda</span><span>${fmtMoney(n.net)}</span></div>
    </div>
    <p class="muted small" style="margin:0">La comisión de MP depende del plazo de acreditación que tengas configurado en tu cuenta de Mercado Pago (<a href="#/mp">cambiar</a>). Es una estimación con tarjeta de crédito.</p>`;
}

// Tasa de servicio = comisión de la plataforma + la de Mercado Pago. El fotógrafo elige quién la paga.
function feeModeHtml(name, value) {
  const v = ['absorb', 'half', 'buyer'].includes(value) ? value : 'absorb';
  const opt = (val, title, hint) => `<label class="check"><input type="radio" name="${name}" value="${val}" ${v === val ? 'checked' : ''}> <span>${title} <span class="muted small">(${hint})</span></span></label>`;
  return `
    <p class="muted small" style="margin:0">La tasa de servicio es la comisión de Quiero Mis Fotos (${myFee()}%) más la de Mercado Pago (${mpPlanOf(S.profile, S.settings).percent}%). Elegí quién la paga:</p>
    ${opt('absorb', 'La pago toda yo', 'el comprador paga el precio limpio y a vos se te descuentan las dos comisiones')}
    ${opt('half', 'Mitad yo, mitad el comprador', 'se suma al comprador la mitad como "tasa de servicio"')}
    ${opt('buyer', 'La paga toda el comprador', 'se suma como "tasa de servicio" y a vos te queda el precio completo')}`;
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
        <h3>Tasa de servicio</h3>
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
            <label class="field">Intensidad de la marca de agua <span class="hint" id="wm-op-v">${Math.round(strengthOf(wm) * 100)}%</span>
              <input type="range" id="wm-op" min="0.4" max="1" step="0.05" value="${strengthOf(wm)}">
              <span class="hint">Desde 40%. Más intensa protege más tus fotos; más suave deja ver mejor la foto. Se aplica a las fotos que subas desde ahora.</span></label>
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
    useLogo: $('#wm-uselogo').checked && !!logo.key, strength: Math.max(0.4, Number($('#wm-op').value)),
    logoKey: logo.key, logoUrl: logo.url,
  });
  const preview = () => {
    $('#wm-logo-f').classList.toggle('hidden', !$('#wm-uselogo').checked);
    const c = $('#wm-canvas'), ctx = c.getContext('2d');
    drawSampleScene(ctx, c.width, c.height);
    drawWatermark(ctx, c.width, c.height, readWm(), logo.img, () => 0.5); // vista previa fija (sin saltos al mover la barra)
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
    <div class="card stack" id="mp-transfer"></div>
    <div class="card stack">
      <h2>¿Cuánto cobrás de cada venta?</h2>
      <p class="muted" style="margin:0">Mercado Pago cobra una comisión que depende de cuándo querés tener la plata disponible: si la querés al instante cobra más; si esperás unos días, menos. Ese plazo lo elegís vos en tu cuenta de Mercado Pago y vale para todas tus ventas online.</p>
      <details class="mp-guide">
        <summary><strong>📘 Cómo ver y cambiar el plazo en Mercado Pago</strong></summary>
        <div class="stack small" style="margin-top:8px">
          <div><strong>Desde la compu</strong> (mercadopago.com.ar)
            <ol style="margin:4px 0 0 18px;padding:0">
              <li>Entrá con tu cuenta, la misma que vinculaste acá.</li>
              <li>En el menú, abrí <em>Tu negocio</em> → <em>Costos</em>.</li>
              <li>Buscá la parte de cobros <em>online</em> (Checkout o link de pago).</li>
              <li>Elegí el plazo: al instante o a más días, con menos comisión. Ahí mismo ves el porcentaje de cada opción.</li>
            </ol></div>
          <div><strong>Desde el celular</strong> (app de Mercado Pago)
            <ol style="margin:4px 0 0 18px;padding:0">
              <li>Tocá <em>Más</em> o tu perfil → <em>Tu negocio</em>.</li>
              <li>Entrá a <em>Costos</em> y elegí el plazo de los cobros online.</li>
            </ol></div>
          <p class="muted" style="margin:0">Si no encontrás la opción, escribí <em>costos</em> en el buscador de ayuda de Mercado Pago. Mercado Pago a veces cambia los nombres de los menús.</p>
          <p style="margin:0">✅ Cuando lo tengas, <strong>marcá abajo el mismo plazo</strong> para que tus ventas muestren lo que te queda de verdad.</p>
        </div>
      </details>
      <div class="stack" id="mp-plans">
        ${(S.settings.mpFeePlans || []).map(pl => `<label class="check"><input type="radio" name="mp-plan" value="${esc(pl.id)}" ${mpPlanOf(p, S.settings).id === pl.id ? 'checked' : ''}> ${esc(pl.label)} <span class="muted small">(${pl.percent}% con IVA)</span></label>`).join('')}
      </div>
      <h3>Ejemplo con tu precio por foto${p.defaults?.price ? ` (${fmtMoney(p.defaults.price)})` : ''}</h3>
      <div id="mp-net"></div>
    </div>`;
  const drawNet = () => { $('#mp-net').innerHTML = breakdownHtml(p.defaults?.price || 0, p.defaults?.feeMode || 'absorb'); };
  drawNet();
  drawTransferCard();
  $('#mp-plans').addEventListener('change', async e => {
    const mpReleasePlan = e.target.value;
    try { await updateDoc(doc(db, 'users', S.user.uid), { mpReleasePlan }); S.profile.mpReleasePlan = mpReleasePlan; drawNet(); toast('Plazo guardado'); }
    catch (err) { toast(errMsg(err), 'error'); }
  });
  $('#mp-connect').onclick = async e => {
    if (!await requireVerified()) return;
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

// Cobro por transferencia: el comprador transfiere al alias del fotógrafo (sin comisión de MP). Se reconoce solo
// por el monto con centavos; la comisión de la plataforma se acumula como saldo que el fotógrafo paga aparte.
async function drawTransferCard() {
  const box = $('#mp-transfer');
  if (!box) return;
  // Desde el aviso de Inicio: se baja directo al recuadro.
  const goTo = parseHash().query.get('ver') === 'transfer';
  const p = S.profile, st = S.settings;
  const plans = st.transfer?.plans || [];
  if (!plans.length) { box.remove(); return; }
  const allowed = plans.includes(planOf(p));
  const [bal, pays, bank] = await Promise.all([
    getDoc(doc(db, 'feeBalance', S.user.uid)).then(x => x.data() || {}).catch(() => ({})),
    getDocs(query(collection(db, 'feePayments'), where('uid', '==', S.user.uid), limit(20))).then(x => x.docs.map(d => ({ id: d.id, ...d.data() }))).catch(() => []),
    getDoc(doc(db, 'platformPrivate', 'feeBank')).then(x => x.data() || null).catch(() => null),
  ]);
  const owed = Math.max(0, Math.round(((bal.accrued || 0) - (bal.paid || 0)) * 100) / 100);
  const reported = pays.filter(x => x.status === 'reported').reduce((a, x) => a + x.amount, 0);
  pays.sort((a, b) => (b.reportedAt?.toMillis?.() || 0) - (a.reportedAt?.toMillis?.() || 0));
  const PST = { reported: ['Por confirmar', 'warn'], confirmed: ['Confirmado', 'ok'], rejected: ['No encontrado', 'danger'] };
  box.innerHTML = `
    <h2 style="margin:0">🏦 Cobrar por transferencia</h2>
    <p class="muted" style="margin:0">Tus clientes también pueden pagarte por transferencia a tu alias de Mercado Pago: <strong>no pagás la comisión de Mercado Pago</strong>. Cada pedido tiene un monto con centavos únicos (ej. $8.500,37) y se acredita solo cuando entra a tu Mercado Pago. La comisión de la plataforma (${myFee()}%) se va sumando a un saldo que nos pagás vos por transferencia.</p>
    ${!allowed ? `<div class="notice">Disponible en los planes ${plans.map(id => `<strong>${esc(PLANS[id]?.label || id)}</strong>`).join(', ')}. <a href="#/web">Ver planes</a></div>`
      : p.transferBlocked ? '<div class="notice warn">La plataforma desactivó el cobro por transferencia en tu cuenta. Escribinos por WhatsApp para reactivarlo.</div>'
      : `${p.mpConnected ? '' : '<div class="notice warn small" style="margin:0">Vinculá tu Mercado Pago (arriba): lo usamos para reconocer las transferencias que te llegan.</div>'}
      <label class="check"><input type="checkbox" id="tr-on" ${p.transferOn ? 'checked' : ''}> Ofrecer pago por transferencia en mis fotos</label>
      <div class="notice warn small stack" style="margin:0;gap:4px">
        <strong>⚠️ El alias tiene que ser de la MISMA cuenta de Mercado Pago que vinculaste.</strong>
        <span>Las transferencias se reconocen solas porque las vemos entrar a esa cuenta. Si ponés el alias de otra cuenta (otro Mercado Pago, un banco o una billetera), el pago no se acredita, el comprador no puede descargar y lo tenés que confirmar a mano.</span>
        <span id="tr-acct" class="muted"></span>
        <span class="muted">¿Dónde está tu alias? En la app de Mercado Pago, en los datos de tu cuenta (donde figuran tu <strong>CVU y alias</strong>). Tiene que ser esa misma cuenta.</span>
      </div>
      <label class="field">Alias de esa cuenta de Mercado Pago<input type="text" id="tr-alias" maxlength="40" value="${esc(p.transferAlias || '')}" placeholder="Ej: juan.fotos.mp"></label>
      <label class="check"><input type="checkbox" id="tr-same" ${p.transferAlias ? 'checked' : ''}> Confirmo que este alias es de la cuenta de Mercado Pago que vinculé</label>
      <label class="field">Titular (como aparece al transferir)<input type="text" id="tr-holder" maxlength="60" value="${esc(p.transferHolder || '')}" placeholder="Ej: Juan Pérez"></label>
      <div><button class="btn primary" id="tr-save">Guardar</button></div>`}
    ${(bal.accrued || pays.length) ? `<hr>
      <h3 style="margin:0">Saldo de comisiones</h3>
      <div class="row" style="justify-content:space-between"><span>Comisiones de ventas por transferencia${bal.orders ? ` (${bal.orders})` : ''}</span><strong>${fmtMoney(bal.accrued || 0)}</strong></div>
      <div class="row" style="justify-content:space-between"><span>Pagado</span><strong>−${fmtMoney(bal.paid || 0)}</strong></div>
      <div class="row" style="justify-content:space-between;font-size:1.1rem"><span>Debés</span><strong>${fmtMoney(owed)}</strong></div>
      ${reported ? `<div class="notice small" style="margin:0">Avisaste pagos por ${fmtMoney(reported)} que estamos confirmando.</div>` : ''}
      ${owed > 0 ? `${bank && (bank.alias || bank.cbu) ? `<div class="notice stack small" style="margin:0"><strong>Transferí a Quiero Mis Fotos:</strong>
          ${bank.alias ? `<span>Alias: <strong>${esc(bank.alias)}</strong> <button class="btn sm" data-copyv="${esc(bank.alias)}">📋</button></span>` : ''}
          ${bank.cbu ? `<span>CBU/CVU: <strong>${esc(bank.cbu)}</strong> <button class="btn sm" data-copyv="${esc(bank.cbu)}">📋</button></span>` : ''}
          ${bank.holder ? `<span>Titular: ${esc(bank.holder)}${bank.cuit ? ` · CUIT ${esc(bank.cuit)}` : ''}</span>` : ''}
          ${bank.bank ? `<span>${esc(bank.bank)}</span>` : ''}</div>` : '<div class="notice small" style="margin:0">Escribinos por WhatsApp y te pasamos los datos para pagar.</div>'}
        <div class="row" style="align-items:flex-end"><label class="field" style="flex:1">Monto que transferiste<input type="number" id="fee-amount" min="1" step="0.01" value="${owed}"></label><button class="btn" id="fee-report">Avisar que pagué</button></div>` : ''}
      ${pays.length ? `<div class="stack small">${pays.slice(0, 8).map(x => { const [l, c] = PST[x.status] || [x.status, '']; return `<div class="row" style="justify-content:space-between"><span>${esc(fmtTs(x.reportedAt))} · ${fmtMoney(x.amount)}</span><span class="pill ${c}">${l}</span></div>`; }).join('')}</div>` : ''}` : ''}`;
  $('#tr-save')?.addEventListener('click', async e => {
    const transferAlias = $('#tr-alias').value.trim(), transferHolder = $('#tr-holder').value.trim(), transferOn = $('#tr-on').checked;
    if (transferOn && !/^[A-Za-z0-9.\-]{6,20}$/.test(transferAlias)) return toast('Revisá el alias: entre 6 y 20 letras, números, puntos o guiones.', 'error');
    if (transferOn && !$('#tr-same').checked) return toast('Confirmá que el alias es de la cuenta de Mercado Pago que vinculaste.', 'error');
    e.target.disabled = true;
    try {
      await updateDoc(doc(db, 'users', S.user.uid), { transferOn, transferAlias, transferHolder });
      Object.assign(S.profile, { transferOn, transferAlias, transferHolder });
      toast(transferOn ? 'Listo: tus clientes ya pueden pagarte por transferencia' : 'Guardado');
    } catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  });
  $$('[data-copyv]', box).forEach(b => b.onclick = async () => { try { await navigator.clipboard.writeText(b.dataset.copyv); toast('Copiado'); } catch { toast(b.dataset.copyv); } });
  if (goTo) { history.replaceState(null, '', '#/mp'); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  // Cuenta vinculada (Mercado Pago no informa el alias, pero sí el titular): se muestra y completa el titular si está vacío.
  if ($('#tr-acct') && p.mpConnected) apiGet('/mp/account').then(a => {
    if (!a?.name && !a?.email) return;
    $('#tr-acct').innerHTML = `Cuenta vinculada: <strong>${esc(a.name || '')}</strong>${a.email ? ` (${esc(a.email)})` : ''}. Usá el alias de esta cuenta.`;
    if (a.name && $('#tr-holder') && !$('#tr-holder').value.trim()) $('#tr-holder').value = a.name;
  }).catch(() => {});
  $('#fee-report')?.addEventListener('click', async e => {
    const amount = Number($('#fee-amount').value);
    if (!(amount > 0)) return toast('Escribí el monto que transferiste.', 'error');
    e.target.disabled = true;
    try { await apiPost('/fees/report', { amount }); toast('¡Gracias! Lo confirmamos cuando veamos la transferencia.'); drawTransferCard(); }
    catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  });
}

async function viewSales() {
  const snap = await getDocs(query(collection(db, 'orders'), where('photographerUid', '==', S.user.uid), orderBy('createdAt', 'desc'), limit(300)));
  const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const paid = orders.filter(o => o.status === 'approved');
  const mpPct = mpPlanOf(S.profile, S.settings).percent;
  // Transferencia: sin comisión de MP (la de la plataforma queda como saldo a pagar).
  const net = o => (o.total || 0) - (o.platformFee || 0) - (o.payMethod === 'transfer' ? 0 : Math.round(((o.total || 0) * mpPct) / 100));
  const byEvent = new Map();
  for (const o of paid) {
    const e = byEvent.get(o.eventId) || { name: o.eventName, count: 0, photos: 0, total: 0, net: 0 };
    e.count++; e.photos += o.count || 0; e.total += o.total || 0; e.net += net(o);
    byEvent.set(o.eventId, e);
  }
  const STATUS = { approved: ['Pagado', 'ok'], pending: ['Pendiente', 'warn'], rejected: ['Rechazado', 'danger'], refunded: ['Reembolsado', ''], expired: ['Vencido', 'danger'] };
  const waiting = orders.filter(o => o.payMethod === 'transfer' && ['pending', 'expired'].includes(o.status));
  $('#view').innerHTML = `
    <h1>Ventas</h1>
    ${waiting.length ? `<div class="card stack"><h2 style="margin:0">🏦 Transferencias por recibir</h2>
      <p class="muted small" style="margin:0">Se acreditan solas cuando entra a tu Mercado Pago el monto exacto (con los centavos). Si te transfirieron otro monto o desde otra cuenta, confirmalo a mano.</p>
      ${waiting.map(o => `<div class="item-row"><div class="grow"><strong>$ ${Number(o.transferAmount || 0).toLocaleString('es-AR', { minimumFractionDigits: 2 })}</strong> · ${esc(o.eventName)} · ${o.count} foto${o.count === 1 ? '' : 's'}<br>
        <span class="muted small">${esc(fmtTs(o.createdAt))} · ${o.status === 'expired' ? 'venció el plazo' : `vence ${esc(fmtTs(o.transferExpiresAt))}`}</span></div>
        <button class="btn sm ok" data-markpaid="${o.id}">Marcar como pagado</button></div>`).join('')}</div>` : ''}
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
        ${orders.filter(o => o.status !== 'pending').map(o => { const [l, c] = STATUS[o.status] || [o.status, '']; return `<tr><td>${esc(fmtTs(o.createdAt))}</td><td>${esc(o.eventName)}</td><td>${o.count}</td><td>${fmtMoney(o.total)}${o.payMethod === 'transfer' ? ' <span class="muted small">🏦</span>' : ''}</td><td><span class="pill ${c}">${l}</span>${o.status === 'approved' ? ` <a class="small" target="_blank" href="index.html#/pedido/${o.id}" title="Ver el pedido y descargar lo mismo que recibió el comprador">Ver</a>` : ''}</td></tr>`; }).join('')}
      </table></div>` : '<div class="empty">Todavía no tenés ventas.</div>'}
    </div>`;
  $$('[data-markpaid]').forEach(b => b.onclick = async () => {
    const o = waiting.find(x => x.id === b.dataset.markpaid);
    if (!confirm(`¿Recibiste la transferencia de ${o.eventName}? El comprador va a poder descargar las fotos y la comisión de ${fmtMoney(o.platformFee || 0)} se suma a tu saldo.`)) return;
    b.disabled = true;
    try { await apiPost(`/orders/${o.id}/mark-paid`); toast('Listo: el comprador ya puede descargar'); route(); }
    catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
  });
}

// ＋ Subir: elegir a qué álbum (los más recientes) o crear uno nuevo.
async function viewUploadPicker() {
  const snap = await getDocs(query(collection(db, 'events'), where('photographerUids', 'array-contains', S.user.uid), orderBy('date', 'desc'), limit(6)));
  const evs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  $('#view').innerHTML = `
    <h1>Subir fotos</h1>
    <button class="btn primary big-cta" id="up-new" style="width:100%">➕ Álbum nuevo</button>
    ${evs.length ? `<h2 style="margin-top:22px">O a un álbum que ya tenés</h2>
      <div class="stack">${evs.map(ev => `<a class="item-row card" href="#/evento/${ev.id}" style="text-decoration:none">
        <div class="grow"><strong>${esc(ev.name)}</strong><br><span class="muted small">${esc(fmtDate(ev.date))}${ev.location ? ` · ${esc(ev.location)}` : ''}</span></div>${statusPill(ev)}</a>`).join('')}</div>` : ''}`;
  $('#up-new').onclick = () => eventDialog(null);
}

// ================================================================ eventos (fotógrafo)
async function viewMyEvents() {
  const snap = await getDocs(query(collection(db, 'events'), where('photographerUids', 'array-contains', S.user.uid), orderBy('date', 'desc'), limit(200)));
  const evs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  // Mi set en cada evento: fotos, vendidas y vencimiento.
  const [sets, sales, views] = await Promise.all([
    Promise.all(evs.map(ev => getDoc(doc(db, 'events', ev.id, 'sets', S.user.uid)).then(s => s.data() || null).catch(() => null))),
    getDocs(query(collection(db, 'salesStats'), where('photographerUid', '==', S.user.uid))).catch(() => null),
    // Visitas al álbum (contadores anónimos de stats/{evento}).
    Promise.all(evs.map(ev => getDoc(doc(db, 'stats', ev.id)).then(s => s.data()?.views || 0).catch(() => 0))),
  ]);
  const sold = new Map((sales?.docs || []).map(d => [d.data().eventId, d.data().soldPhotos || 0]));
  evs.forEach((ev, i) => { ev.mySet = sets[i] && { ...sets[i], soldPhotos: sold.get(ev.id) || 0, views: views[i] }; });
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Mis álbumes</h1>
      <div class="row"><button class="btn" id="join">Sumarme a un evento</button><button class="btn primary" id="new">＋ Álbum nuevo</button></div>
    </div>
    ${evs.length ? (([open, hist]) => `${open.length ? `<div class="events-grid">${open.map(ev => panelEventCard(ev)).join('')}</div>` : '<div class="card"><div class="empty">No tenés álbumes abiertos. Creá uno nuevo para subir fotos.</div></div>'}
      ${hist.length ? `<h2 style="margin-top:26px">📦 Historial</h2><p class="muted small" style="margin-top:-6px">Álbumes cerrados: se ven en la web con fotos de muestra y no ocupan tu lugar de álbum.</p>
        <div class="events-grid">${hist.map(ev => panelEventCard(ev)).join('')}</div>` : ''}`)([evs.filter(ev => !ev.mySet?.originalsDeleted), evs.filter(ev => ev.mySet?.originalsDeleted)])
      : `<div class="card"><div class="empty">Todavía no estás en ningún evento.<br>Creá uno nuevo o sumate a un evento general.</div></div>`}`;
  $('#new').onclick = () => eventDialog(null);
  $('#join').onclick = joinDialog;
  $$('[data-share]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); shareEvent(evs.find(x => x.id === b.dataset.share)); });
}

function statusPill(ev) {
  if (ev.status === 'removed') return '<span class="pill">Eliminado por el fotógrafo</span>';
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
    deleted: '<span class="stat-chip" title="Ya no se vende: queda con fotos de muestra">📦 Cerrado</span>',
    notstarted: `<span class="stat-chip" title="El plazo arranca cuando subís la primera foto">⏳ ${myRules().days} días al subir</span>`,
    active: `<span class="stat-chip ${r.days <= 3 ? 'warn' : ''}" title="Días que le quedan a la venta">⏳ ${r.days} día${r.days === 1 ? '' : 's'}</span>`,
    grace: `<span class="stat-chip danger" title="Ya no se vende. Extendé el plazo antes de que se borren los originales">⛔ Sin venta · se borra en ${r.ddays} día${r.ddays === 1 ? '' : 's'}</span>`,
  }[r.k] || '';
  return `
    <div class="set-stats">
      <span class="stat-chip" title="Fotos en el álbum">📷 ${set.photoCount || 0}</span>
      ${(c => c.photos ? (c.max ? `<span class="stat-chip ${c.used >= c.max * 0.9 ? 'warn' : ''}" title="Fotos del álbum y tope del plan">🗂️ ${c.used} / ${c.fmt(c.max)}</span>` : '')
        : `<span class="stat-chip ${c.max && c.used >= c.max * 0.9 ? 'warn' : ''}" title="Espacio que ocupa el álbum (originales + muestras)">💾 ${fmtBytes(c.used)}${c.max ? ` / ${fmtBytes(c.max)}` : ''}</span>`)(capOf(set))}
      ${set.views != null ? `<span class="stat-chip" title="Visitas al álbum (una por persona cada 6 horas)">👁️ ${Number(set.views).toLocaleString('es-AR')} visita${set.views === 1 ? '' : 's'}</span>` : ''}
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
        if (!await requireVerified()) return;
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

// ¿El álbum propio tiene precio? (sin precio no se puede publicar). Los eventos generales no tienen precio propio.
async function hasPrice(ev) {
  if (S.isSuper || ev.kind === 'general') return true;
  const st = (await getDoc(doc(db, 'events', ev.id, 'sets', ev.createdBy || S.user.uid)).catch(() => null))?.data();
  if (st?.price > 0) return true;
  toast('Primero poné el precio por foto del álbum (en Precios, más abajo) y guardalo. Sin precio no se puede publicar.', 'error');
  return false;
}

// Superadmin: link para restablecer la contraseña de un cliente o fotógrafo (copiar, WhatsApp o mail).
function resetPasswordDialog(uid, name = '', wa = '') {
  const dlg = openDialog(`🔑 Restablecer clave${name ? ' · ' + name : ''}`, '<div id="pw-out"><div class="spinner"></div></div>',
    '<button class="btn" data-close>Cerrar</button><button class="btn primary" id="pw-mail" disabled>✉️ Enviárselo por mail</button>');
  const out = $('#pw-out', dlg);
  apiPost('/admin/users/reset', { uid }).then(r => {
    const msg = `Hola! Te dejo el link para elegir una nueva contraseña de Quiero Mis Fotos (cuenta ${r.email}): ${r.link}`;
    out.innerHTML = `<div class="stack">
      <span>Cuenta: <strong>${esc(r.email)}</strong>${r.google ? ' <span class="pill">También entra con Google</span>' : ''}</span>
      <span class="muted small">Con este link elige una contraseña nueva y después entra con su mail y esa contraseña. Vence en unas horas y sirve una sola vez.</span>
      <code style="display:block;word-break:break-all;font-size:.75rem">${esc(r.link)}</code>
      <div class="row"><button class="btn sm" id="pw-copy">Copiar link</button><a class="btn sm" target="_blank" rel="noopener" href="${esc(wa ? waLink(wa, msg) : 'https://wa.me/?text=' + encodeURIComponent(msg))}">💬 Mandar por WhatsApp</a></div></div>`;
    $('#pw-copy', dlg).onclick = () => navigator.clipboard.writeText(r.link).then(() => toast('Link copiado'), () => toast('No se pudo copiar', 'error'));
    const mb = $('#pw-mail', dlg);
    mb.disabled = false;
    mb.onclick = async () => {
      mb.disabled = true;
      try { const s = await apiPost('/admin/users/reset', { uid, send: true }); toast(s.sent ? `Mail enviado a ${s.email}` : 'No se pudo enviar el mail', s.sent ? '' : 'error'); }
      catch (e) { toast(errMsg(e), 'error'); }
      mb.disabled = false;
    };
  }).catch(e => { out.innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`; });
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
  // Álbum nuevo: publicado desde el principio, así ya tiene link para compartir mientras se suben las fotos
  // (sin correo confirmado no se puede publicar: arranca en borrador).
  ev = ev || { name: '', date: todayIso(), location: '', tagIds: [], status: needsVerify() ? 'draft' : 'published', openToJoin: general, coverUrl: '' };
  const tax = S.tax;
  const sel = new Set(ev.tagIds || []);
  const dlg = openDialog(isNew ? (general ? 'Nuevo evento general' : 'Nuevo álbum') : 'Editar evento', `
    <label class="field">Nombre<input type="text" id="ev-name" required maxlength="100" value="${esc(ev.name)}" placeholder="Ej: Torneo Apertura Sub-14 — Fecha 3"></label>
    <div class="grid2">
      <label class="field">Fecha<input type="date" id="ev-date" required value="${esc(ev.date)}">
        <span class="hint">Podés crear eventos futuros: aparecen en "Próximos eventos" y en el calendario, y la gente puede activar 🔔 para que le avisemos cuando subas las fotos.</span></label>
      <label class="field">Localidad<input type="text" id="ev-city" maxlength="80" required value="${esc(ev.city || '')}" placeholder="Empezá a escribir y elegí de la lista"></label>
    </div>
    <label class="field">Lugar (opcional)<input type="text" id="ev-loc" maxlength="100" value="${esc(ev.city ? ev.venue || '' : ev.location || '')}" placeholder="Ej: Cancha de Querandí, Hipódromo, Parque Independencia"></label>
    ${tax.types.filter(t => t.id !== 'lugar').map(t => { // "Lugar" ya se pide arriba (campo Lugar); las etiquetas viejas se conservan
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
        <div class="row"><img id="ev-cover-img" src="${esc(ev.coverUrl || ev.autoCoverUrl || '')}" alt="" class="${ev.coverUrl || ev.autoCoverUrl ? '' : 'hidden'}" style="width:160px;aspect-ratio:16/9;object-fit:cover;border-radius:8px">
          <button type="button" class="btn sm" id="ev-cover-pick">🖼️ Elegir de mis fotos</button>
          <label class="btn sm">Subir imagen<input type="file" id="ev-cover-file" accept="image/*" hidden></label>
          ${ev.coverUrl ? '<button type="button" class="btn sm ghost" id="ev-cover-rm">Quitar</button>' : ''}</div>
        <span class="hint">${ev.coverUrl ? 'Portada elegida por vos.' : 'Si no elegís una, usamos una de tus fotos.'} La elegida se ve sin marca de agua y la podés encuadrar.</span>`}
    </div>
    ${isNew && !general ? `<label class="field" style="max-width:260px">Precio por foto (ARS)<input type="number" id="ev-price" min="1" step="1" inputmode="numeric" required value="${(S.profile.defaults?.price || 0) > 0 ? S.profile.defaults.price : ''}" placeholder="Ej: 2500">
      <span class="hint">${(S.profile.defaults?.price || 0) > 0 ? 'Es el que usaste la última vez. Lo podés cambiar.' : 'Sin precio no se puede publicar ni vender.'} Los packs y demás opciones, en el álbum.</span></label>` : ''}
    <label class="field">Estado<select id="ev-status"><option value="draft" ${ev.status !== 'published' ? 'selected' : ''}>Borrador (no visible al público)</option><option value="published" ${ev.status === 'published' ? 'selected' : ''}>Publicado (ya tiene link para compartir)</option></select></label>
    ${general ? '<p class="muted small" style="margin:0">Los eventos generales siempre están abiertos para que se sumen fotógrafos.</p>'
      : `<label class="check"><input type="checkbox" id="ev-open" ${ev.openToJoin ? 'checked' : ''}> Permitir que otros fotógrafos se sumen a este evento</label>`}
  `, `<button class="btn" data-close>Cancelar</button><button class="btn primary" id="ev-save">${isNew ? 'Crear' : 'Guardar'}</button>`);

  placeInput($('#ev-city', dlg));
  // Portada: se encuadra (16:9) y se sube. Puede venir de un archivo o de una foto del álbum (desde el original, sin marca).
  const setCover = async blob => {
    const cropped = await cropImage(blob);
    if (!cropped) return;
    toast('Subiendo portada…');
    const { url } = await uploadAsset('cover', cropped, ev.id);
    $('#ev-cover', dlg).value = url;
    const img = $('#ev-cover-img', dlg); img.src = url; img.classList.remove('hidden');
  };
  $('#ev-cover-file', dlg)?.addEventListener('change', async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try { await setCover(f); } catch (err) { toast(errMsg(err), 'error'); }
  });
  $('#ev-cover-pick', dlg)?.addEventListener('click', async () => {
    const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', S.user.uid), where('hidden', '==', false), limit(150))).catch(() => null);
    const list = (snap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
    if (!list.length) return toast('Todavía no subiste fotos a este evento.', 'error');
    const pick = openDialog('Elegí la foto de portada', `<div class="cover-pick">${list.map(p => `<button type="button" data-pid="${p.id}"><img src="${esc(p.thumbUrl)}" alt="" loading="lazy"></button>`).join('')}</div>`);
    $$('[data-pid]', pick).forEach(b => b.onclick = async () => {
      b.disabled = true;
      try {
        toast('Bajando la foto sin marca de agua…');
        const r = await apiPost(`/review/original/${b.dataset.pid}`);
        const res = await fetch(r.url);
        if (!res.ok) throw new Error('No se pudo bajar la foto. Probá con otra.');
        const blob = await res.blob();
        pick.close();
        await setCover(blob);
      } catch (err) { b.disabled = false; toast(errMsg(err), 'error'); }
    });
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
    const name = $('#ev-name', dlg).value.trim(), date = $('#ev-date', dlg).value, venue = $('#ev-loc', dlg).value.trim();
    if (!name || !date) return toast('Completá nombre y fecha.', 'error');
    const city = await canonicalPlace($('#ev-city', dlg).value);
    if (!city) return toast('Elegí la localidad del evento de la lista (empezá a escribir y tocá una opción).', 'error');
    // "location" (lo que se muestra en todos lados) = lugar + localidad, sin repetir la ciudad si ya está en el lugar.
    const cityName = city.split(',')[0];
    const loc = !venue ? city : normalize(venue).includes(normalize(cityName)) ? venue : `${venue}, ${city}`;
    if ($('#ev-status', dlg).value === 'published' && ev?.status !== 'published' && !await requireVerified()) return;
    const tagNames = [...sel].map(id => tax.tagById.get(id)?.name || '');
    const data = {
      name, date, location: loc, venue, city, tagIds: [...sel].filter(id => tax.tagById.has(id)),
      coverUrl: $('#ev-cover', dlg).value.trim(),
      status: $('#ev-status', dlg).value,
      openToJoin: general ? true : $('#ev-open', dlg).checked,
      searchTokens: searchTokens(name, loc, ...tagNames),
      updatedAt: serverTimestamp(),
    };
    // Sin precio no se publica: en un álbum nuevo se pide acá; al publicar uno existente, se mira el precio del álbum.
    const price = isNew && !general ? Math.round(Number($('#ev-price', dlg).value) || 0) : 0;
    if (isNew && !general && data.status === 'published' && !(price > 0)) return toast('Poné el precio por foto para publicar el álbum (o guardalo como borrador).', 'error');
    if (!isNew && data.status === 'published' && ev.status !== 'published' && !await hasPrice(ev)) return;
    const btn = $('#ev-save', dlg); btn.disabled = true;
    try {
      if (isNew) {
        const ref = doc(collection(db, 'events'));
        const b = writeBatch(db);
        b.set(ref, {
          ...data, kind: general ? 'general' : 'own', createdBy: S.user.uid,
          photographerUids: general ? [] : [S.user.uid], createdAt: serverTimestamp(),
        });
        if (!general) b.set(doc(db, 'events', ref.id, 'sets', S.user.uid), { ...newSetData(), ...(price > 0 ? { price } : {}) });
        if (!general && price > 0 && price !== S.profile.defaults?.price) b.update(doc(db, 'users', S.user.uid), { 'defaults.price': price });
        await b.commit();
        if (!general && price > 0) S.profile.defaults = { ...(S.profile.defaults || {}), price };
        dlg.close();
        toast('Evento creado');
        location.hash = `#/evento/${ref.id}${general ? '' : '?nuevo=1'}`;
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
          <div class="muted">${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}<span id="ev-views"></span></div>
          ${tags.length ? `<div class="pills" style="margin-top:8px">${tags.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>` : ''}
        </div>
        <div class="row">
          <a class="btn sm" target="_blank" href="index.html#/evento/${ev.id}?f=${esc(S.user.uid)}" title="Abre la galería tal como la ve el comprador">👁️ Ver como cliente</a>
          <button class="btn sm share-btn" id="ev-share">🔗 Compartir</button>
          ${canEdit ? `<button class="btn sm" id="ev-edit">Editar</button>` : ''}
          ${canEdit ? `<button class="btn sm" id="ev-toggle">${ev.status === 'published' ? 'Despublicar' : 'Publicar'}</button>` : ''}
        </div>
      </div>
    </div>
    <div id="ev-state"></div>
    <div id="ev-steps"></div>
    <div id="ev-share-card"></div>
    <div id="ev-sets"></div>
    <div class="row end" style="margin-top:14px" id="ev-danger"></div>`;

  const reload = () => viewEvent(id);
  $('#ev-share').onclick = () => shareEvent(ev);
  getDoc(doc(db, 'stats', id)).then(x => { const n = x.data()?.views || 0; if ($('#ev-views')) $('#ev-views').textContent = ` · 👁️ ${n.toLocaleString('es-AR')} visita${n === 1 ? '' : 's'}`; }).catch(() => {});
  if (canEdit) {
    $('#ev-edit').onclick = () => eventDialog(ev, reload);
    $('#ev-toggle').onclick = async () => {
      if (ev.status !== 'published' && !await requireVerified()) return;
      if (ev.status !== 'published' && !await hasPrice(ev)) return;
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
        return `<div class="item-row">${avatarHtml(u)}<div class="grow"><strong>${esc(u.displayName || u.uid)}</strong><br><span class="muted small">${fmtMoney(st.price)} por foto · ${st.photoCount || 0} fotos · 💾 ${fmtBytes(setBytes(st))} · ${(st.subalbums || []).length} sub-álbumes${st.closedAt ? ' · 📦 cerrado' : ''}</span></div>
          <div class="row">${(st.photoCount || 0) > 0 && !st.originalsDeleted ? `<button class="btn sm" data-sclose="${u.uid}" title="Quedan 10 fotos de muestra y se libera el lugar">📦 Cerrar</button>` : ''}<button class="btn sm" data-sprice="${u.uid}" title="Precio por foto y packs de este fotógrafo en el evento">💲 Precios</button><button class="btn sm danger" data-sdel="${u.uid}" title="Borra sus fotos, archivos y su álbum (no se puede si tiene ventas)">🗑️ Forzar eliminación</button></div></div>`;
      }).join('') : '<p class="muted">Todavía no se sumó ningún fotógrafo.</p>'}</div>`;
    $$('[data-sclose]').forEach(b => b.onclick = async () => {
      const u = users.find(x => x.uid === b.dataset.sclose);
      if (!confirm(`¿Cerrar el álbum de ${u.displayName} en "${ev.name}"? Quedan 10 fotos de muestra y se libera su lugar. No se puede deshacer.`)) return;
      b.disabled = true;
      try { const r = await apiPost(`/events/${id}/close`, { uid: u.uid }); toast(`Álbum cerrado (${r.kept ?? 10} de muestra).`); viewEvent(id); }
      catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
    });
    // Superadmin: precio por foto, packs y comisión del álbum de un fotógrafo.
    $$('[data-sprice]').forEach(b => b.onclick = () => {
      const u = users.find(x => x.uid === b.dataset.sprice);
      const st = sets.get(u.uid) || {};
      const dlg = openDialog(`Precios · ${u.displayName || ''}`, `
        <div class="stack">
          <label class="field" style="max-width:240px">Precio por foto (ARS)<input type="number" id="sp-price" min="0" step="1" inputmode="numeric" value="${st.price || ''}"></label>
          <label class="field" style="max-width:320px">Tasa de servicio<select id="sp-fee">
            <option value="absorb" ${!['half', 'buyer'].includes(st.feeMode) ? 'selected' : ''}>La paga toda el fotógrafo (el comprador ve el precio limpio)</option>
            <option value="half" ${st.feeMode === 'half' ? 'selected' : ''}>Mitad el fotógrafo, mitad el comprador</option>
            <option value="buyer" ${st.feeMode === 'buyer' ? 'selected' : ''}>La paga toda el comprador (tasa de servicio)</option></select></label>
          <div class="field"><span>Packs</span><div id="sp-packs"></div></div>
          <p class="muted small" style="margin:0">Cambia solo este álbum. Las fotos con precio especial no cambian.</p>
        </div>`,
        '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="sp-save">Guardar</button>');
      const packs = packsEditor($('#sp-packs', dlg), st.packs || [], () => $('#sp-fee', dlg).value, () => Number($('#sp-price', dlg).value) || 0);
      $('#sp-save', dlg).onclick = async () => {
        const price = Math.round(Number($('#sp-price', dlg).value) || 0);
        if (!(price > 0) && ev.status === 'published') return toast('El evento está publicado: el precio por foto tiene que ser mayor a 0.', 'error');
        try {
          await updateDoc(doc(db, 'events', id, 'sets', u.uid), { price, packs: packs.get(), feeMode: $('#sp-fee', dlg).value, updatedAt: serverTimestamp() });
          dlg.close(); toast(`Precios de ${u.displayName || 'el fotógrafo'} guardados.`); viewEvent(id);
        } catch (e) { toast(errMsg(e), 'error'); }
      };
    });
    $$('[data-sdel]').forEach(b => b.onclick = async () => {
      const u = users.find(x => x.uid === b.dataset.sdel);
      const alone = (ev.photographerUids || []).length === 1 && ev.kind === 'own';
      if (!confirm(`¿ELIMINAR el álbum de ${u.displayName} en "${ev.name}"?\n\nSe borran todas sus fotos y archivos${alone ? ' y también el evento' : ''}. No se puede deshacer.`)) return;
      b.disabled = true;
      try {
        const r = await apiPost(`/admin/events/${id}/delete-album`, { uid: u.uid });
        toast(`Eliminado: ${r.photos} fotos${r.eventDeleted ? ' y el evento' : ''}.`);
        if (r.eventDeleted) location.hash = '#/admin/eventos'; else viewEvent(id);
      } catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
    });
    // Superadmin: la misma tarjeta para compartir que ven los fotógrafos (link del evento, texto, video, QR y cartel).
    // El video y el precio salen del fotógrafo con más fotos del evento.
    const main = users.slice().sort((a, b) => (sets.get(b.uid)?.photoCount || 0) - (sets.get(a.uid)?.photoCount || 0))[0];
    if (main) mountShareCard($('#ev-share-card'), { ev, set: sets.get(main.uid) || {}, uid: main.uid, displayName: users.length > 1 ? users.map(u => u.displayName).filter(Boolean).join(', ') : main.displayName, multi: false });
    $('#ev-share').onclick = () => $('#ev-share-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  // Álbum propio: pasos (si es nuevo) y tarjeta para compartir arriba de todo.
  const mySet = sets.get(me);
  if (mySet) {
    const nuevo = parseHash().query.get('nuevo') === '1';
    const drawSteps = (n = mySet.photoCount || 0) => {
      $('#ev-steps').innerHTML = nuevo || !n ? `<div class="card wizard-steps">
        <span class="ws done">✓ Álbum creado</span>${n ? '<span class="ws done">✓ Subí las fotos</span>' : '<a class="ws now" href="#" id="ws-up" style="text-decoration:none">2 Subí las fotos ⬇</a>'}<span class="ws ${n ? 'now' : ''}">3 Compartí el link</span>
        ${n ? '' : `<div class="row" style="flex-basis:100%;margin-top:6px"><span class="muted small grow">🔗 El link ya funciona: mandalo ahora y la gente ve las fotos a medida que se suben.</span>
          <button class="btn sm" id="ws-copy">Copiar link</button><a class="btn sm primary" id="ws-wa" target="_blank" rel="noopener">💬 WhatsApp</a></div>`}</div>` : '';
      $('#ws-up')?.addEventListener('click', e => { e.preventDefault(); ($('#dz') || $('#set-photos'))?.scrollIntoView({ behavior: 'smooth', block: 'center' }); });
      if (!n && $('#ws-copy')) {
        const url = eventUrl(ev.id, (ev.photographerUids || []).length > 1 ? me : '');
        $('#ws-copy').onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { toast(url); } };
        $('#ws-wa').href = `https://wa.me/?text=${encodeURIComponent(`📸 Estoy subiendo las fotos de ${ev.name}. Buscate y descargalas acá 👉 ${url}`)}`;
      }
      // Sin fotos, primero va la subida; la tarjeta completa para compartir queda abajo hasta que haya fotos.
      const card = $('#ev-share-card'), sets = $('#ev-sets');
      if (card && sets) (n ? sets.before(card) : sets.after(card));
    };
    const share = highlight => mountShareCard($('#ev-share-card'), { ev, set: mySet, uid: me, displayName: S.profile.displayName, multi: (ev.photographerUids || []).length > 1, highlight });
    share(false);
    drawSteps();
    $('#ev-share').onclick = () => $('#ev-share-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Al terminar una subida: festejo y tarjeta de compartir a la vista.
    window.onqmfUploadDone = ({ eventId, count }) => {
      if (eventId !== ev.id || !document.body.contains($('#ev-share-card'))) return;
      drawSteps(count); share(true);
      $('#ev-share-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  if (PLANS[planOf(S.profile)]?.team) {
    getDoc(doc(db, 'teams', me)).then(t => teamSalesHtml(id, me, t.data())).then(html => { if (html && $('#ev-sets')) $('#ev-sets').insertAdjacentHTML('afterbegin', html); }).catch(() => {});
  }
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
      // Álbumes de prueba (los da el superadmin): mientras estén vigentes puede tener más de uno activo.
      if (sets.filter(setActive).length < activeAlbumLimit(S.profile, S.settings)) return;
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

  drawAlbumState(ev, sets.get(me) || null, reload);
}

// Estado del álbum (arriba de todo): abierto → "Cerrar álbum"; cerrado → queda en el historial y se puede eliminar;
// vacío → eliminar o salir. Cerrar libera el lugar; eliminar es opcional y solo con el álbum ya cerrado.
function drawAlbumState(ev, set, reload) {
  const box = $('#ev-state');
  if (!box) return;
  const me = S.user.uid, id = ev.id;
  const isCreator = ev.createdBy === me && ev.kind === 'own';
  const solo = (ev.photographerUids || []).length === 1;
  const n = set?.photoCount || 0;
  const closed = !!set?.originalsDeleted;
  const closedAt = (set?.closedAt || set?.originalsDeletedAt)?.toMillis?.() || 0;
  if (closed) {
    box.innerHTML = `<div class="card album-state closed">
      <div class="grow"><h2 style="margin:0 0 4px">📦 Álbum cerrado${closedAt ? ` el ${fmtMs(closedAt)}` : ''}</h2>
        <p class="muted small" style="margin:0">Queda en tu historial y en la web con ${n ? `${n} foto${n === 1 ? '' : 's'}` : 'algunas fotos'} de muestra (con marca de agua) para mostrar tu trabajo. Ya no se vende y no ocupa tu lugar de álbum. Quien compró sigue descargando sus fotos.</p></div>
      <div class="row"><a class="btn sm" target="_blank" href="index.html#/evento/${id}?f=${esc(me)}">👁️ Ver cómo queda</a><button class="btn sm danger" id="st-remove">🗑️ Eliminar del historial</button></div>
    </div>`;
    $('#st-remove').onclick = () => removeAlbumDialog(ev);
    return;
  }
  if (n > 0) {
    const r = retentionState(set);
    const when = r.k === 'active' ? `Se vende hasta el <strong>${fmtMs(r.until)}</strong>.` : r.k === 'grace' ? `Dejó de venderse el ${fmtMs(r.until)}.` : '';
    box.innerHTML = `<div class="card album-state open">
      <div class="grow"><h2 style="margin:0 0 4px">🟢 Álbum abierto</h2>
        <p class="muted small" style="margin:0">${when} Cuando termines de vender, cerralo: queda en tu historial con 10 fotos de muestra y se libera el lugar para subir otro álbum.</p></div>
      <div class="row"><button class="btn" id="st-close">📦 Cerrar álbum</button></div>
    </div>`;
    $('#st-close').onclick = () => closeAlbumDialog(ev, reload);
    return;
  }
  // Sin fotos: se puede borrar (o salir si el evento es de otro).
  const own = isCreator && solo;
  box.innerHTML = `<div class="row end" style="margin-top:4px"><button class="btn sm ghost" id="st-empty">${own ? '🗑️ Eliminar álbum' : '🚪 Salir del evento'}</button></div>`;
  $('#st-empty').onclick = async () => {
    if (!confirm(own ? `¿Eliminar "${ev.name}"? Todavía no tiene fotos.` : `¿Salir de "${ev.name}"?`)) return;
    try {
      const bt = writeBatch(db);
      if (set) bt.delete(doc(db, 'events', id, 'sets', me));
      if (own) bt.delete(doc(db, 'events', id));
      else bt.update(doc(db, 'events', id), { photographerUids: arrayRemove(me) });
      await bt.commit();
      toast(own ? 'Álbum eliminado' : 'Saliste del evento');
      location.hash = '#/eventos';
    } catch (e) { toast(errMsg(e), 'error'); }
  };
  // Al subir la primera foto cambia a "Álbum abierto".
  const prev = window.onqmfUploadDone;
  window.onqmfUploadDone = x => { prev?.(x); if (x?.eventId === id && document.body.contains(box)) drawAlbumState(ev, { ...(set || {}), photoCount: x.count || 1, firstPhotoAt: set?.firstPhotoAt }, reload); };
}

function closeAlbumDialog(ev, reload) {
  const dlg = openDialog('Cerrar álbum', `
    <p style="margin-top:0">Vas a cerrar <strong>${esc(ev.name)}</strong>.</p>
    <ul class="stack" style="gap:6px;padding:0;margin:0;list-style:none">
      <li>✅ <strong>Se libera el lugar</strong> para subir otro álbum.</li>
      <li>📸 Queda en tu historial y en la web con <strong>10 fotos de muestra</strong> (las más vendidas) con marca de agua.</li>
      <li>🛒 Las fotos <strong>dejan de venderse</strong> y se borran los originales.</li>
      <li>⬇️ Quien ya compró sigue descargando sus fotos.</li>
    </ul>
    <p class="muted small" style="margin-bottom:0">No se puede deshacer. Después, si querés, lo podés eliminar del historial.</p>`,
    '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="cl-ok">📦 Cerrar álbum</button>');
  $('#cl-ok', dlg).onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Cerrando…';
    try { const r = await apiPost(`/events/${ev.id}/close`); dlg.close(); toast(`Álbum cerrado. Quedaron ${r.kept ?? 10} fotos de muestra en tu historial.`); reload(); }
    catch (err) { e.target.disabled = false; e.target.textContent = '📦 Cerrar álbum'; toast(errMsg(err), 'error'); }
  };
}

function removeAlbumDialog(ev) {
  const dlg = openDialog('Eliminar del historial', `
    <p style="margin-top:0">Se borran las fotos de muestra de <strong>${esc(ev.name)}</strong> y el álbum deja de verse en la web y en tu panel.</p>
    <p class="muted small" style="margin-bottom:0">Las ventas no se pierden: siguen en Ventas y quien compró sigue descargando sus fotos. No se puede deshacer.</p>`,
    '<button class="btn" data-close>Cancelar</button><button class="btn danger" id="rm-ok">🗑️ Eliminar</button>');
  $('#rm-ok', dlg).onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Eliminando…';
    try { await apiPost(`/events/${ev.id}/remove`); dlg.close(); toast('Álbum eliminado del historial'); location.hash = '#/eventos'; }
    catch (err) { e.target.disabled = false; e.target.textContent = '🗑️ Eliminar'; toast(errMsg(err), 'error'); }
  };
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
    $('#mk-set').onclick = async () => { if (!await requireVerified()) return; try { await setDoc(doc(db, 'events', ev.id, 'sets', S.user.uid), newSetData()); reload(); } catch (e) { toast(errMsg(e), 'error'); } };
    return;
  }
  if (set.originalsDeleted) { box.innerHTML = ''; return; }
  let subs = (set.subalbums || []).map(s => ({ ...s })).sort((a, b) => a.order - b.order);
  setTimeout(() => drawShortLink(ev), 0);

  const emptyAlbum = !(set.photoCount > 0);
  box.innerHTML = `
    ${emptyAlbum ? '<div id="set-photos"></div>' : ''}
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
    ${!(set.price > 0) && (set.photoCount || 0) > 0 ? '<div class="notice danger"><strong>💲 Este álbum no tiene precio: nadie puede comprar las fotos.</strong><br>Cargá el precio por foto acá abajo y tocá Guardar.</div>' : ''}
    <form class="card stack" id="set-form">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Precios</h2><button type="button" class="btn sm" id="use-def">Usar mis valores por defecto</button></div>
      <label class="field" style="max-width:240px">Precio por foto (ARS)<input type="number" min="0" step="1" id="st-price" value="${set.price || ''}"></label>
      <h3>Packs</h3>
      <div id="st-packs"></div>
      <h3>Tasa de servicio</h3>
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
      ${S.settings.selfieEnabled === false ? '' : `<label class="check"><input type="checkbox" id="st-selfie" ${set.selfie !== false ? 'checked' : ''}> 🤳 Búsqueda por selfie</label>
      <p class="muted small" style="margin:0">Cada uno se saca una selfie y ve las fotos donde aparece. Las caras se procesan en tu dispositivo al subir y solo se guarda una huella numérica (nunca imágenes de caras).</p>
      <div id="st-selfie-status"></div>`}
      <div class="row end"><button class="btn primary" type="submit">Guardar set</button></div>
    </form>
    ${emptyAlbum ? '' : '<div id="set-photos"></div>'}`;
  if (S.settings.selfieEnabled !== false && set.selfie !== false && (set.photoCount || 0) > 0) drawSelfieStatus(ev);
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
      const newPrice = Math.round(Number($('#st-price').value) || 0);
      if (!(newPrice > 0) && ev.status === 'published' && ev.kind === 'own' && ev.createdBy === S.user.uid) return toast('El álbum está publicado: necesita un precio por foto mayor a 0.', 'error');
      await updateDoc(doc(db, 'events', ev.id, 'sets', S.user.uid), {
        price: newPrice,
        packs: packs.get(),
        feeMode: $('input[name=st-fee]:checked').value,
        subalbums: clean,
        showHours: $('#st-hours').checked,
        ...($('#st-bibs') ? { detectBibs: $('#st-bibs').checked } : {}),
        ...($('#st-selfie') ? { selfie: $('#st-selfie').checked } : {}),
        updatedAt: serverTimestamp(),
      });
      // Precio, packs y comisión pasan a ser los predeterminados de sus próximos álbumes (los puede cambiar en cada uno).
      if (newPrice > 0) {
        const defaults = { ...(S.profile.defaults || {}), price: newPrice, packs: packs.get(), feeMode: $('input[name=st-fee]:checked').value };
        await updateDoc(doc(db, 'users', S.user.uid), { defaults }).then(() => { S.profile.defaults = defaults; }).catch(() => {});
      }
      toast(newPrice > 0 ? 'Guardado. Tus próximos álbumes arrancan con estos precios.' : 'Guardado');
      reload();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
}

// Búsqueda por selfie: cuántas fotos ya tienen las caras procesadas y botón para preparar las que faltan
// (fotos subidas antes de activarla o si se cerró la página antes de terminar). Usa las muestras (ya subidas).
async function drawSelfieStatus(ev) {
  const box = $('#st-selfie-status');
  if (!box) return;
  try {
    const s = await uploadSession(ev.id);
    const r = await fetch(`${API_BASE}/faces/${ev.id}/mine`, { headers: { 'X-Upload-Token': s.token } }).then(x => x.json());
    const done = new Set(r.ids || []);
    const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', S.user.uid), where('hidden', '==', false), limit(5000)));
    const todo = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => !done.has(p.id) && (!p.uploadedBy || p.uploadedBy === S.user.uid));
    if (!todo.length) { box.innerHTML = `<p class="small" style="margin:0">✅ Las ${done.size} fotos ya están listas para la búsqueda por selfie.</p>`; return; }
    box.innerHTML = `<div class="notice small stack" style="margin:0"><span>🤳 ${todo.length} foto${todo.length === 1 ? '' : 's'} todavía no ${todo.length === 1 ? 'está lista' : 'están listas'} para la búsqueda por selfie.</span>
      <div><button type="button" class="btn sm primary" id="sf-go">Prepararlas ahora</button> <span class="muted" id="sf-pct"></span></div></div>`;
    $('#sf-go').onclick = async e => {
      e.target.disabled = true;
      const { photoFaces } = await import('./faces.js');
      const batch = [];
      const flush = async () => { if (!batch.length) return; const t = await uploadSession(ev.id); await postWithToken(`/faces/${ev.id}`, { items: batch.splice(0) }, t.token); };
      try {
        for (const [i, p] of todo.entries()) {
          if (!document.body.contains(box)) return; // salió de la pantalla: lo que falta queda para después
          $('#sf-pct').textContent = `${i + 1} de ${todo.length}… dejá esta pantalla abierta`;
          try {
            const img = new Image(); img.crossOrigin = 'anonymous';
            img.src = `${API_BASE}/public/${new URL(p.previewUrl).pathname.replace(/^\//, '')}`;
            await img.decode();
            batch.push({ p: p.id, f: await photoFaces(img) });
          } catch (err) { console.warn('caras', err); }
          if (batch.length >= 20) await flush();
        }
        await flush();
        toast('Listo: ya se pueden buscar con una selfie');
        drawSelfieStatus(ev);
      } catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
    };
  } catch (err) { box.innerHTML = ''; console.warn('selfie', err); }
}

// ================================================================ superadmin: fotógrafos
let photogTab = 'pending';
let photogPlan = '';          // filtro por plan: '' | free | lite | pro | … | courtesy
const photogOpen = new Set(); // fichas con "Ver más" abierto
let photogQ = '';             // buscador por nombre o ciudad
let photogSeen = { at: 0, map: {} }; // último ingreso (Firebase Auth, vía Worker), se refresca cada 5 minutos
const agoText = ms => {
  if (!ms) return 'nunca ingresó';
  const d = Math.floor((Date.now() - ms) / 86400000);
  return d <= 0 ? 'ingresó hoy' : d === 1 ? 'ingresó ayer' : d < 60 ? `ingresó hace ${d} días` : `ingresó el ${new Date(ms).toLocaleDateString('es-AR')}`;
};
async function viewAdminPhotographers() {
  const view = $('#view');
  const tabs = [['pending', 'Pendientes'], ['approved', 'Aprobados'], ['suspended', 'Suspendidos']];
  const manual = !S.settings.autoApprove;
  view.innerHTML = `
    <h1>Fotógrafos</h1>
    <div class="notice ${manual ? '' : 'warn'} row" style="justify-content:space-between;gap:8px">
      <span>${manual ? '✋ <strong>Aprobación manual activada:</strong> cada fotógrafo nuevo espera que lo apruebes.' : '⚡ <strong>Aprobación manual desactivada:</strong> los fotógrafos nuevos se aprueban solos al crear la cuenta (te llega una alerta de cada uno).'}</span>
      <button class="btn sm" id="ap-toggle">${manual ? 'Desactivar aprobación' : 'Activar aprobación'}</button>
    </div>
    <div class="tabs">${tabs.map(([k, l]) => `<button class="chip ${photogTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
    <div class="tabs" style="margin-top:-4px">${[['', 'Todos los planes'], ['free', 'Gratis'], ...Object.entries(PLANS).filter(([k]) => k !== 'free').map(([k, v]) => [k, v.label]), ['courtesy', '🎁 Cortesía']]
      .map(([k, l]) => `<button class="chip ${photogPlan === k ? 'on' : ''}" data-pfilter="${k}">${esc(l)}</button>`).join('')}</div>
    <input type="search" id="ph-q" placeholder="🔎 Buscar por nombre o ciudad" value="${esc(photogQ)}" style="margin:4px 0 12px">
    <div class="card" id="pl"><div class="spinner"></div></div>`;
  // Buscador: filtra las fichas ya cargadas (sin volver a pedir datos).
  const applyQ = () => {
    const q = normalize(photogQ);
    let shown = 0;
    $$('#pl .ph-row').forEach(r => { const ok = !q || r.dataset.q.includes(q); r.classList.toggle('hidden', !ok); shown += ok; });
    const none = $('#pl .ph-none');
    if (none) none.classList.toggle('hidden', shown > 0);
  };
  $('#ph-q').oninput = e => { photogQ = e.target.value; applyQ(); };
  $$('[data-tab]').forEach(b => b.onclick = () => { photogTab = b.dataset.tab; viewAdminPhotographers(); });
  $$('[data-pfilter]').forEach(b => b.onclick = () => { photogPlan = b.dataset.pfilter; viewAdminPhotographers(); });
  $('#ap-toggle').onclick = async () => {
    const autoApprove = manual;
    if (autoApprove && !confirm('¿Desactivar la aprobación? Los fotógrafos nuevos van a quedar aprobados solos y pueden publicar y vender enseguida. Los que ya están pendientes se aprueban la próxima vez que entren.')) return;
    try {
      await updateDoc(doc(db, 'settings', 'platform'), { autoApprove, updatedAt: serverTimestamp() });
      S.settings.autoApprove = autoApprove;
      toast(autoApprove ? 'Aprobación desactivada: los nuevos se aprueban solos' : 'Aprobación activada: los nuevos esperan tu aprobación');
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  const snap = await getDocs(query(collection(db, 'users'), where('status', '==', photogTab)));
  const courtesyOf = u => planOf(u) !== 'free' && (u.courtesy || (u.proUntil?.toMillis?.() || 0) > Date.parse('2090-01-01'));
  const users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role === 'photographer')
    .filter(u => !photogPlan || (photogPlan === 'courtesy' ? courtesyOf(u) : planOf(u) === photogPlan && !(photogPlan !== 'free' && courtesyOf(u))))
    .sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
  // Fotos vendidas (salesStats) y álbumes / fotos vigentes (sets activos) de cada fotógrafo.
  const [salesSnap, setsSnap] = await Promise.all([
    getDocs(collection(db, 'salesStats')).catch(() => null),
    getDocs(collectionGroup(db, 'sets')).catch(() => null),
  ]);
  const soldBy = new Map(), liveBy = new Map();
  for (const d of salesSnap?.docs || []) { const x = d.data(); soldBy.set(x.photographerUid, (soldBy.get(x.photographerUid) || 0) + (x.soldPhotos || 0)); }
  for (const d of setsSnap?.docs || []) { const x = d.data(); if (!setActive(x)) continue; const l = liveBy.get(d.id) || { albums: 0, photos: 0 }; l.albums++; l.photos += x.photoCount || 0; liveBy.set(d.id, l); }
  const privs = await Promise.all(users.map(u => getDoc(doc(db, 'userPrivate', u.uid)).then(s => s.data() || {}).catch(() => ({}))));
  const reqs = await Promise.all(users.map(u => getDoc(doc(db, 'planRequests', u.uid)).then(s => s.data() || null).catch(() => null)));
  const zoneOk = await Promise.all(users.map(u => canonicalPlace(u.zone).catch(() => 'x')));
  // Cobro por transferencia: saldos de comisiones y pagos avisados por confirmar.
  const [balSnap, repSnap] = await Promise.all([
    getDocs(collection(db, 'feeBalance')).catch(() => null),
    getDocs(query(collection(db, 'feePayments'), where('status', '==', 'reported'))).catch(() => null),
  ]);
  const bals = new Map((balSnap?.docs || []).map(d => [d.id, d.data()]));
  const reported = (repSnap?.docs || []).map(d => ({ id: d.id, ...d.data() }));
  const owedOf = uid => { const b = bals.get(uid) || {}; return Math.max(0, Math.round(((b.accrued || 0) - (b.paid || 0)) * 100) / 100); };
  const planSel = (u, i, attr) => `<select ${attr}="${u.uid}" style="width:auto"><option value="">Elegí el plan…</option>${Object.entries(PLANS).filter(([k]) => k !== 'free').map(([k, p]) => `<option value="${k}" ${(reqs[i]?.plan || (planOf(u) !== 'free' ? planOf(u) : '')) === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}</select>`;
  $('#pl').innerHTML = users.length ? users.map((u, i) => {
    const wa = waOf(u, privs[i]), live = liveBy.get(u.uid) || { albums: 0, photos: 0 }, sold = soldBy.get(u.uid) || 0;
    const open = photogOpen.has(u.uid);
    return `
    <div class="ph-row" data-q="${esc(normalize(`${u.displayName || ''} ${u.zone || ''} ${u.slug || ''}`))}">
      <div class="item-row" style="border:0;padding:0">
        ${avatarHtml(u)}
        <div class="grow" style="min-width:0">
          <div><strong>${esc(u.displayName || '—')}</strong> <span class="muted small">· ${u.zone ? `📍 ${esc(u.zone)}` : '📍 Sin ciudad'} · 🕒 <span data-seen="${u.uid}">…</span></span>${zoneOk[i] ? '' : ' <span class="pill warn" title="Lo escribió a mano y no coincide con una localidad de la lista. Corregilo en Ver más → Cambiar ciudad">revisar</span>'}</div>
          <div class="row small" style="gap:6px;margin-top:4px">
            ${wa ? `<a class="btn sm ok" target="_blank" rel="noopener" href="${esc(waLink(wa))}">💬 ${esc(wa)}</a>` : '<span class="muted small">Sin WhatsApp</span>'}
            ${planOf(u) !== 'free' ? `<span class="pill accent">⭐ ${esc(PLANS[planOf(u)].label)}${courtesyOf(u) ? ' · cortesía' : ` · hasta ${esc(fmtTs(u.proUntil))}`}</span>` : '<span class="pill">Gratis</span>'}
            ${reqs[i] && reqs[i].plan !== planOf(u) ? `<span class="pill warn">Pidió: ${esc(PLANS[reqs[i].plan]?.label || reqs[i].plan)}</span>` : ''}
          </div>
          <div class="set-stats" style="margin-top:6px">
            <span class="stat-chip ${sold ? 'ok' : ''}" title="Fotos vendidas en total">🛒 ${sold} vendida${sold === 1 ? '' : 's'}</span>
            <a class="stat-chip" target="_blank" href="index.html#/f/${esc(u.slug)}" title="Ver su perfil con los álbumes" style="text-decoration:none;color:inherit">📁 ${live.albums} álbum${live.albums === 1 ? '' : 'es'} vigente${live.albums === 1 ? '' : 's'} ↗</a>
            <span class="stat-chip" title="Fotos en los álbumes vigentes">📷 ${live.photos.toLocaleString('es-AR')} fotos</span>
          </div>
        </div>
        <div class="row" style="flex:none">
          ${u.status === 'pending' ? `<button class="btn sm ok" data-st="approved" data-uid="${u.uid}">Aprobar</button>` : ''}
          <button class="btn sm" data-more="${u.uid}" aria-expanded="${open}">${open ? 'Ver menos ▴' : 'Ver más ▾'}</button>
        </div>
      </div>
      <div class="ph-more stack ${open ? '' : 'hidden'}" id="more-${u.uid}">
        <div><h3>Cuenta</h3>
          <div class="muted small">${esc(privs[i].email || privs[i].phone || '')} · /${esc(u.slug || '')} · alta ${esc(fmtTs(u.createdAt))}</div>
          <div class="row" style="gap:6px;margin-top:6px">
            ${privs[i].provider ? `<span class="pill">${privs[i].provider === 'google' ? 'Ingresa con Google' : privs[i].provider === 'phone' ? 'Ingresa con el celular' : 'Ingresa con email y contraseña'}</span>` : ''}
            ${u.mpConnected ? '<span class="pill ok">Mercado Pago vinculado</span>' : `<span class="pill ${u.status === 'approved' ? 'danger' : ''}">Mercado Pago sin vincular</span>`}
            ${privs[i].emailVerified ? '' : `<span class="pill warn" title="Todavía no tocó el link del mail de confirmación: no puede publicar ni vincular Mercado Pago">✉️ Correo sin confirmar</span> <button class="btn sm" data-verify="${u.uid}" title="Para quien no puede abrir el mail: lo confirmás vos">✅ Confirmar cuenta</button>`}
            ${u.site?.requestedDomain && !u.domainActive ? `<span class="pill warn">Dominio pedido: ${esc(u.site.requestedDomain)}</span>` : ''}
            ${u.domainActive ? `<span class="pill ${u.domainSetup && u.domainSetup.status !== 'active' ? 'warn' : 'ok'}">🌐 ${esc(u.siteDomain)}${u.domainSetup && u.domainSetup.status !== 'active' ? ' · esperando NIC.ar' : ''}</span>` : ''}
          </div>
          <div class="row" style="gap:6px;margin-top:8px">
            <a class="btn sm" target="_blank" href="index.html#/f/${esc(u.slug)}" title="Su perfil público, con el portfolio">👤 Perfil y portfolio</a>
            ${planOf(u) !== 'free' && PLANS[planOf(u)].web ? `<a class="btn sm" target="_blank" href="${esc(siteUrlOf(u))}">🌐 Su web</a>` : ''}
            <button class="btn sm" data-pwreset="${u.uid}" data-pwname="${esc(u.displayName || '')}" data-pwwa="${esc(wa || '')}" title="Link para que elija una contraseña nueva">🔑 Restablecer clave</button>
            <button class="btn sm" data-zone="${u.uid}" title="Corregir la ciudad (de la lista oficial de localidades)">📍 Cambiar ciudad</button>
            ${u.status === 'suspended' ? `<button class="btn sm" data-st="pending" data-uid="${u.uid}">Volver a pendiente</button>` : `<button class="btn sm danger" data-st="suspended" data-uid="${u.uid}">🚫 Suspender</button>`}
            ${u.status === 'suspended' ? `<button class="btn sm ok" data-st="approved" data-uid="${u.uid}">Aprobar</button>` : ''}
          </div>
        </div>
        ${u.status === 'approved' ? `<div><h3>Plan</h3>
          <div class="row" style="gap:6px">
            <button class="btn sm ghost" data-subsync="${u.uid}" title="Revisa en Mercado Pago su suscripción y aplica el plan">🔄 Revisar suscripción</button>
            <button class="btn sm ghost" data-alias="${u.uid}" title="Ver o corregir el alias para cobrar por transferencia">🏦 Alias: ${u.transferAlias ? `${esc(u.transferAlias)}${u.transferOn ? '' : ' (apagado)'}` : 'sin cargar'}</button>
            ${isPro(u) && !courtesyOf(u) ? `<button class="btn sm ghost" data-unpro="${u.uid}">Quitar plan</button>` : ''}
            ${u.transferOn || bals.has(u.uid) || u.transferBlocked ? `<button class="btn sm ghost" data-fees="${u.uid}">🏦 Comisiones por transferencia${owedOf(u.uid) ? ` · debe ${fmtMoney(owedOf(u.uid))}` : ''}${reported.some(r => r.uid === u.uid) ? ' · 🔔 avisó un pago' : ''}</button>` : ''}
            ${PLANS[planOf(u)]?.team ? `<button class="btn sm ghost" data-seats="${u.uid}" title="Lugares extra para su equipo (además de los del plan)">👥 Lugares extra: ${u.teamExtraSeats || 0}</button>` : ''}
            ${PLANS[planOf(u)]?.domain && u.site?.requestedDomain && !u.domainActive ? `<button class="btn sm ok" data-dom="${u.uid}">Activar dominio</button>` : ''}
            ${u.domainActive && u.domainSetup && u.domainSetup.status !== 'active' ? `<button class="btn sm" data-domst="${u.uid}">Revisar dominio</button>` : ''}
          </div>
          <div class="row" style="gap:6px;margin-top:8px">${planSel(u, i, 'data-plan-sel')}<button class="btn sm" data-pro="${u.uid}">Dar 30 días</button></div>
          <p class="muted small" style="margin:4px 0 0">"Dar 30 días": para cuando te paga por fuera de Mercado Pago (ej. transferencia). Le da el plan elegido por 30 días más.</p>
        </div>
        <div><h3>🎁 Cortesías</h3>
          <div class="row" style="gap:6px">
            ${courtesyOf(u) ? `<span class="pill accent">⭐ ${esc(PLANS[planOf(u)].label)} de cortesía</span><button class="btn sm ghost" data-unpro="${u.uid}">Quitar cortesía</button>`
              : `${planSel(u, i, 'data-cplan-sel')}<button class="btn sm" data-courtesy="${u.uid}" title="Plan sin costo y sin vencimiento, hasta que lo quites">🎁 Dar plan de cortesía</button>`}
          </div>
          <div class="row" style="gap:6px;margin-top:8px">
            <button class="btn sm ghost" data-pbonus="${u.uid}" title="Más fotos por álbum, por un tiempo, a modo de prueba">📈 Fotos de prueba</button>
            ${photoBonusOf(u) ? `<span class="pill accent">📈 +${photoBonusOf(u).photos} fotos por álbum hasta ${esc(new Date(photoBonusOf(u).until).toLocaleDateString('es-AR'))}</span>` : ''}
            ${planOf(u) === 'free' ? `<button class="btn sm ghost" data-bonus="${u.uid}" title="Más álbumes activos a la vez, por un tiempo, a modo de prueba">🗂️ Álbumes de prueba</button>` : ''}
            ${albumBonusOf(u) ? `<span class="pill accent">🗂️ +${albumBonusOf(u).count} álbum${albumBonusOf(u).count === 1 ? '' : 'es'} hasta ${esc(new Date(albumBonusOf(u).until).toLocaleDateString('es-AR'))}</span>` : ''}
          </div>
        </div>` : ''}
      </div>
    </div>`; }).join('') + '<div class="empty ph-none hidden">Ningún fotógrafo coincide con la búsqueda.</div>' : '<div class="empty">No hay fotógrafos en esta lista.</div>';
  applyQ();
  // Último ingreso de cada uno (se completa después de mostrar la lista).
  const fillSeen = () => $$('[data-seen]').forEach(x => { const ms = photogSeen.map[x.dataset.seen]; x.textContent = ms === undefined ? '—' : agoText(ms); });
  const missing = users.some(u => photogSeen.map[u.uid] === undefined);
  if (users.length && (missing || Date.now() - photogSeen.at > 5 * 60000)) {
    apiPost('/admin/users/activity', { uids: users.map(u => u.uid) })
      .then(r => { photogSeen = { at: Date.now(), map: { ...photogSeen.map, ...Object.fromEntries(users.map(u => [u.uid, r.activity?.[u.uid] || 0])) } }; fillSeen(); })
      .catch(() => fillSeen());
  } else fillSeen();
  $$('[data-more]').forEach(b => b.onclick = () => {
    const uid = b.dataset.more, box = $(`#more-${uid}`);
    const open = box.classList.toggle('hidden') === false;
    open ? photogOpen.add(uid) : photogOpen.delete(uid);
    b.textContent = open ? 'Ver menos ▴' : 'Ver más ▾'; b.setAttribute('aria-expanded', open);
  });
  $$('[data-pro]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.pro);
    const plan = $(`[data-plan-sel="${u.uid}"]`).value;
    if (!plan) return toast('Elegí qué plan darle en la lista.', 'error');
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
    const plan = $(`[data-cplan-sel="${u.uid}"]`).value;
    if (!plan) return toast('Elegí qué plan darle en la lista.', 'error');
    if (!confirm(`¿Dar a ${u.displayName} el plan ${PLANS[plan].label} de cortesía, sin costo y sin vencimiento?`)) return;
    try {
      await updateDoc(doc(db, 'users', u.uid), { plan, proUntil: Timestamp.fromDate(new Date('2099-12-31T00:00:00Z')), courtesy: true, trial: false });
      await deleteDoc(doc(db, 'planRequests', u.uid)).catch(() => {});
      toast(`${u.displayName}: plan ${PLANS[plan].label} de cortesía`);
      viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  // Álbumes de prueba: en plan Gratis, X álbumes activos extra hasta una fecha.
  $$('[data-bonus]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.uid === b.dataset.bonus);
    const cur = albumBonusOf(u);
    const dlg = openDialog(`Álbumes de prueba · ${u.displayName}`, `
      <p class="muted small" style="margin:0">Con el plan Gratis puede tener 1 álbum activo a la vez. Sumale álbumes extra por un tiempo para que pruebe la plataforma.</p>
      <label class="field">Álbumes extra<input type="number" id="bn-count" min="1" max="50" step="1" value="${cur?.count || 3}"></label>
      <label class="field">Hasta el<input type="date" id="bn-until" value="${new Date(cur?.until || Date.now() + 30 * 86400000).toISOString().slice(0, 10)}"></label>`,
      `${cur ? '<button class="btn ghost danger" id="bn-off">Quitar</button>' : ''}<button class="btn primary" id="bn-save">Guardar</button>`);
    const save = async albumBonus => {
      try { await updateDoc(doc(db, 'users', u.uid), { albumBonus }); dlg.close(); toast(albumBonus ? 'Álbumes de prueba asignados' : 'Álbumes de prueba quitados'); viewAdminPhotographers(); }
      catch (e) { toast(errMsg(e), 'error'); }
    };
    $('#bn-save', dlg).onclick = () => {
      const count = Math.round(Number($('#bn-count', dlg).value) || 0), d = $('#bn-until', dlg).value;
      if (!(count > 0) || !d) return toast('Completá la cantidad y la fecha.', 'error');
      save({ count, until: Timestamp.fromMillis(Date.parse(`${d}T23:59:59-03:00`)), givenAt: Timestamp.now() });
    };
    $('#bn-off', dlg)?.addEventListener('click', () => save(null));
  });
  // Fotos de prueba: más fotos por álbum (sobre el tope de su plan) hasta una fecha.
  $$('[data-pbonus]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.uid === b.dataset.pbonus);
    const cur = photoBonusOf(u);
    const base = planSpec(planOf(u), S.settings).albumPhotos || 0;
    const dlg = openDialog(`Fotos de prueba · ${u.displayName}`, `
      <p class="muted small" style="margin:0">Su plan permite ${base ? `${base} fotos por álbum` : 'fotos sin tope'}. Sumale fotos extra por álbum por un tiempo para que pruebe la plataforma.</p>
      <label class="field">Fotos extra por álbum<input type="number" id="pb-n" min="50" max="20000" step="50" value="${cur?.photos || 500}"></label>
      <label class="field">Hasta el<input type="date" id="pb-until" value="${new Date(cur?.until || Date.now() + 30 * 86400000).toISOString().slice(0, 10)}"></label>`,
      `${cur ? '<button class="btn ghost danger" id="pb-off">Quitar</button>' : ''}<button class="btn primary" id="pb-save">Guardar</button>`);
    const save = async photoBonus => {
      try { await updateDoc(doc(db, 'users', u.uid), { photoBonus }); dlg.close(); toast(photoBonus ? `Listo: ${base ? base + photoBonus.photos : 'sin tope'} fotos por álbum hasta el ${new Date(photoBonus.until.toMillis()).toLocaleDateString('es-AR')}` : 'Fotos de prueba quitadas'); viewAdminPhotographers(); }
      catch (e) { toast(errMsg(e), 'error'); }
    };
    $('#pb-save', dlg).onclick = () => {
      const photos = Math.round(Number($('#pb-n', dlg).value) || 0), d = $('#pb-until', dlg).value;
      if (!(photos > 0) || !d) return toast('Completá la cantidad y la fecha.', 'error');
      save({ photos, until: Timestamp.fromMillis(Date.parse(`${d}T23:59:59-03:00`)), givenAt: Timestamp.now() });
    };
    $('#pb-off', dlg)?.addEventListener('click', () => save(null));
  });
  // Localidad del fotógrafo (de la lista oficial), editada por el superadmin.
  $$('[data-zone]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.uid === b.dataset.zone);
    const dlg = openDialog(`Localidad · ${u.displayName}`, `
      <label class="field">Localidad<input type="text" id="zn-in" maxlength="80" value="${esc(u.zone || '')}" placeholder="Empezá a escribir y elegí de la lista">
        ${u.zone ? `<span class="hint">Hoy dice: "${esc(u.zone)}"</span>` : ''}</label>`,
      '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="zn-save">Guardar</button>');
    placeInput($('#zn-in', dlg));
    $('#zn-save', dlg).onclick = async () => {
      const zone = await canonicalPlace($('#zn-in', dlg).value);
      if (!zone) return toast('Elegí una localidad de la lista.', 'error');
      try { await updateDoc(doc(db, 'users', u.uid), { zone }); dlg.close(); toast(`Localidad de ${u.displayName}: ${zone}`); viewAdminPhotographers(); }
      catch (e) { toast(errMsg(e), 'error'); }
    };
  });
  // Confirmación manual de la cuenta (no puede abrir el mail de confirmación).
  $$('[data-pwreset]').forEach(b => b.onclick = () => resetPasswordDialog(b.dataset.pwreset, b.dataset.pwname, b.dataset.pwwa));
  $$('[data-verify]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.verify);
    if (!confirm(`¿Confirmar la cuenta de ${u.displayName}? Va a poder publicar y vincular Mercado Pago sin abrir el mail.`)) return;
    b.disabled = true;
    try { await apiPost('/admin/users/verify', { uid: u.uid }); toast('Cuenta confirmada. Le avisamos al fotógrafo.'); viewAdminPhotographers(); }
    catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
  });
  // Cobro por transferencia de un fotógrafo: saldo, pagos avisados (confirmar / rechazar), registrar un pago y bloquear la opción.
  $$('[data-fees]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.uid === b.dataset.fees);
    const bal = bals.get(u.uid) || {};
    const mine = reported.filter(r => r.uid === u.uid);
    const dlg = openDialog(`Transferencia · ${u.displayName}`, `
      <div class="stack">
        <div>Estado: ${u.transferBlocked ? '<span class="pill danger">Bloqueada por vos</span>' : u.transferOn ? `<span class="pill ok">Activa</span> <span class="muted small">alias ${esc(u.transferAlias || '')}</span>` : '<span class="pill">Apagada por el fotógrafo</span>'}</div>
        <div class="row" style="justify-content:space-between"><span>Comisiones acumuladas${bal.orders ? ` (${bal.orders} ventas)` : ''}</span><strong>${fmtMoney(bal.accrued || 0)}</strong></div>
        <div class="row" style="justify-content:space-between"><span>Pagado</span><strong>−${fmtMoney(bal.paid || 0)}</strong></div>
        <div class="row" style="justify-content:space-between;font-size:1.1rem"><span>Debe</span><strong>${fmtMoney(owedOf(u.uid))}</strong></div>
        ${mine.length ? `<strong class="small">Pagos que avisó</strong>${mine.map(r => `<div class="item-row"><div class="grow">${fmtMoney(r.amount)} <span class="muted small">${esc(fmtTs(r.reportedAt))}${r.note ? ` · ${esc(r.note)}` : ''}</span></div>
          <button class="btn sm ok" data-fconf="${r.id}">Confirmar</button><button class="btn sm ghost danger" data-frej="${r.id}">No llegó</button></div>`).join('')}` : ''}
        <div class="row" style="align-items:flex-end"><label class="field" style="flex:1">Registrar un pago recibido<input type="number" id="f-amt" min="1" step="0.01" placeholder="Monto"></label><button class="btn" id="f-add">Registrar</button></div>
      </div>`,
      `<button class="btn ${u.transferBlocked ? 'ok' : 'danger'}" id="f-block">${u.transferBlocked ? 'Habilitar transferencia' : 'Bloquear transferencia'}</button>`);
    const done = msg => { toast(msg); dlg.close(); viewAdminPhotographers(); };
    $$('[data-fconf]', dlg).forEach(x => x.onclick = async () => { x.disabled = true; try { await apiPost('/admin/fees/confirm', { id: x.dataset.fconf }); done('Pago confirmado'); } catch (e) { x.disabled = false; toast(errMsg(e), 'error'); } });
    $$('[data-frej]', dlg).forEach(x => x.onclick = async () => { if (!confirm('¿Marcar que este pago no llegó? Le avisamos al fotógrafo.')) return; x.disabled = true; try { await apiPost('/admin/fees/confirm', { id: x.dataset.frej, reject: true }); done('Marcado como no recibido'); } catch (e) { x.disabled = false; toast(errMsg(e), 'error'); } });
    $('#f-add', dlg).onclick = async e => {
      const amount = Number($('#f-amt', dlg).value);
      if (!(amount > 0)) return toast('Escribí el monto.', 'error');
      e.target.disabled = true;
      try { await apiPost('/admin/fees/confirm', { uid: u.uid, amount }); done('Pago registrado'); } catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
    };
    $('#f-block', dlg).onclick = async e => {
      const transferBlocked = !u.transferBlocked;
      if (transferBlocked && !confirm(`¿Bloquear el cobro por transferencia de ${u.displayName}? Sus clientes solo van a poder pagar con Mercado Pago.`)) return;
      e.target.disabled = true;
      try { await updateDoc(doc(db, 'users', u.uid), { transferBlocked }); done(transferBlocked ? 'Transferencia bloqueada' : 'Transferencia habilitada'); } catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
    };
  });
  // Alias de transferencias del fotógrafo: verlo y corregirlo (tiene que ser de la cuenta de MP que vinculó).
  $$('[data-alias]').forEach(b => b.onclick = () => {
    const u = users.find(x => x.uid === b.dataset.alias);
    const dlg = openDialog(`Alias · ${u.displayName}`, `
      <div class="notice warn small" style="margin:0">El alias tiene que ser de la <strong>misma cuenta de Mercado Pago que vinculó</strong>${u.mpConnected ? '' : ' (todavía <strong>no vinculó</strong> Mercado Pago)'}; si no, las transferencias no se acreditan solas.</div>
      <label class="field">Alias<input type="text" id="al-alias" maxlength="40" value="${esc(u.transferAlias || '')}" placeholder="Ej: juan.fotos.mp"></label>
      <label class="field">Titular (como aparece al transferir)<input type="text" id="al-holder" maxlength="60" value="${esc(u.transferHolder || '')}"></label>
      <label class="check"><input type="checkbox" id="al-on" ${u.transferOn ? 'checked' : ''}> Ofrecer pago por transferencia en sus fotos</label>
      ${u.transferBlocked ? '<p class="muted small" style="margin:0">⚠️ Tiene la transferencia bloqueada por vos: aunque esté activada, no se ofrece. Se desbloquea en "Comisiones por transferencia".</p>' : ''}
      ${(S.settings.transfer?.plans || []).includes(planOf(u)) ? '' : '<p class="muted small" style="margin:0">Su plan actual no incluye transferencias: se guarda, pero no se ofrece hasta que tenga un plan que la incluya.</p>'}`,
      '<button class="btn" data-close>Cancelar</button><button class="btn primary" id="al-save">Guardar</button>');
    $('#al-save', dlg).onclick = async e => {
      const transferAlias = $('#al-alias', dlg).value.trim(), transferHolder = $('#al-holder', dlg).value.trim(), transferOn = $('#al-on', dlg).checked;
      if (transferAlias && !/^[A-Za-z0-9.\-]{6,20}$/.test(transferAlias)) return toast('Revisá el alias: entre 6 y 20 letras, números, puntos o guiones.', 'error');
      if (transferOn && !transferAlias) return toast('Para activarla hace falta el alias.', 'error');
      e.target.disabled = true;
      try { await updateDoc(doc(db, 'users', u.uid), { transferAlias, transferHolder, transferOn }); dlg.close(); toast(`Alias de ${u.displayName} guardado`); viewAdminPhotographers(); }
      catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
    };
  });
  $$('[data-subsync]').forEach(b => b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await apiPost('/admin/plans/sync', { uid: b.dataset.subsync });
      const st = { authorized: '✅ activa', pending: '⏳ pendiente (no confirmó el pago en Mercado Pago)', cancelled: 'cancelada', paused: 'pausada', none: 'no tiene suscripción' }[r.status] || r.status;
      toast(`Suscripción ${r.plan ? `${PLANS[r.plan]?.label || r.plan} ` : ''}${st}${r.lastPaidAt ? ' · último cobro registrado' : ''}`);
      if (r.status === 'authorized') viewAdminPhotographers();
    } catch (e) { toast(errMsg(e), 'error'); }
    b.disabled = false;
  });
  $$('[data-seats]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.seats);
    const v = prompt(`Lugares extra para el equipo de ${u.displayName} (además de los ${planSpec('empresa', S.settings).team} del plan). Cobralos aparte.`, String(u.teamExtraSeats || 0));
    if (v === null) return;
    const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    try { await updateDoc(doc(db, 'users', u.uid), { teamExtraSeats: n }); toast(`${u.displayName}: ${n} lugares extra`); viewAdminPhotographers(); }
    catch (e) { toast(errMsg(e), 'error'); }
  });
  $$('[data-unpro]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Quitar el plan? Las fotos de portfolio que superen el límite gratis se ocultan (no se borran) y su web deja de estar disponible.')) return;
    try { await updateDoc(doc(db, 'users', b.dataset.unpro), { plan: 'free', proUntil: null, courtesy: false }); viewAdminPhotographers(); }
    catch (e) { toast(errMsg(e), 'error'); }
  });
  // Dominio propio: el Worker lo agrega a Cloudflare, lo apunta a la web y devuelve los servidores de nombres para NIC.ar.
  const nsHelp = (d, ns) => `${d}\n\nEn NIC.ar → tu dominio → Delegaciones, cargá estos servidores de nombres:\n\n${(ns || []).join('\n')}\n\nCuando NIC.ar lo delegue (unas horas), la web queda andando sola y se le avisa al fotógrafo.`;
  $$('[data-dom]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.dom);
    const d = u.site.requestedDomain;
    if (!confirm(`¿Conectar ${d} para ${u.displayName}?\n\nAntes registralo en ${d.endsWith('.com.ar') ? 'NIC Argentina (con tu clave fiscal)' : 'Cloudflare → Registrar dominios'}. Después de esto te muestro los servidores de nombres.`)) return;
    b.disabled = true; b.textContent = 'Conectando…';
    try {
      const r = await apiPost('/admin/domains/activate', { uid: u.uid });
      prompt(r.status === 'active' ? `✅ ${d} ya está activo.` : nsHelp(d, r.nameServers), (r.nameServers || []).join(' '));
      viewAdminPhotographers();
    } catch (e) { b.disabled = false; b.textContent = 'Activar dominio'; toast(errMsg(e), 'error'); }
  });
  $$('[data-domst]').forEach(b => b.onclick = async () => {
    const u = users.find(x => x.uid === b.dataset.domst);
    b.disabled = true;
    try {
      const r = await apiPost('/admin/domains/status', { uid: u.uid });
      if (r.status === 'active') { toast(`✅ ${u.siteDomain} ya está andando`); viewAdminPhotographers(); }
      else { prompt(`Todavía esperando la delegación.\n\n${nsHelp(u.siteDomain, r.nameServers)}`, (r.nameServers || []).join(' ')); b.disabled = false; }
    } catch (e) { b.disabled = false; toast(errMsg(e), 'error'); }
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
  const evs = all.filter(e => adminEvFilter === 'all' || (adminEvFilter === 'nocity' ? !e.city : e.kind === adminEvFilter));
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px">
      <h1 style="margin:0">Eventos</h1>
      <button class="btn primary" id="new">+ Evento general</button>
    </div>
    <div class="tabs">${[['all', 'Todos'], ['general', 'Generales'], ['own', 'De fotógrafos'], ['nocity', `📍 Sin localidad (${all.filter(e => !e.city).length})`]].map(([k, l]) => `<button class="chip ${adminEvFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
    ${adminEvFilter === 'nocity' ? '<p class="muted small">Eventos cargados antes de la lista de localidades. Tocá ✏️ para elegirla.</p>' : ''}
    ${evs.length ? `<div class="events-grid">${evs.map(ev => panelEventCard(ev).replace('<button class="card-share"', `<button class="card-share" data-edit-ev="${ev.id}" title="Editar evento y localidad" aria-label="Editar" style="right:48px">✏️</button><button class="card-share"`)).join('')}</div>` : '<div class="card"><div class="empty">No hay eventos.</div></div>'}`;
  $('#new').onclick = () => eventDialog(null);
  $$('[data-edit-ev]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); eventDialog(evs.find(x => x.id === b.dataset.editEv), () => viewAdminEvents()); });
  $$('[data-f]').forEach(b => b.onclick = () => { adminEvFilter = b.dataset.f; viewAdminEvents(); });
  $$('[data-share]').forEach(b => b.onclick = e => { e.preventDefault(); e.stopPropagation(); shareEvent(evs.find(x => x.id === b.dataset.share)); });
}

// ================================================================ superadmin: historial de compras
// Una fila por compra: cliente, álbum, fotógrafo, fotos, forma de pago, estado, descargas. Filtros, totales y CSV.
const PURCHASE_STATUS = { approved: ['Pagada', 'ok'], pending: ['Pendiente', 'warn'], rejected: ['Rechazada', 'danger'], expired: ['Vencida', 'danger'], refunded: ['Reembolsada', ''] };
let purF = { range: 30, ph: '', pay: '', st: 'approved', q: '' };
// Cobros de suscripciones (planes de fotógrafos): se piden una vez por visita a Compras (el Worker consulta Mercado Pago).
let planPays = null;
function drawPlanPays(from, q) {
  const box = $('#pu-subs');
  if (!box) return;
  if (purF.pay === 'transfer') { box.innerHTML = ''; return; }
  if (!planPays) { box.innerHTML = '<div class="card"><h2>⭐ Suscripciones</h2><div class="spinner"></div></div>'; return; }
  if (planPays.fail) { box.innerHTML = `<div class="card"><h2>⭐ Suscripciones</h2><div class="notice danger">${esc(planPays.fail)}</div></div>`; return; }
  const list = planPays.items.filter(p => Date.parse(p.at) >= from && (!purF.ph || p.uid === purF.ph) && (!q || normalize(`${p.name} ${PLANS[p.plan]?.label || p.plan}`).includes(q)));
  const total = list.reduce((a, p) => a + (p.amount || 0), 0);
  box.innerHTML = `<div class="card stack">
    <div class="row" style="justify-content:space-between"><h2 style="margin:0">⭐ Suscripciones</h2><strong>${fmtMoney(total)}</strong></div>
    <p class="muted small" style="margin:0">Cobros de los planes de fotógrafos: el primero (alta) y cada renovación. ${list.filter(p => p.first).length} alta${list.filter(p => p.first).length === 1 ? '' : 's'} · ${list.filter(p => !p.first).length} renovaci${list.filter(p => !p.first).length === 1 ? 'ón' : 'ones'}.</p>
    ${planPays.error ? `<div class="notice warn small">${esc(planPays.error)}</div>` : ''}
    ${list.length ? `<div class="table-wrap"><table class="list">
      <tr><th>Fotógrafo</th><th>Fecha</th><th>Plan</th><th>Cobro</th><th>Monto</th></tr>
      ${list.map(p => `<tr><td><strong>${esc(p.name || '—')}</strong></td><td class="small">${esc(new Date(p.at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }))}</td>
        <td>${esc(PLANS[p.plan]?.label || p.plan || '—')}${p.period === 'year' ? ' <span class="muted small">anual</span>' : ''}</td>
        <td>${p.first ? '<span class="pill ok">🆕 Primer cobro</span>' : '<span class="pill">🔁 Renovación</span>'}</td><td>${fmtMoney(p.amount)}</td></tr>`).join('')}
    </table></div>` : '<p class="muted small" style="margin:0">No hay cobros de suscripciones con estos filtros.</p>'}
  </div>`;
}
async function viewAdminPurchases() {
  const [os, ps, cs, us] = await Promise.all([
    getDocs(query(collection(db, 'orders'), orderBy('createdAt', 'desc'), limit(3000))),
    getDocs(query(collection(db, 'orderPrivate'), limit(5000))).catch(() => null),
    getDocs(query(collection(db, 'customers'), limit(5000))).catch(() => null),
    getDocs(query(collection(db, 'users'), where('role', '==', 'photographer'))).catch(() => null),
  ]);
  const priv = new Map((ps?.docs || []).map(d => [d.id, d.data()]));
  const cust = new Map((cs?.docs || []).map(d => [d.id, d.data()]));
  const phs = (us?.docs || []).map(d => ({ uid: d.id, name: d.data().displayName || d.id })).sort((a, b) => a.name.localeCompare(b.name));
  const ms = t => t?.toMillis?.() || 0;
  const all = os.docs.map(d => {
    const o = { id: d.id, ...d.data() }, pv = priv.get(d.id) || {}, c = cust.get(o.buyerUid) || {};
    return { ...o, at: ms(o.paidAt || o.createdAt), buyerName: c.name || pv.buyerName || '', buyerEmail: c.email || pv.buyerEmail || pv.mpPayerEmail || pv.buyerPhone || '', buyerWa: c.whatsapp || '', pay: o.payMethod === 'transfer' ? 'transfer' : 'mp' };
  });
  const from = purF.range ? Date.now() - purF.range * 86400000 : 0;
  const q = normalize(purF.q);
  const list = all.filter(o => o.at >= from && (!purF.ph || o.photographerUid === purF.ph) && (!purF.pay || o.pay === purF.pay)
    && (!purF.st || o.status === purF.st) && (!q || normalize(`${o.buyerName} ${o.buyerEmail} ${o.eventName} ${o.photographerName} ${o.id}`).includes(q)));
  const paid = list.filter(o => o.status === 'approved');
  const sum = (l, f) => l.reduce((a, x) => a + (Number(f(x)) || 0), 0);
  const when = t => (t ? new Date(t).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between;margin-bottom:14px"><h1 style="margin:0">🧾 Compras</h1><button class="btn" id="pu-csv">⬇️ Exportar CSV</button></div>
    <div class="stats">
      <div class="stat"><span class="muted small">Compras pagadas</span><strong>${paid.length}</strong><span class="muted small">${sum(paid, o => o.count)} fotos</span></div>
      <div class="stat"><span class="muted small">Cobrado</span><strong>${fmtMoney(sum(paid, o => o.total))}</strong><span class="muted small">comisiones ${fmtMoney(sum(paid, o => o.platformFee))}</span></div>
      <div class="stat"><span class="muted small">Forma de pago</span><strong>💳 ${paid.filter(o => o.pay === 'mp').length} · 🏦 ${paid.filter(o => o.pay === 'transfer').length}</strong><span class="muted small">Mercado Pago · transferencia</span></div>
      <div class="stat"><span class="muted small">Sin descargar</span><strong>${paid.filter(o => !o.downloads).length}</strong><span class="muted small">pagadas que todavía no bajaron fotos*</span></div>
    </div>
    <div class="card stack">
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <select id="pu-range">${[[1, 'Hoy'], [7, 'Últimos 7 días'], [30, 'Últimos 30 días'], [90, 'Últimos 90 días'], [0, 'Todo']].map(([v, l]) => `<option value="${v}" ${purF.range === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <select id="pu-ph"><option value="">Todos los fotógrafos</option>${phs.map(p => `<option value="${p.uid}" ${purF.ph === p.uid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select id="pu-pay"><option value="">Mercado Pago y transferencia</option><option value="mp" ${purF.pay === 'mp' ? 'selected' : ''}>💳 Mercado Pago</option><option value="transfer" ${purF.pay === 'transfer' ? 'selected' : ''}>🏦 Transferencia</option></select>
        <select id="pu-st"><option value="">Todos los estados</option>${Object.entries(PURCHASE_STATUS).map(([k, [l]]) => `<option value="${k}" ${purF.st === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <input type="search" id="pu-q" placeholder="Buscar cliente, mail, álbum o código" value="${esc(purF.q)}" style="flex:1;min-width:200px">
      </div>
      <div class="table-wrap"><table class="list">
        <tr><th>Fecha</th><th>Cliente</th><th>Álbum</th><th>Fotos</th><th>Total</th><th>Pago</th><th>Estado</th><th>Descargas</th><th></th></tr>
        ${list.slice(0, 500).map(o => {
          const [l, c] = PURCHASE_STATUS[o.status] || [o.status, ''];
          return `<tr>
            <td class="small">${esc(when(o.at))}</td>
            <td><strong>${esc(o.buyerName || '—')}</strong>${o.buyerGuest ? ' <span class="pill">Invitado</span>' : ''}<br><span class="muted small">${esc(o.buyerEmail)}</span>${o.buyerWa ? `<br><a class="small" target="_blank" rel="noopener" href="${esc(waLink(o.buyerWa))}">💬 ${esc(o.buyerWa)}</a>` : ''}</td>
            <td>${esc(o.eventName || '')}<br><span class="muted small">📷 ${esc(o.photographerName || '')}</span></td>
            <td>${o.count || 0}${(o.lines || []).some(x => x.label && x.label !== 'Foto suelta') ? ' <span class="muted small">pack</span>' : ''}</td>
            <td>${fmtMoney(o.total)}<br><span class="muted small">com. ${fmtMoney(o.platformFee || 0)}</span></td>
            <td>${o.pay === 'transfer' ? '🏦 Transferencia' : '💳 Mercado Pago'}</td>
            <td><span class="pill ${c}">${l}</span></td>
            <td class="small">${o.status === 'approved' ? (o.downloads ? `${o.downloads}<br><span class="muted">${esc(when(ms(o.lastDownloadAt)))}</span>` : '<span class="muted">—</span>') : ''}</td>
            <td><div class="row" style="gap:4px;flex-wrap:nowrap">
              <a class="btn sm" target="_blank" href="index.html#/pedido/${o.id}" title="Ver la compra como el comprador">Ver</a>
              ${o.status === 'approved' ? `<button class="btn sm" data-pulink="${o.id}" title="Link de descarga para el comprador (sin cuenta)">🔗</button>` : ''}
            </div><span class="muted small">${esc(o.id.slice(0, 8))}</span></td></tr>`;
        }).join('') || '<tr><td colspan="9" class="muted">No hay compras con estos filtros.</td></tr>'}
      </table></div>
      ${list.length > 500 ? `<p class="muted small">Se muestran las primeras 500 de ${list.length}. Usá los filtros o exportá el CSV.</p>` : ''}
      <p class="muted small" style="margin:0">* Las descargas se cuentan desde el 09/11/2026.</p>
    </div>
    <div id="pu-subs"></div>`;
  if (planPays && Date.now() - (planPays.t || 0) > 5 * 60000) planPays = null; // se refresca cada 5 minutos
  drawPlanPays(from, q);
  if (!planPays) apiGet('/admin/plan-payments').then(r => { planPays = { ...r, t: Date.now() }; }, e => { planPays = { items: [], fail: errMsg(e) }; }).then(() => drawPlanPays(from, q));
  const set = (k, v) => { purF[k] = v; viewAdminPurchases(); };
  $('#pu-range').onchange = e => set('range', Number(e.target.value));
  $('#pu-ph').onchange = e => set('ph', e.target.value);
  $('#pu-pay').onchange = e => set('pay', e.target.value);
  $('#pu-st').onchange = e => set('st', e.target.value);
  let t;
  $('#pu-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { purF.q = e.target.value; viewAdminPurchases().then(() => { const i = $('#pu-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); };
  $$('[data-pulink]').forEach(b => b.onclick = async () => {
    const o = list.find(x => x.id === b.dataset.pulink);
    b.disabled = true;
    try {
      const { url } = await apiPost(`/orders/${o.id}/link`);
      const msg = `Hola! Te dejo el link para descargar tus fotos de ${o.eventName || 'tu evento'} (funciona en cualquier celular): ${url}`;
      const dlg = openDialog('🔗 Link de descarga', `<p class="muted small" style="margin:0">Para ${esc(o.buyerName || o.buyerEmail || 'el comprador')}: abre sus fotos sin cuenta, en cualquier celular.</p>
        <code style="display:block;word-break:break-all;font-size:.8rem;margin:8px 0">${esc(url)}</code>`,
        `<button class="btn" id="pl-copy">Copiar link</button><a class="btn primary" target="_blank" rel="noopener" href="${esc(o.buyerWa ? waLink(o.buyerWa, msg) : 'https://wa.me/?text=' + encodeURIComponent(msg))}">💬 Mandar por WhatsApp</a>`);
      $('#pl-copy', dlg).onclick = () => navigator.clipboard.writeText(url).then(() => toast('Link copiado'), () => toast('No se pudo copiar', 'error'));
    } catch (e) { toast(errMsg(e), 'error'); }
    b.disabled = false;
  });
  $('#pu-csv').onclick = () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Fecha', 'Código', 'Cliente', 'Email', 'WhatsApp', 'Invitado', 'Álbum', 'Fotógrafo', 'Fotos', 'Total', 'Comisión', 'Pago', 'Estado', 'Descargas'],
      ...list.map(o => [when(o.at), o.id, o.buyerName, o.buyerEmail, o.buyerWa, o.buyerGuest ? 'sí' : '', o.eventName, o.photographerName, o.count, o.total, o.platformFee || 0,
        o.pay === 'transfer' ? 'Transferencia' : 'Mercado Pago', (PURCHASE_STATUS[o.status] || [o.status])[0], o.downloads || 0])];
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `compras-quieromisfotos-${todayIso()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
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
    Object.assign(get(d.id), { name: c.name || '', email: c.email || c.phone || '', whatsapp: c.whatsapp || '', provider: c.provider || '', createdAt: ts(c.createdAt), lastLoginAt: ts(c.lastLoginAt) });
  }
  // Los que compraron antes de existir el registro salen de sus pedidos.
  for (const d of os.docs) {
    const o = d.data();
    if (!o.buyerUid || o.status !== 'approved') continue;
    const c = get(o.buyerUid);
    const pv = priv.get(d.id) || {};
    if (!c.email) c.email = pv.buyerEmail || pv.mpPayerEmail || pv.buyerPhone || o.buyerEmail || '';
    if (o.buyerGuest) c.guest = true;
    if (!c.name) c.name = pv.buyerName || o.buyerName || '';
    c.orders++; c.photos += o.count || 0; c.spent += o.total || 0;
    c.lastBuy = Math.max(c.lastBuy, ts(o.paidAt || o.createdAt));
    if (!c.createdAt) c.createdAt = ts(o.createdAt);
    c.events.add(o.eventName || o.eventId);
    (c.orderIds ||= []).push(d.id);
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
      <form id="cu-order" class="row" style="gap:6px"><input type="search" id="cu-oid" placeholder="Código de pedido (ej: A1B2C3D4)" style="max-width:220px"><button class="btn sm">👁️ Ver pedido</button></form>
      <div class="tabs" style="margin:0">${[['all', 'Todos'], ['buyers', 'Compraron'], ['none', 'Nunca compraron']].map(([k, l]) => `<button class="chip ${custFilter === k ? 'on' : ''}" data-cf="${k}">${l}</button>`).join('')}</div>
    </div>
    <div class="card">${list.length ? `<div class="table-wrap"><table class="list">
      <tr><th>Cliente</th><th>Alta</th><th>Último ingreso</th><th>Compras</th><th>Fotos</th><th>Gastó</th><th>Última compra</th><th>Eventos</th></tr>
      ${list.slice(0, 500).map(c => `<tr>
        <td><strong>${esc(c.name || '—')}</strong>${c.photographer ? ' <span class="pill">Fotógrafo</span>' : ''}${c.guest ? ' <span class="pill">Invitado</span>' : ''}<br><span class="muted small">${esc(c.email)}</span>${c.whatsapp ? ` · <a class="small" target="_blank" rel="noopener" href="${esc(waLink(c.whatsapp))}">💬 ${esc(c.whatsapp)}</a>` : ''}${c.guest && !c.name ? '' : ` <button class="btn sm ghost" data-pwreset="${esc(c.uid)}" data-pwname="${esc(c.name || c.email || '')}" data-pwwa="${esc(c.whatsapp || '')}" title="Link para que elija una contraseña nueva">🔑</button>`}</td>
        <td>${d(c.createdAt)}</td><td>${d(c.lastLoginAt)}</td><td>${c.orders}</td><td>${c.photos}</td><td>${c.spent ? fmtMoney(c.spent) : '—'}</td>
        <td>${d(c.lastBuy)}</td><td class="small">${esc([...c.events].slice(0, 3).join(', '))}${c.events.size > 3 ? ` +${c.events.size - 3}` : ''}${(c.orderIds || []).slice(0, 5).map(id => `<br><a target="_blank" href="index.html#/pedido/${id}" title="Ver la compra y el link de descarga para el comprador">🧾 ${esc(id.slice(0, 8))}</a>`).join('')}</td></tr>`).join('')}
    </table></div>${list.length > 500 ? '<p class="muted small">Se muestran los primeros 500: usá la búsqueda o exportá el CSV.</p>' : ''}`
      : '<div class="empty">No hay clientes con ese filtro.</div>'}</div>
    <p class="muted small">Desde el 14/10/2026 se registra a todos los que ingresan al sitio. Antes, solo figuran los que compraron.</p>`;

  let t;
  $('#cu-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { custQ = e.target.value; viewAdminCustomers().then(() => { const i = $('#cu-q'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }); }, 300); };
  // Revisar un pedido (por ejemplo, la calidad que recibió el comprador): se busca por el código que ve el cliente.
  $('#cu-order').onsubmit = e => {
    e.preventDefault();
    const code = $('#cu-oid').value.trim().toLowerCase();
    const o = code.length >= 6 && os.docs.find(d => d.id.toLowerCase().startsWith(code));
    if (!o) return toast('No encontré un pedido con ese código.', 'error');
    window.open(`index.html#/pedido/${o.id}`, '_blank');
  };
  $$('[data-cf]').forEach(b => b.onclick = () => { custFilter = b.dataset.cf; viewAdminCustomers(); });
  $$('[data-pwreset]').forEach(b => b.onclick = () => resetPasswordDialog(b.dataset.pwreset, b.dataset.pwname, b.dataset.pwwa));
  $('#cu-csv').onclick = () => {
    const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Nombre', 'Email', 'WhatsApp', 'Fotógrafo', 'Alta', 'Último ingreso', 'Compras', 'Fotos', 'Gastó', 'Última compra', 'Eventos'],
      ...list.map(c => [c.name, c.email, c.whatsapp, c.photographer ? 'sí' : '', d(c.createdAt), d(c.lastLoginAt), c.orders, c.photos, c.spent, d(c.lastBuy), [...c.events].join(' | ')])];
    const blob = new Blob(['\ufeff' + rows.map(r => r.map(cell).join(';')).join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `clientes-quieromisfotos-${todayIso()}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}

// Ingresos en tu Mercado Pago: cuándo se acredita cada cobro y los retiros que hacés a tu reserva.
async function incomeDialog() {
  const dlg = openDialog('💰 Tus ingresos en Mercado Pago', '<div id="inc"><div class="spinner"></div></div>');
  const box = $('#inc', dlg);
  const draw = async () => {
    const [r, ws] = await Promise.all([apiGet('/admin/income'), getDocs(query(collection(db, 'withdrawals'), orderBy('date', 'desc'), limit(200)))]);
    const wd = ws.docs.map(d => ({ id: d.id, ...d.data() }));
    const now = Date.now(), dayMs = x => (x ? Date.parse(x) : 0);
    const items = r.items.slice().sort((a, b) => (dayMs(a.releaseAt) || 9e15) - (dayMs(b.releaseAt) || 9e15));
    const credited = items.filter(x => x.releaseAt && dayMs(x.releaseAt) <= now);
    const pending = items.filter(x => x.releaseAt && dayMs(x.releaseAt) > now);
    const unknown = items.filter(x => !x.releaseAt);
    const tot = l => l.reduce((a, x) => a + (Number(x.net) || 0), 0);
    const since = now - r.days * 86400000;
    const wdIn = wd.filter(w => (w.date?.toMillis?.() || 0) >= since);
    const saved = wdIn.reduce((a, w) => a + (w.amount || 0), 0);
    const day = x => new Date(x).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
    const kind = { mp: "⭐", fee: '📸 Comisión', transfer: '🏦 Saldo por transferencia' };
    // Por acreditar, agrupado por día: cuánto entra cada día.
    const byDay = {};
    for (const x of pending) { const k = x.releaseAt.slice(0, 10); (byDay[k] ||= []).push(x); }
    box.innerHTML = `
      ${r.error ? `<div class="notice warn small">No se pudo leer Mercado Pago: ${esc(r.error)}</div>` : ''}
      <div class="stats" style="margin-bottom:12px">
        <div class="stat"><span class="muted small">Acreditado (${r.days} días)</span><strong>${fmtMoney(tot(credited))}</strong><span class="muted small">neto, ya disponible</span></div>
        <div class="stat"><span class="muted small">Guardado en la reserva</span><strong>${fmtMoney(saved)}</strong><span class="muted small">${wdIn.length} retiro${wdIn.length === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="muted small">Falta guardar</span><strong>${fmtMoney(Math.max(0, tot(credited) - saved))}</strong><span class="muted small">acreditado − guardado</span></div>
        <div class="stat"><span class="muted small">Por acreditar</span><strong>${fmtMoney(tot(pending))}</strong><span class="muted small">${pending.length} cobro${pending.length === 1 ? '' : 's'}</span></div>
      </div>
      <h3 style="margin:8px 0">📅 Próximas acreditaciones</h3>
      ${Object.keys(byDay).length ? Object.entries(byDay).map(([d, l]) => `<div class="item-row"><span class="grow"><strong>${esc(day(d + 'T12:00'))}</strong><br><span class="muted small">${l.map(x => `${kind[x.kind] || ''} ${fmtMoney(x.net)}`).join(' · ')}</span></span><strong>${fmtMoney(tot(l))}</strong></div>`).join('') : '<p class="muted small">No hay cobros por acreditar.</p>'}
      <h3 style="margin:16px 0 8px">🏦 Retiros a tu reserva</h3>
      <form class="row" id="wd-f" style="gap:8px;flex-wrap:wrap">
        <input type="date" id="wd-date" value="${todayIso()}" required style="max-width:160px">
        <input type="number" id="wd-amount" min="1" step="0.01" inputmode="decimal" placeholder="Monto" required style="max-width:140px">
        <input type="text" id="wd-note" maxlength="80" placeholder="Nota (opcional)" style="flex:1;min-width:140px">
        <button class="btn primary sm" type="submit">Registrar retiro</button>
      </form>
      ${wd.length ? wd.map(w => `<div class="item-row"><span class="grow"><strong>${fmtMoney(w.amount)}</strong> <span class="muted small">${esc(w.date?.toDate?.().toLocaleDateString('es-AR') || '')}${w.note ? ' · ' + esc(w.note) : ''}</span></span><button class="btn sm ghost" data-wdel="${w.id}" aria-label="Borrar retiro">✕</button></div>`).join('') : '<p class="muted small">Todavía no registraste retiros.</p>'}
      <h3 style="margin:16px 0 8px">✅ Acreditados</h3>
      ${credited.length ? credited.slice().reverse().map(x => `<div class="item-row small"><span class="grow">${kind[x.kind] || ''} · ${esc(x.desc)}<br><span class="muted">${esc(day(x.releaseAt))}${x.amount !== x.net ? ` · cobrado ${fmtMoney(x.amount)}` : ''}</span></span><strong>${fmtMoney(x.net)}</strong></div>`).join('') : '<p class="muted small">Nada acreditado en este período.</p>'}
      ${unknown.length ? `<p class="muted small" style="margin-top:12px">${unknown.length} comisión${unknown.length === 1 ? '' : 'es'} de ventas anteriores a este cambio (${fmtMoney(tot(unknown))}) no tienen fecha de acreditación guardada. Las nuevas ya la traen.</p>` : ''}`;
    $('#wd-f', box).onsubmit = async e => {
      e.preventDefault();
      const amount = Number($('#wd-amount', box).value);
      if (!(amount > 0)) return toast('Poné el monto del retiro.', 'error');
      try {
        await addDoc(collection(db, 'withdrawals'), { amount, date: Timestamp.fromMillis(Date.parse(`${$('#wd-date', box).value}T12:00:00-03:00`)), note: $('#wd-note', box).value.trim(), createdAt: serverTimestamp() });
        toast('Retiro registrado'); draw();
      } catch (err) { toast(errMsg(err), 'error'); }
    };
    $$('[data-wdel]', box).forEach(b => b.onclick = async () => {
      if (!confirm('¿Borrar este retiro?')) return;
      try { await deleteDoc(doc(db, 'withdrawals', b.dataset.wdel)); draw(); } catch (err) { toast(errMsg(err), 'error'); }
    });
  };
  draw().catch(e => { box.innerHTML = `<div class="notice danger">${esc(errMsg(e))}</div>`; });
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
  // Cortesías (marcadas así o con vencimiento lejano, "de prueba") no cuentan como ingreso.
  const active = users.filter(u => planOf(u) !== 'free');
  const isCourtesy = u => !!u.courtesy || (u.proUntil?.toMillis?.() || 0) > Date.parse('2090-01-01');
  const paid = active.filter(u => !isCourtesy(u));
  const mrr = sum(paid, u => planSpec(planOf(u), S.settings).price || 0);
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
      <div class="stat" id="m-income" role="button" tabindex="0" style="cursor:pointer" title="Ver acreditaciones y retiros"><span class="muted small">Tus ingresos ›</span><strong>${fmtMoney(commission + extRevenue)}</strong><span class="muted small">comisiones ${fmtMoney(commission)} · extensiones ${fmtMoney(extRevenue)}</span></div>
      <div class="stat"><span class="muted small">Vendido por los fotógrafos</span><strong>${fmtMoney(sum(orders, o => o.total))}</strong><span class="muted small">${orders.length} ventas · ${sum(orders, o => o.count)} fotos</span></div>
      <div class="stat"><span class="muted small">Compradores</span><strong>${buyers}</strong><span class="muted small">ticket promedio ${fmtMoney(orders.length ? sum(orders, o => o.total) / orders.length : 0)}</span></div>
      <div class="stat"><span class="muted small">Fotógrafos</span><strong>${approvedPh.length}</strong><span class="muted small">${selling.size} con ventas en el período · ${users.filter(u => u.status === 'pending').length} pendientes</span></div>
      <div class="stat" id="m-plans" role="button" tabindex="0" style="cursor:pointer" title="Ver fotógrafos con plan"><span class="muted small">Planes pagos ›</span><strong>${paid.length}</strong><span class="muted small">≈ ${fmtMoney(mrr)}/mes · ${active.length - paid.length} cortesía${active.length - paid.length === 1 ? '' : 's'}</span></div>
    </div>

    <div class="card"><h2>Tus ingresos por mes</h2>
      <div class="spark tall">${byMonth.map(m => `<span style="height:${Math.max(2, (m.v / maxM) * 100)}%" title="${m.label}: ${fmtMoney(m.v)} (vendido ${fmtMoney(m.gmv)})"></span>`).join('')}</div>
      <div class="spark-labels">${byMonth.map(m => `<span>${m.label}</span>`).join('')}</div>
      <p class="muted small">Comisiones + extensiones. Los planes (Pro/Web) se suman cuando se cobren por Mercado Pago.</p></div>
    <div class="card"><h2>Por fotógrafo</h2>${table(group('photographerUid', 'photographerName'), 'Fotógrafo')}</div>
    <div class="card"><h2>Por evento</h2>${table(group('eventId', 'eventName'), 'Evento')}</div>`;
  $$('[data-r]').forEach(b => b.onclick = () => { metricsRange = Number(b.dataset.r); viewAdminMetrics(); });
  $('#m-plans').onclick = () => openDialog(`Planes vigentes (${active.length})`, active.length ? active.map(u => `<div class="item-row"><span class="grow"><strong>${esc(u.displayName || u.uid)}</strong> <span class="muted small">/${esc(u.slug || '')}</span><br>
      <span class="muted small">${esc(PLANS[planOf(u)]?.label || planOf(u))} · ${isCourtesy(u) ? 'cortesía, no suma al ingreso' : `hasta ${esc(fmtTs(u.proUntil))} · ${fmtMoney(planSpec(planOf(u), S.settings).price || 0)}/mes`}</span></span>
      ${u.status !== 'approved' ? `<span class="pill warn">${esc({ pending: 'Pendiente', suspended: 'Suspendido', rejected: 'Rechazado' }[u.status] || u.status || 'Sin estado')}</span>` : isCourtesy(u) ? '<span class="pill">Cortesía</span>' : '<span class="pill ok">Pago</span>'}</div>`).join('') : '<p class="muted">No hay planes vigentes.</p>');
  $('#m-income').onclick = () => incomeDialog();
}

// ================================================================ superadmin: almacenamiento (R2)
// Precios de Cloudflare R2 (clase estándar). Revisar si Cloudflare los cambia.
const R2 = { freeGB: 10, usdPerGB: 0.015, freeA: 1e6, freeB: 1e7 };

function r2Cost(bytes) {
  return Math.max(0, bytes / 1e9 - R2.freeGB) * R2.usdPerGB;
}
const fmtUsd = n => `US$ ${n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Uso del mes de cada servicio que cobra, contra lo que entra gratis (worker/src/costs.js).
async function viewAdminCosts(fresh = false) {
  $('#view').innerHTML = '<h1>Costos</h1><div class="spinner"></div>';
  let d;
  try { d = await apiGet(`/admin/costs${fresh ? '?fresh=1' : ''}`); }
  catch (e) { $('#view').innerHTML = `<h1>Costos</h1><div class="notice danger">${esc(errMsg(e))}</div>`; return; }
  const n = v => Number(v || 0).toLocaleString('es-AR');
  const usd = v => `US$ ${Number(v || 0).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const P = d.prices;
  const bar = (v, max) => { const pct = Math.min(100, max ? v / max * 100 : 0); return `<div class="meter"><span style="width:${pct}%;background:${pct >= 100 ? 'var(--danger)' : pct >= 80 ? 'var(--warn)' : 'var(--ok)'}"></span></div>`; };
  const err = x => x?.error ? `<div class="notice warn small">${esc(x.error)}</div>` : '';
  const row = (label, used, free, unit, note = '') => `<div class="stack" style="gap:4px"><div class="row" style="justify-content:space-between"><span>${label}</span><span class="small"><strong>${n(used)}</strong> / ${n(free)} ${unit}</span></div>${bar(used, free)}${note ? `<span class="muted small">${note}</span>` : ''}</div>`;
  const maxDay = (arr, k) => Math.max(0, ...(arr || []).map(r => r[k] || 0));
  const fs = d.firestore || {};
  const days = (fs.daily || []).length || 1;
  $('#view').innerHTML = `
    <div class="row" style="justify-content:space-between"><h1>Costos</h1><button class="btn" id="co-fresh">🔄 Actualizar</button></div>
    <div class="notice ${d.usd > 0 ? 'warn' : 'ok'}">Este mes (${esc(d.month)}): <strong>${usd(d.usd)}</strong> estimado · proyección a fin de mes <strong>${usd(d.projectedUsd)}</strong>.
      <span class="muted small">Precios de lista en dólares; la factura de Google y Cloudflare manda. Actualizado ${esc(new Date(d.at).toLocaleString('es-AR'))}.</span></div>
    <div class="card stack"><h2 style="margin:0">🔥 Firebase · base de datos</h2>${err(fs)}
      ${fs.error ? '' : `<span class="muted small">El cupo gratis es por día. Peor día del mes contra el cupo diario:</span>
      ${row('Lecturas', maxDay(fs.daily, 'read'), P.firestore.read.free, 'por día', `Promedio ${n(Math.round(fs.totals.read / days))}/día · pagas este mes: ${n(fs.over.read)}`)}
      ${row('Escrituras', maxDay(fs.daily, 'write'), P.firestore.write.free, 'por día', `Promedio ${n(Math.round(fs.totals.write / days))}/día · pagas este mes: ${n(fs.over.write)}`)}
      ${row('Borrados', maxDay(fs.daily, 'delete'), P.firestore.delete.free, 'por día', `Pagos este mes: ${n(fs.over.delete)}`)}
      <div>Costo estimado: <strong>${usd(fs.usd)}</strong></div>`}</div>
    <div class="card stack"><h2 style="margin:0">☁️ Cloudflare · servidor</h2>${err(d.workers)}
      ${d.workers.error ? '' : `${row('Pedidos (peor día)', d.workers.maxDay, d.workers.freePerDay, 'por día', `Total del mes: ${n(d.workers.total)}. En el plan gratis, pasado el tope los pedidos fallan (no se cobra): si se acerca, conviene el plan de US$ 5/mes.`)}`}</div>
    <div class="card stack"><h2 style="margin:0">🖼️ Cloudflare · fotos (R2)</h2>${err(d.storage)}${err(d.r2ops)}
      ${d.storage.error ? '' : row('Espacio (promedio del mes)', d.storage.avgGB, d.storage.freeGB, 'GB', `Hoy: ${d.storage.nowGB} GB · costo ${usd(d.storage.usd)}. Detalle por fotógrafo en <a href="#/admin/almacenamiento">Almacenamiento</a>.`)}
      ${d.r2ops.error ? '' : `${row('Operaciones clase A (subir, listar)', d.r2ops.classA, P.r2.classA.free, 'en el mes')}${row('Operaciones clase B (ver fotos)', d.r2ops.classB, P.r2.classB.free, 'en el mes')}<div>Costo de operaciones: <strong>${usd(d.r2ops.usd)}</strong></div>`}</div>
    <div class="card stack"><h2 style="margin:0">🤖 Cloudflare · IA de dorsales</h2>${err(d.ai)}
      ${d.ai.error ? '' : `${row('Neuronas (peor día)', d.ai.maxDay, d.ai.freePerDay, 'por día', `Total del mes: ${n(d.ai.total)}`)}<div>Costo estimado: <strong>${usd(d.ai.usd)}</strong></div>`}</div>
    <p class="muted small">Sin costo hoy: inicio de sesión (Firebase Auth), notificaciones (FCM), web en GitHub Pages. Se revisa solo todos los días y te avisa si algo pasa lo gratis (Plataforma → Avisos para vos).</p>`;
  $('#co-fresh').onclick = () => viewAdminCosts(true);
}

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
      <label class="check"><input type="checkbox" id="lim-selfie" ${S.settings.selfieEnabled !== false ? 'checked' : ''}> 🤳 Búsqueda por selfie (todos los fotógrafos)</label>
      <p class="muted small" style="margin:0">Las caras se procesan en el dispositivo del fotógrafo al subir y la comparación en el servidor: sin costo. Cada fotógrafo la puede apagar en su álbum.</p>
      <label class="check"><input type="checkbox" id="lim-bibs" ${S.settings.bibsEnabled !== false ? 'checked' : ''}> 🔢 Lectura automática de dorsales (todos los fotógrafos)</label>
      <p class="muted small" style="margin:0">Con IA de Cloudflare (Workers AI): las primeras ~200 fotos por día son gratis; después cuesta ~US$ 0,55 cada 1.000 fotos. Cada fotógrafo la activa en su álbum (viene activada en running, ciclismo, triatlón…).</p>
      <h3 style="margin:4px 0 0">Packs adicionales para un álbum</h3>
      <p class="muted small" style="margin:0">Fotos extra para un álbum. Solo planes pagos (el Gratis tiene tope fijo).</p>
      <div id="lim-plans" class="stack"></div>
      <div class="row"><button type="button" class="btn sm" id="lim-add">+ Agregar pack</button><span class="spacer" style="flex:1"></span><button class="btn primary">Guardar</button></div>
    </form>
    <div class="card stack"><h2 style="margin:0">Borrado de originales</h2>
      <p class="muted small" style="margin:0">Los álbumes se venden ${S.settings.retentionDays} días desde la primera foto (más las extensiones pagas). Después quedan ${GRACE_DAYS} días para descargas y para extender, y se borran los originales: quedan 10 fotos de muestra con marca de agua (las más vendidas), sin venta.
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
      await setDoc(doc(db, 'settings', 'platform'), { optimizeOriginals: $('#lim-opt').checked, bibsEnabled: $('#lim-bibs').checked, selfieEnabled: $('#lim-selfie').checked, storagePlans: clean, updatedAt: serverTimestamp() }, { merge: true });
      S.settings = await loadSettings(true);
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
  empresa: { price: 'empresaPrice', first: 'empresaFirstPrice', year: 'empresaYearPrice', fee: 'empresaFeePercent', portfolio: 'empresaPortfolioLimit',
    albumPhotos: 'empresaAlbumPhotos', days: 'empresaRetentionDays', featured: 'empresaFeatured', team: 'empresaSeats', seatPrice: 'empresaSeatPrice' },
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
// Superadmin: avisos push de lo que pasa en la plataforma (registros, membresías, álbumes, ventas).
const SUPER_PUSH = [
  ['signup', '🆕 Se registra un fotógrafo'],
  ['membership', '⭐ Un fotógrafo paga su membresía'],
  ['album', '📸 Se publica un álbum'],
  ['sale', '💰 Se vende una foto'],
  ['costos', '🧾 Algún servicio pasa lo gratis (Firebase, Cloudflare): revisión diaria'],
];
// Cobro por transferencia: qué planes lo tienen y los datos bancarios donde los fotógrafos pagan su saldo de comisiones.
async function drawAdminTransfer() {
  const box = $('#a-transfer');
  if (!box) return;
  const plans = S.settings.transfer?.plans || [];
  const bank = (await getDoc(doc(db, 'platformPrivate', 'feeBank')).then(x => x.data()).catch(() => null)) || {};
  box.innerHTML = `
    <h2 style="margin:0">🏦 Cobro por transferencia</h2>
    <p class="muted small" style="margin:0">El comprador transfiere al alias del fotógrafo (sin comisión de Mercado Pago) y se acredita solo. Tu comisión se acumula como saldo que el fotógrafo te paga a los datos de abajo; lo confirmás en Fotógrafos.</p>
    <div class="stack" style="gap:6px"><strong class="small">Planes que pueden ofrecerlo</strong>
      ${['lite', 'web', 'webdomain', 'empresa'].map(id => `<label class="check"><input type="checkbox" data-trplan="${id}" ${plans.includes(id) ? 'checked' : ''}> ${esc(PLANS[id]?.label || id)}</label>`).join('')}</div>
    <strong class="small">Tus datos para que te paguen el saldo</strong>
    <label class="field">Alias<input type="text" id="fb-alias" maxlength="40" value="${esc(bank.alias || '')}"></label>
    <label class="field">CBU / CVU<input type="text" id="fb-cbu" maxlength="30" inputmode="numeric" value="${esc(bank.cbu || '')}"></label>
    <label class="field">Titular<input type="text" id="fb-holder" maxlength="80" value="${esc(bank.holder || '')}"></label>
    <label class="field">CUIT<input type="text" id="fb-cuit" maxlength="15" value="${esc(bank.cuit || '')}"></label>
    <label class="field">Banco o billetera<input type="text" id="fb-bank" maxlength="60" value="${esc(bank.bank || '')}" placeholder="Ej: Mercado Pago"></label>
    <p class="muted small" style="margin:0">Estos datos solo los ven los fotógrafos registrados.</p>
    <div><button class="btn primary" id="fb-save">Guardar</button></div>`;
  $('#fb-save', box).onclick = async e => {
    const plansOn = $$('[data-trplan]', box).filter(c => c.checked).map(c => c.dataset.trplan);
    const data = { alias: $('#fb-alias').value.trim(), cbu: $('#fb-cbu').value.replace(/\s/g, ''), holder: $('#fb-holder').value.trim(), cuit: $('#fb-cuit').value.trim(), bank: $('#fb-bank').value.trim(), updatedAt: serverTimestamp() };
    if (plansOn.length && !data.alias && !data.cbu) return toast('Cargá tu alias o CBU para que los fotógrafos te puedan pagar.', 'error');
    e.target.disabled = true;
    try {
      await Promise.all([
        setDoc(doc(db, 'platformPrivate', 'feeBank'), data),
        setDoc(doc(db, 'settings', 'platform'), { transfer: { plans: plansOn }, updatedAt: serverTimestamp() }, { merge: true }),
      ]);
      S.settings.transfer = { ...(S.settings.transfer || {}), plans: plansOn };
      toast('Guardado');
    } catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  };
}

async function drawSuperPush() {
  const box = $('#a-push');
  if (!box) return;
  const sp = S.settings.superPush || {};
  const avail = await pushAvailable();
  box.innerHTML = `
    <div class="row" style="justify-content:space-between">
      <div><h2 style="margin:0 0 4px">🔔 Avisos para vos</h2>
        <span class="muted small">${!avail ? (isIos() && !isStandalone() ? 'En iPhone, primero agregá el panel a la pantalla de inicio (Compartir → Agregar a inicio) y abrilo desde ese ícono.' : 'Este navegador no permite notificaciones.')
          : pushOn() ? 'Activados en este dispositivo.' : pushBlocked() ? 'Bloqueaste las notificaciones de este sitio: habilitalas desde la configuración del navegador.' : 'Activalos en cada dispositivo donde quieras recibirlos.'}</span></div>
      ${avail && !pushBlocked() ? (pushOn() ? '<button class="btn sm" id="sp-off">Desactivar en este dispositivo</button>' : '<button class="btn primary sm" id="sp-on">Activar en este dispositivo</button>') : ''}
    </div>
    <div class="stack" style="gap:6px">${SUPER_PUSH.map(([k, l]) => `<label class="check"><input type="checkbox" data-sp="${k}" ${sp[k] === false ? '' : 'checked'}> ${l}</label>`).join('')}</div>`;
  $('#sp-on', box)?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { await enablePush(S.user.uid); toast('🔔 Avisos activados en este dispositivo'); } catch (err) { toast(errMsg(err), 'error'); }
    drawSuperPush();
  });
  $('#sp-off', box)?.addEventListener('click', async () => { await disablePush(S.user.uid).catch(() => {}); toast('Avisos desactivados en este dispositivo'); drawSuperPush(); });
  $$('[data-sp]', box).forEach(cb => cb.onchange = async () => {
    try {
      await setDoc(doc(db, 'settings', 'platform'), { superPush: { [cb.dataset.sp]: cb.checked }, updatedAt: serverTimestamp() }, { merge: true });
      S.settings.superPush = { ...(S.settings.superPush || {}), [cb.dataset.sp]: cb.checked };
      toast('Guardado');
    } catch (err) { toast(errMsg(err), 'error'); cb.checked = !cb.checked; }
  });
}

async function viewAdminConfig() {
  S.settings = await loadSettings(true);
  const st = S.settings;
  let plans = (st.extensionPlans || []).map(p => ({ ...p }));
  $('#view').innerHTML = `
    <h1>Configuración de la plataforma</h1>
    <div class="card row" style="justify-content:space-between">
      <div><strong>Refrescar todos los dispositivos</strong><br><span class="muted small">Recarga el sitio y el panel en todos los navegadores abiertos (oficial y prueba), en los próximos 5 minutos o cuando vuelvan a la pestaña. Los que están subiendo fotos ven un aviso y no se cortan.</span></div>
      <button class="btn" id="a-reload">🔄 Refrescar todos</button>
      <button class="btn" id="a-mailtest" title="Manda un mail a tu casilla para confirmar que Resend anda">✉️ Enviarme un mail de prueba</button>
    </div>
    <div class="card row" style="justify-content:space-between">
      <div><strong>📊 Resumen semanal</strong><br><span class="muted small">Te llega solo todos los lunes a las 6 con la semana anterior (lunes a domingo): ventas, tu ganancia (comisiones, extensiones y suscripciones), compradores, fotógrafos nuevos y a quién hay que darle una mano.</span></div>
      <button class="btn" id="a-weekly">Enviármelo ahora</button>
    </div>
    <div class="card row" style="justify-content:space-between">
      <div><strong>📣 Novedades a los fotógrafos</strong><br><span class="muted small">Video para historias, portada, búsqueda por selfie y precio especial. Primero mandátelo de prueba; el envío a todos se hace una sola vez.</span></div>
      <button class="btn" id="a-news-test">Enviarme la prueba</button>
      <button class="btn primary" id="a-news">Enviar a todos</button>
    </div>
    <div class="card stack" id="a-push"></div>
    <div class="card stack" id="a-transfer"></div>
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
          ${[['free', 'Gratis'], ['lite', 'Profesional Lite'], ['web', 'Profesional'], ['webdomain', 'Profesional Premium'], ['empresa', 'Empresas']].map(([id, label]) => {
            const p = planSpec(id, st);
            const num = (k, v, step = 1) => `<input type="number" data-k="${k}" min="0" step="${step}" value="${v ?? ''}">`;
            return `<tr data-plan="${id}"><td><strong>${label}</strong>${id === 'free' ? '<br><span class="muted small">1 álbum activo</span>' : id === 'web' ? '<br><span class="muted small">con web</span>' : id === 'webdomain' ? '<br><span class="muted small">web + dominio</span>' : id === 'empresa' ? `<br><span class="muted small">web + dominio + equipo</span><span class="hint">Colaboradores incluidos</span>${num('team', p.team)}<span class="hint">Lugar extra ($/mes)</span>${num('seatPrice', p.seatPrice)}` : ''}</td>
              <td>${id === 'free' ? '—' : `<span class="hint">Mensual</span>${num('price', p.price)}
                ${PLANS[id]?.domain ? `<span class="hint">Primer mes</span>${num('first', p.first)}` : ''}
                <span class="hint">Anual</span>${num('year', p.year)}`}</td>
              <td>${num('fee', p.baseFee ?? p.fee, 0.1)}</td>
              <td>${num('portfolio', p.portfolio)}</td>
              <td>${num('albumPhotos', p.albumPhotos, 50)}</td>
              <td>${num('days', p.days)}</td>
              <td>${id === 'free' ? '—' : `<input type="checkbox" data-k="featured" ${p.featured ? 'checked' : ''}>`}</td></tr>`;
          }).join('')}
        </table></div>
        <div class="row" style="align-items:flex-end;gap:10px">
          <label class="field" style="max-width:200px">Promo: comisión % para todos<input type="number" id="a-promo-fee" min="0" step="0.1" value="${esc(String('promoFee' in st ? st.promoFee : 3))}"></label>
          <label class="field" style="max-width:200px">hasta el (inclusive)<input type="date" id="a-promo-until" value="${esc('promoUntil' in st ? st.promoUntil || '' : '2026-11-15')}"></label>
          <span class="hint" style="flex:1">Mientras dure, se cobra esta comisión en todos los planes (si es menor que la del plan) y se muestra en Soy fotógrafo. 0 = sin promo.</span>
        </div>
        <label class="field" style="max-width:320px">Prueba gratis de Profesional para fotógrafos nuevos (días)<input type="number" id="a-trial" min="0" max="90" step="1" value="${st.trialDays ?? 30}">
          <span class="hint">Se da al aprobar al fotógrafo, una sola vez. 0 = sin prueba. Rige con los planes nuevos.</span></label>
        <div class="row"><button type="button" class="btn sm" id="a-mpacc">💳 Ver la cuenta que cobra los planes</button><span class="small" id="a-mpacc-out"></span></div>
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
  // Cuenta de Mercado Pago con la que la plataforma cobra suscripciones y extensiones (tiene que ser la real).
  $('#a-mpacc').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await apiPost('/admin/mp/whoami');
      $('#a-mpacc-out').innerHTML = !r.configured ? '❌ No hay token cargado'
        : r.test ? `⚠️ <strong>Cuenta de PRUEBA</strong> (${esc(r.nickname)} · #${esc(r.id)}): con esta cuenta los pagos reales fallan. Cargá el Access Token de producción de tu cuenta real.`
        : `✅ Cuenta real: ${esc(r.nickname)} · #${esc(r.id)}${r.email ? ` · ${esc(r.email)}` : ''}`;
    } catch (err) { $('#a-mpacc-out').textContent = errMsg(err); }
    e.target.disabled = false;
  };
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
  drawSuperPush();
  drawAdminTransfer();
  $('#a-mailtest').onclick = async e => {
    e.target.disabled = true;
    try { const r = await apiPost('/admin/mail/test'); toast(`Mail enviado a ${r.to}. Revisá la bandeja (y Spam).`); }
    catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  };
  $('#a-weekly').onclick = async e => {
    e.target.disabled = true;
    try { const r = await apiPost('/admin/weekly/send'); toast(`Resumen de la semana del ${r.week} enviado a ${r.to}.`); }
    catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  };
  $('#a-news-test').onclick = async e => {
    e.target.disabled = true;
    try { await apiPost('/admin/mail/news', { test: true }); toast('Prueba enviada a tu mail. Revisá la bandeja (y Spam).'); }
    catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  };
  $('#a-news').onclick = async e => {
    if (!confirm('¿Enviar las novedades por mail a todos los fotógrafos? Se hace una sola vez.')) return;
    e.target.disabled = true;
    try { const r = await apiPost('/admin/mail/news', {}); toast(`Novedades enviadas a ${r.sent} fotógrafo${r.sent === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} sin mail)` : ''}.`); }
    catch (err) { toast(errMsg(err), 'error'); e.target.disabled = false; }
  };
  $('#a-reload').onclick = async () => {
    if (!confirm('¿Recargar el sitio en todos los dispositivos abiertos?')) return;
    try { await setDoc(doc(db, 'settings', 'app'), { reloadAt: serverTimestamp() }, { merge: true }); toast('Listo: se van a recargar en los próximos minutos'); }
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
        promoFee: Number($('#a-promo-fee').value) || 0, promoUntil: $('#a-promo-until').value || '',
        retentionDays: Math.round(Number($('#a-ret').value)),
        extensionPlans: clean,
        mpFeePlans: $$('#a-mp [data-mp]').map(i => ({ id: i.dataset.mp, label: i.dataset.label, percent: Math.round(Number(i.value) * 100) / 100 })),
        updatedAt: serverTimestamp(),
      }, { merge: true });
      S.settings = await loadSettings(true);
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
