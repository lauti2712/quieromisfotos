// Tema claro / oscuro a elección del usuario (se guarda en este dispositivo). Sin elección: sigue al sistema.
// El <head> de cada página aplica la elección guardada antes de pintar (evita el parpadeo).
const KEY = 'qmf-theme';
const mq = matchMedia('(prefers-color-scheme: dark)');

export const getTheme = () => { try { return localStorage.getItem(KEY) || 'auto'; } catch { return 'auto'; } };
const effective = () => { const t = getTheme(); return t === 'auto' ? (mq.matches ? 'dark' : 'light') : t; };

export function setTheme(t) {
  try { t === 'auto' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, t); } catch { /* sin almacenamiento */ }
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  sync();
}

function sync() {
  const dark = effective() === 'dark';
  document.querySelectorAll('[data-theme-btn]').forEach(b => {
    b.textContent = dark ? '☀️' : '🌙';
    b.title = dark ? 'Pasar a modo claro' : 'Pasar a modo oscuro';
    b.setAttribute('aria-label', b.title);
  });
  document.querySelectorAll('[data-theme-opt]').forEach(a => a.classList.toggle('on', a.dataset.themeOpt === getTheme()));
}

export function initTheme() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-theme-btn]');
    if (b) { setTheme(effective() === 'dark' ? 'light' : 'dark'); return; }
    const o = e.target.closest('[data-theme-opt]');
    if (o) { e.preventDefault(); setTheme(o.dataset.themeOpt); }
  });
  mq.addEventListener?.('change', sync);
  sync();
}
