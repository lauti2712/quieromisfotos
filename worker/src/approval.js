// Aprobación automática de fotógrafos (settings/platform.autoApprove, lo prende o apaga el superadmin en Plataforma).
// Con la aprobación prendida, cada cuenta nueva espera que el superadmin la apruebe a mano; apagada, se aprueba sola.
//   POST /photographers/activate  (Bearer fotógrafo pendiente) -> { status }
// El panel lo llama al terminar el alta y cada vez que entra un pendiente: la primera vez avisa al superadmin del registro.
// Igual que al aprobar a mano: la primera vez se le da la prueba gratis de Profesional.
import { adminGetMany, adminUpdate } from './admin.js';
import { requireUser } from './firebase.js';
import { planOf } from './plans.js';
import { addAlert } from './alerts.js';
import { notifySuper } from './push.js';
import { json } from './http.js';

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
