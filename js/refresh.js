// Mantiene actualizados los navegadores abiertos:
// - cada 5 min (y al volver a la pestaña) compara version.json con la versión cargada; si hay una nueva,
//   recarga en el próximo cambio de pantalla o al volver a la pestaña (no interrumpe lo que está haciendo);
// - el superadmin puede forzar la recarga de todos (settings/app.reloadAt) desde Plataforma.
import { db, doc, onSnapshot } from './fb.js';
import { toast } from './util.js';

const current = document.querySelector('meta[name="app-version"]')?.content || '';
let latest = '';
let pending = false;

export function initRefresh({ busy = () => false } = {}) {
  const reload = () => {
    if (busy()) return;
    // ?v= evita que el CDN devuelva el HTML viejo cacheado.
    const u = new URL(location.href);
    u.searchParams.set('v', latest || Date.now().toString(36));
    location.replace(u.toString());
  };
  const check = async () => {
    try {
      const r = await fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' });
      const { v } = await r.json();
      if (current && v && v !== current) { latest = v; pending = true; }
    } catch { /* sin conexión */ }
  };
  setInterval(check, 5 * 60 * 1000);
  setTimeout(check, 20 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (pending) reload(); else check();
  });
  window.addEventListener('hashchange', () => { if (pending) reload(); });

  // Recarga forzada: se ignora la primera lectura (estado al abrir) y se reacciona solo a cambios posteriores.
  let first = true;
  onSnapshot(doc(db, 'settings', 'app'), s => {
    if (first) { first = false; return; }
    if (!s.data()?.reloadAt) return;
    if (busy()) { toast('Hay una versión nueva. Recargá la página cuando termine la subida.'); return; }
    toast('Actualizando a la versión nueva…');
    setTimeout(reload, 2500);
  }, () => {});
}
