// Tarjeta "Compartí tu álbum" del panel: link + WhatsApp con texto sugerido, video para historias, QR y cartel para imprimir.
// El video y las imágenes se generan en el dispositivo del fotógrafo (canvas), sin costo de servidor.
import { db, collection, getDocs, query, where, orderBy, limit } from './fb.js';
import { $, esc, toast, fmtMoney, fmtDate } from './util.js';
import { eventUrl } from './share.js';
import { API_BASE } from './api.js';

const ORANGE = '#ff5a1f', INK = '#0f1115';

export function mountShareCard(el, { ev, set, uid, displayName, multi = false, highlight = false }) {
  const url = eventUrl(ev.id, multi ? uid : '');
  const packs = (set?.packs || []).filter(p => p.qty > 1 && p.price > 0 && p.price < p.qty * (set?.price || 0)).sort((a, b) => a.qty - b.qty);
  const price = set?.price ? ` · ${fmtMoney(set.price)} la foto${packs[0] ? `, ${packs[0].qty} por ${fmtMoney(packs[0].price)}` : ''}` : '';
  const text = `📸 Ya están las fotos de ${ev.name}. Buscate y descargalas en alta calidad 👉 ${url}${price}`;
  el.innerHTML = `
    <div class="card stack share-card ${highlight ? 'flash' : ''}">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">📣 Compartí tu álbum</h2>
        ${ev.status === 'published' ? '<span class="pill ok">Link activo</span>' : '<span class="pill warn">En borrador: publicalo para que el link funcione</span>'}</div>
      <div class="row" style="flex-wrap:nowrap">
        <input type="text" readonly value="${esc(url)}" style="flex:1;min-width:0" id="sc-url">
        <button class="btn" id="sc-copy">Copiar</button>
      </div>
      <label class="field">Texto sugerido (lo podés cambiar)<textarea id="sc-text" rows="3">${esc(text)}</textarea></label>
      <div class="share-actions">
        <a class="btn primary" id="sc-wa" target="_blank" rel="noopener" href="#">💬 WhatsApp</a>
        ${navigator.share ? '<button class="btn" id="sc-native">📲 Compartir…</button>' : ''}
        <button class="btn" id="sc-video">🎬 Video para historias</button>
        <button class="btn" id="sc-qr">🔳 QR</button>
        <button class="btn" id="sc-poster">🖨️ Cartel para imprimir</button>
      </div>
      <div id="sc-out"></div>
    </div>`;
  const msg = () => $('#sc-text', el).value.trim();
  const syncWa = () => { $('#sc-wa', el).href = `https://wa.me/?text=${encodeURIComponent(msg())}`; };
  syncWa();
  $('#sc-text', el).oninput = syncWa;
  $('#sc-copy', el).onclick = async () => { try { await navigator.clipboard.writeText(url); toast('Link copiado'); } catch { $('#sc-url', el).select(); } };
  $('#sc-native', el)?.addEventListener('click', async () => { try { await navigator.share({ title: ev.name, text: msg() }); } catch { /* cancelado */ } });
  $('#sc-qr', el).onclick = async () => {
    const c = await qrCanvas(url, 1000);
    download(await toBlob(c, 'image/png'), `qr-${slug(ev.name)}.png`);
  };
  $('#sc-poster', el).onclick = async () => {
    const c = await posterCanvas({ ev, url, displayName });
    const blob = await toBlob(c, 'image/png');
    const w = window.open('', '_blank');
    if (!w) return download(blob, `cartel-${slug(ev.name)}.png`);
    w.document.write(`<title>Cartel · ${esc(ev.name)}</title><style>@page{size:A4;margin:0}body{margin:0}img{width:100%;display:block}</style><img src="${URL.createObjectURL(blob)}" onload="setTimeout(()=>print(),300)">`);
    w.document.close();
  };
  $('#sc-video', el).onclick = async e => {
    const btn = e.target;
    const out = $('#sc-out', el);
    btn.disabled = true;
    try {
      const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', uid), where('hidden', '==', false), orderBy('takenAt'), limit(60)));
      const all = snap.docs.map(d => d.data()).filter(p => p.previewUrl);
      if (all.length < 3) throw new Error('Subí al menos 3 fotos para armar el video.');
      const pick = [0, 1, 2, 3, 4, 5].map(i => all[Math.floor((i * all.length) / 6)]).filter((p, i, a) => a.indexOf(p) === i);
      out.innerHTML = '<div class="notice small" style="margin:0">🎬 Armando el video… <strong id="sc-pct">0%</strong> · dejá esta pantalla abierta unos segundos.</div>';
      const { blob, ext } = await storyVideo({
        ev, photos: pick.map(p => p.previewUrl), displayName, link: url.replace(/^https?:\/\//, '').replace(/\?.*$/, ''),
        onProgress: p => { const s = $('#sc-pct', el); if (s) s.textContent = `${Math.round(p * 100)}%`; },
      });
      const file = new File([blob], `historia-${slug(ev.name)}.${ext}`, { type: blob.type });
      out.innerHTML = `<div class="stack" style="gap:8px"><video src="${URL.createObjectURL(blob)}" controls playsinline muted style="width:100%;max-width:240px;border-radius:12px;background:#000"></video>
        <div class="row">${navigator.canShare?.({ files: [file] }) ? '<button class="btn primary" id="sc-vshare">📲 Compartir video</button>' : ''}<button class="btn" id="sc-vdl">⬇️ Descargar</button></div>
        <span class="muted small">Subilo a tus historias de Instagram o WhatsApp. Pegá el link como sticker de enlace.</span></div>`;
      $('#sc-vshare', el)?.addEventListener('click', () => navigator.share({ files: [file], title: ev.name }).catch(() => {}));
      $('#sc-vdl', el).onclick = () => download(blob, file.name);
    } catch (err) {
      out.innerHTML = '';
      toast(err.message || 'No se pudo armar el video en este dispositivo', 'error');
    }
    btn.disabled = false;
  };
}

// ------------------------------------------------------------------ utilidades
const slug = s => String(s || 'evento').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'evento';
const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
// Las fotos se piden por el Worker (agrega CORS) para poder dibujarlas en el canvas.
function loadImg(src, cors = true) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (cors) im.crossOrigin = 'anonymous';
    im.onload = () => res(im);
    im.onerror = () => rej(new Error('No se pudo cargar una foto'));
    im.src = src;
  });
}
const viaApi = u => { try { return `${API_BASE}/public/${new URL(u).pathname.replace(/^\//, '')}`; } catch { return u; } };
const logoImg = () => loadImg('assets/logo.svg', false);

function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/), lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}
function cover(ctx, im, x, y, w, h, zoom = 1, dx = 0) {
  const s = Math.max(w / im.width, h / im.height) * zoom;
  const iw = im.width * s, ih = im.height * s;
  ctx.drawImage(im, x + (w - iw) / 2 + dx, y + (h - ih) / 2, iw, ih);
}
const FONT = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';

// ------------------------------------------------------------------ QR y cartel
export async function qrCanvas(url, size) {
  const { default: qrcode } = await import('./vendor/qrcode.js');
  const q = qrcode(0, 'M');
  q.addData(url); q.make();
  const n = q.getModuleCount(), m = 4, cell = Math.floor(size / (n + m * 2));
  const c = document.createElement('canvas');
  c.width = c.height = cell * (n + m * 2);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = INK;
  for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) ctx.fillRect((k + m) * cell, (r + m) * cell, cell, cell);
  return c;
}

export async function posterCanvas({ ev, url, displayName }) {
  const W = 1240, H = 1754; // A4 a 150 ppp
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = ORANGE; ctx.fillRect(0, 0, W, 300);
  const logo = await logoImg().catch(() => null);
  if (logo) ctx.drawImage(logo, 80, 80, 140, 140);
  ctx.fillStyle = '#fff'; ctx.font = `800 64px ${FONT}`; ctx.textBaseline = 'middle';
  ctx.fillText('quieromisfotos', 250, 150);
  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  ctx.font = `800 64px ${FONT}`;
  ctx.fillText('📸 Buscá tus fotos', W / 2, 430);
  ctx.font = `700 52px ${FONT}`;
  wrap(ctx, ev.name, W - 200).slice(0, 2).forEach((l, i) => ctx.fillText(l, W / 2, 520 + i * 64));
  ctx.font = `400 36px ${FONT}`; ctx.fillStyle = '#555';
  ctx.fillText(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }), W / 2, 670);
  const qr = await qrCanvas(url, 760);
  ctx.drawImage(qr, (W - 760) / 2, 720, 760, 760);
  ctx.fillStyle = INK; ctx.font = `700 40px ${FONT}`;
  ctx.fillText('Escaneá con la cámara del celular', W / 2, 1540);
  ctx.font = `400 32px ${FONT}`; ctx.fillStyle = '#555';
  ctx.fillText(url.replace(/^https?:\/\//, ''), W / 2, 1600);
  ctx.fillText(`Fotos de ${displayName || ''} · quieromisfotos.com.ar`, W / 2, 1680);
  return c;
}

// ------------------------------------------------------------------ video para historias (9 s, 1080×1920)
// Misma idea que la plantilla de Remotion: intro con el evento, 6 fotos con zoom lento y cierre "Buscate".
export async function storyVideo({ ev, photos, displayName, link, onProgress }) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('Este navegador no puede armar videos. Probá desde Chrome o Safari actualizados.');
  const W = 1080, H = 1920, FPS = 30;
  const INTRO = 50, SLIDE = 22, OUTRO = 90, N = photos.length, TOTAL = INTRO + N * SLIDE + OUTRO;
  const [imgs, logo] = await Promise.all([Promise.all(photos.map(u => loadImg(viaApi(u)))), logoImg().catch(() => null)]);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const bg = () => {
    const g = ctx.createRadialGradient(W / 2, 150, 50, W / 2, 150, 1300);
    g.addColorStop(0, '#3a1a0e'); g.addColorStop(1, INK);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  const text = (t, y, size, color, weight = 800, alpha = 1) => {
    ctx.globalAlpha = alpha; ctx.fillStyle = color; ctx.font = `${weight} ${size}px ${FONT}`; ctx.textAlign = 'center';
    const lines = wrap(ctx, t, W - 160);
    lines.forEach((l, i) => ctx.fillText(l, W / 2, y + i * size * 1.1));
    ctx.globalAlpha = 1;
    return lines.length;
  };
  const draw = f => {
    if (f < INTRO) {
      bg();
      const a = ease(f / 12), b = ease((f - 6) / 12);
      text('📸 Ya están las fotos de', 760 - (1 - a) * 30, 60, '#9aa3b2', 800, a);
      const n = text(ev.name, 900 - (1 - b) * 40, 110, '#fff', 900, b);
      text(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }), 900 + n * 121 + 30, 50, '#fff', 600, ease((f - 14) / 12));
      return;
    }
    if (f < INTRO + N * SLIDE) {
      const i = Math.floor((f - INTRO) / SLIDE), t = ((f - INTRO) % SLIDE) / SLIDE;
      ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
      cover(ctx, imgs[i], 0, 0, W, H, 1.15 - 0.13 * ease(t), (i % 2 ? -30 : 30) * (1 - ease(t)));
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(0.3, 'rgba(0,0,0,0)'); g.addColorStop(0.65, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.65)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      return;
    }
    bg();
    const s = ease((f - INTRO - N * SLIDE) / 14);
    text('Buscate 👀', 820, 130 * (0.8 + 0.2 * s), '#fff', 900, s);
    text(`Fotos de ${displayName || ''}`, 930, 50, '#9aa3b2', 600, s);
    ctx.globalAlpha = s; ctx.font = `800 46px ${FONT}`;
    const pw = Math.min(W - 120, ctx.measureText(link).width + 90);
    ctx.fillStyle = ORANGE; ctx.beginPath(); ctx.roundRect((W - pw) / 2, 1000, pw, 100, 50); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(link, W / 2, 1066, W - 160);
    if (logo) ctx.drawImage(logo, W / 2 - 230, 1190, 70, 70);
    ctx.font = `800 40px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText('quieromisfotos.com.ar', W / 2 - 145, 1238);
    ctx.globalAlpha = 1;
  };
  const type = ['video/mp4;codecs=avc1.42E01E', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('Este navegador no puede armar videos.');
  draw(0);
  const stream = c.captureStream(FPS);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const done = new Promise(r => { rec.onstop = r; });
  rec.start(250);
  // Se graba en tiempo real: cada cuadro se dibuja en su momento (9 s).
  await new Promise(resolve => {
    const t0 = performance.now();
    const tick = () => {
      const f = Math.floor(((performance.now() - t0) / 1000) * FPS);
      if (f >= TOTAL) return resolve();
      draw(f); onProgress?.(f / TOTAL);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  rec.stop();
  await done;
  stream.getTracks().forEach(t => t.stop());
  const blob = new Blob(chunks, { type: type.split(';')[0] });
  return { blob, ext: type.startsWith('video/mp4') ? 'mp4' : 'webm' };
}
