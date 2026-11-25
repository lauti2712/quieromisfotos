// Texto: utilidades puras (sin DOM) que comparten el sitio, el panel, el Worker y las páginas SEO (tools/build-seo.py).

// Escapa texto para meterlo en HTML (contenido o atributo). Es la defensa contra XSS: usar siempre al armar HTML con datos.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Usuario de Instagram limpio (sin @, sin link, en minúsculas). '' si no parece un usuario válido.
// Acepta "@Club_Talleres", "instagram.com/club_talleres/", "https://www.instagram.com/club_talleres?igsh=…".
export function igHandle(s) {
  const h = String(s ?? '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^instagram\.com\//i, '')
    .replace(/[/?#].*$/, '').replace(/^@+/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : '';
}
