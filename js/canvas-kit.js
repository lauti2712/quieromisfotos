// Herramientas de dibujo en canvas que comparten los generadores de imágenes y videos del panel:
// la tarjeta "Compartí tu álbum" del fotógrafo (panel-share.js) y el generador de Instagram del superadmin (panel-instagram.js).
// Todo corre en el navegador, sin costo de servidor.
import { API_BASE } from './api.js';

export const ORANGE = '#ff5a1f', INK = '#0f1115';
export const FONT = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';

export const slug = s => String(s || 'evento').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'evento';
export const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
export function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
// Las fotos se piden por el Worker (agrega CORS) para poder dibujarlas en el canvas.
export function loadImg(src, cors = true) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('No se pudo cargar una foto'));
    im.src = src;
  });
}
export const viaApi = u => { try { return `${API_BASE}/public/${new URL(u).pathname.replace(/^\//, '')}`; } catch { return u; } };
export const logoImg = () => loadImg('assets/logo.svg', false);

// Corta el texto en líneas que entran en maxW (con la fuente que tenga el ctx).
export function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
// Dibuja la imagen cubriendo el recuadro (recorta lo que sobra). zoom y dx sirven para el zoom lento de los videos.
export function cover(ctx, im, x, y, w, h, zoom = 1, dx = 0) {
  const s = Math.max(w / im.width, h / im.height) * zoom;
  const iw = im.width * s, ih = im.height * s;
  ctx.drawImage(im, x + (w - iw) / 2 + dx, y + (h - ih) / 2, iw, ih);
}

// Error claro si el navegador no puede grabar video desde un canvas (llamar antes de cargar fotos).
export function assertCanRecord() {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('Este navegador no puede armar videos. Probá desde Chrome o Safari actualizados.');
}
// Graba un video del canvas en tiempo real: draw(f) dibuja el cuadro f (0..total-1). MP4 si el navegador puede, si no WebM.
// -> { blob, ext }
export async function recordCanvas(canvas, { total, fps = 30, draw, onProgress }) {
  assertCanRecord();
  const type = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('Este navegador no puede armar videos.');
  draw(0);
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(250);
  await new Promise(resolve => {
    const t0 = performance.now();
    const tick = () => {
      const f = Math.floor(((performance.now() - t0) / 1000) * fps);
      if (f >= total) return resolve();
      draw(f); onProgress?.(f / total);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  stream.getTracks().forEach(t => t.stop());
  return { blob: new Blob(chunks, { type: type.split(';')[0] }), ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
}
