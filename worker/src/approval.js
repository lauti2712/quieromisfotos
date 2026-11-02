// Aprobación automática de fotógrafos (settings/platform.autoApprove, lo prende o apaga el superadmin en Plataforma).
// Con la aprobación prendida, cada cuenta nueva espera que el superadmin la apruebe a mano; apagada, se aprueba sola.
//   POST /photographers/activate  (Bearer fotógrafo pendiente) -> { status }
// El panel lo llama al terminar el alta y cada vez que entra un pendiente: la primera vez avisa al superadmin del registro.
// Igual que al aprobar a mano: la primera vez se le da la prueba gratis de Profesional.
import { adminGetMany, adminUpdate, adminCommit, serviceToken } from './admin.js';
import { requireUser } from './firebase.js';
import { planOf } from './plans.js';
import { addAlert } from './alerts.js';
import { notifySuper, notifyUser } from './push.js';
import { json, httpError } from './http.js';

export async function activatePhotographer(req, env) {
  const claims = await requireUser(req, env);
  const [user, st] = await adminGetMany(env, [`users/${claims.sub}`, 'settings/platform']);
  if (!user || user.role !== 'photographer' || user.status !== 'pending') return json({ status: user?.status || '' });
  const now = new Date();
  if (!user.signupNotifiedAt) {
    await adminUpdate(env, `users/${claims.sub}`, { signupNotifiedAt: now });
    await notifySuper(env, 'signup', { title: '🆕 Se registró un fotógrafo', body: `${user.displayName || 'Sin nombre'}${user.zone ? ` · ${user.zone}` : ''}`, link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/admin/fotografos` });
  }
  if (!st?.autoApprove) return json({ status: 'pending' });
  const upd = { status: 'approved', statusChangedAt: now, autoApproved: true };
  const trialDays = Number(st.trialDays ?? 30);
  if (trialDays > 0 && !user.trialUsed && planOf(user) === 'free') {
    Object.assign(upd, { plan: 'web', proUntil: new Date(now.getTime() + trialDays * 86400_000), trial: true, trialUsed: true });
  }
  await adminUpdate(env, `users/${claims.sub}`, upd);
  await addAlert(env, { type: 'alta', ref: claims.sub, text: `Se aprobó solo un fotógrafo nuevo: ${user.displayName || ''} (/${user.slug || ''}). Revisalo en Fotógrafos y suspendelo si no corresponde.` }).catch(() => {});
  return json({ status: 'approved', trialDays: upd.trial ? trialDays : 0 });
}

// Confirmación manual de la cuenta (superadmin): para fotógrafos que no pueden abrir el mail de confirmación.
// Marca el correo como verificado en Firebase Auth; al fotógrafo le alcanza con tocar "Ya lo confirmé" o volver a entrar.
//   POST /admin/users/verify {uid}
export async function verifyAccount(req, env) {
  const c = await requireUser(req, env);
  if (c.email !== 'lautarom87@gmail.com' || c.email_verified !== true) throw httpError(403, 'Solo superadmin');
  const { uid } = await req.json().catch(() => ({}));
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid || '')) throw httpError(400, 'Pedido inválido');
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:update`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ localId: uid, emailVerified: true }),
  });
  if (!res.ok) throw httpError(502, `Firebase Auth ${res.status}: ${(await res.text()).slice(0, 160)}`);
  await adminCommit(env, [{ upsert: `userPrivate/${uid}`, data: { emailVerified: true, manualVerifiedAt: new Date() } }]);
  await notifyUser(env, uid, { title: '✅ Tu cuenta está confirmada', body: 'Ya podés publicar tus álbumes y vincular Mercado Pago.', link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/inicio` }).catch(() => {});
  return json({ ok: true });
}
