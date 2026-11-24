// Texto: utilidades puras (sin DOM) que comparten el sitio, el panel, el Worker y las páginas SEO (tools/build-seo.py).

// Escapa texto para meterlo en HTML (contenido o atributo). Es la defensa contra XSS: usar siempre al armar HTML con datos.
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
