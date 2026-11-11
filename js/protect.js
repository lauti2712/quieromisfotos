// Versiones protegidas de las fotos de los álbumes (lo único público antes de comprar):
//  - miniatura (_t2): chica (240 px) y nítida, con marca de agua, para la cuadrícula y el estado inicial del visor;
//  - muestra (_p2): más grande, desenfocada en menor medida y bien comprimida (lo "más claro" que se puede ver).
// El desenfoque se aplica a los píxeles (no es un filtro CSS) y la marca de agua va encima, nítida.
// Los parámetros salen de settings/platform.protect (los cambia el superadmin) y se completan con estos.
import { drawWatermark } from './watermark.js';

export const PROTECT_VERSION = 2;
export const PROTECT_DEFAULTS = {
  thumbSide: 240,     // px del lado más largo
  thumbBlur: 0,       // desenfoque de la miniatura (sigma en px; 0 = nítida: es chica y la protege su tamaño)
  thumbQuality: 0.6,  // JPEG 0..1
  previewSide: 720,
  previewBlur: 1.6,   // sigma en px sobre la muestra ("marcado": se reconoce la escena, no los detalles)
  previewQuality: 0.55,
};
const LIMITS = {
  thumbSide: [160, 400], thumbBlur: [0, 12], thumbQuality: [0.3, 0.9],
  previewSide: [480, 1200], previewBlur: [0, 12], previewQuality: [0.3, 0.9],
};
// Nivel de protección que elige el fotógrafo para cada álbum (antes de subir): escala el desenfoque de los ajustes.
export const PROTECT_LEVELS = [
  { id: 'high', label: 'Marcada (recomendada)', hint: 'Se reconoce la escena y la persona, no los detalles. La que más protege.', k: 1 },
  { id: 'mid', label: 'Media', hint: 'Se reconoce mejor a cada persona; protege un poco menos.', k: 0.75 },
  { id: 'low', label: 'Suave', hint: 'Casi nítida a la vista, con la marca de agua. Para quien prefiere que se vea más.', k: 0.5 },
];
export const levelOf = set => PROTECT_LEVELS.find(l => l.id === set?.protectLevel) || PROTECT_LEVELS[0];

// Configuración efectiva (valores fuera de rango vuelven al límite). level: nivel del álbum (escala el desenfoque).
export function protectOf(settings, level = null) {
  const src = { ...PROTECT_DEFAULTS, ...(settings?.protect || {}) };
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const v = Number(src[k]);
    out[k] = Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : PROTECT_DEFAULTS[k];
  }
  const k = PROTECT_LEVELS.find(l => l.id === level)?.k ?? 1;
  out.thumbBlur *= k; out.previewBlur *= k;
  return out;
}

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function toBlob(c, quality) {
  if (c.convertToBlob) return c.convertToBlob({ type: 'image/jpeg', quality });
  return new Promise(res => c.toBlob(res, 'image/jpeg', quality));
}
// Escala en pasos de a la mitad (mejor calidad que un solo salto grande).
function scaled(src, sw, sh, maxSide) {
  let cur = src, cw = sw, ch = sh;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const tw = Math.max(1, Math.round(sw * k)), th = Math.max(1, Math.round(sh * k));
  while (cw / 2 > tw) {
    const nw = Math.round(cw / 2), nh = Math.round(ch / 2);
    const c = canvas(nw, nh), x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, nw, nh);
    cur = c; cw = nw; ch = nh;
  }
  const c = canvas(tw, th), x = c.getContext('2d');
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(cur, 0, 0, tw, th);
  return c;
}

// Desenfoque gaussiano aproximado con 3 pasadas de caja (horizontal y vertical), sobre los píxeles.
// No depende de ctx.filter (Safari viejo no lo tiene).
function boxSizes(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}
function boxPass(src, dst, w, h, r, horizontal) {
  const iarr = 1 / (r + r + 1);
  const lines = horizontal ? h : w, len = horizontal ? w : h;
  const step = horizontal ? 4 : w * 4;
  for (let l = 0; l < lines; l++) {
    const start = horizontal ? l * w * 4 : l * 4;
    for (let ch = 0; ch < 3; ch++) {
      const at = k => src[start + (k < 0 ? 0 : k >= len ? len - 1 : k) * step + ch];
      // Ventana [j-r, j+r] con los bordes repetidos.
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += at(k);
      dst[start + ch] = acc * iarr;
      for (let j = 1; j < len; j++) {
        acc += at(j + r) - at(j - r - 1);
        dst[start + j * step + ch] = acc * iarr;
      }
    }
    for (let j = 0; j < len; j++) dst[start + j * step + 3] = src[start + j * step + 3];
  }
}
export function blurCanvas(c, sigma) {
  if (!(sigma > 0.3)) return c;
  const ctx = c.getContext('2d');
  const w = c.width, h = c.height;
  const img = ctx.getImageData(0, 0, w, h);
  let a = img.data, b = new Uint8ClampedArray(a.length);
  for (const size of boxSizes(sigma)) {
    const r = (size - 1) / 2;
    if (r < 1) continue;
    boxPass(a, b, w, h, r, true);
    boxPass(b, a, w, h, r, false);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// src: imagen/canvas/bitmap sin marca (o una muestra vieja, en la migración). Devuelve { preview, thumb } en JPEG.
export async function makeProtected(src, sw, sh, wm, logo, seed, cfg = PROTECT_DEFAULTS) {
  const p = scaled(src, sw, sh, cfg.previewSide);
  // La miniatura sale de la foto sin desenfocar (con su propio desenfoque, si se configura).
  const t = scaled(p, p.width, p.height, cfg.thumbSide);
  blurCanvas(p, cfg.previewBlur);
  blurCanvas(t, cfg.thumbBlur);
  if (wm) {
    drawWatermark(p.getContext('2d'), p.width, p.height, wm, logo, seed);
    drawWatermark(t.getContext('2d'), t.width, t.height, wm, logo, seed);
  }
  const [preview, thumb] = await Promise.all([toBlob(p, cfg.previewQuality), toBlob(t, cfg.thumbQuality)]);
  return { preview, thumb };
}
