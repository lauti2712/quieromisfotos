// Avisos para el público: seguir un evento (aviso cuando suban las fotos) o a un fotógrafo (cada vez que sube).
// Se guardan en follows/{uid} { events: [], photographers: [] }; las notificaciones llegan por push (push.js).
import { db, doc, getDoc, setDoc, arrayUnion, arrayRemove, serverTimestamp } from './fb.js';
import { currentUser, requireLogin } from './account.js';
import { pushAvailable, pushOn, enablePush, isIos, isStandalone } from './push.js';
import { toast, errMsg } from './util.js';

let cache = null; // { uid, events:Set, photographers:Set }

export async function myFollows() {
  const u = currentUser();
  if (!u) return { events: new Set(), photographers: new Set() };
  if (cache?.uid === u.uid) return cache;
  const s = await getDoc(doc(db, 'follows', u.uid)).catch(() => null);
  const d = s?.data() || {};
  cache = { uid: u.uid, events: new Set(d.events || []), photographers: new Set(d.photographers || []) };
  return cache;
}

// type: 'events' | 'photographers'. Devuelve el nuevo estado (true = siguiendo).
export async function toggleFollow(type, id, label) {
  const u = await requireLogin(type === 'events' ? 'Ingresá para que te avisemos cuando suban las fotos.' : 'Ingresá para seguir a este fotógrafo.');
  const f = await myFollows();
  const on = !f[type].has(id);
  try {
    await setDoc(doc(db, 'follows', u.uid), { [type]: on ? arrayUnion(id) : arrayRemove(id), updatedAt: serverTimestamp() }, { merge: true });
    on ? f[type].add(id) : f[type].delete(id);
  } catch (e) { toast(errMsg(e), 'error'); return !on; }
  if (!on) { toast('Listo, ya no te avisamos.'); return false; }
  // Las notificaciones necesitan permiso en este dispositivo.
  if (!pushOn() && await pushAvailable()) {
    try { await enablePush(u.uid); } catch { toast('Guardado. Para recibir el aviso en el celular, permití las notificaciones.'); return true; }
  } else if (!pushOn() && isIos() && !isStandalone()) {
    toast('Guardado ✅ En iPhone, para recibir el aviso agregá el sitio a tu pantalla de inicio (Compartir → Agregar a inicio). También lo ves en Mi cuenta.');
    return true;
  }
  toast(type === 'events' ? `🔔 Te avisamos cuando estén las fotos${label ? ` de ${label}` : ''}` : `🔔 Ahora seguís a ${label || 'este fotógrafo'}`);
  return true;
}

export function resetFollowsCache() { cache = null; }
window.addEventListener('account:change', () => { cache = null; });
