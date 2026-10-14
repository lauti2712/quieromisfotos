// Marca de agua sobre un canvas 2D (sirve para canvas y OffscreenCanvas).
// Siempre lleva el sitio (www.quieromisfotos.com.ar) en mosaico. En el centro va el logo del fotógrafo
// si lo activó y está cargado; si no, el sitio.
// wm: { useLogo: bool, opacity: 0..1, logoKey, logoUrl }   logo: ImageBitmap/HTMLImageElement opcional.

export const SITE_MARK = 'www.quieromisfotos.com.ar';
export const DEFAULT_WATERMARK = { useLogo: false, opacity: 0.35 };

// Compatibilidad con perfiles guardados con el formato anterior ({ type: 'logo' | 'text', ... }).
export const wantsLogo = wm => !!(wm && wm.logoKey && (wm.useLogo || wm.type === 'logo'));

export function drawWatermark(ctx, w, h, wm, logo = null) {
  const opts = { ...DEFAULT_WATERMARK, ...wm };
  const alpha = Math.min(0.9, Math.max(0.05, Number(opts.opacity) || 0.35));
  const tiled = SITE_MARK.toUpperCase();
  const big = Math.max(w, h);

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';

  // Mosaico diagonal con el sitio
  const size = Math.max(11, Math.round(big * 0.024));
  ctx.font = `700 ${size}px system-ui, -apple-system, Arial, sans-serif`;
  ctx.globalAlpha = alpha * 0.75;
  const stepX = ctx.measureText(tiled).width + size * 3;
  const stepY = size * 5.5;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 6);
  const R = Math.hypot(w, h) / 2 + stepX;
  let row = 0;
  for (let y = -R; y < R; y += stepY, row++) {
    const offset = row % 2 ? stepX / 2 : 0;
    for (let x = -R + offset; x < R; x += stepX) stamp(ctx, tiled, x, y, size);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // Centro: logo del fotógrafo o el sitio
  ctx.globalAlpha = Math.min(0.95, alpha * 1.4);
  if (wantsLogo(opts) && logo) {
    drawLogo(ctx, logo, w / 2, h / 2, Math.min(w, h) * 0.4);
  } else {
    let cs = Math.round(Math.min(w, h) * 0.075);
    ctx.font = `800 ${cs}px system-ui, -apple-system, Arial, sans-serif`;
    const max = w * 0.85;
    const tw = ctx.measureText(SITE_MARK).width;
    if (tw > max) {
      cs = Math.max(11, Math.floor(cs * max / tw));
      ctx.font = `800 ${cs}px system-ui, -apple-system, Arial, sans-serif`;
    }
    stamp(ctx, SITE_MARK, w / 2, h / 2, cs);
  }
  ctx.restore();
}

function stamp(ctx, text, x, y, size) {
  ctx.lineWidth = Math.max(1, size * 0.12);
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
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
