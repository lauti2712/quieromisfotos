// Acceso sin SMS: cuando a un comprador no le llega el código, nos escribe y el superadmin le genera un link de acceso
// para su celular. Al abrirlo entra a su cuenta (la misma que tendría con el SMS: usuario de Firebase con ese teléfono).
//   POST /admin/login-link   Bearer (superadmin)  {phone, name?}  -> { url, created }
//   POST /auth/link          público  {t}                           -> { token } (custom token de Firebase, un solo uso)
// El link vale 48 h y se puede usar una sola vez (loginLinks/{jti}).
import { requireUser } from './firebase.js';
import { serviceToken, adminSet, adminUpdate, adminGet, adminQuery, adminDelete } from './admin.js';
import { b64url, signToken, verifyToken } from './tokens.js';
import { json, httpError } from './http.js';
import { sendMail, mailLayout } from './mail.js';

const IDT = env => `https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}`;

async function idt(env, path, body) {
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  const res = await fetch(`${IDT(env)}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(502, `Firebase Auth: ${d.error?.message || res.status}`);
  return d;
}

export async function createLoginLink(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const { phone, name } = await req.json().catch(() => ({}));
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length < 12 || digits.length > 15) throw httpError(400, 'Escribí el celular con código de país y de área (ej: 54 9 342 555-1234).');
  const e164 = `+${digits}`;
  // La cuenta de ese celular: si no existe, se crea (como si hubiera entrado con el SMS).
  const found = await idt(env, '/accounts:lookup', { phoneNumber: [e164] });
  let uid = found.users?.[0]?.localId, created = false;
  if (!uid) {
    const d = await idt(env, '/accounts', { phoneNumber: e164, ...(name ? { displayName: String(name).slice(0, 60) } : {}) });
    uid = d.localId; created = true;
  }
  const jti = crypto.randomUUID();
  const t = await signToken({ typ: 'login', uid, jti, exp: Math.floor(Date.now() / 1000) + 48 * 3600 }, env.UPLOAD_SECRET);
  const site = (env.SITE_URL || 'https://quieromisfotos.com.ar/').replace(/\/?$/, '/');
  return json({ url: `${site}#/acceso/${t}`, created, phone: e164 });
}

export async function useLoginLink(req, env) {
  const { t } = await req.json().catch(() => ({}));
  const p = await verifyToken(t, env.UPLOAD_SECRET, 'login');
  if (!p || p.exp < Date.now() / 1000) throw httpError(400, 'El link venció o no es válido. Escribinos y te mandamos otro.');
  await adminSet(env, `loginLinks/${p.jti}`, { uid: p.uid, usedAt: new Date() }, { mustNotExist: true })
    .catch(() => { throw httpError(409, 'Este link ya se usó. Si necesitás entrar de nuevo, escribinos.'); });
  // Custom token de Firebase firmado con la cuenta de servicio.
  const sa = JSON.parse(env.FIREBASE_SA);
  const enc = new TextEncoder(), now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, sub: sa.client_email, uid: p.uid, iat: now, exp: now + 3600,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
  })));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), ch => ch.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  return json({ token: `${header}.${claims}.${b64url(sig)}` });
}

// Superadmin: link para que un cliente o fotógrafo elija una contraseña nueva (y, si se pide, se le manda por mail).
//   POST /admin/users/reset   Bearer (superadmin)  {uid, send?}  -> { email, link, google, sent }
export async function resetPasswordLink(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const { uid, send, newEmail, replace } = await req.json().catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid || '')) throw httpError(400, 'Pedido inválido');
  if (newEmail) return changeEmail(env, uid, newEmail, replace === true); // {uid, newEmail}: cambiar el mail de la cuenta
  const u = (await idt(env, '/accounts:lookup', { localId: [uid] })).users?.[0];
  if (!u) throw httpError(404, 'No existe esa cuenta');
  if (!u.email) throw httpError(409, 'Esta cuenta no tiene mail (compró como invitado o entra con el celular): no tiene contraseña para restablecer.');
  const google = (u.providerUserInfo || []).some(p => p.providerId === 'google.com');
  const link = (await idt(env, '/accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email: u.email, returnOobLink: true })).oobLink;
  let sent = false;
  if (send) {
    sent = !!await sendMail(env, {
      to: u.email,
      subject: '🔑 Elegí tu nueva contraseña de Quiero Mis Fotos',
      html: mailLayout({
        title: 'Elegí tu nueva contraseña',
        intro: 'Te mandamos este link para que elijas una contraseña nueva para tu cuenta de Quiero Mis Fotos.',
        cta: { label: '🔑 Elegir mi contraseña', url: link },
        foot: google ? 'Tu cuenta también puede entrar con <strong>Continuar con Google</strong>.' : 'Si no lo pediste, podés ignorar este mail.',
      }),
    });
  }
  return json({ email: u.email, link, google, sent });
}

// Cambiar el mail de una cuenta (superadmin, vía POST /admin/users/reset {uid, newEmail}): para quien se registró con
// el mail mal escrito. Lo cambia en Firebase Auth (queda confirmado: lo hace el superadmin) y en userPrivate. Si entraba
// con Google, se le quita ese acceso (su Google es el mail viejo) y se devuelve un link para que elija contraseña.
async function changeEmail(env, uid, raw, replace = false) {
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) throw httpError(400, 'Mail inválido');
  const u = (await idt(env, '/accounts:lookup', { localId: [uid] })).users?.[0];
  if (!u) throw httpError(404, 'No existe esa cuenta');
  if ((u.email || '').toLowerCase() === email) throw httpError(409, 'La cuenta ya tiene ese mail');
  const other = (await idt(env, '/accounts:lookup', { email: [email] })).users?.[0];
  if (other) {
    // Otra cuenta ya usa ese mail (suele ser una que se creó de nuevo con el mail bien escrito). Si está vacía
    // (sin álbumes ni compras pagadas) se puede borrar para pasarle el mail a esta; si no, se frena.
    const ou = other.localId;
    const [prof, ord, evs] = await Promise.all([
      adminGet(env, `users/${ou}`).catch(() => null),
      adminQuery(env, 'orders', { filters: [['buyerUid', '==', ou]], limit: 50 }).catch(() => []),
      adminQuery(env, 'events', { filters: [['photographerUids', 'array-contains', ou]], limit: 5 }).catch(() => []),
    ]);
    const info = { name: prof?.displayName || other.displayName || '', role: prof?.role === 'photographer' ? 'fotógrafo' : 'comprador',
      status: prof?.status || '', albums: evs.length, purchases: ord.filter(o => o.status === 'approved').length,
      createdAt: Number(other.createdAt) || 0, lastLoginAt: Number(other.lastLoginAt) || 0 };
    const empty = !info.albums && !info.purchases;
    if (!replace) return json({ conflict: info, canReplace: empty });
    if (!empty) throw httpError(409, `La otra cuenta con ${email} tiene ${info.albums} álbum(es) y ${info.purchases} compra(s): no se borra. Revisala a mano.`);
    await idt(env, '/accounts:delete', { localId: ou });
    await Promise.all(['users', 'userPrivate', 'customers', 'planRequests'].map(c => adminDelete(env, `${c}/${ou}`).catch(() => {})));
    if (prof?.slug) { const s = await adminGet(env, `slugs/${prof.slug}`).catch(() => null); if (s?.uid === ou) await adminDelete(env, `slugs/${prof.slug}`).catch(() => {}); }
  }
  const google = (u.providerUserInfo || []).some(p => p.providerId === 'google.com');
  const hasPw = (u.providerUserInfo || []).some(p => p.providerId === 'password');
  await idt(env, '/accounts:update', { localId: uid, email, emailVerified: true, ...(google ? { deleteProvider: ['google.com'] } : {}) });
  await adminUpdate(env, `userPrivate/${uid}`, { email, emailVerified: true, emailChangedFrom: u.email || '', emailChangedAt: new Date(), ...(google ? { provider: 'password' } : {}) });
  // Sin contraseña propia (entraba con Google): link para que elija una con el mail nuevo.
  const link = google && !hasPw ? (await idt(env, '/accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email, returnOobLink: true })).oobLink : '';
  return json({ email, google, link, changed: true });
}
