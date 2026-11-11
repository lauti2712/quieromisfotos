// Visor de fotos a pantalla completa (galería de evento y portfolio).
// openViewer({ count, index, src(i), thumb(i)?, total(i), footer(i, el, redrawFooter), onIndex(i), onProtect(i)? })
// onProtect: al intentar guardar la foto (clic derecho o mantenerla apretada) en vez del menú del navegador.
// thumb: miniatura que se muestra al instante mientras baja la foto grande.
// El botón "atrás" del celular cierra el visor (no se va del evento).
// reveal: fotos protegidas. Arriba va la miniatura (muy desenfocada) y abajo la foto ampliada (algo más clara).
//   Lupa: en la compu, donde está el mouse se abre un círculo que deja ver la ampliada; en el celular, tocando la foto
//   aparece el círculo ahí (se arrastra con el dedo; tocándolo de nuevo se cierra). Sin zoom, y en el celular la foto
//   ocupa el 75% del ancho (no de borde a borde). size(i) -> {w, h}: proporción de la foto, para que las dos ocupen lo mismo desde el principio.
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

export function openViewer({ index, src, thumb, count, total = count, footer, onIndex, onProtect, reveal = false, size }) {
  let i = index;
  const lb = document.createElement('div');
  lb.className = onProtect ? 'lightbox lb-protect' : 'lightbox'; // lb-protect: fotos en venta (sitio público)
  lb.setAttribute('role', 'dialog');
  lb.innerHTML = `
    <div class="lb-top"><span class="small" id="lb-count"></span>${reveal ? '<span class="lb-tip small" id="lb-tip"></span>' : ''}<span class="spacer"></span><button class="btn sm" id="lb-close" aria-label="Cerrar">✕</button></div>
    <div class="lb-stage"><button class="lb-nav lb-prev" aria-label="Anterior">‹</button><img id="lb-img" alt="">${reveal ? '<img class="lb-veil" id="lb-veil" alt="" aria-hidden="true">' : ''}<button class="lb-nav lb-next" aria-label="Siguiente">›</button></div>
    ${hintOnce() ? `<div class="lb-hint">${reveal ? 'Deslizá para ver otra' : 'Deslizá para ver otra · doble toque para zoom'}</div>` : ''}
    <div class="lb-bottom" id="lb-bottom"></div>`;
  document.body.appendChild(lb);
  document.body.style.overflow = 'hidden';

  // Zoom: pellizcar o doble toque (celular), doble clic o rueda (compu). Con zoom, un dedo mueve la foto.
  const img = $('#lb-img', lb), veil = $('#lb-veil', lb);
  let z = 1, tx = 0, ty = 0;
  // La miniatura de arriba acompaña a la foto en el zoom y al deslizar.
  const setTf = t => { img.style.transform = t; if (veil) veil.style.transform = t; };
  const setTr = t => { img.style.transition = t; if (veil) veil.style.transition = t ? `${t}, opacity .6s ease` : ''; };
  const apply = () => {
    const w = img.offsetWidth, h = img.offsetHeight; // tamaño sin zoom
    const mx = (w * z - w) / 2, my = (h * z - h) / 2;
    tx = Math.max(-mx, Math.min(mx, tx)); ty = Math.max(-my, Math.min(my, ty));
    setTf(z > 1 ? `translate(${tx}px, ${ty}px) scale(${z})` : '');
    lb.classList.toggle('zoomed', z > 1);
    if (veil) setReveal(z > 1); // con zoom se ve la ampliada entera; sin zoom, la protegida con lupa
  };
  const zoomTo = (nz, cx, cy) => {
    if (veil) return; // fotos protegidas: sin zoom (lo único más claro es el círculo de la lupa)
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
  const resetZoom = () => { z = 1; tx = 0; ty = 0; setTf(''); img.style.opacity = ''; setTr(''); lb.classList.remove('zoomed'); };

  // ---- fotos protegidas: tamaño fijo para las dos capas, lupa con mouse o dedo, y la ampliada entera con zoom
  const hover = matchMedia('(hover: hover) and (pointer: fine)').matches;
  let revealed = false, lensOn = false, lx = 0, ly = 0;
  const drawTip = () => {
    const tip = $('#lb-tip', lb);
    if (!tip) return;
    tip.textContent = revealed ? '' : hover ? (lensOn ? '' : 'Pasá el mouse por la foto para ver más clara esa parte')
      : (lensOn ? 'Arrastrá el círculo · tocalo para cerrarlo' : 'Tocá la foto para ver más clara esa parte');
  };
  const lensR = () => Math.max(55, Math.min(veil.offsetWidth, veil.offsetHeight) * (hover ? 0.2 : 0.26));
  const setLens = (cx, cy) => {
    if (!veil || revealed) return;
    const r = veil.getBoundingClientRect();
    lx = Math.max(0, Math.min(r.width, cx - r.left)); ly = Math.max(0, Math.min(r.height, cy - r.top));
    veil.style.setProperty('--lx', `${lx}px`); veil.style.setProperty('--ly', `${ly}px`); veil.style.setProperty('--lr', `${lensR()}px`);
    if (!lensOn) { lensOn = true; drawTip(); }
  };
  const lensOff = () => {
    if (!veil) return;
    veil.style.setProperty('--lr', '0px');
    if (lensOn) { lensOn = false; drawTip(); }
  };
  const inLens = (cx, cy) => { if (!lensOn) return false; const r = veil.getBoundingClientRect(); return Math.hypot(cx - r.left - lx, cy - r.top - ly) <= lensR(); };
  const setReveal = on => {
    if (!veil || revealed === on) return;
    revealed = on;
    if (on) lensOff();
    lb.classList.toggle('revealed', on);
    drawTip();
  };
  let ratio = 0;
  const fit = () => {
    if (!veil) return;
    const cs = getComputedStyle(stage);
    let W = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    let H = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (matchMedia('(min-width: 761px)').matches) { W = Math.min(W, 800); H = Math.min(H, 800); }
    else W *= 0.75; // celular: más chica que la pantalla
    const r = ratio || (img.naturalWidth && img.naturalWidth / img.naturalHeight) || (veil.naturalWidth && veil.naturalWidth / veil.naturalHeight) || 1.5;
    const w = Math.max(1, Math.min(W, H * r)), h = w / r;
    img.style.width = veil.style.width = `${w}px`;
    img.style.height = veil.style.height = `${h}px`;
    veil.style.left = `${img.offsetLeft}px`; veil.style.top = `${img.offsetTop}px`;
  };

  // Redibuja solo la barra de abajo (favorita, carrito) sin volver a cargar la foto.
  const drawFooter = () => {
    const bottom = $('#lb-bottom', lb);
    bottom.innerHTML = '';
    footer?.(i, bottom, drawFooter);
  };
  const show = () => {
    resetZoom();
    const k = i, full = src(k), small = thumb?.(k);
    if (veil) {
      // Protegida: abajo la ampliada, arriba la miniatura (estado inicial), las dos del mismo tamaño.
      const d = size?.(k);
      ratio = d?.w > 0 && d?.h > 0 ? d.w / d.h : 0;
      revealed = true; setReveal(false); lensOff();
      veil.src = small || full;
      img.src = full;
      drawFooter();
      fit();
      if (!ratio) { img.onload = () => { if (i === k) fit(); }; veil.onload = () => { if (i === k && !img.naturalWidth) fit(); }; }
      $('#lb-count', lb).textContent = `${i + 1} / ${total()}`;
      if (i + 1 < count()) { new Image().src = src(i + 1); if (thumb) new Image().src = thumb(i + 1); }
      if (i > 0) new Image().src = src(i - 1);
      onIndex?.(i);
      return;
    }
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
    window.removeEventListener('resize', onResize);
    ro?.disconnect();
    clearTimeout(tapT);
    document.body.style.overflow = '';
    lb.remove();
  };
  const onKey = e => {
    // Sitio público: con el visor abierto, Ctrl/Cmd+S (guardar) y Ctrl/Cmd+P (imprimir) muestran el aviso de derechos.
    if (onProtect && (e.ctrlKey || e.metaKey) && ['s', 'p'].includes(e.key.toLowerCase())) { e.preventDefault(); onProtect(i); return; }
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
  let x0 = null, y0 = null, pinch = null, pan = null, lastTap = 0, moved = false, tapT = 0, lensDrag = false;
  const dist = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  stage.addEventListener('touchstart', e => {
    moved = false;
    if (e.touches.length === 2) {
      pinch = { d: dist(e.touches), z, cx: (e.touches[0].clientX + e.touches[1].clientX) / 2, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 };
      x0 = null;
    } else if (e.touches.length === 1) {
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY;
      if (z > 1) pan = { x: x0, y: y0, tx, ty };
      else lensDrag = inLens(x0, y0); // el dedo empieza sobre la lupa: se arrastra la lupa (no cambia de foto)
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
    } else if (lensDrag && e.touches.length === 1) {
      e.preventDefault();
      if (Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 6) moved = true;
      setLens(e.touches[0].clientX, e.touches[0].clientY);
    } else if (z === 1 && x0 != null && e.touches.length === 1) {
      // Sin zoom: la foto acompaña el dedo al deslizar.
      const dx = e.touches[0].clientX - x0, dy = e.touches[0].clientY - y0;
      if (Math.abs(dx) > Math.abs(dy)) {
        e.preventDefault();
        setTr('none');
        setTf(`translateX(${dx}px)`);
        img.style.opacity = String(Math.max(0.4, 1 - Math.abs(dx) / 600));
      }
    }
  }, { passive: false });
  stage.addEventListener('touchend', e => {
    if (pinch) { if (e.touches.length < 2) pinch = null; x0 = null; return; }
    if (pan) { pan = null; if (moved) { x0 = null; return; } }
    if (x0 == null) return;
    if (lensDrag) { lensDrag = false; if (moved) { x0 = null; return; } }
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    const settle = () => { setTr(''); setTf(''); img.style.opacity = ''; };
    if (z === 1 && Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      const j = i + (dx < 0 ? 1 : -1);
      settle();
      if (j >= 0 && j < count()) go(dx < 0 ? 1 : -1);
      return;
    }
    if (z === 1) settle();
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) {
      const now = Date.now();
      if (!veil && now - lastTap < 300) { clearTimeout(tapT); e.preventDefault(); zoomTo(z > 1 ? 1 : 2.5, e.changedTouches[0].clientX, e.changedTouches[0].clientY); lastTap = 0; }
      else {
        lastTap = now;
        // Un toque solo (no doble) sobre la foto protegida: abre la lupa ahí, la mueve, o la cierra si se toca adentro.
        const t = e.changedTouches[0], cx = t.clientX, cy = t.clientY;
        if (veil && onImg(t)) { if (inLens(cx, cy)) lensOff(); else setLens(cx, cy); }
      }
    }
  });
  // La foto no recibe el puntero (CSS pointer-events: none): clic derecho / "guardar" no la toman. Los gestos se
  // escuchan en el escenario y se fija si el puntero está sobre la foto.
  const onImg = e => { const r = img.getBoundingClientRect(); return e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom; };
  stage.addEventListener('dblclick', e => { if (onImg(e)) zoomTo(z > 1 ? 1 : 2.5, e.clientX, e.clientY); });
  stage.addEventListener('wheel', e => { e.preventDefault(); zoomTo(z * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  let drag = null;
  stage.addEventListener('mousedown', e => { if (z > 1 && onImg(e)) { e.preventDefault(); drag = { x: e.clientX, y: e.clientY, tx, ty }; } });
  window.addEventListener('mousemove', e => { if (drag) { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; apply(); } });
  window.addEventListener('mouseup', () => { drag = null; });
  stage.addEventListener('click', e => { if (e.target === stage && !onImg(e)) close(); });
  stage.addEventListener('dragstart', e => e.preventDefault());
  if (veil && hover) {
    stage.addEventListener('mousemove', e => { if (z === 1) { if (onImg(e)) setLens(e.clientX, e.clientY); else lensOff(); } });
    stage.addEventListener('mouseleave', lensOff);
  }
  // Si cambia el lugar disponible (rotar el celular, la barra de abajo se redibuja), se reubican las dos capas.
  const ro = veil && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(stage);
  const onResize = () => fit();
  if (veil && !ro) window.addEventListener('resize', onResize);
  img.draggable = false;
  // Algo cambió afuera (ej. se agregó al carrito desde el aviso de derechos): se redibuja el pie.
  const redraw = () => { if (document.body.contains(lb)) drawFooter(); };
  window.addEventListener('qmf-viewer-redraw', redraw);
  stage.addEventListener('contextmenu', e => { if (!onProtect || !onImg(e)) return; e.preventDefault(); onProtect(i); });
  // Mantener apretada (celular): en vez de "Guardar imagen", el aviso de derechos con la opción de comprarla.
  let press = null, pressAt = { x: 0, y: 0 };
  stage.addEventListener('touchstart', e => {
    clearTimeout(press);
    if (e.touches.length !== 1 || z > 1 || !onProtect || !onImg(e.touches[0])) return;
    const t0 = e.touches[0];
    press = setTimeout(() => { press = null; onProtect(i); }, 600);
    pressAt = { x: t0.clientX, y: t0.clientY };
  }, { passive: true });
  stage.addEventListener('touchmove', e => { if (press && Math.hypot(e.touches[0].clientX - pressAt.x, e.touches[0].clientY - pressAt.y) > 10) { clearTimeout(press); press = null; } }, { passive: true });
  stage.addEventListener('touchend', () => { clearTimeout(press); press = null; });
  show();
  return { close };
}
