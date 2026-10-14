// Visor de fotos a pantalla completa (galería de evento y portfolio).
// openViewer({ count, index, src(i), total(i), footer(i, lb, rerender), onIndex(i) })
import { $ } from './util.js';

export function openViewer({ index, src, count, total = count, footer, onIndex }) {
  let i = index;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.innerHTML = `
    <div class="lb-top"><span class="small" id="lb-count"></span><span class="spacer"></span><button class="btn sm" id="lb-close" aria-label="Cerrar">✕</button></div>
    <div class="lb-stage"><button class="lb-nav lb-prev" aria-label="Anterior">‹</button><img id="lb-img" alt=""><button class="lb-nav lb-next" aria-label="Siguiente">›</button></div>
    <div class="lb-bottom" id="lb-bottom"></div>`;
  document.body.appendChild(lb);
  document.body.style.overflow = 'hidden';

  const show = () => {
    $('#lb-img', lb).src = src(i);
    $('#lb-count', lb).textContent = `${i + 1} / ${total()}`;
    const bottom = $('#lb-bottom', lb);
    bottom.innerHTML = '';
    footer?.(i, bottom, show);
    if (i + 1 < count()) new Image().src = src(i + 1); // precarga
    onIndex?.(i);
  };
  const go = d => {
    const j = i + d;
    if (j < 0 || j >= count()) return;
    i = j; show();
  };
  const close = () => {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', close);
    document.body.style.overflow = '';
    lb.remove();
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  document.addEventListener('keydown', onKey);
  window.addEventListener('hashchange', close);
  $('#lb-close', lb).onclick = close;
  $('.lb-prev', lb).onclick = () => go(-1);
  $('.lb-next', lb).onclick = () => go(1);
  // deslizar en celular
  let x0 = null;
  const stage = $('.lb-stage', lb);
  stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  stage.addEventListener('touchend', e => {
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0;
    if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
    x0 = null;
  });
  stage.addEventListener('click', e => { if (e.target === stage) close(); });
  $('#lb-img', lb).addEventListener('contextmenu', e => e.preventDefault());
  show();
  return { close };
}
