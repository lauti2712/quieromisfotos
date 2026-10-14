// Carrito persistido en localStorage. Ítems agrupados por fotógrafo + evento
// (cada pago de Mercado Pago va a un solo vendedor y una orden es de un evento).

const KEY = 'qmf.cart.v1';
const MAX_ITEMS = 300;

function read() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
}
let items = read();

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(items)); } catch { /* modo privado: queda en memoria */ }
  window.dispatchEvent(new CustomEvent('cart:change', { detail: { count: items.length } }));
}

// Sincroniza si el carrito cambia en otra pestaña.
window.addEventListener('storage', e => {
  if (e.key === KEY) { items = read(); window.dispatchEvent(new CustomEvent('cart:change', { detail: { count: items.length } })); }
});

export const cart = {
  items: () => items.slice(),
  count: () => items.length,
  has: photoId => items.some(i => i.photoId === photoId),
  add(p) {
    if (this.has(p.id) || items.length >= MAX_ITEMS) return false;
    items.push({ photoId: p.id, eventId: p.eventId, photographerUid: p.photographerUid, thumbUrl: p.thumbUrl, addedAt: Date.now() });
    save();
    return true;
  },
  remove(photoId) { items = items.filter(i => i.photoId !== photoId); save(); },
  toggle(p) { if (this.has(p.id)) { this.remove(p.id); return false; } return this.add(p); },
  removeGroup(eventId, uid) { items = items.filter(i => !(i.eventId === eventId && i.photographerUid === uid)); save(); },
  clear() { items = []; save(); },
  groups() {
    const map = new Map();
    for (const it of items) {
      const k = `${it.eventId}|${it.photographerUid}`;
      if (!map.has(k)) map.set(k, { key: k, eventId: it.eventId, photographerUid: it.photographerUid, items: [] });
      map.get(k).items.push(it);
    }
    return [...map.values()];
  },
};
