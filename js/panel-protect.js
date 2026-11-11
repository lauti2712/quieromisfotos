// Superadmin → Almacenamiento → "Protección de fotos":
//  - ajustes de las versiones protegidas (desenfoque, tamaño y calidad), con una prueba sobre una foto propia;
//  - proteger un álbum ya subido (a pedido, de a un álbum): primero se ve cómo quedan sin guardar nada; después se aplica.
//    Las fotos subidas antes de este cambio quedan como están salvo que se elija su álbum acá. Los originales no se tocan.
import { db, auth, doc, setDoc, getDoc, getDocs, collection, query, where, limit, serverTimestamp } from './fb.js';
import { $, $$, esc, toast, errMsg, fmtBytes, normalize } from './util.js';
import { API_BASE, loadLogoBitmap, apiPost } from './api.js';
import { PROTECT_DEFAULTS, PROTECT_LEVELS, protectOf, makeProtected, levelOf } from './protect.js';
import { DEFAULT_WATERMARK, wantsLogo } from './watermark.js';

const FIELDS = [
  ['thumbSide', 'Miniatura: lado más largo (px)', 1],
  ['thumbBlur', 'Miniatura: desenfoque extra', 0.1],
  ['thumbQuality', 'Miniatura: calidad JPEG (0,3 a 0,9)', 0.05],
  ['previewSide', 'Foto ampliada: lado más largo (px)', 10],
  ['previewBlur', 'Foto ampliada: desenfoque', 0.1],
  ['previewQuality', 'Foto ampliada: calidad JPEG (0,3 a 0,9)', 0.05],
];
const PREVIEW_N = 6; // fotos que se muestran en "Ver cómo quedan"

export function mountProtectCard(box, { settings, onSaved }) {
  const cfg = protectOf(settings);
  box.innerHTML = `
    <h2 style="margin:0">🛡️ Protección de fotos</h2>
    <p class="muted small" style="margin:0">Lo que se ve antes de comprar: una <strong>miniatura</strong> muy desenfocada (cuadrícula y estado inicial del visor)
      y una <strong>foto ampliada</strong> algo más clara, que aparece al pasar el mouse o tocar la foto. Las dos llevan el desenfoque y la marca de agua grabados en los píxeles.
      Lo más claro que se puede ver es lo que alguien puede capturar: subir el desenfoque protege más, pero cuesta más reconocerse. Los originales no se tocan.</p>
    <form id="pr-form" class="stack">
      <div class="grid2">${FIELDS.map(([k, label]) => `<label class="field">${label}
        <input type="number" data-k="${k}" step="any" min="0" value="${cfg[k]}" placeholder="${PROTECT_DEFAULTS[k]}"></label>`).join('')}</div>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <label class="btn sm">🧪 Probar con una foto<input type="file" id="pr-test" accept="image/jpeg,image/png,image/webp" hidden></label>
        <button type="button" class="btn sm ghost" id="pr-reset">Valores recomendados</button>
        <span class="spacer" style="flex:1"></span><button class="btn primary">Guardar</button>
      </div>
      <p class="muted small" style="margin:0">Los cambios valen para las fotos que se suban desde ahora. Las fotos ya subidas no cambian, salvo el álbum que protejas abajo.</p>
      <div id="pr-out"></div>
    </form>
    <hr>
    <h3 style="margin:0">Proteger un álbum ya subido</h3>
    <p class="muted small" style="margin:0">Las fotos subidas antes de este cambio <strong>no se modifican</strong>, salvo el álbum que elijas acá.
      Primero tocá <strong>Ver cómo quedan</strong> (no guarda nada). Si te gusta, <strong>Aplicar a este álbum</strong> regenera su miniatura y su foto ampliada con los ajustes de arriba y el nivel que eligió el fotógrafo, desde los originales, y borra las anteriores.
      Sirve también para volver a aplicar ajustes nuevos a un álbum ya protegido.
      Corre en esta pestaña: dejala abierta.</p>
    <div class="row" style="gap:8px;flex-wrap:wrap"><input type="search" id="pr-q" placeholder="Nombre del evento" style="flex:1;min-width:200px"><button type="button" class="btn sm" id="pr-find">Buscar</button></div>
    <div id="pr-albums" class="stack"></div>
    `;

  // level: nivel del álbum (lo elige el fotógrafo); escala el desenfoque de estos ajustes.
  const read = (level = null) => {
    const o = {};
    $$('#pr-form [data-k]', box).forEach(i => { if (i.value !== '') o[i.dataset.k] = Number(i.value); });
    return protectOf({ protect: o }, level);
  };
  $('#pr-reset', box).onclick = () => $$('#pr-form [data-k]', box).forEach(i => { i.value = PROTECT_DEFAULTS[i.dataset.k]; });
  $('#pr-form', box).onsubmit = async e => {
    e.preventDefault();
    try {
      await setDoc(doc(db, 'settings', 'platform'), { protect: read(), updatedAt: serverTimestamp() }, { merge: true });
      toast('Protección guardada');
      onSaved?.();
    } catch (err) { toast(errMsg(err), 'error'); }
  };
  // Prueba: muestra cómo quedarían la miniatura y la foto ampliada (no sube nada).
  $('#pr-test', box).onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    const out = $('#pr-out', box);
    out.innerHTML = '<p class="muted small">Procesando…</p>';
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' });
      const r = await makeProtected(bmp, bmp.width, bmp.height, { ...DEFAULT_WATERMARK, name: 'Fotógrafo' }, null, 'prueba123', read());
      bmp.close?.();
      const u1 = URL.createObjectURL(r.thumb), u2 = URL.createObjectURL(r.preview);
      out.innerHTML = `<div class="grid2">
        <figure style="margin:0"><img src="${u1}" alt="" style="width:100%;border-radius:8px"><figcaption class="muted small">Miniatura / estado inicial · ${fmtBytes(r.thumb.size)}</figcaption></figure>
        <figure style="margin:0"><img src="${u2}" alt="" style="width:100%;border-radius:8px"><figcaption class="muted small">Foto ampliada (lo más claro que se ve) · ${fmtBytes(r.preview.size)}</figcaption></figure></div>`;
    } catch (err) { out.innerHTML = ''; toast(errMsg(err), 'error'); }
  };

  // ---- un álbum (evento + fotógrafo)
  const names = new Map();
  const nameOf = async uid => {
    if (!names.has(uid)) names.set(uid, getDoc(doc(db, 'users', uid)).then(d => d.data()?.displayName || uid).catch(() => uid));
    return names.get(uid);
  };
  $('#pr-find', box).onclick = async () => {
    const words = normalize($('#pr-q', box).value).split(/[^a-z0-9]+/).filter(w => w.length >= 2);
    const out = $('#pr-albums', box);
    if (!words.length) return toast('Escribí una palabra del nombre del evento.', 'error');
    const w = words.sort((x, y) => y.length - x.length)[0];
    out.innerHTML = '<p class="muted small">Buscando…</p>';
    try {
      const snap = await getDocs(query(collection(db, 'events'), where('searchTokens', 'array-contains', w), limit(30)));
      const evs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
        .filter(ev => words.every(x => normalize(ev.name).includes(x) || (ev.searchTokens || []).includes(x)));
      const rows = [];
      for (const ev of evs) for (const uid of ev.photographerUids || []) {
        const set = (await getDoc(doc(db, 'events', ev.id, 'sets', uid)).catch(() => null))?.data() || {};
        rows.push({ ev, uid, set, name: `${await nameOf(uid)} · protección ${levelOf(set).label.toLowerCase()}` });
      }
      out.innerHTML = rows.length ? rows.map((r, i) => `<div class="row" style="justify-content:space-between;gap:8px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding:6px 0">
          <span><strong>${esc(r.ev.name || r.ev.id)}</strong> <span class="muted small">${esc(r.ev.date || '')} · ${esc(r.name)}</span></span>
          <span class="row" style="gap:6px"><button type="button" class="btn sm" data-prev="${i}">👀 Ver cómo quedan</button><button type="button" class="btn sm primary" data-run="${i}">🛡️ Aplicar a este álbum</button></span>
          <div class="stack" data-st="${i}" style="width:100%"></div></div>`).join('')
        : '<p class="muted small">No encontré eventos con ese nombre.</p>';
      $$('[data-prev]', out).forEach(b => b.onclick = () => previewAlbum(rows[+b.dataset.prev], $(`[data-st="${b.dataset.prev}"]`, out)));
      $$('[data-run]', out).forEach(b => b.onclick = () => runAlbum(rows[+b.dataset.run], $(`[data-st="${b.dataset.run}"]`, out), b));
    } catch (err) { out.innerHTML = ''; toast(errMsg(err), 'error'); }
  };
  $('#pr-q', box).addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#pr-find', box).click(); } });

  const albumPhotos = async ({ ev, uid }) => {
    const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', uid), limit(5000)));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  };
  const wmOf = async uid => {
    const u = (await getDoc(doc(db, 'users', uid)).catch(() => null))?.data() || {};
    const wm = { ...DEFAULT_WATERMARK, ...(u.watermark || {}), name: u.displayName || '' };
    const logo = wantsLogo(wm) ? await loadLogoBitmap(wm.logoKey).catch(() => null) : null;
    return { wm, logo };
  };

  // Antes y después de algunas fotos del álbum, sin subir ni cambiar nada.
  async function previewAlbum(row, st) {
    st.innerHTML = '<p class="muted small" style="margin:0">Preparando…</p>';
    try {
      const all = await albumPhotos(row);
      const prot = all.filter(p => p.pv >= 2).length;
      if (!all.length) { st.innerHTML = '<p class="muted small" style="margin:0">El álbum no tiene fotos.</p>'; return; }
      const pick = all.filter(p => !p.hidden).slice(0, PREVIEW_N);
      const conf = read(row.set.protectLevel), mark = await wmOf(row.uid);
      const cards = [];
      for (const p of pick) {
        const [now, src] = await Promise.all([currentOf(p), sourceOf(p)]);
        const bmp = await createImageBitmap(src, { imageOrientation: 'from-image' });
        const r = await makeProtected(bmp, bmp.width, bmp.height, mark.wm, mark.logo, p.id, conf);
        bmp.close?.();
        cards.push({ before: URL.createObjectURL(now), thumb: URL.createObjectURL(r.thumb), after: URL.createObjectURL(r.preview), bs: now.size, ts: r.thumb.size, as: r.preview.size });
      }
      st.innerHTML = `<p class="small" style="margin:0">${prot} de ${all.length} fotos ya protegidas. Vista previa de ${cards.length} con los ajustes de arriba (no se guardó nada):</p>
        ${cards.map(c => `<div class="pr-cmp" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px">
          <figure style="margin:0"><img src="${c.before}" alt="" style="width:100%;border-radius:6px"><figcaption class="muted small">Ahora (ampliada) · ${fmtBytes(c.bs)}</figcaption></figure>
          <figure style="margin:0"><img src="${c.thumb}" alt="" style="width:100%;border-radius:6px"><figcaption class="muted small">Al abrir (miniatura) · ${fmtBytes(c.ts)}</figcaption></figure>
          <figure style="margin:0"><img src="${c.after}" alt="" style="width:100%;border-radius:6px"><figcaption class="muted small">Al tocar (lo más claro) · ${fmtBytes(c.as)}</figcaption></figure></div>`).join('')}`;
    } catch (err) { st.innerHTML = ''; toast(errMsg(err), 'error'); }
  }

  let running = false;
  async function runAlbum(row, st, btn) {
    if (running) return toast('Ya hay un álbum protegiéndose.', 'error');
    if (!confirm(`¿Aplicar la protección a las fotos de "${row.ev.name}" (${row.name})? Se regeneran su miniatura y su foto ampliada desde los originales y se borran las anteriores. Los originales no se tocan.`)) return;
    running = true; btn.disabled = true;
    let stop = false, done = 0, fail = 0;
    st.innerHTML = '<div class="row" style="gap:8px"><span class="small" data-msg>Buscando fotos…</span><button type="button" class="btn sm ghost" data-stop>Frenar</button></div>';
    const msg = t => { $('[data-msg]', st).innerHTML = t; };
    $('[data-stop]', st).onclick = e => { stop = true; e.target.disabled = true; };
    try {
      // Las que ya tienen la versión más alta posible o perdieron el original (álbum vencido) y ya están protegidas, quedan.
      const todo = (await albumPhotos(row)).filter(p => (p.previewUrl || p.thumbUrl) && (p.pv || 1) < 9 && !(p.originalDeleted && p.pv >= 2));
      const conf = read(row.set.protectLevel), mark = await wmOf(row.uid);
      let i = 0;
      const worker = async () => {
        while (!stop && i < todo.length) {
          const p = todo[i++];
          try { await migrateOne(p, row.ev, conf, mark); done++; p.pv = (p.pv || 1) + 1; }
          catch (err) { fail++; console.warn('proteger', p.id, err); }
          msg(`${done + fail} de ${todo.length}${fail ? ` · ⚠️ ${fail} con error` : ''}`);
        }
      };
      await worker(); // de a una: los originales pesan (memoria del navegador)
      msg(stop ? `⏸️ Frenado: ${done} protegidas. Tocá de nuevo para seguir.` : `✅ Listo: ${done} fotos protegidas${fail ? ` · ⚠️ ${fail} con error (tocá de nuevo para reintentar)` : ''}.`);
      $('[data-stop]', st)?.remove();
    } catch (err) { toast(errMsg(err), 'error'); msg(`Error: ${esc(errMsg(err))}`); }
    running = false; btn.disabled = false;
  }
}

// Cómo se ve hoy (la ampliada pública), vía la API (con CORS).
async function currentOf(p) {
  const path = url => `${API_BASE}/public/${new URL(url).pathname.replace(/^\//, '')}`;
  for (const u of [p.previewUrl, p.thumbUrl]) {
    if (!u) continue;
    const res = await fetch(path(u)).catch(() => null);
    if (res?.ok) return res.blob();
  }
  throw new Error('No se encontró la muestra');
}

// De dónde se genera: el original (link firmado para el superadmin); si ya no está (álbum vencido), la muestra actual,
// solo si todavía no estaba protegida (desenfocar dos veces la dejaría peor).
async function sourceOf(p) {
  if (!p.originalDeleted) {
    try {
      const r = await apiPost(`/review/original/${p.id}`);
      const res = await fetch(r.url);
      if (res.ok) return res.blob();
    } catch { /* sigue con la muestra */ }
  }
  if (p.pv >= 2) throw new Error('Sin original: ya está protegida');
  return currentOf(p);
}

// Genera las protegidas desde el original (o la muestra vieja) y las sube como la versión siguiente.
async function migrateOne(p, ev, conf, { wm, logo }) {
  const blob = await sourceOf(p);
  const pv = Math.max(2, (p.pv || 1) + 1);
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  let r;
  try { r = await makeProtected(bmp, bmp.width, bmp.height, wm, logo, p.id, conf); } finally { bmp.close?.(); }
  const token = await auth.currentUser.getIdToken();
  const base = `${API_BASE}/admin/protect/${ev.id}/${p.photographerUid}/${p.id}`;
  const send = async (url, init) => {
    const res = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers || {}) } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  };
  await send(`${base}/preview?pv=${pv}`, { method: 'PUT', body: r.preview, headers: { 'Content-Type': 'image/jpeg' } });
  await send(`${base}/thumb?pv=${pv}`, { method: 'PUT', body: r.thumb, headers: { 'Content-Type': 'image/jpeg' } });
  await send(`${base}/commit`, { method: 'POST', body: JSON.stringify({ pv, cover: !!ev.autoCoverUrl && ev.autoCoverUrl === p.previewUrl }), headers: { 'Content-Type': 'application/json' } });
}

// ---- Para el fotógrafo: ejemplos de cada nivel de protección, sobre una foto de muestra o una suya (no se sube nada).
// select: el <select> del nivel del álbum (tocar un ejemplo lo elige).
const SAMPLE_PHOTO = 'demo/run-cover.jpg';
export function mountLevelExamples(box, { settings, profile, select }) {
  box.innerHTML = `<div class="row" style="gap:8px;flex-wrap:wrap">
      <button type="button" class="btn sm" id="lv-show">👀 Ver ejemplos de cada nivel</button>
      <label class="btn sm ghost">📷 Probar con una foto mía<input type="file" id="lv-file" accept="image/jpeg,image/png,image/webp" hidden></label>
    </div>
    <div id="lv-out" class="stack" style="margin-top:8px"></div>`;
  const out = $('#lv-out', box);
  let mark = null;
  const markOf = async () => {
    if (mark) return mark;
    const wm = { ...DEFAULT_WATERMARK, ...(profile?.watermark || {}), name: profile?.displayName || '' };
    const logo = wantsLogo(wm) ? await loadLogoBitmap(wm.logoKey).catch(() => null) : null;
    return (mark = { wm, logo });
  };
  const draw = async source => {
    out.innerHTML = '<p class="muted small" style="margin:0">Preparando los ejemplos…</p>';
    try {
      const blob = source || await (await fetch(SAMPLE_PHOTO)).blob();
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      const { wm, logo } = await markOf();
      const cards = [];
      for (const l of PROTECT_LEVELS) {
        const r = await makeProtected(bmp, bmp.width, bmp.height, wm, logo, 'ejemplo1', protectOf(settings, l.id));
        cards.push({ l, t: URL.createObjectURL(r.thumb), p: URL.createObjectURL(r.preview) });
      }
      bmp.close?.();
      out.innerHTML = `<p class="muted small" style="margin:0">Así ve el público tu foto con cada nivel ${source ? '(tu foto no se subió)' : '(foto de ejemplo)'}. Tocá uno para elegirlo.</p>
        ${cards.map(c => `<button type="button" class="lv-card ${select.value === c.l.id ? 'on' : ''}" data-lv="${c.l.id}">
          <strong>${esc(c.l.label)}</strong>
          <span class="lv-imgs"><figure><img src="${c.t}" alt=""><figcaption>Al abrir</figcaption></figure><figure><img src="${c.p}" alt=""><figcaption>Con la lupa (lo más claro)</figcaption></figure></span>
          <span class="muted small">${esc(c.l.hint)}</span></button>`).join('')}`;
      $$('[data-lv]', out).forEach(b => b.onclick = () => {
        select.value = b.dataset.lv;
        select.dispatchEvent(new Event('change'));
        $$('[data-lv]', out).forEach(x => x.classList.toggle('on', x === b));
      });
    } catch (err) { out.innerHTML = ''; toast(errMsg(err), 'error'); }
  };
  $('#lv-show', box).onclick = () => draw(null);
  $('#lv-file', box).onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) draw(f); };
  select.addEventListener('change', () => $$('[data-lv]', out).forEach(x => x.classList.toggle('on', x.dataset.lv === select.value)));
}
