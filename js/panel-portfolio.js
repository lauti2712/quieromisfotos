// Panel: portfolio del fotógrafo (fotos de muestra que no se venden). Gratis: N fotos; Pro: más.
import { db, collection, doc, getDocs, setDoc, deleteDoc, updateDoc, query, where, serverTimestamp } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg } from './util.js';
import { processFile } from './image-proc.js';
import { uploadAsset, deleteAsset, loadLogoBitmap } from './api.js';
import { DEFAULT_WATERMARK, wantsLogo } from './watermark.js';
import { isPro, portfolioLimit, planOf, PLANS, planSpec } from './data.js';

export async function viewPortfolio(view, { uid, profile, settings }) {
  const pro = isPro(profile);
  const max = portfolioLimit(profile, settings);
  let items = [];
  let busy = false;

  view.innerHTML = `
    <h1>Portfolio</h1>
    <p class="muted">Mostrá tus mejores trabajos en tu perfil. Estas fotos no se venden: sirven para que te conozcan y te pidan presupuesto.</p>
    <div class="card stack" id="pf-plan"></div>
    <div class="card stack">
      <label class="dropzone" id="pf-dz">
        <input type="file" id="pf-files" multiple accept="image/jpeg,image/png,image/webp" hidden>
        <strong>Arrastrá fotos acá o tocá para elegirlas</strong>
        <span class="muted small">Se guarda una versión web (1600px); el original no se sube.</span>
      </label>
      <p class="muted small" style="margin:0">${wantsLogo(profile.watermark)
        ? 'Se aplica la marca de agua del sitio (www.quieromisfotos.com.ar) en mosaico y <strong>tu logo en el centro</strong>.'
        : 'Se aplica la marca de agua del sitio (www.quieromisfotos.com.ar). Si querés sumar <strong>tu logo en el centro</strong>, activalo en <a href="#/config">Precios y marca</a>.'}</p>
      <label class="field" style="max-width:320px">Álbum <span class="hint">Las fotos se agrupan así en tu web (ej: Rugby, Books, Eventos).</span>
        <input type="text" id="pf-album" list="pf-albums" maxlength="30" placeholder="Sin álbum"></label>
      <datalist id="pf-albums"></datalist>
      <div id="pf-progress" class="small muted"></div>
    </div>
    <div class="card"><div class="photo-grid" id="pf-grid"></div></div>`;

  function drawPlan() {
    const used = items.filter(i => i.slot < max).length;
    $('#pf-plan').innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div><strong>${pro ? `⭐ Plan ${PLANS[planOf(profile)].label}` : 'Plan Gratis'}</strong> · ${used} de ${max} fotos
          ${pro ? `<div class="muted small">Activo hasta el ${esc(fmtTs(profile.proUntil))}</div>` : ''}</div>
        ${pro ? '' : `<a class="pill accent" href="#/web" style="text-decoration:none">Pro: ${fmtMoney(settings.proPrice)}/mes</a>`}
      </div>
      <div class="progress"><span style="width:${Math.min(100, (used / max) * 100)}%"></span></div>
      ${pro ? '' : settings.plansV2
        ? `<p class="muted small" style="margin:0">Con <strong>Profesional Lite</strong> subís hasta ${planSpec('lite', settings).portfolio} fotos; con <strong>Profesional</strong>, ${planSpec('web', settings).portfolio} y además tenés tu propia web. <a href="#/web">Ver planes</a></p>`
        : `<p class="muted small" style="margin:0">Con <strong>Pro</strong> subís hasta ${settings.proPortfolioLimit} fotos y aparecés destacado en el directorio. Con el plan <strong>Web</strong> además tenés tu propia web. <a href="#/web">Ver planes</a></p>`}`;
  }

  const albums = () => [...new Set(items.map(i => (i.album || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  function draw() {
    items.sort((a, b) => (a.order || 0) - (b.order || 0) || a.slot - b.slot);
    drawPlan();
    $('#pf-albums').innerHTML = albums().map(a => `<option value="${esc(a)}">`).join('');
    $('#pf-grid').innerHTML = items.length ? items.map(p => `
      <div class="ph ${p.slot >= max ? 'is-hidden' : ''}" data-id="${p.id}">
        <img src="${esc(p.thumbUrl)}" alt="" loading="lazy">
        <span class="ph-meta">${p.slot >= max ? '<span class="pill warn">Oculta: supera tu plan</span>' : ''}${p.album ? `<span class="pill">📁 ${esc(p.album)}</span>` : ''}${p.caption ? `<span class="pill">${esc(p.caption)}</span>` : ''}</span>
        <span class="ph-actions">
          <button class="btn sm" data-alb="${p.id}" title="Álbum">📁</button>
          <button class="btn sm" data-cap="${p.id}" title="Descripción">✎</button>
          <button class="btn sm danger" data-del="${p.id}" title="Borrar">✕</button>
        </span>
      </div>`).join('') : '<div class="empty" style="grid-column:1/-1">Todavía no subiste fotos a tu portfolio.</div>';
    $$('[data-del]').forEach(b => b.onclick = () => remove(items.find(i => i.id === b.dataset.del)));
    $$('[data-alb]').forEach(b => b.onclick = async () => {
      const it = items.find(i => i.id === b.dataset.alb);
      const list = albums();
      const album = prompt(`Álbum de esta foto${list.length ? ` (existentes: ${list.join(', ')})` : ''}. Dejalo vacío para quitarla del álbum.`, it.album || '');
      if (album == null) return;
      const clean = album.trim().slice(0, 30);
      const same = list.find(a => a.toLowerCase() === clean.toLowerCase()) || clean;
      try { await updateDoc(doc(db, 'portfolio', it.id), { album: same }); it.album = same; draw(); }
      catch (e) { toast(errMsg(e), 'error'); }
    });
    $$('[data-cap]').forEach(b => b.onclick = async () => {
      const it = items.find(i => i.id === b.dataset.cap);
      const caption = prompt('Descripción corta (opcional)', it.caption || '');
      if (caption == null) return;
      try { await updateDoc(doc(db, 'portfolio', it.id), { caption: caption.trim().slice(0, 80) }); it.caption = caption.trim().slice(0, 80); draw(); }
      catch (e) { toast(errMsg(e), 'error'); }
    });
  }

  async function remove(it) {
    if (!confirm('¿Borrar esta foto del portfolio?')) return;
    try {
      await deleteDoc(doc(db, 'portfolio', it.id));
      items = items.filter(i => i.id !== it.id);
      draw();
      await Promise.all([it.urlKey, it.thumbKey, it.cleanKey].filter(Boolean).map(k => deleteAsset(k).catch(() => {})));
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  async function addFiles(files) {
    if (busy) return toast('Esperá a que termine la subida anterior.', 'error');
    const free = [];
    const used = new Set(items.map(i => i.slot));
    for (let k = 0; k < max && free.length < files.length; k++) if (!used.has(k)) free.push(k);
    if (!free.length) return toast(`Llegaste al límite de ${max} fotos de tu plan.`, 'error');
    if (free.length < files.length) toast(`Solo entran ${free.length} foto(s) más en tu plan.`, 'error');

    const wm = { ...DEFAULT_WATERMARK, ...(profile.watermark || {}) };
    let logo = null;
    if (wantsLogo(wm)) { try { logo = await loadLogoBitmap(wm.logoKey); } catch { /* va la marca del sitio */ } }
    busy = true;
    let done = 0;
    const list = [...files].slice(0, free.length);
    for (const [n, file] of list.entries()) {
      $('#pf-progress').textContent = `Subiendo ${n + 1} de ${list.length}…`;
      try {
        const r = await processFile(file, wm, logo);
        // Copia sin marca de agua: la usa la web personal si el fotógrafo elige mostrar sus fotos limpias.
        const c = await processFile(file, null);
        const [p, t, cl] = [await uploadAsset('portfolio', r.preview), await uploadAsset('portfolio', r.thumb), await uploadAsset('portfolio', c.preview)];
        const slot = free[n];
        const typed = $('#pf-album').value.trim().slice(0, 30);
        const album = albums().find(a => a.toLowerCase() === typed.toLowerCase()) || typed;
        const data = {
          photographerUid: uid, slot, url: p.url, thumbUrl: t.url, urlKey: p.key, thumbKey: t.key,
          cleanUrl: cl.url, cleanKey: cl.key, album,
          width: r.width, height: r.height, caption: '', order: Date.now(), createdAt: serverTimestamp(),
        };
        await setDoc(doc(db, 'portfolio', `${uid}_${slot}`), data);
        items.push({ id: `${uid}_${slot}`, ...data });
        done++;
        draw();
      } catch (e) { toast(`${file.name}: ${errMsg(e)}`, 'error'); }
    }
    busy = false;
    $('#pf-progress').textContent = done ? `✓ ${done} foto(s) agregadas.` : '';
  }

  $('#pf-files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  const dz = $('#pf-dz');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });

  const snap = await getDocs(query(collection(db, 'portfolio'), where('photographerUid', '==', uid)));
  items = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  draw();
}
