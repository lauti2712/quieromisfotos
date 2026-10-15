// Avisos de venta en el dispositivo del fotógrafo (Firebase Cloud Messaging).
// El token se guarda en userPrivate/{uid}.fcmTokens (no público). En iPhone solo funciona con la web instalada en la pantalla de inicio.
import { app, db, doc, setDoc, arrayUnion, arrayRemove } from './fb.js';
import { getMessaging, getToken, deleteToken, onMessage, isSupported } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-messaging.js';
import { toast } from './util.js';

const KEY = 'qmf.push.token';
const swUrl = () => new URL('firebase-messaging-sw.js', location.href).toString();

export async function pushAvailable() {
  return 'Notification' in window && 'serviceWorker' in navigator && await isSupported().catch(() => false);
}
export const pushOn = () => typeof Notification !== 'undefined' && Notification.permission === 'granted' && !!localStorage.getItem(KEY);
export const pushBlocked = () => typeof Notification !== 'undefined' && Notification.permission === 'denied';
export const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

export async function enablePush(uid) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('No diste permiso para las notificaciones');
  const reg = await navigator.serviceWorker.register(swUrl());
  const token = await getToken(getMessaging(app), { serviceWorkerRegistration: reg });
  await setDoc(doc(db, 'userPrivate', uid), { fcmTokens: arrayUnion(token) }, { merge: true });
  try { localStorage.setItem(KEY, token); } catch { /* modo privado */ }
  listenForeground();
}

export async function disablePush(uid) {
  const token = localStorage.getItem(KEY);
  try { await deleteToken(getMessaging(app)); } catch { /* ya no existía */ }
  if (token) await setDoc(doc(db, 'userPrivate', uid), { fcmTokens: arrayRemove(token) }, { merge: true });
  localStorage.removeItem(KEY);
}

// Con el panel abierto el navegador no muestra la notificación: se avisa con un toast.
let listening = false;
export function listenForeground() {
  if (listening || !pushOn()) return;
  listening = true;
  isSupported().then(ok => ok && onMessage(getMessaging(app), m => toast(`${m.notification?.title || ''} ${m.notification?.body || ''}`))).catch(() => {});
}
