// Marca de agua sobre un canvas 2D (sirve para canvas y OffscreenCanvas).
// Siempre lleva el sitio (www.quieromisfotos.com.ar) en mosaico. En el centro va el logo del fotógrafo
// si lo activó y está cargado; si no, el sitio.
// wm: { useLogo: bool, strength: 0.4..1 (intensidad que elige el fotógrafo), logoKey, logoUrl }   logo: ImageBitmap/HTMLImageElement opcional.

export const SITE_MARK = 'www.quieromisfotos.com.ar';
export const DEFAULT_WATERMARK = { useLogo: false, strength: 0.5 };
export const MIN_STRENGTH = 0.4;
// Intensidad guardada (del 40% al 100%). Los perfiles viejos (opacity) arrancan en la de por defecto.
export const strengthOf = wm => Math.min(1, Math.max(MIN_STRENGTH, Number(wm?.strength) || DEFAULT_WATERMARK.strength));

// Compatibilidad con perfiles guardados con el formato anterior ({ type: 'logo' | 'text', ... }).
export const wantsLogo = wm => !!(wm && wm.logoKey && (wm.useLogo || wm.type === 'logo'));

// Aviso de derechos visible: además de desalentar, varios asistentes de IA se niegan a borrar marcas de fotos que lo muestran.
export const RIGHTS_MARK = '© FOTO PROTEGIDA · PROHIBIDO QUITAR LA MARCA DE AGUA';

// rnd: para tests (posición fija); en uso real cada foto sale con ángulo y corrimiento distintos, así la IA no "aprende" un patrón.
export function drawWatermark(ctx, w, h, wm, logo = null, rnd = Math.random) {
  const opts = { ...DEFAULT_WATERMARK, ...wm };
  const k = strengthOf(opts);
  const alpha = 0.12 + 0.36 * k; // 40% → 0,26 · 50% → 0,30 · 100% → 0,48
  const tiled = SITE_MARK.toUpperCase();
  const big = Math.max(w, h), small = Math.min(w, h);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Mosaico diagonal con el sitio, más denso que antes; ángulo entre 20° y 40° y corrimiento al azar en cada foto.
  const size = Math.max(10, Math.round(big * (0.016 + 0.006 * k)));
  ctx.font = `${k >= 0.75 ? 700 : 600} ${size}px system-ui, -apple-system, Arial, sans-serif`;
  ctx.globalAlpha = alpha;
  const stepX = ctx.measureText(tiled).width + size * 3.5;
  const stepY = size * 5.5;
  ctx.translate(w / 2 + (rnd() - 0.5) * stepX, h / 2 + (rnd() - 0.5) * stepY);
  ctx.rotate(-(Math.PI / 9 + rnd() * Math.PI / 9));
  const R = Math.hypot(w, h) / 2 + stepX * 2;
  let row = 0;
  for (let y = -R; y < R; y += stepY, row++) {
    const offset = row % 2 ? stepX / 2 : 0;
    for (let x = -R + offset; x < R; x += stepX) stamp(ctx, tiled, x, y, size);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Sello central (donde suele estar la persona, lo más difícil de reconstruir para una IA), un poco corrido en cada foto:
  // logo del fotógrafo o el sitio, más grande, y debajo el aviso de derechos.
  const cx = w / 2 + (rnd() - 0.5) * w * 0.12, cy = h / 2 + (rnd() - 0.5) * h * 0.12;
  ctx.globalAlpha = Math.min(0.85, alpha * 1.5);
  let below = cy;
  if (wantsLogo(opts) && logo) {
    const side = small * 0.45;
    drawLogo(ctx, logo, cx, cy, side);
    below = cy + side * 0.5 * Math.min(1, logo.height / Math.max(logo.width, logo.height)) + small * 0.05;
  } else {
    let cs = Math.round(small * 0.075);
    ctx.font = `700 ${cs}px system-ui, -apple-system, Arial, sans-serif`;
    const max = w * 0.78;
    const tw = ctx.measureText(SITE_MARK).width;
    if (tw > max) { cs = Math.max(11, Math.floor(cs * max / tw)); ctx.font = `700 ${cs}px system-ui, -apple-system, Arial, sans-serif`; }
    stamp(ctx, SITE_MARK, cx, cy, cs);
    below = cy + cs * 1.2;
  }
  let rs = Math.round(small * 0.03);
  ctx.font = `700 ${rs}px system-ui, -apple-system, Arial, sans-serif`;
  const rw = ctx.measureText(RIGHTS_MARK).width;
  if (rw > w * 0.8) { rs = Math.max(9, Math.floor(rs * w * 0.8 / rw)); ctx.font = `700 ${rs}px system-ui, -apple-system, Arial, sans-serif`; }
  stamp(ctx, RIGHTS_MARK, cx, Math.min(h - rs, below), rs);
  ctx.restore();
}

function stamp(ctx, text, x, y, size) {
  ctx.lineWidth = Math.max(1, size * 0.08);
  ctx.strokeStyle = 'rgba(0,0,0,0.3)';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, x, y);
}

function drawLogo(ctx, logo, cx, cy, maxSide) {
  const lw = logo.width, lh = logo.height;
  const k = maxSide / Math.max(lw, lh);
  ctx.drawImage(logo, cx - (lw * k) / 2, cy - (lh * k) / 2, lw * k, lh * k);
}

// Imagen de ejemplo para la vista previa en el panel.
export function drawSampleScene(ctx, w, h) {
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, '#5aa7e8');
  g.addColorStop(0.55, '#a9d6f5');
  g.addColorStop(0.56, '#3f9b4b');
  g.addColorStop(1, '#2d7a37');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.8)';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.ellipse(w / 2, h * 0.8, w * 0.22, h * 0.09, 0, 0, Math.PI * 2);
  ctx.stroke();
  // jugador estilizado
  ctx.fillStyle = '#d23b2a';
  ctx.fillRect(w * 0.44, h * 0.42, w * 0.08, h * 0.2);
  ctx.fillStyle = '#f1c7a0';
  ctx.beginPath(); ctx.arc(w * 0.48, h * 0.37, h * 0.05, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.arc(w * 0.6, h * 0.7, h * 0.035, 0, Math.PI * 2); ctx.fill();
}
