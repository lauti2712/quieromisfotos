// Visor de fotos a pantalla completa (galería de evento y portfolio).
// openViewer({ count, index, src(i), thumb(i)?, total(i), footer(i, el, redrawFooter), onIndex(i), onProtect(i)? })
// onProtect: al intentar guardar la foto (clic derecho o mantenerla apretada) en vez del menú del navegador.
// thumb: miniatura que se muestra al instante mientras baja la foto grande.
// El botón "atrás" del celular cierra el visor (no se va del evento).
import { $ } from './util.js';

// La ayuda de gestos se muestra las primeras 3 veces.
function hintOnce() {
  try {
    const n = Number(localStorage.getItem('qmf-lb-hint') || 0);
    if (n >= 3) return false;
    localStorage.setItem('qmf-lb-hint', String(n + 1));
  } catch { /* nada */ }
  return true;
}

export function openViewer({ index, src, thumb, count, total = count, footer, onIndex, onProtect }) {
  let i = index;
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.setAttribute('role', 'dialog');
  lb.innerHTML = `
    <div class="lb-top"><span class="small" id="lb-count"></span><span class="spacer"></span><button class="btn sm" id="lb-close" aria-label="Cerrar">✕</button></div>
    <div class="lb-stage"><button class="lb-nav lb-prev" aria-label="Anterior">‹</button><img id="lb-img" alt=""><button class="lb-nav lb-next" aria-label="Siguiente">›</button></div>
    ${hintOnce() ? '<div class="lb-hint">Deslizá para ver otra · doble toque para zoom</div>' : ''}
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
  const resetZoom = () => { z = 1; tx = 0; ty = 0; img.style.transform = ''; img.style.opacity = ''; img.style.transition = ''; lb.classList.remove('zoomed'); };

  // Redibuja solo la barra de abajo (favorita, carrito) sin volver a cargar la foto.
  const drawFooter = () => {
    const bottom = $('#lb-bottom', lb);
    bottom.innerHTML = '';
    footer?.(i, bottom, drawFooter);
  };
  const show = () => {
    resetZoom();
    const k = i, full = src(k), small = thumb?.(k);
    img.classList.toggle('lb-low', !!small);
    img.src = small || full;
    if (small) {
      const big = new Image();
      big.src = full;
      (big.decode ? big.decode() : Promise.resolve()).catch(() => {}).then(() => { if (i === k) { img.src = full; img.classList.remove('lb-low'); } });
    }
    $('#lb-count', lb).textContent = `${i + 1} / ${total()}`;
    drawFooter();
    // Precarga la siguiente y la anterior.
    if (i + 1 < count()) new Image().src = src(i + 1);
    if (i > 0) new Image().src = src(i - 1);
    onIndex?.(i);
  };
  const go = d => {
    const j = i + d;
    if (j < 0 || j >= count()) return;
    i = j; show();
  };
  // Atrás del celular: se agrega un paso al historial; volver cierra el visor.
  history.pushState({ qmfViewer: 1 }, '');
  let closed = false;
  const close = (fromHistory = false) => {
    if (closed) return;
    if (fromHistory !== true && history.state?.qmfViewer) { history.back(); return; } // el popstate termina de cerrar
    closed = true;
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('hashchange', onHash);
    document.body.style.overflow = '';
    lb.remove();
  };
  const onKey = e => {
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
  };
  const onPop = () => close(true);
  const onHash = () => close(true); // se fue a otra página (ej. Ver carrito)
  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', onPop);
  window.addEventListener('hashchange', onHash);
  $('#lb-close', lb).onclick = () => close();
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
    } else if (z === 1 && x0 != null && e.touches.length === 1) {
      // Sin zoom: la foto acompaña el dedo al deslizar.
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        img.style.transition = 'none';
        img.style.transform = `translateX(${dx}px)`;
        img.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 600));
      }
    }
  }, { passive: false });
  stage.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; x0 = null; return; }
    if (pan) { pan = null; if (moved) { x0 = null; return; } }
    if (x0 == null) return;
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    const settle = () => { img.style.transition = ''; img.style.transform = ''; img.style.opacity = ''; };
    if (z === 1 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      const j = i + (dx < 0 ? 1 : -1);
      settle();
      if (j >= 0 && j < count()) go(dx < 0 ? 1 : -1);
      return;
    }
    if (z === 1) settle();
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
  img.draggable = false;
  // Algo cambió afuera (ej. se agregó al carrito desde el aviso de derechos): se redibuja el pie.
  const redraw = () => { if (document.body.contains(lb)) drawFooter(); };
  window.addEventListener('qmf-viewer-redraw', redraw);
  img.addEventListener('contextmenu', e => { e.preventDefault(); onProtect?.(i); });
  // Mantener apretada (celular): en vez de "Guardar imagen", el aviso de derechos con la opción de comprarla.
  let press = null;
  img.addEventListener('touchstart', e => {
    clearTimeout(press);
    if (e.touches.length !== 1 || z > 1 || !onProtect) return;
    const t0 = e.touches[0];
    press = setTimeout(() => { press = null; onProtect(i); }, 600);
    press.x = t0.clientX; press.y = t0.clientY;
  }, { passive: true });
  img.addEventListener('touchmove', e => { if (press && Math.hypot(e.touches[0].clientX - press.x, e.touches[0].clientY - press.y) > 10) { clearTimeout(press); press = null; } }, { passive: true });
  img.addEventListener('touchend', () => { clearTimeout(press); press = null; });
  show();
  return { close };
}
