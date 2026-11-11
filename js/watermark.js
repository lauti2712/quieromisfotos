// Marca de agua sobre un canvas 2D (sirve para canvas y OffscreenCanvas).
// Pensada para que la copia robada no sirva y cueste borrarla (también con IA), sin arruinar la foto para vender:
//  - mosaico diagonal con el sitio, distinto en cada foto (ángulo, corrimiento y tamaño por fila, según una semilla);
//  - 3 a 5 sellos chicos y bien visibles (logo de Quiero Mis Fotos + nombre o logo del fotógrafo) alrededor del centro,
//    sin tapar la zona principal, en lugares que cambian en cada foto;
//  - trazos finos irregulares cruzando la foto (rompen el "rellenado" de las IA);
//  - código corto de la foto repetido (si aparece en redes, se sabe de qué álbum salió) y aviso de derechos.
// wm: { useLogo: bool, strength: 0.5..1 (intensidad que elige el fotógrafo), logoKey, logoUrl, name (del fotógrafo) }   logo: ImageBitmap/HTMLImageElement opcional.
// seed: id de la foto (cada foto sale distinta). Sin semilla (vista previa del panel) se dibuja siempre igual.

export const SITE_MARK = 'www.quieromisfotos.com.ar';
// mesh y subjectSeal: malla fina + sello sobre la persona (contra la IA que "redibuja" la foto). Encendidos para los álbumes.
export const DEFAULT_WATERMARK = { useLogo: false, strength: 0.6, mesh: true, subjectSeal: true };
export const MIN_STRENGTH = 0.5;
// Intensidad guardada (del 50% al 100%). Los perfiles viejos (opacity, o intensidades de 40-45%) suben al mínimo nuevo.
export const strengthOf = wm => Math.min(1, Math.max(MIN_STRENGTH, Number(wm?.strength) || DEFAULT_WATERMARK.strength));

// Compatibilidad con perfiles guardados con el formato anterior ({ type: 'logo' | 'text', ... }).
export const wantsLogo = wm => !!(wm && wm.logoKey && (wm.useLogo || wm.type === 'logo'));

// Aviso de derechos visible: además de desalentar, algunos asistentes de IA se niegan a borrar marcas de fotos que lo muestran.
export const RIGHTS_MARK = '© FOTO PROTEGIDA · PROHIBIDO QUITAR LA MARCA DE AGUA';

// Código corto de la foto (últimos 6 caracteres del id), para rastrear una copia.
export const photoCode = seed => String(seed || '').replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase();

// PRNG con semilla (mulberry32 sobre un hash del texto): misma semilla, misma marca.
function seeded(seed) {
  let h = 1779033703;
  for (const ch of String(seed)) { h = Math.imul(h ^ ch.charCodeAt(0), 3432918353); h = (h << 13) | (h >>> 19); }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function drawWatermark(ctx, w, h, wm, logo = null, seed = null) {
  const opts = { ...DEFAULT_WATERMARK, ...wm };
  const k = strengthOf(opts);
  const rnd = seeded(seed ?? 'qmf-preview');
  const alpha = 0.18 + 0.32 * k; // 50% → 0,34 · 100% → 0,50
  const tiled = SITE_MARK.toUpperCase();
  const big = Math.max(w, h), small = Math.min(w, h);
  const font = (wt, px) => `${wt} ${px}px system-ui, -apple-system, Arial, sans-serif`;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // 2) Trazos finos irregulares (curvas de grosor variable) cruzando toda la foto.
  const lines = 6 + Math.floor(rnd() * 4);
  for (let n = 0; n < lines; n++) {
    const fromLeft = rnd() < 0.5;
    const p0 = fromLeft ? [-w * 0.05, rnd() * h] : [rnd() * w, -h * 0.05];
    const p3 = fromLeft ? [w * 1.05, rnd() * h] : [rnd() * w, h * 1.05];
    const c1 = [rnd() * w, rnd() * h], c2 = [rnd() * w, rnd() * h];
    const segs = 24;
    let prev = p0;
    ctx.strokeStyle = n % 2 ? 'rgba(0,0,0,1)' : 'rgba(255,255,255,1)';
    ctx.globalAlpha = 0.08 + rnd() * 0.04 + 0.02 * (k - 0.5);
    const w0 = Math.max(1, big * (0.0012 + rnd() * 0.0025));
    for (let sgi = 1; sgi <= segs; sgi++) {
      const t = sgi / segs, u = 1 - t;
      const pt = [0, 1].map(j => u * u * u * p0[j] + 3 * u * u * t * c1[j] + 3 * u * t * t * c2[j] + t * t * t * p3[j]);
      ctx.lineWidth = w0 * (0.5 + Math.sin(t * Math.PI * (1 + n % 3)) ** 2 * 1.2);
      ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(pt[0], pt[1]); ctx.stroke();
      prev = pt;
    }
  }

  // 2b) (opcional, opts.mesh) Malla fina sobre toda la foto: líneas diagonales cruzadas, finas y juntas. Le quita detalle
  //     a todo (también a la cara y la camiseta) y así una IA que "redibuja" la foto tiene que inventar en vez de copiar.
  if (opts.mesh) {
    const gap = Math.max(6, Math.round(small * 0.016));
    const lw = Math.max(1, small * 0.0016);
    const R2 = Math.hypot(w, h);
    ctx.save();
    ctx.translate(w / 2, h / 2);
    for (const [ang, col] of [[-(Math.PI / 5 + rnd() * 0.15), 'rgba(255,255,255,1)'], [Math.PI / 5 + rnd() * 0.15, 'rgba(0,0,0,1)']]) {
      ctx.save();
      ctx.rotate(ang);
      ctx.strokeStyle = col;
      ctx.globalAlpha = 0.1 + 0.08 * k;
      ctx.lineWidth = lw;
      ctx.beginPath();
      const off = rnd() * gap;
      for (let x = -R2 + off; x < R2; x += gap) { ctx.moveTo(x, -R2); ctx.lineTo(x, R2); }
      ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
  }

  // 3) Mosaico diagonal con el sitio: ángulo entre 20° y 40°, corrimiento al azar y tamaño que varía por fila.
  const size = Math.max(10, Math.round(big * (0.016 + 0.006 * k)));
  ctx.font = font(k >= 0.75 ? 700 : 600, size);
  ctx.globalAlpha = alpha;
  const stepX = ctx.measureText(tiled).width + size * 4;
  const stepY = size * 6.5;
  ctx.translate(w / 2 + (rnd() - 0.5) * stepX, h / 2 + (rnd() - 0.5) * stepY);
  ctx.rotate(-(Math.PI / 9 + rnd() * Math.PI / 9));
  const R = Math.hypot(w, h) / 2 + stepX * 2;
  let row = 0;
  for (let y = -R; y < R; y += stepY, row++) {
    const rs = Math.max(9, Math.round(size * (0.88 + rnd() * 0.24)));
    ctx.font = font(k >= 0.75 ? 700 : 600, rs);
    const offset = (row % 2 ? stepX / 2 : 0) + (rnd() - 0.5) * size * 2;
    for (let x = -R + offset; x < R; x += stepX) stamp(ctx, tiled, x, y, rs);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  // 4) Sellos chicos y bien visibles: logo de Quiero Mis Fotos + nombre (o logo) del fotógrafo, de 3 a 5, alrededor del
  //    centro (la zona principal queda libre) y en lugares que cambian en cada foto.
  const H = Math.max(18, Math.round(small * 0.07));
  const name = String(opts.name || '').trim().slice(0, 40);
  const useLogo = wantsLogo(opts) && logo;
  const t1 = 'quieromisfotos.com.ar', t2 = name ? `Foto: ${name}` : '';
  const f1 = Math.round(H * 0.36), f2 = Math.round(H * 0.32);
  ctx.font = font(700, f1); const w1 = ctx.measureText(t1).width;
  ctx.font = font(600, f2); const w2 = t2 ? ctx.measureText(t2).width : 0;
  const lw = useLogo ? Math.min(H * 3, (logo.width / logo.height) * H) : 0;
  const sealW = H + H * 0.25 + (useLogo ? lw : Math.max(w1, w2));
  const n = 3 + Math.floor(rnd() * 3);
  // Zonas alrededor del centro (arriba/abajo/costados y esquinas, sin el medio): se eligen n distintas al azar y el
  // sello cae en un punto al azar dentro de cada una, así quedan repartidos y no se amontonan.
  const zones = [[0, 0], [1, 0], [2, 0], [0, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
  for (let j = zones.length - 1; j > 0; j--) { const r = Math.floor(rnd() * (j + 1)); [zones[j], zones[r]] = [zones[r], zones[j]]; }
  // Siempre uno centrado a lo ancho (arriba o abajo): si recortan la foto para una historia de Instagram, que se queda
  // con la franja del medio, la marca sigue estando. Su par opuesto queda del otro lado.
  const mid = zones.findIndex(z => z[0] === 1);
  zones.unshift(zones.splice(mid, 1)[0]);
  // De a pares opuestos (arriba-izquierda con abajo-derecha, etc.): así cubren toda la foto.
  const pick = [];
  for (const z of zones) {
    if (pick.length >= n) break;
    if (pick.some(q => q[0] === z[0] && q[1] === z[1])) continue;
    pick.push(z);
    const op = [2 - z[0], 2 - z[1]];
    if (pick.length < n && !pick.some(q => q[0] === op[0] && q[1] === op[1])) pick.push(op);
  }
  const posOf = ([zx, zy]) => {
    const cw = w / 3, ch = h / 3;
    // Centrados a lo ancho: cerca del borde de arriba o de abajo (para no tapar la cara).
    if (zx === 1) return { x: (w - sealW) / 2, y: zy === 0 ? h * (0.05 + rnd() * 0.08) : h * (0.8 + rnd() * 0.06) - H };
    const x = Math.min(w - sealW - w * 0.03, Math.max(w * 0.03, zx * cw + rnd() * Math.max(1, cw - sealW)));
    const y = Math.min(h - H - h * 0.06, Math.max(h * 0.05, zy * ch + rnd() * Math.max(1, ch - H)));
    return { x, y };
  };
  // Se ubican primero los elegidos y, si alguno se pisa con otro (fotos angostas/verticales), se prueba con las zonas
  // que quedan, hasta tener n sin superponerse. El centro de la foto siempre queda libre.
  const placed = [];
  for (const z of [...pick, ...zones.filter(z => !pick.some(q => q[0] === z[0] && q[1] === z[1]))]) {
    if (placed.length >= n) break;
    const q = posOf(z);
    // Ningún sello puede tocar la zona central (lo principal de la foto).
    if (q.x < w * 0.7 && q.x + sealW > w * 0.3 && q.y < h * 0.72 && q.y + H > h * 0.28) continue;
    if (placed.some(o => Math.abs(o.x - q.x) < sealW * 1.08 && Math.abs(o.y - q.y) < H * 1.7)) continue;
    placed.push(q);
  }
  ctx.globalAlpha = Math.min(0.92, 0.55 + 0.35 * k); // 50% → 0,73 · 100% → 0,90
  for (const q of placed) {
    drawQmfIcon(ctx, q.x, q.y, H);
    const tx0 = q.x + H * 1.25;
    if (useLogo) {
      ctx.drawImage(logo, tx0, q.y + (H - lw * (logo.height / logo.width)) / 2, lw, lw * (logo.height / logo.width));
    } else {
      ctx.textAlign = 'left';
      ctx.font = font(700, f1); stamp(ctx, t1, tx0, q.y + (t2 ? H * 0.3 : H / 2), f1);
      if (t2) { ctx.font = font(600, f2); stamp(ctx, t2, tx0, q.y + H * 0.74, f2); }
      ctx.textAlign = 'center';
    }
  }
  // Aviso de derechos, chico, abajo.
  let rsz = Math.max(9, Math.round(small * 0.022));
  ctx.font = font(700, rsz);
  const rw = ctx.measureText(RIGHTS_MARK).width;
  if (rw > w * 0.9) { rsz = Math.max(8, Math.floor(rsz * w * 0.9 / rw)); ctx.font = font(700, rsz); }
  ctx.globalAlpha = Math.min(0.8, alpha * 1.5);
  stamp(ctx, RIGHTS_MARK, w / 2, h - rsz * 1.4, rsz);

  // 4b) (opcional, opts.subjectSeal) Un sello más sobre la persona (a la altura del pecho, no de la cara), semitransparente:
  //     lo más valioso de la foto siempre queda marcado.
  if (opts.subjectSeal) {
    const sH = Math.round(H * 1.15);
    const sx = (w - sH * 4.6) / 2 + (rnd() - 0.5) * w * 0.06, sy = h * (0.56 + rnd() * 0.06);
    ctx.globalAlpha = Math.min(0.6, 0.35 + 0.25 * k);
    drawQmfIcon(ctx, sx, sy, sH);
    ctx.textAlign = 'left';
    const sf = Math.round(sH * 0.42);
    ctx.font = font(800, sf);
    stamp(ctx, 'quieromisfotos.com.ar', sx + sH * 1.2, sy + sH / 2, sf);
    ctx.textAlign = 'center';
  }

  // 5) Código de la foto, chico, 3 veces en lugares que cambian según la foto.
  const code = photoCode(seed);
  if (code) {
    const csz = Math.max(9, Math.round(small * 0.018));
    ctx.font = font(700, csz);
    ctx.globalAlpha = Math.min(0.7, alpha * 1.4);
    for (let n = 0; n < 3; n++) {
      const x = w * (0.1 + 0.8 * rnd()), y = h * (0.08 + 0.84 * ((n + rnd()) / 3));
      stamp(ctx, `#${code}`, x, y, csz);
    }
  }
  ctx.restore();
}

const QMF_FRAME = 'M12 22V12h10M42 12h10v10M52 42v10H42M22 52H12V42';
const QMF_HEART = 'M32 44C21 37 17 31.5 17 26.5 17 22.4 20.2 19 24.3 19c3.2 0 6 1.9 7.7 4.7 1.7-2.8 4.5-4.7 7.7-4.7 4.1 0 7.3 3.4 7.3 7.5C47 31.5 43 37 32 44Z';
function drawQmfIcon(ctx, x, y, size) {
  const s = size / 64;
  ctx.save();
  ctx.translate(x, y); ctx.scale(s, s);
  ctx.fillStyle = '#ff5a1f';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(0, 0, 64, 64, 16); else ctx.rect(0, 0, 64, 64);
  ctx.fill();
  if (typeof Path2D !== 'undefined') {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.stroke(new Path2D(QMF_FRAME));
    ctx.fillStyle = '#fff'; ctx.fill(new Path2D(QMF_HEART));
  }
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
