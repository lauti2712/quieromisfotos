// Panel: subida masiva y gestión de fotos del set de un fotógrafo en un evento.
import {
  db, collection, doc, getDocs, query, where, orderBy, limit, startAfter, writeBatch, updateDoc, increment, Timestamp,
} from './fb.js';
import { $, $$, esc, toast, errMsg } from './util.js';
import { createUploader } from './uploader.js';
import { uploadSession, apiDelete, API_BASE } from './api.js';
import { DEFAULT_WATERMARK } from './watermark.js';

const PAGE = 120;
let activeUploader = null;

window.addEventListener('beforeunload', e => {
  if (activeUploader?.busy()) { e.preventDefault(); e.returnValue = ''; }
});

export function uploadsInProgress() {
  return !!activeUploader?.busy();
}

export async function mountPhotos(box, { ev, set, uid, profile, settings }) {
  const subs = (set.subalbums || []).slice().sort((a, b) => a.order - b.order);
  const subName = id => subs.find(s => s.id === id)?.name || 'Sin sub-álbum';
  const subOptions = (sel = '') => `<option value="">Sin sub-álbum</option>${subs.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}`;

  box.innerHTML = `
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Subir fotos</h2>
        <label class="row small">Destino <select id="up-sub" style="width:auto">${subOptions()}</select></label>
      </div>
      <label class="dropzone" id="dz">
        <input type="file" id="up-files" multiple accept="image/jpeg,image/png,image/webp" hidden>
        <strong>Arrastrá las fotos acá</strong>
        <span class="muted small">o tocá para elegirlas · JPG, PNG o WEBP · la marca de agua se aplica en tu dispositivo</span>
      </label>
      <div id="up-status" class="hidden">
        <div class="row" style="justify-content:space-between">
          <span id="up-summary" class="small"></span>
          <span class="row"><button class="btn sm hidden" id="up-retry">Reintentar fallidas</button><button class="btn sm" id="up-clear">Limpiar terminadas</button></span>
        </div>
        <div class="progress"><span id="up-bar"></span></div>
        <div id="up-list" class="up-list"></div>
      </div>
    </div>
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">Mis fotos <span class="muted small" id="ph-count"></span></h2>
        <select id="ph-filter" style="width:auto"><option value="*">Todas</option>${subOptions()}</select>
      </div>
      <div class="row toolbar" id="ph-tools">
        <label class="check small"><input type="checkbox" id="ph-all"> Seleccionar todas</label>
        <span class="muted small" id="ph-sel"></span>
        <span class="spacer" style="flex:1"></span>
        <select id="ph-move" style="width:auto" disabled><option value="-">Mover a…</option>${subOptions().replace('value=""', 'value="__none"')}</select>
        <button class="btn sm" id="ph-hide" disabled>Ocultar</button>
        <button class="btn sm" id="ph-show" disabled>Mostrar</button>
        <button class="btn sm danger" id="ph-del" disabled>Borrar</button>
      </div>
      <div id="ph-grid" class="photo-grid"></div>
      <div class="row" style="justify-content:center"><button class="btn hidden" id="ph-more">Cargar más</button></div>
    </div>`;

  // ------------------------------------------------ listado
  let photos = [];
  let cursor = null;
  const selected = new Set();

  async function load(reset) {
    if (reset) { photos = []; cursor = null; selected.clear(); }
    const f = $('#ph-filter').value;
    const cons = [where('eventId', '==', ev.id), where('photographerUid', '==', uid)];
    if (f !== '*') cons.push(where('subalbumId', '==', f));
    cons.push(orderBy('takenAt'), limit(PAGE));
    if (cursor) cons.push(startAfter(cursor));
    const snap = await getDocs(query(collection(db, 'photos'), ...cons));
    cursor = snap.docs.at(-1) || cursor;
    photos.push(...snap.docs.map(d => ({ id: d.id, ...d.data() })));
    $('#ph-more').classList.toggle('hidden', snap.docs.length < PAGE);
    draw();
  }

  function draw() {
    $('#ph-count').textContent = `(${set.photoCount || 0})`;
    $('#ph-grid').innerHTML = photos.length ? photos.map(p => `
      <label class="ph ${p.hidden ? 'is-hidden' : ''} ${selected.has(p.id) ? 'sel' : ''}" data-id="${p.id}">
        <img src="${esc(p.thumbUrl)}" alt="" loading="lazy">
        <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''}>
        <span class="ph-meta">${p.hidden ? '<span class="pill warn">Oculta</span>' : ''}${subs.length ? `<span class="pill">${esc(subName(p.subalbumId))}</span>` : ''}</span>
      </label>`).join('') : '<div class="empty" style="grid-column:1/-1">Todavía no subiste fotos a este evento.</div>';
    $$('#ph-grid .ph input').forEach(cb => cb.onchange = () => {
      const id = cb.closest('.ph').dataset.id;
      cb.checked ? selected.add(id) : selected.delete(id);
      cb.closest('.ph').classList.toggle('sel', cb.checked);
      tools();
    });
    tools();
  }

  function tools() {
    const n = selected.size;
    $('#ph-sel').textContent = n ? `${n} seleccionada${n > 1 ? 's' : ''}` : '';
    ['ph-move', 'ph-hide', 'ph-show', 'ph-del'].forEach(id => { $('#' + id).disabled = !n; });
    $('#ph-all').checked = n > 0 && n === photos.length;
  }

  $('#ph-filter').onchange = () => load(true).catch(e => toast(errMsg(e), 'error'));
  $('#ph-more').onclick = () => load(false).catch(e => toast(errMsg(e), 'error'));
  $('#ph-all').onchange = e => { selected.clear(); if (e.target.checked) photos.forEach(p => selected.add(p.id)); draw(); };

  async function bulkUpdate(data, msg) {
    const ids = [...selected];
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const b = writeBatch(db);
        ids.slice(i, i + 400).forEach(id => b.update(doc(db, 'photos', id), data));
        await b.commit();
      }
      photos.forEach(p => { if (selected.has(p.id)) Object.assign(p, data); });
      selected.clear();
      if ('subalbumId' in data && $('#ph-filter').value !== '*') photos = photos.filter(p => p.subalbumId === $('#ph-filter').value);
      draw();
      toast(msg);
    } catch (e) { toast(errMsg(e), 'error'); }
  }
  $('#ph-move').onchange = e => {
    const v = e.target.value;
    e.target.value = '-';
    if (v === '-') return;
    bulkUpdate({ subalbumId: v === '__none' ? '' : v }, 'Fotos movidas');
  };
  $('#ph-hide').onclick = () => bulkUpdate({ hidden: true }, 'Fotos ocultas');
  $('#ph-show').onclick = () => bulkUpdate({ hidden: false }, 'Fotos visibles');
  $('#ph-del').onclick = async () => {
    const ids = [...selected];
    if (!confirm(`¿Borrar ${ids.length} foto${ids.length > 1 ? 's' : ''}? Se eliminan también los originales.`)) return;
    const btn = $('#ph-del'); btn.disabled = true; btn.textContent = 'Borrando…';
    try {
      const s = await uploadSession(ev.id);
      let bytes = 0, n = 0;
      for (const id of ids) {
        const p = photos.find(x => x.id === id);
        await apiDelete(`/photo/${ev.id}/${id}`, s.token);
        const b = writeBatch(db);
        b.delete(doc(db, 'photos', id));
        b.update(doc(db, 'events', ev.id, 'sets', uid), { photoCount: increment(-1), bytesOriginal: increment(-(p?.bytes || 0)) });
        await b.commit();
        bytes += p?.bytes || 0; n++;
        photos = photos.filter(x => x.id !== id);
        selected.delete(id);
      }
      set.photoCount = Math.max(0, (set.photoCount || 0) - n);
      set.bytesOriginal = Math.max(0, (set.bytesOriginal || 0) - bytes);
      toast(`${n} foto${n > 1 ? 's' : ''} borrada${n > 1 ? 's' : ''}`);
    } catch (e) { toast(errMsg(e), 'error'); }
    btn.textContent = 'Borrar';
    draw();
  };

  // ------------------------------------------------ subida
  const wm = { ...DEFAULT_WATERMARK, text: profile.displayName, ...(profile.watermark || {}) };
  let logo = null;
  if (wm.type === 'logo' && wm.logoKey) {
    try { logo = await createImageBitmap(await (await fetch(`${API_BASE}/public/${wm.logoKey}`)).blob()); }
    catch { wm.type = 'text'; toast('No se pudo cargar tu logo; se usa marca de texto.', 'error'); }
  }

  if (activeUploader && !activeUploader.busy()) activeUploader.destroy();
  const up = activeUploader = createUploader({
    eventId: ev.id, uid, wm, logo,
    onChange: renderQueue,
    onPhoto: p => {
      set.photoCount = (set.photoCount || 0) + 1;
      startExpiry();
      const f = $('#ph-filter')?.value;
      if (f === '*' || f === p.subalbumId) { photos.push(p); photos.sort((a, b) => a.takenAt.toMillis() - b.takenAt.toMillis()); }
      scheduleDraw();
    },
  });
  // El vencimiento de los originales arranca con la primera subida (una sola vez).
  let expiryStarted = !!set.expiresAt;
  function startExpiry() {
    if (expiryStarted) return;
    expiryStarted = true;
    const expiresAt = Timestamp.fromMillis(Date.now() + (settings.retentionDays || 14) * 86400000);
    updateDoc(doc(db, 'events', ev.id, 'sets', uid), { expiresAt })
      .then(() => { set.expiresAt = expiresAt; })
      .catch(e => { expiryStarted = false; console.warn('expiresAt', e); });
  }

  let drawT;
  const scheduleDraw = () => { clearTimeout(drawT); drawT = setTimeout(() => document.body.contains(box) && draw(), 400); };

  const LABEL = { queued: 'En cola', processing: 'Procesando…', uploading: 'Subiendo…', retrying: 'Reintentando…', done: 'Lista', error: 'Error' };
  let renderT = 0;
  function renderQueue(s) {
    if (!document.body.contains(box)) return;
    const now = performance.now();
    if (now - renderT < 150 && s.active) return; // limitar re-render
    renderT = now;
    $('#up-status').classList.toggle('hidden', !s.total);
    $('#up-summary').textContent = `${s.done} de ${s.total} subidas${s.failed ? ` · ${s.failed} con error` : ''} · ${s.pct}%`;
    $('#up-bar').style.width = `${s.pct}%`;
    $('#up-retry').classList.toggle('hidden', !s.failed);
    $('#up-list').innerHTML = s.items.filter(i => i.status !== 'done').slice(0, 60).map(i => `
      <div class="up-item ${i.status}">
        <span class="name">${esc(i.file.name)}</span>
        <span class="muted small">${LABEL[i.status]}${i.error ? ` — ${esc(i.error)}` : ''}</span>
        <span class="progress sm"><span style="width:${i.file.size ? Math.round((i.loaded / i.file.size) * 100) : 0}%"></span></span>
      </div>`).join('');
  }

  const addFiles = files => {
    if (!files.length) return;
    up.add([...files], $('#up-sub').value);
  };
  $('#up-files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  const dz = $('#dz');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#up-retry').onclick = () => up.retryFailed();
  $('#up-clear').onclick = () => up.clearDone();

  await load(true);
}
