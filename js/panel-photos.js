// Panel: subida masiva y gestión de fotos del set de un fotógrafo en un evento.
import {
  db, collection, doc, getDocs, query, where, orderBy, limit, startAfter, writeBatch, Timestamp,
} from './fb.js';
import { $, $$, esc, toast, errMsg, fmtBytes, setBytes } from './util.js';
import { createUploader, fileKey, interruptedUpload, clearInterrupted } from './uploader.js';
import { uploadSession, postWithToken, loadLogoBitmap } from './api.js';
import { DEFAULT_WATERMARK, wantsLogo } from './watermark.js';
import { albumPhotoLimit } from './data.js';

const PAGE = 120;
let activeUploader = null;

window.addEventListener('beforeunload', e => {
  if (activeUploader?.busy()) { e.preventDefault(); e.returnValue = ''; }
});

export function uploadsInProgress() {
  return !!activeUploader?.busy();
}

export async function mountPhotos(box, { ev, set, uid, profile, settings, bibs = false }) {
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
      <div id="up-cut"></div>
      <p class="muted small mobile-only" style="margin:6px 0 0">📱 Desde el celular: dejá esta pantalla abierta mientras sube (no la bloquees ni cambies de app). Si se corta la conexión, sigue sola cuando vuelve.</p>
      <div id="up-status" class="hidden">
        <div class="row" style="justify-content:space-between">
          <span id="up-summary" class="small"></span>
          <span class="row"><button class="btn sm primary hidden" id="up-full">➕ Comprar más espacio</button><button class="btn sm hidden" id="up-retry">Reintentar fallidas</button><button class="btn sm" id="up-clear">Limpiar terminadas</button></span>
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
        <button class="btn sm" id="ph-bibs" disabled title="Corregir los dorsales de la foto seleccionada">🔢 Dorsales</button>
        <button class="btn sm" id="ph-hide" disabled>Ocultar</button>
        <button class="btn sm" id="ph-show" disabled>Mostrar</button>
        <button class="btn sm danger" id="ph-del" disabled>Borrar</button>
      </div>
      <div id="ph-grid" class="photo-grid"></div>
      <div class="row" style="justify-content:center"><button class="btn hidden" id="ph-more">Cargar más</button></div>
    </div>
    <button type="button" class="up-fab hidden" id="up-fab">📤 Subir fotos</button>`;
  // Celular: botón fijo para subir mientras la zona de subida no está a la vista.
  $('#up-fab', box).onclick = () => $('#up-files').click();
  new IntersectionObserver(([en], obs) => {
    if (!document.body.contains(box)) return obs.disconnect();
    $('#up-fab', box).classList.toggle('hidden', en.isIntersecting);
  }).observe($('#dz', box));

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
    // Las fotos recién subidas ya pueden estar en la lista: no repetirlas.
    const have = new Set(photos.map(p => p.id));
    photos.push(...snap.docs.filter(d => !have.has(d.id)).map(d => ({ id: d.id, ...d.data() })));
    $('#ph-more').classList.toggle('hidden', snap.docs.length < PAGE);
    draw();
  }

  function draw() {
    $('#ph-count').textContent = `(${set.photoCount || 0} · ${fmtBytes(setBytes(set))})`;
    $('#ph-grid').innerHTML = photos.length ? photos.map(p => `
      <label class="ph ${p.hidden ? 'is-hidden' : ''} ${selected.has(p.id) ? 'sel' : ''}" data-id="${p.id}">
        <img src="${esc(p.thumbUrl)}" alt="" loading="lazy">
        <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''}>
        <span class="ph-meta">${p.hidden ? '<span class="pill warn">Oculta</span>' : ''}${subs.length ? `<span class="pill">${esc(subName(p.subalbumId))}</span>` : ''}${(p.bibs || []).length ? `<span class="pill ok" title="Dorsales">#${p.bibs.map(esc).join(' #')}</span>` : ''}</span>
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
    $('#ph-bibs').disabled = n !== 1;
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
  // Corregir dorsales a mano (la lectura automática puede fallar si el número está tapado o movido).
  $('#ph-bibs').onclick = () => {
    const p = photos.find(x => selected.has(x.id));
    if (!p) return;
    const v = prompt('Dorsales de esta foto, separados por coma (vacío = ninguno):', (p.bibs || []).join(', '));
    if (v === null) return;
    const list = [...new Set((v.match(/\d{1,6}/g) || []).map(n => String(parseInt(n, 10))).filter(n => n !== '0'))].slice(0, 20);
    bulkUpdate({ bibs: list }, list.length ? `Dorsales: ${list.join(', ')}` : 'Dorsales borrados');
  };
  $('#ph-hide').onclick = () => bulkUpdate({ hidden: true }, 'Fotos ocultas');
  $('#ph-show').onclick = () => bulkUpdate({ hidden: false }, 'Fotos visibles');
  $('#ph-del').onclick = async () => {
    const ids = [...selected];
    if (!confirm(`¿Borrar ${ids.length} foto${ids.length > 1 ? 's' : ''}? Se eliminan también los originales.`)) return;
    const btn = $('#ph-del'); btn.disabled = true; btn.textContent = 'Borrando…';
    let gone = 0, kept = 0;
    try {
      const s = await uploadSession(ev.id);
      for (let i = 0; i < ids.length; i += 100) {
        // El Worker borra y descuenta del álbum; las fotos vendidas con descarga vigente solo se ocultan.
        const r = await postWithToken(`/photos/${ev.id}/delete`, { ids: ids.slice(i, i + 100) }, s.token);
        for (const id of r.deleted || []) {
          const p = photos.find(x => x.id === id);
          if (p) {
            uploadedKeys?.delete(`${p.fileName}|${p.fileBytes || p.bytes}`);
            set.photoCount = Math.max(0, (set.photoCount || 0) - 1);
            set.bytesOriginal = Math.max(0, (set.bytesOriginal || 0) - (p.bytes || 0));
            set.bytesPublic = Math.max(0, (set.bytesPublic || 0) - (p.bytesPublic || 0));
          }
          photos = photos.filter(x => x.id !== id);
          selected.delete(id);
          gone++;
        }
        for (const id of r.hidden || []) {
          const p = photos.find(x => x.id === id);
          if (p) p.hidden = true;
          selected.delete(id);
          kept++;
        }
      }
      if (gone) toast(`${gone} foto${gone > 1 ? 's' : ''} borrada${gone > 1 ? 's' : ''}`);
      if (kept) toast(`${kept} foto${kept > 1 ? 's' : ''} ya ${kept > 1 ? 'fueron vendidas' : 'fue vendida'}: quedan ocultas y se borran cuando vence la descarga del comprador.`);
    } catch (e) { toast(errMsg(e), 'error'); }
    btn.textContent = 'Borrar';
    draw();
  };

  // ------------------------------------------------ subida
  const wm = { ...DEFAULT_WATERMARK, ...(profile.watermark || {}) };
  let logo = null;
  if (wantsLogo(wm)) {
    try { logo = await loadLogoBitmap(wm.logoKey); }
    catch { toast('No se pudo cargar tu logo; en el centro va la marca del sitio.', 'error'); }
  }

  if (activeUploader && !activeUploader.busy()) activeUploader.destroy();
  // Si volvió al evento mientras se sigue subiendo, se reutiliza la misma cola (no se arma otra).
  const handlers = {
    onChange: renderQueue,
    onPhoto: (p, expiresAt) => {
      set.photoCount = (set.photoCount || 0) + 1;
      set.bytesOriginal = (set.bytesOriginal || 0) + (p.bytes || 0);
      set.bytesPublic = (set.bytesPublic || 0) + (p.bytesPublic || 0);
      // El vencimiento lo fija el Worker con la primera foto.
      if (expiresAt && !set.expiresAt) set.expiresAt = Timestamp.fromMillis(expiresAt);
      const f = $('#ph-filter')?.value;
      if ((f === '*' || f === p.subalbumId) && !photos.some(x => x.id === p.id)) { photos.push(p); photos.sort((a, b) => a.takenAt.toMillis() - b.takenAt.toMillis()); }
      scheduleDraw();
    },
    onBibs: (id, list) => {
      const p = photos.find(x => x.id === id);
      if (p) { p.bibs = list; scheduleDraw(); }
      if (list.length) set.bibPhotos = (set.bibPhotos || 0) + 1;
    },
  };
  // Subida cortada (se cerró la pestaña): las ya subidas se saltean solas al volver a elegirlas.
  const cut = !(activeUploader?.busy() && activeUploader.eventId === ev.id) && interruptedUpload(ev.id);
  if (cut) {
    $('#up-cut').innerHTML = `<div class="notice warn small" style="margin:8px 0 0">⚠️ Se cortó una subida: quedaron <strong>${cut.left} de ${cut.total}</strong> fotos sin subir.
      Elegí las mismas fotos de nuevo: las que ya se subieron se saltean solas. <button type="button" class="btn sm ghost" id="up-cut-x">Entendido</button></div>`;
    $('#up-cut-x').onclick = () => { clearInterrupted(ev.id); $('#up-cut').innerHTML = ''; };
  }
  let up;
  if (activeUploader?.busy() && activeUploader.eventId === ev.id) { up = activeUploader; up.setHandlers(handlers); }
  else up = activeUploader = createUploader({ eventId: ev.id, uid, wm, logo, optimize: settings.optimizeOriginals !== false, bibs: bibs && settings.bibsEnabled !== false, ...handlers });
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
    const full = s.items.some(i => i.full && i.status === 'error');
    $('#up-full').classList.toggle('hidden', !full);
    $('#up-list').innerHTML = s.items.filter(i => i.status !== 'done').slice(0, 60).map(i => `
      <div class="up-item ${i.status}">
        <span class="name">${esc(i.file.name)}</span>
        <span class="muted small">${LABEL[i.status]}${i.error ? ` — ${esc(i.error)}` : ''}</span>
        <span class="progress sm"><span style="width:${i.file.size ? Math.round((i.loaded / i.file.size) * 100) : 0}%"></span></span>
      </div>`).join('');
  }

  // Saltea las fotos que ya están subidas en este evento (mismo nombre y tamaño) o ya en la cola.
  let uploadedKeys = null;
  const addFiles = async files => {
    files = [...files];
    if (!files.length) return;
    try {
      if (!uploadedKeys) {
        const snap = await getDocs(query(collection(db, 'photos'), where('eventId', '==', ev.id), where('photographerUid', '==', uid)));
        uploadedKeys = new Set(snap.docs.map(d => `${d.data().fileName}|${d.data().fileBytes || d.data().bytes}`));
      }
    } catch (e) { console.warn('duplicados', e); }
    let fresh = uploadedKeys ? files.filter(f => !uploadedKeys.has(fileKey(f))) : files;
    const dups = files.length - fresh.length; // ya subidas antes
    // Tope de fotos del álbum (planes nuevos): se suben solo las que entran.
    const max = albumPhotoLimit(set, settings, profile);
    if (max) {
      const room = Math.max(0, max - (set.photoCount || 0) - up.summary().active);
      if (fresh.length > room) {
        toast(room ? `Tu álbum admite ${room} foto${room === 1 ? '' : 's'} más (tope ${max}). Se suben las primeras ${room}.` : `El álbum llegó a su tope de ${max} fotos.`, 'error');
        fresh = fresh.slice(0, room);
        if (!room) { window.onqmfAlbumFull?.(); return; }
      }
    }
    const skipped = dups + up.add(fresh, $('#up-sub').value);
    fresh.forEach(f => uploadedKeys?.add(fileKey(f)));
    if (skipped) toast(`${skipped} foto${skipped > 1 ? 's' : ''} ya estaba${skipped > 1 ? 'n' : ''} subida${skipped > 1 ? 's' : ''}: no se repite${skipped > 1 ? 'n' : ''}.`);
  };
  $('#up-files').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
  const dz = $('#dz');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); addFiles(e.dataTransfer.files); });
  $('#up-retry').onclick = () => up.retryFailed();
  $('#up-full').onclick = () => window.onqmfAlbumFull?.();
  $('#up-clear').onclick = () => up.clearDone();

  await load(true);
}
