// Procesamiento de imágenes en el navegador: muestra (1600px) y miniatura (400px) con marca de agua (wm = null: sin marca).
// Funciona en un Web Worker (OffscreenCanvas) o en el hilo principal.
import { drawWatermark } from './watermark.js';

export const PREVIEW_SIDE = 1600;
export const THUMB_SIDE = 400;

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

function scaled(src, sw, sh, maxSide) {
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, w, h);
  return c;
}

export async function processFile(file, wm, logo = null) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const width = bmp.width, height = bmp.height;
  try {
    // Base sin marca a 1600px; de ahí sale la miniatura (mejor calidad que escalar directo desde el original).
    const base = scaled(bmp, width, height, PREVIEW_SIDE);
    const thumbC = scaled(base, base.width, base.height, THUMB_SIDE);
    if (wm) {
      drawWatermark(base.getContext('2d'), base.width, base.height, wm, logo);
      drawWatermark(thumbC.getContext('2d'), thumbC.width, thumbC.height, wm, logo);
    }
    const [preview, thumb] = await Promise.all([toBlob(base, 0.8), toBlob(thumbC, 0.7)]);
    const takenAt = await exifDate(file).catch(() => null);
    return { preview, thumb, width, height, takenAt: takenAt || file.lastModified || Date.now() };
  } finally {
    bmp.close?.();
  }
}

// Lee DateTimeOriginal (0x9003) del EXIF de un JPEG. Devuelve epoch ms o null.
export async function exifDate(file) {
  if (!/jpe?g$/i.test(file.type) && !/\.jpe?g$/i.test(file.name || '')) return null;
  const buf = await file.slice(0, 256 * 1024).arrayBuffer();
  const v = new DataView(buf);
  if (v.getUint16(0) !== 0xFFD8) return null;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) return parseTiff(v, off + 10);
    if ((marker & 0xFF00) !== 0xFF00) return null;
    off += 2 + len;
  }
  return null;
}

function parseTiff(v, t) {
  const le = v.getUint16(t) === 0x4949;
  const u16 = o => v.getUint16(t + o, le);
  const u32 = o => v.getUint32(t + o, le);
  const readIfd = (ifdOff, want) => {
    const n = u16(ifdOff);
    for (let i = 0; i < n; i++) {
      const e = ifdOff + 2 + i * 12;
      if (u16(e) === want) return e;
    }
    return null;
  };
  const ifd0 = u32(4);
  const exifPtr = readIfd(ifd0, 0x8769);
  let entry = exifPtr != null ? readIfd(u32(exifPtr + 8), 0x9003) : null;
  if (entry == null) entry = readIfd(ifd0, 0x0132); // DateTime como alternativa
  if (entry == null) return null;
  const count = u32(entry + 4);
  const strOff = count > 4 ? u32(entry + 8) : entry + 8;
  let s = '';
  for (let i = 0; i < Math.min(count, 19); i++) s += String.fromCharCode(v.getUint8(t + strOff + i));
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d) ? null : d.getTime();
}

// Redimensiona una imagen suelta (avatar, portada) a JPEG.
export async function resizeToJpeg(file, maxSide, quality = 0.85) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    return await toBlob(scaled(bmp, bmp.width, bmp.height, maxSide), quality);
  } finally {
    bmp.close?.();
  }
}
