// Superadmin → 📣 Instagram: arma los posteos para el Instagram de Quiero Mis Fotos a partir de los álbumes publicados
// (portada con mosaico, carrusel con las fotos elegidas, cierre y una historia), con el texto listo para copiar.
// Todo se dibuja en el navegador (canvas). Se usan las muestras públicas (protegidas), nunca los originales.
import { db, collection, getDocs, getDoc, doc, query, where, orderBy, limit } from './fb.js';
import { $, $$, esc, toast, errMsg, fmtDate } from './util.js';
import { loadImg, viaApi, cover, wrap, download, toBlob, slug, FONT, ORANGE, INK } from './panel-share.js';

const NEW_DAYS = 7;   // "Nuevo": álbumes de eventos de la última semana
const PICK = 6;       // fotos elegidas por defecto para el carrusel
const MAX_PICK = 9;   // tope de fotos (Instagram admite 10 por carrusel; la portada ocupa una)

export async function viewAdminInstagram(view) {
  view.innerHTML = '<div class="spinner"></div>';
  const snap = await getDocs(query(collection(db, 'events'), orderBy('date', 'desc'), limit(60)));
  const evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => (e.photoCount || 0) > 0 && e.status === 'published');
  const uids = [...new Set(evs.flatMap(e => e.photographerUids || []))];
  const users = new Map((await Promise.all(uids.map(u => getDoc(doc(db, 'users', u)).catch(() => null))))
    .filter(Boolean).map(d => [d.id, d.data() || {}]));
  const cutoff = Date.now() - NEW_DAYS * 86400000;
  const rows = evs.flatMap(ev => (ev.photographerUids || []).map(uid => ({ ev, uid, u: users.get(uid) || {} })));
  view.innerHTML = `
    <h1>📣 Instagram</h1>
    <p class="muted" style="margin-top:-6px">Elegí un álbum publicado y te armo el posteo para el Instagram de Quiero Mis Fotos: portada, carrusel con las fotos que elijas, cierre, una historia y el texto. Se usan las muestras protegidas (con marca de agua), no los originales.</p>
    <div class="stack" id="ig-list">${rows.length ? rows.map((r, i) => {
      const nuevo = Date.parse(r.ev.date || '') >= cutoff;
      return `<div class="card row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
        <span style="min-width:0"><strong>${esc(r.ev.name || r.ev.id)}</strong> ${nuevo ? '<span class="pill ok">Nuevo</span>' : ''}<br>
          <span class="muted small">${esc(fmtDate(r.ev.date))} · ${esc(r.u.displayName || 'Fotógrafo')}${igOf(r.u) ? ` · @${esc(igOf(r.u))}` : ''}</span></span>
        <button class="btn primary sm" data-ig="${i}">Armar post</button>
        <div data-igout="${i}" style="width:100%"></div></div>`;
    }).join('') : '<p class="muted">Todavía no hay álbumes publicados con fotos.</p>'}</div>`;
  $$('[data-ig]', view).forEach(b => b.onclick = () => openBuilder(rows[+b.dataset.ig], $(`[data-igout="${b.dataset.ig}"]`, view), b));
}

const igOf = u => String(u?.socials?.instagram || '').trim().replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').replace(/^@/, '');

// Paso 1: elegir fotos. Paso 2: generar y compartir.
async function openBuilder({ ev, uid, u }, out, btn) {
  if (out.dataset.open) { out.innerHTML = ''; delete out.dataset.open; return; }
  out.dataset.open = '1';
  out.innerHTML = '<p class="muted small">Cargando fotos…</p>';
  btn.disabled = true;
  try {
    const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', uid), where('hidden', '==', false), orderBy('takenAt'), limit(60)));
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.previewUrl);
    if (!all.length) throw new Error('El álbum no tiene fotos visibles.');
    const sel = new Set([0, 1, 2, 3, 4, 5].map(i => all[Math.floor((i * all.length) / PICK)]?.id).filter(Boolean));
    out.innerHTML = `<div class="stack" style="margin-top:10px">
      <p class="small" style="margin:0">Tocá las fotos para elegir cuáles van (hasta ${MAX_PICK}). Las 3 primeras elegidas arman la portada.</p>
      <div class="ig-pick">${all.map(p => `<button type="button" data-pid="${p.id}" class="${sel.has(p.id) ? 'on' : ''}"><img src="${esc(p.thumbUrl || p.previewUrl)}" alt="" loading="lazy"></button>`).join('')}</div>
      <div><button class="btn primary" data-make>🎨 Generar imágenes</button></div>
      <div data-res></div></div>`;
    $$('[data-pid]', out).forEach(b => b.onclick = () => {
      const id = b.dataset.pid;
      if (sel.has(id)) sel.delete(id);
      else if (sel.size >= MAX_PICK) return toast(`Hasta ${MAX_PICK} fotos.`, 'error');
      else sel.add(id);
      b.classList.toggle('on', sel.has(id));
    });
    $('[data-make]', out).onclick = async e => {
      const photos = all.filter(p => sel.has(p.id));
      if (photos.length < 1) return toast('Elegí al menos una foto.', 'error');
      e.target.disabled = true; e.target.textContent = 'Generando…';
      try { await render({ ev, u, photos }, $('[data-res]', out)); }
      catch (err) { toast(errMsg(err), 'error'); }
      e.target.disabled = false; e.target.textContent = '🎨 Generar de nuevo';
    };
  } catch (err) { out.innerHTML = `<div class="notice danger small">${esc(errMsg(err))}</div>`; }
  btn.disabled = false;
}

export async function render({ ev, u, photos }, box) {
  box.innerHTML = '<p class="muted small">Dibujando…</p>';
  const [imgs, logo] = await Promise.all([Promise.all(photos.map(p => loadImg(viaApi(p.previewUrl)))), loadImg('assets/logo.svg', false).catch(() => null)]);
  const name = u.displayName || 'el fotógrafo', ig = igOf(u);
  const date = fmtDate(ev.date, { day: 'numeric', month: 'long' });
  const info = { ev, name, ig, date, logo };
  const feed = [coverPost(info, imgs.slice(0, 3)), ...imgs.map((im, i) => photoPost(info, im, i + 2, imgs.length + 2)), closingPost(info, imgs.length + 2)];
  const story = storyPost(info, imgs.slice(0, 3));
  const base = slug(ev.name);
  const files = await Promise.all(feed.map(async (c, i) => new File([await toBlob(c, 'image/jpeg', 0.92)], `${base}-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' })));
  const storyFile = new File([await toBlob(story, 'image/jpeg', 0.92)], `${base}-historia.jpg`, { type: 'image/jpeg' });
  const caption = `📸 Ya están las fotos de ${ev.name} (${date}).\nFotos de ${ig ? `@${ig}` : name}.\n\nBuscá la tuya con tu dorsal o una selfie y descargá el original, sin marca de agua 👉 link en la bio\n\n#quieromisfotos #fotografiadeportiva #fotosdeportivas`;
  const canShare = f => !!navigator.canShare?.({ files: f });
  box.innerHTML = `<div class="stack">
    <div class="ig-prev">${files.map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('')}<img class="story" src="${URL.createObjectURL(storyFile)}" alt=""></div>
    <label class="field">Texto del posteo<textarea rows="6" data-cap>${esc(caption)}</textarea></label>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn" data-copy>📋 Copiar texto</button>
      ${canShare(files) ? '<button class="btn primary" data-share>📲 Compartir carrusel</button>' : ''}
      ${canShare([storyFile]) ? '<button class="btn" data-sshare>📲 Compartir historia</button>' : ''}
      <button class="btn" data-dl>⬇️ Descargar todo</button>
    </div>
    <p class="muted small" style="margin:0">${ig ? `Publicalo como <strong>colaboración</strong> con @${esc(ig)} (en Instagram: Etiquetar personas → Invitar colaborador) para que salga también en su perfil.` : 'Este fotógrafo no cargó su Instagram en el perfil: mencionalo a mano si lo sabés.'} En la historia, poné el sticker de Link sobre el recuadro blanco.</p>
  </div>`;
  const cap = () => $('[data-cap]', box).value;
  $('[data-copy]', box).onclick = async () => { try { await navigator.clipboard.writeText(cap()); toast('Texto copiado'); } catch { $('[data-cap]', box).select(); } };
  $('[data-share]', box)?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cap()).catch(() => {}); await navigator.share({ files, text: cap() }); } catch { /* cancelado */ }
  });
  $('[data-sshare]', box)?.addEventListener('click', () => navigator.share({ files: [storyFile] }).catch(() => {}));
  $('[data-dl]', box).onclick = async () => {
    for (const f of [...files, storyFile]) { download(f, f.name); await new Promise(r => setTimeout(r, 350)); }
  };
}

// ------------------------------------------------------------------ dibujo (mismo estilo que las piezas de la marca)
const W = 1080;
function canvas(h) { const c = document.createElement('canvas'); c.width = W; c.height = h; return [c, c.getContext('2d')]; }
function brand(ctx, logo, x, y) {
  if (logo) ctx.drawImage(logo, x, y, 64, 64);
  ctx.font = `800 38px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.7)'; ctx.shadowBlur = 14;
  let cx = x + 82;
  for (const [t, col] of [['quiero', '#fff'], ['mis', ORANGE], ['fotos', '#fff']]) { ctx.fillStyle = col; ctx.fillText(t, cx, y + 33); cx += ctx.measureText(t).width; }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}
// Título que se achica hasta entrar en las líneas disponibles.
function title(ctx, text, x, y, maxW, maxLines, sizes) {
  for (const size of sizes) {
    ctx.font = `900 ${size}px ${FONT}`;
    if (wrap(ctx, text, maxW).length <= maxLines || size === sizes[sizes.length - 1]) return lines(ctx, text, x, y, size, 900, '#fff', maxW, maxLines);
  }
  return 0;
}
function pill(ctx, text, x, y, { bg = ORANGE, fg = '#fff', size = 34 } = {}) {
  ctx.font = `800 ${size}px ${FONT}`;
  const w = ctx.measureText(text).width + size * 1.6, h = size * 1.9;
  ctx.fillStyle = bg; ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fill();
  ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(text, x + size * 0.8, y + h / 2 + 2); ctx.textBaseline = 'alphabetic';
  return h;
}
function rounded(ctx, im, x, y, w, h, r) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip(); cover(ctx, im, x, y, w, h); ctx.restore();
}
function mosaic(ctx, imgs, x, y, w, h) {
  const g = 14;
  if (imgs.length === 1) return rounded(ctx, imgs[0], x, y, w, h, 28);
  if (imgs.length === 2) { const cw = (w - g) / 2; rounded(ctx, imgs[0], x, y, cw, h, 28); rounded(ctx, imgs[1], x + cw + g, y, cw, h, 28); return; }
  const lw = (w - g) * 0.56, rw = w - g - lw, rh = (h - g) / 2;
  rounded(ctx, imgs[0], x, y, lw, h, 28); rounded(ctx, imgs[1], x + lw + g, y, rw, rh, 24); rounded(ctx, imgs[2], x + lw + g, y + rh + g, rw, rh, 24);
}
function lines(ctx, text, x, y, size, weight, color, maxW, maxLines = 3, lh = 1.04) {
  ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = 'left';
  const all = wrap(ctx, text, maxW), ls = all.slice(0, maxLines);
  // Si no entra, la última línea termina en "…".
  if (all.length > maxLines) {
    let last = ls[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    ls[maxLines - 1] = `${last.trimEnd()}…`;
  }
  ls.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  return ls.length * size * lh;
}
const credit = i => (i.ig ? `@${i.ig}` : i.name);

function coverPost(i, imgs) {
  const [c, ctx] = canvas(1350);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, 1350);
  brand(ctx, i.logo, 80, 80);
  pill(ctx, '📸 Ya están las fotos', 80, 190);
  mosaic(ctx, imgs, 80, 300, W - 160, 560);
  let y = 950;
  y += title(ctx, i.ev.name, 80, y, W - 160, 3, [76, 66, 58]) + 6;
  lines(ctx, `${i.date} · Fotos de ${credit(i)}`, 80, y, 36, 500, '#d6dae2', W - 160, 2, 1.3);
  ctx.font = `700 34px ${FONT}`; ctx.fillStyle = ORANGE; ctx.fillText('quieromisfotos.com.ar', 80, 1270);
  ctx.textAlign = 'right'; ctx.fillStyle = '#9aa3b2'; ctx.font = `700 30px ${FONT}`; ctx.fillText('Deslizá →', W - 80, 1270);
  return c;
}
function photoPost(i, im, n, total) {
  const [c, ctx] = canvas(1350);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, 1350);
  cover(ctx, im, 0, 0, W, 1350);
  const g = ctx.createLinearGradient(0, 0, 0, 1350);
  g.addColorStop(0, 'rgba(15,17,21,.6)'); g.addColorStop(0.18, 'rgba(15,17,21,0)'); g.addColorStop(0.72, 'rgba(15,17,21,0)'); g.addColorStop(1, 'rgba(15,17,21,.85)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 1350);
  ctx.fillStyle = 'rgba(15,17,21,.72)'; ctx.beginPath(); ctx.roundRect(54, 58, 410, 88, 44); ctx.fill();
  brand(ctx, i.logo, 70, 70);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10;
  lines(ctx, i.ev.name, 70, 1210, 40, 800, '#fff', W - 260, 1);
  ctx.restore();
  ctx.font = `600 30px ${FONT}`; ctx.fillStyle = '#d6dae2'; ctx.fillText(`Fotos de ${credit(i)}`, 70, 1262);
  ctx.textAlign = 'right'; ctx.font = `800 30px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(`${n}/${total}`, W - 70, 1262);
  return c;
}
function closingPost(i, n) {
  const [c, ctx] = canvas(1350);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, 1350);
  brand(ctx, i.logo, 80, 80);
  let y = 520;
  y += lines(ctx, 'Buscá la tuya 👀', 80, y, 104, 900, '#fff', W - 160, 2);
  y += 20;
  y += lines(ctx, 'Con tu dorsal o una selfie. El original sin marca de agua, totalmente enfocado y en alta calidad.', 80, y, 40, 500, '#d6dae2', W - 160, 4, 1.3);
  pill(ctx, 'Link en la bio · quieromisfotos.com.ar', 80, y + 50, { size: 32 });
  ctx.font = `600 32px ${FONT}`; ctx.fillStyle = '#9aa3b2'; ctx.textAlign = 'left'; ctx.fillText(`Fotos de ${credit(i)}`, 80, 1270);
  ctx.textAlign = 'right'; ctx.font = `800 30px ${FONT}`; ctx.fillStyle = '#fff'; ctx.fillText(`${n}/${n}`, W - 80, 1270);
  return c;
}
function storyPost(i, imgs) {
  const H = 1920;
  const [c, ctx] = canvas(H);
  ctx.fillStyle = INK; ctx.fillRect(0, 0, W, H);
  brand(ctx, i.logo, 80, 140);
  pill(ctx, '📸 Ya están las fotos', 80, 260);
  mosaic(ctx, imgs, 80, 380, W - 160, 820);
  let y = 1300;
  y += title(ctx, i.ev.name, 80, y, W - 160, 3, [84, 72, 62]) + 6;
  lines(ctx, `${i.date} · Fotos de ${credit(i)}`, 80, y, 38, 500, '#d6dae2', W - 160, 2, 1.3);
  // Lugar para el sticker de link.
  const t = 'quieromisfotos.com.ar'; ctx.font = `800 38px ${FONT}`;
  const bw = ctx.measureText(t).width + 120, bx = (W - bw) / 2, by = H - 280;
  ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.roundRect(bx, by, bw, 100, 50); ctx.fill();
  ctx.setLineDash([14, 10]); ctx.lineWidth = 4; ctx.strokeStyle = ORANGE; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = INK; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(`🔗 ${t}`, W / 2, by + 52); ctx.textBaseline = 'alphabetic';
  return c;
}

