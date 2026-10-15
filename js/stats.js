// Estadísticas anónimas para los fotógrafos: visitas a eventos y perfiles, fotos vistas y agregadas al carrito,
// de dónde llega la gente y visitas por día. No se guarda NADA de quién visita (ni usuario, ni IP).
//   stats/{eventId}:  views, days.{YYYY-MM-DD}, src.{origen}, pv.{uidFotógrafo}, ca.{uidFotógrafo}
//   stats/u_{uid}:    views, days, src (perfil del fotógrafo)
// Una escritura por visita (una vez por sesión) + un envío agrupado de fotos vistas / carrito.
import { db, doc, setDoc, increment, serverTimestamp } from './fb.js';
import { todayIso } from './util.js';

function source() {
  const q = new URLSearchParams(location.search);
  const utm = (q.get('utm_source') || '').toLowerCase();
  const ref = document.referrer || '';
  const host = (() => { try { return new URL(ref).hostname; } catch { return ''; } })();
  if (utm) return utm.replace(/[^a-z0-9]/g, '').slice(0, 20) || 'otro';
  if (/whatsapp|wa\.me/.test(host)) return 'whatsapp';
  if (/instagram/.test(host)) return 'instagram';
  if (/facebook|fb\./.test(host)) return 'facebook';
  if (/google\./.test(host)) return 'google';
  if (/quieromisfotos/.test(host)) return q.has('s') ? 'link' : 'sitio';
  if (q.has('s')) return 'link'; // link compartido (WhatsApp y otras apps no mandan de dónde vienen)
  return host ? 'otro' : 'directo';
}

const once = key => {
  try { if (sessionStorage.getItem(key)) return false; sessionStorage.setItem(key, '1'); } catch { /* modo privado */ }
  return true;
};

function hit(id) {
  if (!once(`qmf.st.${id}`)) return;
  setDoc(doc(db, 'stats', id), {
    views: increment(1), days: { [todayIso()]: increment(1) }, src: { [source()]: increment(1) }, updatedAt: serverTimestamp(),
  }, { merge: true }).catch(() => {});
}
export const trackEventView = eventId => hit(eventId);
export const trackProfileView = uid => hit(`u_${uid}`);

// Fotos vistas y agregadas al carrito: se juntan y se mandan en una sola escritura.
let pending = null, timer = null;
function bump(eventId, field, uid) {
  if (!eventId || !uid) return;
  if (pending && pending.eventId !== eventId) flush();
  pending ||= { eventId, pv: {}, ca: {} };
  pending[field][uid] = (pending[field][uid] || 0) + 1;
  clearTimeout(timer);
  timer = setTimeout(flush, 15000);
}
export function flush() {
  clearTimeout(timer);
  const p = pending; pending = null;
  if (!p) return;
  const data = { updatedAt: serverTimestamp() };
  if (Object.keys(p.pv).length) data.pv = Object.fromEntries(Object.entries(p.pv).map(([u, n]) => [u, increment(Math.min(n, 200))]));
  if (Object.keys(p.ca).length) data.ca = Object.fromEntries(Object.entries(p.ca).map(([u, n]) => [u, increment(Math.min(n, 200))]));
  setDoc(doc(db, 'stats', p.eventId), data, { merge: true }).catch(() => {});
}
export const trackPhotoView = (eventId, uid) => bump(eventId, 'pv', uid);
export const trackCartAdd = (eventId, uid) => bump(eventId, 'ca', uid);
window.addEventListener('pagehide', flush);
window.addEventListener('hashchange', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
