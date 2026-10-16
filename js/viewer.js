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
    <div class="lb-hint">Doble toque o pellizcá para hacer zoom</div>
    <div class="lb-bottom" id="lb-bottom"></div>`;
  document.body.appendChild(lb);
  document.body.style.overflow = 'hidden';

  // Zoom: pellizcar o doble toque (celular), doble clic o rueda (compu). Con zoom, un dedo mueve la foto.
  const img = $('#lb-img', lb);
  let z = 1, tx = 0, ty = 0;
  const apply = () => {
    const w = img.offsetWidth, h = img.offsetHeight; // tamaño sin zoom
    const mx = (w * z - w) / 2, my = (h * z - h) / 2;
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
    img.style.transform = z > 1 ? `translate(${tx}px, ${ty}px) scale(${z})` : '';
    lb.classList.toggle('zoomed', z > 1);
  };
  const zoomTo = (nz, cx, cy) => {
    const r = img.getBoundingClientRect();
    const k = nz / z;
    if (cx != null) { // mantener el punto tocado bajo el dedo
      const ox = cx - (r.left + r.width / 2 - tx), oy = cy - (r.top + r.height / 2 - ty); // respecto del centro sin mover
      tx = (tx - ox) * k + ox; ty = (ty - oy) * k + oy;
    }
    z = Math.max(1, Math.min(5, nz));
    if (z === 1) { tx = 0; ty = 0; }
    apply();
  };
  const resetZoom = () => { z = 1; tx = 0; ty = 0; img.style.transform = ''; lb.classList.remove('zoomed'); };

  const show = () => {
    resetZoom();
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
  // Celular: deslizar (sin zoom), pellizcar, doble toque y arrastrar con zoom.
  const stage = $('.lb-stage', lb);
  let x0 = null, y0 = null, pinch = null, pan = null, lastTap = 0, moved = false;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stage.addEventListener('touchstart', e => {
    moved = false;
    if (e.touches.length === 2) {
      pinch = { d: dist(e.touches), z, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      x0 = null;
    } else if (e.touches.length === 1) {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      if (z > 1) pan = { x: x0, y: y0, tx, ty };
    }
  }, { passive: true });
  stage.addEventListener('touchmove', e => {
    if (pinch && e.touches.length === 2) {
      e.preventDefault(); moved = true;
      zoomTo(pinch.z * (dist(e.touches) / pinch.d), pinch.cx, pinch.cy);
      pinch.z = z; pinch.d = dist(e.touches);
    } else if (pan && e.touches.length === 1) {
      e.preventDefault(); moved = true;
      tx = pan.tx + (e.touches[0].clientX - pan.x); ty = pan.ty + (e.touches[0].clientY - pan.y); apply();
    }
  }, { passive: false });
  stage.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; x0 = null; return; }
    if (pan) { pan = null; if (moved) { x0 = null; return; } }
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (z === 1 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) { go(dx < 0 ? 1 : -1); return; }
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (now - lastTap < 300) { e.preventDefault(); zoomTo(z > 1 ? 1 : 2.5, e.changedTouches[0].clientX, e.changedTouches[0].clientY); lastTap = 0; }
      else lastTap = now;
    }
  });
  img.addEventListener('dblclick', e => zoomTo(z > 1 ? 1 : 2.5, e.clientX, e.clientY));
  stage.addEventListener('wheel', e => { e.preventDefault(); zoomTo(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  let drag = null;
  img.addEventListener('mousedown', e => { if (z > 1) { e.preventDefault(); drag = { x: e.clientX, y: e.clientY, tx, ty }; } });
  window.addEventListener('mousemove', e => { if (drag) { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; apply(); } });
  window.addEventListener('mouseup', () => { drag = null; });
  stage.addEventListener('click', e => { if (e.target === stage) close(); });
  $('#lb-img', lb).addEventListener('contextmenu', e => e.preventDefault());
  show();
  return { close };
}
