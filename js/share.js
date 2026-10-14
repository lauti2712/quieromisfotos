// Compartir links (eventos / álbum de un fotógrafo). En celular usa el menú nativo; si no, diálogo con copiar + WhatsApp.
import { esc, toast } from './util.js';

// URL base del sitio público (sirve desde index.html y panel.html).
export function siteBase() {
  return `${location.origin}${location.pathname.replace(/(index|panel)\.html$/, '')}`;
}

// Link a la página indexable del evento (/e/{id}/). Con ?s=1 lleva directo a la galería;
// así WhatsApp muestra la portada del evento y Google indexa la versión sin parámetros.
export function eventUrl(eventId, photographerUid = '') {
  const local = /^(localhost|127\.)/.test(location.hostname);
  if (local) return `${siteBase()}#/evento/${eventId}${photographerUid ? `?f=${encodeURIComponent(photographerUid)}` : ''}`;
  return `${location.origin}/e/${eventId}/?s=1${photographerUid ? `&f=${encodeURIComponent(photographerUid)}` : ''}`;
}

export async function shareLink({ title, text, url }) {
  if (navigator.share && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ title, text, url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const msg = `${text ? `${text} ` : ''}${url}`;
  const dlg = document.createElement('dialog');
  dlg.innerHTML = `
    <div class="dlg-head"><h2>Compartir</h2><button class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
    <div class="dlg-body">
      <p class="muted" style="margin:0">${esc(title)}</p>
      <div class="row" style="flex-wrap:nowrap">
        <input type="text" readonly value="${esc(url)}" id="sh-url" style="flex:1;min-width:0">
        <button class="btn primary" id="sh-copy">Copiar</button>
      </div>
      <div class="row">
        <a class="btn" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">💬 WhatsApp</a>
        <a class="btn" target="_blank" rel="noopener" href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}">Facebook</a>
      </div>
    </div>`;
  document.body.appendChild(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.querySelector('[data-close]').onclick = () => dlg.close();
  dlg.querySelector('#sh-copy').onclick = async () => {
    const inp = dlg.querySelector('#sh-url');
    try { await navigator.clipboard.writeText(url); } catch { inp.select(); document.execCommand?.('copy'); }
    toast('Link copiado');
  };
  dlg.showModal();
  dlg.querySelector('#sh-url').select();
}
