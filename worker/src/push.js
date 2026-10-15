// Notificaciones push (Firebase Cloud Messaging) a los dispositivos que el usuario activó (userPrivate/{uid}.fcmTokens).
import { adminGet, adminUpdate, accessToken } from './admin.js';

export async function notifyUser(env, uid, { title, body, link }) {
  if (env.FIREBASE_EMULATOR) return;
  const priv = await adminGet(env, `userPrivate/${uid}`);
  const tokens = priv?.fcmTokens || [];
  if (!tokens.length) return;
  const at = await accessToken(env);
  const dead = [];
  await Promise.all(tokens.map(async token => {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: {
        token,
        notification: { title, body },
        webpush: { fcm_options: { link }, notification: { icon: 'https://quieromisfotos.com.ar/assets/icon-192.png' } },
      } }),
    });
    if (!res.ok) {
      const t = await res.text();
      if (res.status === 404 || /UNREGISTERED|registration-token-not-registered/i.test(t)) dead.push(token);
      else console.error('fcm', res.status, t.slice(0, 200));
    }
  }));
  // Dispositivos que ya no existen (desinstalado, permiso quitado).
  if (dead.length) await adminUpdate(env, `userPrivate/${uid}`, { fcmTokens: tokens.filter(t => !dead.includes(t)) });
}
