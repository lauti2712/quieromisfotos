// Acceso sin SMS: cuando a un comprador no le llega el código, nos escribe y el superadmin le genera un link de acceso
// para su celular. Al abrirlo entra a su cuenta (la misma que tendría con el SMS: usuario de Firebase con ese teléfono).
//   POST /admin/login-link   Bearer (superadmin)  {phone, name?}  -> { url, created }
//   POST /auth/link          público  {t}                           -> { token } (custom token de Firebase, un solo uso)
// El link vale 48 h y se puede usar una sola vez (loginLinks/{jti}).
import { requireUser } from './firebase.js';
import { serviceToken, adminSet } from './admin.js';
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
  const { uid, send } = await req.json().catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid || '')) throw httpError(400, 'Pedido inválido');
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
