// Encuadre de la portada: arrastrar para mover y deslizar para acercar. Siempre 16:9 (como las tarjetas de eventos).
// cropImage(blob) -> Blob JPEG 1600×900, o null si se cancela.
import { $ } from './util.js';

const OUT_W = 1600, OUT_H = 900;

export async function cropImage(blob, { title = 'Encuadrá la portada' } = {}) {
  // Se achica antes de editar (los originales pueden ser de 6000 px).
  const bmp = await createImageBitmap(blob, { resizeWidth: 2400, resizeQuality: 'high', imageOrientation: 'from-image' })
    .catch(() => createImageBitmap(blob));
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'crop-dlg';
    dlg.innerHTML = `
      <div class="dlg-head"><h2>${title}</h2><button class="btn ghost sm" data-close aria-label="Cerrar">✕</button></div>
      <div class="dlg-body stack">
        <div class="crop-stage"><canvas id="cr-c" width="${OUT_W}" height="${OUT_H}"></canvas></div>
        <label class="field">Acercar<input type="range" id="cr-z" min="1" max="3" step="0.01" value="1"></label>
        <p class="muted small" style="margin:0">Arrastrá la foto para encuadrarla. Así se va a ver en la tarjeta del evento.</p>
      </div>
      <div class="dlg-foot"><button class="btn" data-close>Cancelar</button><button class="btn primary" id="cr-ok">Usar esta portada</button></div>`;
    document.body.appendChild(dlg);
    const c = $('#cr-c', dlg), ctx = c.getContext('2d');
    const base = Math.max(OUT_W / bmp.width, OUT_H / bmp.height); // escala mínima que cubre el marco
    let z = 1, cx = bmp.width / 2, cy = bmp.height / 2; // centro del encuadre en px de la imagen
    const clamp = () => {
      const s = base * z, hw = OUT_W / s / 2, hh = OUT_H / s / 2;
      cx = Math.min(bmp.width - hw, Math.max(hw, cx)); cy = Math.min(bmp.height - hh, Math.max(hh, cy));
    };
    const draw = () => {
      clamp();
      const s = base * z;
      ctx.drawImage(bmp, cx - OUT_W / s / 2, cy - OUT_H / s / 2, OUT_W / s, OUT_H / s, 0, 0, OUT_W, OUT_H);
    };
    draw();
    $('#cr-z', dlg).oninput = e => { z = Number(e.target.value); draw(); };
    // Arrastre con mouse o dedo (en px de pantalla → px de imagen).
    let drag = null;
    c.addEventListener('pointerdown', e => { drag = { x: e.clientX, y: e.clientY, cx, cy }; try { c.setPointerCapture(e.pointerId); } catch { /* nada */ } });
    c.addEventListener('pointermove', e => {
      if (!drag) return;
      const k = (OUT_W / c.getBoundingClientRect().width) / (base * z);
      cx = drag.cx - (e.clientX - drag.x) * k; cy = drag.cy - (e.clientY - drag.y) * k; draw();
    });
    c.addEventListener('pointerup', () => { drag = null; });
    c.addEventListener('wheel', e => { e.preventDefault(); z = Math.min(3, Math.max(1, z * (e.deltaY < 0 ? 1.08 : 1 / 1.08))); $('#cr-z', dlg).value = z; draw(); }, { passive: false });
    // Se resuelve al confirmar o cancelar (también con Esc), una sola vez.
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      if (dlg.open) dlg.close();
      dlg.remove(); bmp.close?.(); resolve(result);
    };
    dlg.querySelectorAll('[data-close]').forEach(b => b.onclick = () => finish(null));
    $('#cr-ok', dlg).onclick = () => c.toBlob(b => finish(b), 'image/jpeg', 0.86);
    dlg.addEventListener('close', () => finish(null));
    dlg.showModal();
  });
}
