// Notificaciones push (Firebase Cloud Messaging) a los dispositivos que el usuario activó (userPrivate/{uid}.fcmTokens).
import { adminGet, adminUpdate, accessToken, adminQuery, adminDelete, adminGetMany, adminSet } from './admin.js';

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

// ---------------------------------------------------------------- avisos a seguidores
// Cuando un álbum ya tiene fotos se encola un aviso para quienes siguen el evento o al fotógrafo (pushQueue/{eid}_{uid}).
// La cola se manda de a poco (cron cada 5 min) porque el plan gratis de Workers limita los pedidos por ejecución.

const SEND_PER_RUN = 30;

export async function notifyFollowersOnce(env, eid, uid) {
  const [ev, ph] = await adminGetMany(env, [`events/${eid}`, `users/${uid}`]);
  if (!ev || ev.status !== 'published') return false; // en borrador: se reintenta en el escaneo diario
  await adminUpdate(env, `events/${eid}/sets/${uid}`, { followersNotifiedAt: new Date() });
  const [a, b] = await Promise.all([
    adminQuery(env, 'follows', { filters: [['events', 'array-contains', eid]], limit: 5000 }),
    adminQuery(env, 'follows', { filters: [['photographers', 'array-contains', uid]], limit: 5000 }),
  ]);
  const uids = [...new Set([...a, ...b].map(f => f.id))].filter(x => x !== uid);
  if (!uids.length) return true;
  const site = env.SITE_URL || 'https://quieromisfotos.com.ar/';
  await adminSet(env, `pushQueue/${eid}_${uid}`, {
    title: `📸 Ya están las fotos de ${ev.name || 'tu evento'}`,
    body: `${ph?.displayName || 'El fotógrafo'} subió las fotos. Buscate y descargalas.`,
    link: `${site}#/evento/${eid}?f=${uid}`, uids, createdAt: new Date(),
  }, { mustNotExist: true }).catch(() => {}); // ya encolado
  return true;
}

// Devuelve cuántos avisos mandó (el cron usa el resto de los pedidos de la ejecución para las suscripciones).
export async function drainPushQueue(env) {
  if (env.FIREBASE_EMULATOR) return 0;
  const [job] = await adminQuery(env, 'pushQueue', { limit: 1 });
  if (!job) return 0;
  const batch = job.uids.slice(0, 25), rest = job.uids.slice(25);
  const privs = await adminGetMany(env, batch.map(u => `userPrivate/${u}`));
  const tokens = privs.flatMap(p => p?.fcmTokens || []).slice(0, SEND_PER_RUN);
  const at = await accessToken(env);
  for (const token of tokens) {
    await fetch(`https://fcm.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, notification: { title: job.title, body: job.body },
        webpush: { fcm_options: { link: job.link }, notification: { icon: 'https://quieromisfotos.com.ar/assets/icon-192.png' } } } }),
    }).catch(() => {});
  }
  if (rest.length) await adminUpdate(env, `pushQueue/${job.id}`, { uids: rest });
  else await adminDelete(env, `pushQueue/${job.id}`);
  return tokens.length;
}
