// Superadmin → 📣 Instagram: arma los posteos para el Instagram de Quiero Mis Fotos a partir de los álbumes publicados
// (portada con mosaico, carrusel con las fotos elegidas, cierre, una historia y un reel), con el texto listo para copiar.
// Todo se dibuja en el navegador (canvas). Se usan las muestras públicas (protegidas), nunca los originales.
//   - Cada álbum usa una paleta de colores distinta (rotan en orden), así el feed no queda monótono.
//   - Lo generado queda guardado en igPosts/{eventId}_{uid} (paleta y fotos elegidas): al volver se ve igual.
//   - "Marcar como subido" registra la fecha y (opcional) le avisa al fotógrafo para que lo comparta.
import { db, collection, getDocs, getDoc, doc, query, where, orderBy, limit, setDoc, updateDoc, serverTimestamp } from './fb.js';
import { $, $$, esc, toast, errMsg, fmtDate, searchTokens } from './util.js';
import { igHandle } from './text-core.js';
import { loadTaxonomy } from './data.js';
import { apiPost } from './api.js';
import { eventUrl } from './share.js';
import { loadImg, viaApi, cover, wrap, download, toBlob, slug, FONT, ORANGE } from './panel-share.js';

const NEW_DAYS = 7;   // "Nuevo": álbumes de eventos de la última semana
const PICK = 6;       // fotos elegidas por defecto para el carrusel
const MAX_PICK = 9;   // tope de fotos (Instagram admite 10 por carrusel; la portada ocupa una)

// Paletas: fondo (degradé bg → bg2), acento (pastillas), texto principal / secundario / apagado.
export const PALETTES = [
  { id: 'noche', name: 'Noche', bg: '#0f1115', bg2: '#3a1a0e', accent: ORANGE, onAccent: '#fff', fg: '#fff', sub: '#d6dae2', mute: '#9aa3b2', mis: ORANGE },
  { id: 'naranja', name: 'Naranja', bg: '#ff5a1f', bg2: '#b83a0d', accent: '#0f1115', onAccent: '#fff', fg: '#fff', sub: '#ffe6da', mute: '#ffd0bb', mis: '#0f1115' },
  { id: 'azul', name: 'Azul', bg: '#0b2447', bg2: '#1d4f91', accent: '#ffb020', onAccent: '#0f1115', fg: '#fff', sub: '#cfe0f7', mute: '#9fb8da', mis: '#ffb020' },
  { id: 'cancha', name: 'Cancha', bg: '#0b3326', bg2: '#17694c', accent: '#c8f031', onAccent: '#0f1115', fg: '#fff', sub: '#d3eadf', mute: '#9cc7b4', mis: '#c8f031' },
  { id: 'crema', name: 'Crema', bg: '#f6f0e6', bg2: '#e9d6b8', accent: ORANGE, onAccent: '#fff', fg: '#15181e', sub: '#3d424d', mute: '#6b7280', mis: ORANGE },
  { id: 'violeta', name: 'Violeta', bg: '#1f1038', bg2: '#4a2580', accent: '#ff5fa2', onAccent: '#fff', fg: '#fff', sub: '#e2d6f5', mute: '#b3a1d1', mis: '#ff5fa2' },
];
const palOf = id => PALETTES.find(p => p.id === id) || PALETTES[0];

const postId = (eid, uid) => `${eid}_${uid}`;
let igFilter = 'pend';

export async function viewAdminInstagram(view) {
  view.innerHTML = '<div class="spinner"></div>';
  const [snap, postsSnap] = await Promise.all([
    getDocs(query(collection(db, 'events'), orderBy('date', 'desc'), limit(80))),
    getDocs(collection(db, 'igPosts')).catch(() => null),
  ]);
  const posts = new Map((postsSnap?.docs || []).map(d => [d.id, d.data()]));
  const evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(e => (e.photoCount || 0) > 0 && e.status === 'published');
  const uids = [...new Set(evs.flatMap(e => e.photographerUids || []))];
  const users = new Map((await Promise.all(uids.map(u => getDoc(doc(db, 'users', u)).catch(() => null))))
    .filter(Boolean).map(d => [d.id, d.data() || {}]));
  const cutoff = Date.now() - NEW_DAYS * 86400000;
  const all = evs.flatMap(ev => (ev.photographerUids || []).map(uid => ({ ev, uid, u: users.get(uid) || {}, post: posts.get(postId(ev.id, uid)) || null })));
  const isPosted = r => !!r.post?.postedAt;
  const draw = () => {
    const rows = all.filter(r => igFilter === 'all' || (igFilter === 'done' ? isPosted(r) : !isPosted(r)));
    const tabs = [['pend', `Pendientes (${all.filter(r => !isPosted(r)).length})`], ['done', `Subidos (${all.filter(isPosted).length})`], ['all', 'Todos']];
    view.innerHTML = `
      <h1>📣 Instagram</h1>
      <p class="muted" style="margin-top:-6px">Elegí un álbum publicado y te armo el posteo para el Instagram de Quiero Mis Fotos: portada, carrusel con las fotos que elijas, cierre, historia, reel y el texto. Se usan las muestras protegidas (con marca de agua), no los originales. Cada álbum sale con otra paleta de colores y lo generado queda guardado.</p>
      <div class="tabs">${tabs.map(([k, l]) => `<button class="chip ${igFilter === k ? 'on' : ''}" data-igf="${k}">${l}</button>`).join('')}</div>
      <div class="stack" id="ig-list">${rows.length ? rows.map((r, i) => {
        const nuevo = Date.parse(r.ev.date || '') >= cutoff;
        const tags = r.ev.igTags || [];
        return `<div class="card row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
          <span style="min-width:0"><strong data-igname="${i}">${esc(r.ev.name || r.ev.id)}</strong> ${nuevo ? '<span class="pill ok">Nuevo</span>' : ''}
            ${isPosted(r) ? `<span class="pill ok">✓ Subido ${esc(fmtTsShort(r.post.postedAt))}</span>` : r.post ? '<span class="pill">Generado</span>' : ''}<br>
            <span class="muted small">${esc(fmtDate(r.ev.date))} · ${esc(r.u.displayName || 'Fotógrafo')}${igOf(r.u) ? ` · @${esc(igOf(r.u))}` : ''}${tags.length ? ` · ${tags.map(t => `@${esc(t)}`).join(' ')}` : ''}</span></span>
          <button class="btn ${r.post ? '' : 'primary'} sm" data-ig="${i}">${r.post ? 'Ver post' : 'Armar post'}</button>
          <div data-igout="${i}" style="width:100%"></div></div>`;
      }).join('') : `<p class="muted">${igFilter === 'pend' ? '¡No hay pendientes! Ya subiste todos los álbumes recientes.' : 'No hay álbumes en esta lista.'}</p>`}</div>`;
    $$('[data-igf]', view).forEach(b => b.onclick = () => { igFilter = b.dataset.igf; draw(); });
    $$('[data-ig]', view).forEach(b => b.onclick = () => {
      const i = +b.dataset.ig;
      openBuilder(rows[i], $(`[data-igout="${i}"]`, view), b, { posts, onTitle: name => { $(`[data-igname="${i}"]`, view).textContent = name; } });
    });
  };
  draw();
}

const igOf = u => igHandle(u?.socials?.instagram);
const fmtTsShort = t => { const ms = t?.toMillis?.() || (t ? Date.parse(t) : 0); return ms ? new Date(ms).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }) : ''; };

// Qué búsquedas tiene el álbum: el texto solo nombra el dorsal o la selfie si de verdad están.
function searchModes(set, settings) {
  const bibs = settings?.bibsEnabled !== false && (set?.bibPhotos || 0) > 0;
  const selfie = settings?.selfieEnabled !== false && set?.selfie !== false && (set?.facesPhotos || 0) > 0;
  return { bibs, selfie, how: bibs && selfie ? 'con tu dorsal o una selfie' : bibs ? 'con tu dorsal' : selfie ? 'con una selfie' : '' };
}

// Siguiente paleta: la que sigue a la del último post generado (así dos seguidos nunca salen iguales).
function nextPalette(posts) {
  let last = null, lastAt = -1;
  for (const p of posts.values()) { const at = p.createdAt?.toMillis?.() || 0; if (at > lastAt) { lastAt = at; last = p.palette; } }
  const i = PALETTES.findIndex(p => p.id === last);
  return PALETTES[(i + 1) % PALETTES.length].id;
}

// Paso 1: nombre, paleta y fotos. Paso 2: generar y compartir.
async function openBuilder(row, out, btn, { posts, onTitle }) {
  const { ev, uid, u } = row;
  if (out.dataset.open) { out.innerHTML = ''; delete out.dataset.open; return; }
  out.dataset.open = '1';
  out.innerHTML = '<p class="muted small">Cargando fotos…</p>';
  btn.disabled = true;
  try {
    const [snap, setSnap, stSnap] = await Promise.all([
      getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', uid), where('hidden', '==', false), orderBy('takenAt'), limit(60))),
      getDoc(doc(db, 'events', ev.id, 'sets', uid)).catch(() => null),
      getDoc(doc(db, 'settings', 'platform')).catch(() => null),
    ]);
    const all = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => p.previewUrl);
    if (!all.length) throw new Error('El álbum no tiene fotos visibles.');
    const modes = searchModes(setSnap?.data(), stSnap?.data());
    const saved = posts.get(postId(ev.id, uid));
    const savedIds = (saved?.photoIds || []).filter(id => all.some(p => p.id === id));
    const sel = new Set(savedIds.length ? savedIds : [0, 1, 2, 3, 4, 5].map(i => all[Math.floor((i * all.length) / PICK)]?.id).filter(Boolean));
    let pal = saved?.palette || nextPalette(posts);
    out.innerHTML = `<div class="stack" style="margin-top:10px">
      <div class="row" style="gap:6px;align-items:flex-end;flex-wrap:wrap">
        <label class="field" style="flex:1;min-width:220px;margin:0">Nombre del álbum <span class="muted small">(corregilo si tiene algún error: cambia también en el sitio)</span>
          <input type="text" data-title maxlength="100" value="${esc(ev.name)}"></label>
        <button class="btn sm" data-title-save>Guardar nombre</button>
      </div>
      <div class="field" style="margin:0"><span>Colores</span>
        <div class="row" style="gap:6px;flex-wrap:wrap" data-pals>${PALETTES.map(p => `<button type="button" class="chip ${p.id === pal ? 'on' : ''}" data-pal="${p.id}"><span style="display:inline-block;width:14px;height:14px;border-radius:50%;vertical-align:-2px;background:linear-gradient(135deg,${p.bg} 50%,${p.accent} 50%);border:1px solid var(--border)"></span> ${esc(p.name)}</button>`).join('')}</div></div>
      <p class="small" style="margin:0">Tocá las fotos para elegir cuáles van (hasta ${MAX_PICK}). Las 3 primeras elegidas arman la portada.</p>
      <div class="ig-pick">${all.map(p => `<button type="button" data-pid="${p.id}" class="${sel.has(p.id) ? 'on' : ''}"><img src="${esc(p.thumbUrl || p.previewUrl)}" alt="" loading="lazy"></button>`).join('')}</div>
      <div><button class="btn primary" data-make>🎨 ${saved ? 'Generar de nuevo' : 'Generar imágenes'}</button></div>
      <div data-res></div></div>`;
    $$('[data-pid]', out).forEach(b => b.onclick = () => {
      const id = b.dataset.pid;
      if (sel.has(id)) sel.delete(id);
      else if (sel.size >= MAX_PICK) return toast(`Hasta ${MAX_PICK} fotos.`, 'error');
      else sel.add(id);
      b.classList.toggle('on', sel.has(id));
    });
    $$('[data-pal]', out).forEach(b => b.onclick = () => { pal = b.dataset.pal; $$('[data-pal]', out).forEach(x => x.classList.toggle('on', x === b)); });
    // Corregir el nombre (errores de tipeo): se guarda en el evento, con sus palabras de búsqueda.
    $('[data-title-save]', out).onclick = async e => {
      const name = $('[data-title]', out).value.trim();
      if (!name) return toast('Escribí el nombre.', 'error');
      if (name === ev.name) return toast('No cambió el nombre.');
      e.target.disabled = true;
      try {
        const tax = await loadTaxonomy();
        const tagNames = (ev.tagIds || []).map(id => tax.tagById.get(id)?.name || '');
        await updateDoc(doc(db, 'events', ev.id), { name, searchTokens: searchTokens(name, ev.location || '', ...tagNames), updatedAt: serverTimestamp() });
        ev.name = name; onTitle?.(name);
        toast('Nombre guardado. Generá de nuevo para actualizar las imágenes.');
      } catch (err) { toast(errMsg(err), 'error'); }
      e.target.disabled = false;
    };
    const make = async (store) => {
      const photos = [...sel].map(id => all.find(p => p.id === id)).filter(Boolean);
      if (photos.length < 1) return toast('Elegí al menos una foto.', 'error');
      const b = $('[data-make]', out); b.disabled = true; b.textContent = 'Generando…';
      try {
        await render({ ev, uid, u, photos, pal: palOf(pal), modes, posts, row }, $('[data-res]', out));
        if (store) {
          const data = { eventId: ev.id, uid, palette: pal, photoIds: photos.map(p => p.id), updatedAt: serverTimestamp() };
          if (!saved?.createdAt && !posts.get(postId(ev.id, uid))?.createdAt) data.createdAt = serverTimestamp();
          await setDoc(doc(db, 'igPosts', postId(ev.id, uid)), data, { merge: true });
          posts.set(postId(ev.id, uid), { ...(posts.get(postId(ev.id, uid)) || {}), ...data, createdAt: posts.get(postId(ev.id, uid))?.createdAt || { toMillis: () => Date.now() } });
          row.post = posts.get(postId(ev.id, uid));
        }
      } catch (err) { toast(errMsg(err), 'error'); }
      b.disabled = false; b.textContent = '🎨 Generar de nuevo';
    };
    $('[data-make]', out).onclick = () => make(true);
    if (saved) await make(false); // ya generado: se muestra igual que la última vez
  } catch (err) { out.innerHTML = `<div class="notice danger small">${esc(errMsg(err))}</div>`; }
  btn.disabled = false;
}

export async function render({ ev, uid, u, photos, pal, modes, posts, row }, box) {
  box.innerHTML = '<p class="muted small">Dibujando…</p>';
  const [imgs, logo] = await Promise.all([Promise.all(photos.map(p => loadImg(viaApi(p.previewUrl)))), loadImg('assets/logo.svg', false).catch(() => null)]);
  const name = u.displayName || 'el fotógrafo', ig = igOf(u);
  const tags = (ev.igTags || []).filter(t => t !== ig);
  const date = fmtDate(ev.date, { day: 'numeric', month: 'long' });
  const city = String(ev.city || u.zone || '').split(',')[0].trim(); // ciudad (sin la provincia, para que entre)
  const info = { ev, name, ig, date, logo, city, pal, modes };
  const feed = [coverPost(info, imgs.slice(0, 3)), ...imgs.map((im, i) => photoPost(info, im, i + 2, imgs.length + 2)), closingPost(info, imgs.length + 2)];
  const story = storyPost(info, imgs.slice(0, 3));
  const base = slug(ev.name);
  const files = await Promise.all(feed.map(async (c, i) => new File([await toBlob(c, 'image/jpeg', 0.92)], `${base}-${String(i + 1).padStart(2, '0')}.jpg`, { type: 'image/jpeg' })));
  const storyFile = new File([await toBlob(story, 'image/jpeg', 0.92)], `${base}-historia.jpg`, { type: 'image/jpeg' });
  const link = eventUrl(ev.id, uid);
  const mentions = [ig, ...tags].filter(Boolean).map(h => `@${h}`).join(' ');
  const caption = `📸 Ya están las fotos de ${ev.name} (${date}).\nFotos de ${ig ? `@${ig}` : name}${city ? ` · 📍 ${city}` : ''}.${tags.length ? `\n${tags.map(t => `@${t}`).join(' ')}` : ''}\n\nBuscá la tuya${modes.how ? ` ${modes.how}` : ''} y descargá el original, sin marca de agua 👉 link en la bio\n\n#quieromisfotos #fotografiadeportiva #fotosdeportivas`;
  const canShare = f => !!navigator.canShare?.({ files: f });
  const key = postId(ev.id, uid);
  box.innerHTML = `<div class="stack">
    <div class="ig-prev">${files.map(f => `<img src="${URL.createObjectURL(f)}" alt="">`).join('')}<img class="story" src="${URL.createObjectURL(storyFile)}" alt=""></div>
    <div class="field" style="margin:0"><span>🔗 Link del álbum <span class="muted small">(para el sticker de enlace de la historia)</span></span>
      <div class="row" style="gap:6px"><input type="text" readonly value="${esc(link)}" data-link style="flex:1;min-width:0"><button class="btn sm" data-copy-link>Copiar link</button></div></div>
    <div class="field" style="margin:0"><span>@ Menciones <span class="muted small">(pegalas en el sticker de mención: así les llega el aviso y lo comparten)</span></span>
      ${mentions ? `<div class="row" style="gap:6px"><input type="text" readonly value="${esc(mentions)}" data-ment style="flex:1;min-width:0"><button class="btn sm" data-copy-ment>Copiar menciones</button></div>`
        : '<span class="muted small">Ni el fotógrafo ni el álbum tienen Instagram cargado.</span>'}</div>
    <label class="field">Texto del posteo<textarea rows="7" data-cap>${esc(caption)}</textarea></label>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      <button class="btn" data-copy>📋 Copiar texto</button>
      ${canShare(files) ? '<button class="btn primary" data-share>📲 Compartir carrusel</button>' : ''}
      ${canShare([storyFile]) ? '<button class="btn" data-sshare>📲 Compartir historia</button>' : ''}
      <button class="btn" data-dl>⬇️ Descargar todo</button>
      <button class="btn" data-reel>🎬 Generar reel</button>
    </div>
    <div data-reel-out></div>
    <p class="muted small" style="margin:0">${ig ? `Publicalo como <strong>colaboración</strong> con @${esc(ig)} (en Instagram: Etiquetar personas → Invitar colaborador) para que salga también en su perfil.` : 'Este fotógrafo no cargó su Instagram en el perfil: mencionalo a mano si lo sabés.'} En la historia: el sticker de link va abajo, donde dice "Tocá el link", y las menciones al lado de "Fotos de".</p>
    <div class="card row" data-posted style="justify-content:space-between;gap:8px;flex-wrap:wrap;margin:0"></div>
  </div>`;
  const copy = async (text, msg, input) => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { input?.select(); } };
  const cap = () => $('[data-cap]', box).value;
  $('[data-copy]', box).onclick = () => copy(cap(), 'Texto copiado', $('[data-cap]', box));
  $('[data-copy-link]', box).onclick = () => copy(link, 'Link copiado', $('[data-link]', box));
  $('[data-copy-ment]', box)?.addEventListener('click', () => copy(mentions, 'Menciones copiadas', $('[data-ment]', box)));
  $('[data-share]', box)?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(cap()).catch(() => {}); await navigator.share({ files, text: cap() }); } catch { /* cancelado */ }
  });
  $('[data-sshare]', box)?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(link).catch(() => {}); // el link queda copiado para el sticker
    navigator.share({ files: [storyFile] }).catch(() => {});
  });
  $('[data-dl]', box).onclick = async () => {
    for (const f of [...files, storyFile]) { download(f, f.name); await new Promise(r => setTimeout(r, 350)); }
  };
  $('[data-reel]', box).onclick = async e => {
    const b = e.target, outR = $('[data-reel-out]', box);
    b.disabled = true;
    try {
      outR.innerHTML = '<p class="muted small" data-prog>Grabando el reel… 0%</p>';
      const { blob, ext } = await reelVideo(info, imgs, p => { const el = $('[data-prog]', outR); if (el) el.textContent = `Grabando el reel… ${Math.round(p * 100)}% (no cambies de pestaña)`; });
      const file = new File([blob], `${base}-reel.${ext}`, { type: blob.type });
      outR.innerHTML = `<div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-start">
        <video src="${URL.createObjectURL(file)}" controls muted playsinline style="height:260px;border-radius:10px"></video>
        <div class="stack" style="gap:6px">
          ${canShare([file]) ? '<button class="btn primary sm" data-rshare>📲 Compartir reel</button>' : ''}
          <button class="btn sm" data-rdl>⬇️ Descargar reel</button>
          <span class="muted small">Sin música: agregale una desde Instagram.${ext === 'webm' ? '<br>⚠️ Este navegador lo grabó en WebM: para Instagram generalo desde Safari o Chrome actualizado (MP4).' : ''}</span></div></div>`;
      $('[data-rshare]', outR)?.addEventListener('click', async () => { await navigator.clipboard.writeText(cap()).catch(() => {}); navigator.share({ files: [file], text: cap() }).catch(() => {}); });
      $('[data-rdl]', outR).onclick = () => download(file, file.name);
    } catch (err) { outR.innerHTML = `<div class="notice danger small">${esc(errMsg(err))}</div>`; }
    b.disabled = false;
  };
  // Subido a Instagram: se registra y (opcional) se le avisa al fotógrafo.
  const drawPosted = () => {
    const p = posts.get(key), el = $('[data-posted]', box);
    if (p?.postedAt) {
      el.innerHTML = `<span>✅ <strong>Subido a Instagram</strong> el ${esc(fmtTsShort(p.postedAt))}${p.notifiedAt ? ' · le avisamos al fotógrafo' : ''}</span><button class="btn sm ghost" data-unpost>Desmarcar</button>`;
      $('[data-unpost]', el).onclick = async () => {
        try { await setDoc(doc(db, 'igPosts', key), { postedAt: null }, { merge: true }); posts.set(key, { ...p, postedAt: null }); row.post = posts.get(key); drawPosted(); } catch (err) { toast(errMsg(err), 'error'); }
      };
    } else {
      el.innerHTML = `<label class="check" style="margin:0"><input type="checkbox" data-notify checked> Avisarle a ${esc(name)} para que lo comparta</label><button class="btn primary sm" data-post>✓ Marcar como subido a IG</button>`;
      $('[data-post]', el).onclick = async e => {
        e.target.disabled = true;
        const notify = $('[data-notify]', el).checked;
        try {
          await setDoc(doc(db, 'igPosts', key), { eventId: ev.id, uid, postedAt: serverTimestamp() }, { merge: true });
          const now = { toMillis: () => Date.now() };
          let notifiedAt = null;
          if (notify) {
            try { await apiPost('/admin/ig/posted', { eventId: ev.id, uid }); notifiedAt = now; } catch (err) { toast(`Quedó marcado, pero no se pudo avisar: ${errMsg(err)}`, 'error'); }
          }
          posts.set(key, { ...(posts.get(key) || {}), postedAt: now, notifiedAt });
          row.post = posts.get(key);
          toast(notifiedAt ? 'Marcado como subido. Le avisamos al fotógrafo.' : 'Marcado como subido.');
          drawPosted();
        } catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
      };
    }
  };
  drawPosted();
}

// ------------------------------------------------------------------ dibujo (mismo estilo que las piezas de la marca)
const W = 1080;
function canvas(h) { const c = document.createElement('canvas'); c.width = W; c.height = h; return [c, c.getContext('2d')]; }
const isLight = pal => pal.fg !== '#fff';
function background(ctx, pal, h) {
  const g = ctx.createLinearGradient(0, 0, W * 0.6, h);
  g.addColorStop(0, pal.bg); g.addColorStop(0.55, pal.bg); g.addColorStop(1, pal.bg2);
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, h);
}
function brand(ctx, logo, x, y, pal, onPhoto = false) {
  if (logo) ctx.drawImage(logo, x, y, 64, 64);
  ctx.font = `800 38px ${FONT}`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  ctx.save();
  if (onPhoto || !isLight(pal)) { ctx.shadowColor = 'rgba(0,0,0,.55)'; ctx.shadowBlur = 12; }
  const fg = onPhoto ? '#fff' : pal.fg, mis = onPhoto ? (pal.mis === '#0f1115' ? ORANGE : pal.mis) : pal.mis;
  let cx = x + 82;
  for (const [t, col] of [['quiero', fg], ['mis', mis], ['fotos', fg]]) { ctx.fillStyle = col; ctx.fillText(t, cx, y + 33); cx += ctx.measureText(t).width; }
  ctx.restore();
  ctx.textBaseline = 'alphabetic';
}
// Título que se achica hasta entrar en las líneas disponibles.
function title(ctx, text, x, y, maxW, maxLines, sizes, color) {
  for (const size of sizes) {
    ctx.font = `900 ${size}px ${FONT}`;
    if (wrap(ctx, text, maxW).length <= maxLines || size === sizes[sizes.length - 1]) return lines(ctx, text, x, y, size, 900, color, maxW, maxLines);
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
function rounded(ctx, im, x, y, w, h, r, zoom = 1) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.clip(); cover(ctx, im, x, y, w, h, zoom); ctx.restore();
}
function mosaic(ctx, imgs, x, y, w, h, zoom = 1) {
  const g = 14;
  if (imgs.length === 1) return rounded(ctx, imgs[0], x, y, w, h, 28, zoom);
  if (imgs.length === 2) { const cw = (w - g) / 2; rounded(ctx, imgs[0], x, y, cw, h, 28, zoom); rounded(ctx, imgs[1], x + cw + g, y, cw, h, 28, zoom); return; }
  const lw = (w - g) * 0.56, rw = w - g - lw, rh = (h - g) / 2;
  rounded(ctx, imgs[0], x, y, lw, h, 28, zoom); rounded(ctx, imgs[1], x + lw + g, y, rw, rh, 24, zoom); rounded(ctx, imgs[2], x + lw + g, y + rh + g, rw, rh, 24, zoom);
}
function lines(ctx, text, x, y, size, weight, color, maxW, maxLines = 3, lh = 1.04, align = 'left') {
  ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align;
  const all = wrap(ctx, text, maxW), ls = all.slice(0, maxLines);
  // Si no entra, la última línea termina en "…".
  if (all.length > maxLines) {
    let last = ls[maxLines - 1];
    while (last && ctx.measureText(`${last}…`).width > maxW) last = last.slice(0, -1);
    ls[maxLines - 1] = `${last.trimEnd()}…`;
  }
  ls.forEach((l, i) => ctx.fillText(l, x, y + i * size * lh));
  ctx.textAlign = 'left';
  return ls.length * size * lh;
}
const credit = i => `${i.ig ? `@${i.ig}` : i.name}${i.city ? ` · 📍 ${i.city}` : ''}`;
const searchLine = i => (i.modes.how
  ? `${i.modes.how[0].toUpperCase()}${i.modes.how.slice(1)}. El original sin marca de agua, totalmente enfocado y en alta calidad.`
  : 'Descargá el original sin marca de agua, totalmente enfocado y en alta calidad.');

function coverPost(i, imgs) {
  const { pal } = i;
  const [c, ctx] = canvas(1350);
  background(ctx, pal, 1350);
  brand(ctx, i.logo, 80, 80, pal);
  pill(ctx, '📸 Ya están las fotos', 80, 190, { bg: pal.accent, fg: pal.onAccent });
  mosaic(ctx, imgs, 80, 300, W - 160, 560);
  let y = 950;
  y += title(ctx, i.ev.name, 80, y, W - 160, 3, [76, 66, 58], pal.fg) + 6;
  lines(ctx, `${i.date} · Fotos de ${credit(i)}`, 80, y, 36, 500, pal.sub, W - 160, 2, 1.3);
  ctx.font = `700 34px ${FONT}`; ctx.fillStyle = pal.accent === '#0f1115' ? '#fff' : pal.accent; ctx.textAlign = 'left'; ctx.fillText('quieromisfotos.com.ar', 80, 1270);
  ctx.textAlign = 'right'; ctx.fillStyle = pal.mute; ctx.font = `700 30px ${FONT}`; ctx.fillText('Deslizá →', W - 80, 1270);
  return c;
}
function photoPost(i, im, n, total) {
  const { pal } = i;
  const [c, ctx] = canvas(1350);
  ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, 1350);
  cover(ctx, im, 0, 0, W, 1350);
  const g = ctx.createLinearGradient(0, 0, 0, 1350);
  g.addColorStop(0, 'rgba(15,17,21,.6)'); g.addColorStop(0.18, 'rgba(15,17,21,0)'); g.addColorStop(0.72, 'rgba(15,17,21,0)'); g.addColorStop(1, 'rgba(15,17,21,.85)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, 1350);
  ctx.fillStyle = 'rgba(15,17,21,.72)'; ctx.beginPath(); ctx.roundRect(54, 58, 410, 88, 44); ctx.fill();
  brand(ctx, i.logo, 70, 70, pal, true);
  ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10;
  lines(ctx, i.ev.name, 70, 1210, 40, 800, '#fff', W - 260, 1);
  ctx.restore();
  ctx.font = `600 30px ${FONT}`; ctx.fillStyle = '#d6dae2'; ctx.textAlign = 'left'; ctx.fillText(`Fotos de ${credit(i)}`, 70, 1262, W - 260);
  // Número de foto en una pastilla con el color del acento.
  const t = `${n}/${total}`; ctx.font = `800 30px ${FONT}`;
  const pw = ctx.measureText(t).width + 36;
  ctx.fillStyle = pal.accent; ctx.beginPath(); ctx.roundRect(W - 70 - pw, 1222, pw, 56, 28); ctx.fill();
  ctx.fillStyle = pal.onAccent; ctx.textAlign = 'center'; ctx.fillText(t, W - 70 - pw / 2, 1261); ctx.textAlign = 'left';
  return c;
}
function closingPost(i, n) {
  const { pal } = i;
  const [c, ctx] = canvas(1350);
  background(ctx, pal, 1350);
  brand(ctx, i.logo, 80, 80, pal);
  let y = 520;
  y += lines(ctx, 'Buscá la tuya 👀', 80, y, 104, 900, pal.fg, W - 160, 2);
  y += 20;
  y += lines(ctx, searchLine(i), 80, y, 40, 500, pal.sub, W - 160, 4, 1.3);
  pill(ctx, 'Link en la bio · quieromisfotos.com.ar', 80, y + 50, { size: 32, bg: pal.accent, fg: pal.onAccent });
  ctx.font = `600 32px ${FONT}`; ctx.fillStyle = pal.mute; ctx.textAlign = 'left'; ctx.fillText(`Fotos de ${credit(i)}`, 80, 1270, W - 260);
  ctx.textAlign = 'right'; ctx.font = `800 30px ${FONT}`; ctx.fillStyle = pal.fg; ctx.fillText(`${n}/${n}`, W - 80, 1270); ctx.textAlign = 'left';
  return c;
}
// Historia: sin botón dibujado (el sticker de link de Instagram es más grande y lo tapaba): queda el lugar libre abajo.
// "Fotos de" queda sin nombre para poner al lado el sticker de mención (así al fotógrafo le llega el aviso).
function storyPost(i, imgs) {
  const { pal } = i;
  const H = 1920;
  const [c, ctx] = canvas(H);
  background(ctx, pal, H);
  brand(ctx, i.logo, 80, 140, pal);
  pill(ctx, '📸 Ya están las fotos', 80, 260, { bg: pal.accent, fg: pal.onAccent });
  mosaic(ctx, imgs, 80, 380, W - 160, 780);
  let y = 1260;
  y += title(ctx, i.ev.name, 80, y, W - 160, 3, [84, 72, 62], pal.fg) + 6;
  y += lines(ctx, `${i.date}${i.city ? ` · 📍 ${i.city}` : ''}`, 80, y, 38, 500, pal.sub, W - 160, 1, 1.3);
  lines(ctx, '📷 Fotos de', 80, y + 14, 38, 700, pal.sub, W - 160, 1, 1.3);
  // Lugar libre para el sticker de link (va centrado, abajo).
  ctx.font = `800 34px ${FONT}`; ctx.fillStyle = pal.mute; ctx.textAlign = 'center';
  ctx.fillText('Tocá el link para ver todas 👇', W / 2, H - 330);
  ctx.textAlign = 'left';
  return c;
}

// ------------------------------------------------------------------ reel (video vertical 1080×1920, sin audio)
// Intro con la portada, las fotos elegidas con zoom lento y cierre "Buscá la tuya". Se graba en tiempo real.
async function reelVideo(i, imgs, onProgress) {
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) throw new Error('Este navegador no puede armar videos. Probá desde Chrome o Safari actualizados.');
  const { pal } = i;
  const H = 1920, FPS = 30, INTRO = 66, SLIDE = 42, OUTRO = 84, N = imgs.length, TOTAL = INTRO + N * SLIDE + OUTRO;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const draw = f => {
    ctx.globalAlpha = 1;
    if (f < INTRO) {
      background(ctx, pal, H);
      const a = ease(f / 14), b = ease((f - 8) / 14);
      brand(ctx, i.logo, 80, 140, pal);
      ctx.globalAlpha = a; pill(ctx, '📸 Ya están las fotos', 80, 260, { bg: pal.accent, fg: pal.onAccent });
      ctx.globalAlpha = b; mosaic(ctx, imgs.slice(0, 3), 80, 380 + (1 - b) * 40, W - 160, 780, 1.08 - 0.08 * ease(f / INTRO));
      ctx.globalAlpha = ease((f - 16) / 14);
      let y = 1260;
      y += title(ctx, i.ev.name, 80, y, W - 160, 3, [84, 72, 62], pal.fg) + 6;
      lines(ctx, `${i.date}${i.city ? ` · 📍 ${i.city}` : ''}`, 80, y, 38, 500, pal.sub, W - 160, 1, 1.3);
      ctx.globalAlpha = 1;
      return;
    }
    if (f < INTRO + N * SLIDE) {
      const k = Math.floor((f - INTRO) / SLIDE), t = ((f - INTRO) % SLIDE) / SLIDE;
      ctx.fillStyle = pal.bg; ctx.fillRect(0, 0, W, H);
      cover(ctx, imgs[k], 0, 0, W, H, 1.15 - 0.13 * ease(t), (k % 2 ? -30 : 30) * (1 - ease(t)));
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(0.25, 'rgba(0,0,0,0)'); g.addColorStop(0.7, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.7)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(15,17,21,.72)'; ctx.beginPath(); ctx.roundRect(54, 118, 410, 88, 44); ctx.fill();
      brand(ctx, i.logo, 70, 130, pal, true);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 10;
      lines(ctx, i.ev.name, 70, H - 250, 46, 800, '#fff', W - 140, 2, 1.1);
      ctx.restore();
      ctx.font = `600 34px ${FONT}`; ctx.fillStyle = '#d6dae2'; ctx.textAlign = 'left'; ctx.fillText(`Fotos de ${credit(i)}`, 70, H - 120, W - 140);
      return;
    }
    background(ctx, pal, H);
    const s = ease((f - INTRO - N * SLIDE) / 16);
    ctx.globalAlpha = s;
    brand(ctx, i.logo, 80, 140, pal);
    let y = 760;
    y += lines(ctx, 'Buscá la tuya 👀', W / 2, y, 120 * (0.85 + 0.15 * s), 900, pal.fg, W - 160, 2, 1.04, 'center') + 30;
    y += lines(ctx, searchLine(i), W / 2, y, 42, 500, pal.sub, W - 200, 4, 1.3, 'center');
    ctx.font = `800 40px ${FONT}`;
    const t = 'Link en la bio · quieromisfotos.com.ar', pw = Math.min(W - 120, ctx.measureText(t).width + 80);
    ctx.fillStyle = pal.accent; ctx.beginPath(); ctx.roundRect((W - pw) / 2, y + 60, pw, 96, 48); ctx.fill();
    ctx.fillStyle = pal.onAccent; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(t, W / 2, y + 110, W - 180); ctx.textBaseline = 'alphabetic';
    ctx.font = `600 36px ${FONT}`; ctx.fillStyle = pal.mute; ctx.fillText(`Fotos de ${credit(i)}`, W / 2, H - 200, W - 160);
    ctx.textAlign = 'left'; ctx.globalAlpha = 1;
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
