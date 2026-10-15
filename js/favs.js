// Favoritas: fotos marcadas con ♥ en este dispositivo (localStorage), para decidir después qué comprar.
const KEY = 'qmf.favs.v1';
const MAX = 500;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
let items = read();
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* modo privado */ }
  window.dispatchEvent(new CustomEvent('favs:change'));
}
window.addEventListener('storage', e => { if (e.key === KEY) { items = read(); window.dispatchEvent(new CustomEvent('favs:change')); } });

export const favs = {
  has: id => items.some(i => i.id === id),
  forEvent: eventId => items.filter(i => i.eventId === eventId),
  toggle(p) {
    if (this.has(p.id)) { items = items.filter(i => i.id !== p.id); save(); return false; }
    items.push({
      id: p.id, eventId: p.eventId, photographerUid: p.photographerUid, thumbUrl: p.thumbUrl, previewUrl: p.previewUrl,
      takenAt: p.takenAt?.toMillis?.() || p.takenAt || 0,
    });
    if (items.length > MAX) items.shift();
    save();
    return true;
  },
};
