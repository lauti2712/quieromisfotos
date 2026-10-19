// Estadísticas anónimas para los fotógrafos: visitas a eventos y perfiles, fotos vistas y agregadas al carrito,
// de dónde llega la gente y visitas por día. No se guarda NADA de quién visita (ni usuario, ni IP).
//   stats/{eventId}:  views, days.{YYYY-MM-DD}, src.{origen}, pv.{uidFotógrafo}, ca.{uidFotógrafo}
//   stats/u_{uid}:    views, days, src (perfil del fotógrafo)
// Las escribe el Worker (POST /stats): valida el evento, cuenta una visita por persona cada 6 horas y pone topes,
// así nadie las puede inflar. Una llamada por visita (una vez por sesión) + un envío agrupado de fotos vistas / carrito.
import { API_BASE } from './api.js';

function send(body) {
  // text/plain: pedido simple (sin preflight) y keepalive para que salga aunque se cierre la página.
  fetch(`${API_BASE}/stats`, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) }).catch(() => {});
}

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

function hit(kind, id) {
  if (!once(`qmf.st.${kind}.${id}`)) return;
  send({ kind, id, view: true, src: source() });
}
export const trackEventView = eventId => hit('event', eventId);
export const trackProfileView = uid => hit('profile', uid);

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
  const cap = o => Object.fromEntries(Object.entries(o).map(([u, n]) => [u, Math.min(n, 200)]));
  if (Object.keys(p.pv).length || Object.keys(p.ca).length) send({ kind: 'event', id: p.eventId, pv: cap(p.pv), ca: cap(p.ca) });
}
export const trackPhotoView = (eventId, uid) => bump(eventId, 'pv', uid);
export const trackCartAdd = (eventId, uid) => bump(eventId, 'ca', uid);
window.addEventListener('pagehide', flush);
window.addEventListener('hashchange', flush);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
