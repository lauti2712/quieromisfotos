// Panel: portfolio del fotógrafo (fotos de muestra que no se venden). Gratis: N fotos; Pro: más.
import { db, collection, doc, getDocs, setDoc, deleteDoc, updateDoc, query, where, serverTimestamp } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg } from './util.js';
import { processFile } from './image-proc.js';
import { uploadAsset, deleteAsset, API_BASE } from './api.js';
import { DEFAULT_WATERMARK } from './watermark.js';
import { isPro, portfolioLimit } from './data.js';

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
      <label class="check"><input type="checkbox" id="pf-wm" checked> Aplicar mi marca de agua</label>
      <div id="pf-progress" class="small muted"></div>
    </div>
    <div class="card"><div class="photo-grid" id="pf-grid"></div></div>`;

  function drawPlan() {
    const used = items.filter(i => i.slot < max).length;
    $('#pf-plan').innerHTML = `
      <div class="row" style="justify-content:space-between">
        <div><strong>${pro ? '⭐ Plan Pro' : 'Plan Gratis'}</strong> · ${used} de ${max} fotos
          ${pro ? `<div class="muted small">Activo hasta el ${esc(fmtTs(profile.proUntil))}</div>` : ''}</div>
        ${pro ? '' : `<span class="pill accent">Pro: ${fmtMoney(settings.proPrice)}/mes</span>`}
      </div>
      <div class="progress"><span style="width:${Math.min(100, (used / max) * 100)}%"></span></div>
      ${pro ? '' : `<p class="muted small" style="margin:0">Con <strong>Pro</strong> subís hasta ${settings.proPortfolioLimit} fotos y aparecés destacado en el directorio de fotógrafos. La suscripción se habilita muy pronto.</p>`}`;
  }

  function draw() {
    items.sort((a, b) => (a.order || 0) - (b.order || 0) || a.slot - b.slot);
    drawPlan();
    $('#pf-grid').innerHTML = items.length ? items.map(p => `
      <div class="ph ${p.slot >= max ? 'is-hidden' : ''}" data-id="${p.id}">
        <img src="${esc(p.thumbUrl)}" alt="" loading="lazy">
        <span class="ph-meta">${p.slot >= max ? '<span class="pill warn">Oculta: supera tu plan</span>' : ''}${p.caption ? `<span class="pill">${esc(p.caption)}</span>` : ''}</span>
        <span class="ph-actions">
          <button class="btn sm" data-cap="${p.id}" title="Descripción">✎</button>
          <button class="btn sm danger" data-del="${p.id}" title="Borrar">✕</button>
        </span>
      </div>`).join('') : '<div class="empty" style="grid-column:1/-1">Todavía no subiste fotos a tu portfolio.</div>';
    $$('[data-del]').forEach(b => b.onclick = () => remove(items.find(i => i.id === b.dataset.del)));
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
      await Promise.all([it.urlKey, it.thumbKey].filter(Boolean).map(k => deleteAsset(k).catch(() => {})));
    } catch (e) { toast(errMsg(e), 'error'); }
  }

  async function addFiles(files) {
    if (busy) return toast('Esperá a que termine la subida anterior.', 'error');
    const free = [];
    const used = new Set(items.map(i => i.slot));
    for (let k = 0; k < max && free.length < files.length; k++) if (!used.has(k)) free.push(k);
    if (!free.length) return toast(`Llegaste al límite de ${max} fotos de tu plan.`, 'error');
    if (free.length < files.length) toast(`Solo entran ${free.length} foto(s) más en tu plan.`, 'error');

    const wm = $('#pf-wm').checked ? { ...DEFAULT_WATERMARK, text: profile.displayName, ...(profile.watermark || {}) } : null;
    let logo = null;
    if (wm?.type === 'logo' && wm.logoKey) {
      try { logo = await createImageBitmap(await (await fetch(`${API_BASE}/public/${wm.logoKey}`)).blob()); } catch { wm.type = 'text'; }
    }
    busy = true;
    let done = 0;
    const list = [...files].slice(0, free.length);
    for (const [n, file] of list.entries()) {
      $('#pf-progress').textContent = `Subiendo ${n + 1} de ${list.length}…`;
      try {
        const r = await processFile(file, wm, logo);
        const [p, t] = [await uploadAsset('portfolio', r.preview), await uploadAsset('portfolio', r.thumb)];
        const slot = free[n];
        const data = {
          photographerUid: uid, slot, url: p.url, thumbUrl: t.url, urlKey: p.key, thumbKey: t.key,
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
