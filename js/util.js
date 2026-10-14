// Utilidades compartidas entre el sitio público y el panel.

export const $ = (sel, el = document) => el.querySelector(sel);
export const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normalize(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function slugify(s) {
  return normalize(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

// Tokens para búsqueda por nombre: palabras completas (>=2) y prefijos (>=3).
export function searchTokens(...texts) {
  const out = new Set();
  for (const w of normalize(texts.join(' ')).split(/[^a-z0-9]+/)) {
    if (w.length < 2) continue;
    out.add(w);
    for (let i = 3; i < w.length; i++) out.add(w.slice(0, i));
  }
  return [...out].slice(0, 150);
}

export function queryWords(q) {
  return normalize(q).split(/[^a-z0-9]+/).filter(w => w.length >= 2);
}

const moneyFmt = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 });
export const fmtMoney = n => moneyFmt.format(Math.round(Number(n) || 0));

// Tamaño legible (GB decimales, como factura Cloudflare).
export function fmtBytes(n) {
  n = Number(n) || 0;
  const [v, u] = n >= 1e9 ? [n / 1e9, 'GB'] : n >= 1e6 ? [n / 1e6, 'MB'] : [n / 1e3, 'KB'];
  return `${v.toLocaleString('es-AR', { maximumFractionDigits: v >= 100 ? 0 : v >= 10 ? 1 : 2 })} ${u}`;
}
// Bytes que ocupa el álbum de un fotógrafo en R2 (originales + muestras y miniaturas).
export const setBytes = set => (set?.bytesOriginal || 0) + (set?.bytesPublic || 0);

export function fmtDate(iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('es-AR', opts);
}

export function fmtTs(ts) {
  const d = ts?.toDate ? ts.toDate() : ts instanceof Date ? ts : null;
  return d ? d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

export function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

export function avatarHtml(user, cls = '') {
  const img = user?.avatarUrl ? `<img src="${esc(user.avatarUrl)}" alt="" referrerpolicy="no-referrer">` : esc(initials(user?.displayName));
  return `<span class="avatar ${cls}">${img}</span>`;
}

export function coverHtml(ev, badge = '') {
  const inner = ev.coverUrl
    ? `<img src="${esc(ev.coverUrl)}" alt="" loading="lazy">`
    : `<span class="initial">${esc(initials(ev.name))}</span>`;
  return `<div class="cover">${inner}${badge ? `<span class="badge">${badge}</span>` : ''}</div>`;
}

// Hash routing: "#/evento/abc?t=1" -> { parts: ['evento','abc'], query }
export function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs || '') };
}

export function toast(msg, type = '') {
  let box = document.getElementById('toasts');
  if (!box) { box = document.createElement('div'); box.id = 'toasts'; document.body.appendChild(box); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.remove(), type === 'error' ? 6000 : 3000);
}

export function errMsg(e) {
  const code = e?.code || '';
  const map = {
    'permission-denied': 'No tenés permiso para esta acción.',
    'auth/invalid-credential': 'Email o contraseña incorrectos.',
    'auth/wrong-password': 'Email o contraseña incorrectos.',
    'auth/user-not-found': 'No existe una cuenta con ese email.',
    'auth/email-already-in-use': 'Ya existe una cuenta con ese email. Ingresá en vez de registrarte.',
    'auth/weak-password': 'La contraseña tiene que tener al menos 6 caracteres.',
    'auth/invalid-email': 'El email no es válido.',
    'auth/popup-closed-by-user': 'Se cerró la ventana de Google.',
    'auth/too-many-requests': 'Demasiados intentos. Probá en unos minutos.',
    'auth/configuration-not-found': 'El inicio de sesión todavía no está habilitado en Firebase.',
    'auth/operation-not-allowed': 'Ese método de inicio de sesión no está habilitado.',
    'auth/unauthorized-domain': 'Este dominio no está autorizado en Firebase Auth.',
    unavailable: 'Sin conexión. Probá de nuevo.',
  };
  return map[code] || e?.message || String(e);
}

export function debounce(fn, ms = 300) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const SOCIALS = [
  { key: 'instagram', label: 'Instagram', url: v => `https://instagram.com/${v.replace(/^@/, '')}` },
  { key: 'facebook', label: 'Facebook', url: v => (v.startsWith('http') ? v : `https://facebook.com/${v}`) },
  { key: 'whatsapp', label: 'WhatsApp', url: v => `https://wa.me/${waNumber(v)}` },
  { key: 'web', label: 'Web', url: v => (v.startsWith('http') ? v : `https://${v}`) },
];

export function newId() {
  return Math.random().toString(36).slice(2, 10);
}

// Normaliza un número argentino al formato de wa.me (549 + área + número).
export function waNumber(v) {
  let d = String(v || '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0')) d = d.slice(1);               // 0341… -> 341…
  if (d.length === 12 && !d.startsWith('54')) {        // área + 15 + número -> sin el 15
    const k = [2, 3, 4].find(n => d.slice(n, n + 2) === '15');
    if (k) d = d.slice(0, k) + d.slice(k + 2);
  }
  if (d.length === 10) d = `549${d}`;                  // área + número
  else if (d.startsWith('54') && !d.startsWith('549') && d.length === 12) d = `549${d.slice(2)}`;
  return d;
}

export function waLink(number, text) {
  return `https://wa.me/${waNumber(number)}${text ? `?text=${encodeURIComponent(text)}` : ''}`;
}
