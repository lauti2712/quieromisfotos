// Galería pública de un evento: filtros por fotógrafo y sub-álbum, scroll infinito y visor.
import { db, collection, getDocs, query, where, orderBy, limit, startAfter } from './fb.js';
import { $, $$, esc, fmtMoney, toast, errMsg } from './util.js';

const PAGE = 60;

export function mountGallery(box, { ev, photographers, sets }) {
  const byUid = new Map(photographers.map(p => [p.uid, p]));
  const withPhotos = photographers.filter(p => (sets.get(p.uid)?.photoCount || 0) > 0);
  const state = { uid: '', sub: '', photos: [], cursor: null, done: false, loading: false };

  if (!withPhotos.length) {
    box.innerHTML = '<div class="empty">📷 Las fotos de este evento van a estar disponibles muy pronto.</div>';
    return;
  }

  box.innerHTML = `
    <div class="filter-row" id="g-ph"></div>
    <div class="filter-row" id="g-sub"></div>
    <div class="gallery" id="g-grid"></div>
    <div id="g-sentinel" style="height:1px"></div>
    <div class="row" style="justify-content:center;margin-top:14px" id="g-more"></div>`;

  function drawFilters() {
    $('#g-ph', box).innerHTML = withPhotos.length > 1
      ? [`<button class="chip ${!state.uid ? 'on' : ''}" data-uid="">Todos</button>`,
        ...withPhotos.map(p => `<button class="chip ${state.uid === p.uid ? 'on' : ''}" data-uid="${p.uid}">${esc(p.displayName)}</button>`)].join('')
      : '';
    const subs = state.uid ? (sets.get(state.uid)?.subalbums || []).slice().sort((a, b) => a.order - b.order)
      : withPhotos.length === 1 ? (sets.get(withPhotos[0].uid)?.subalbums || []).slice().sort((a, b) => a.order - b.order) : [];
    $('#g-sub', box).innerHTML = subs.length
      ? [`<button class="chip ${!state.sub ? 'on' : ''}" data-sub="">Todas</button>`,
        ...subs.map(s => `<button class="chip ${state.sub === s.id ? 'on' : ''}" data-sub="${s.id}">${esc(s.name)}</button>`)].join('')
      : '';
    $$('[data-uid]', box).forEach(b => b.onclick = () => { state.uid = b.dataset.uid; state.sub = ''; reset(); });
    $$('[data-sub]', box).forEach(b => b.onclick = () => {
      state.sub = b.dataset.sub;
      if (!state.uid && withPhotos.length === 1) state.uid = withPhotos[0].uid;
      reset();
    });
  }

  function reset() {
    Object.assign(state, { photos: [], cursor: null, done: false });
    $('#g-grid', box).innerHTML = '';
    drawFilters();
    loadMore();
  }

  async function loadMore() {
    if (state.loading || state.done) return;
    state.loading = true;
    $('#g-more', box).innerHTML = '<div class="spinner" style="margin:6px auto"></div>';
    const cons = [where('eventId', '==', ev.id), where('hidden', '==', false)];
    if (state.uid) cons.push(where('photographerUid', '==', state.uid));
    if (state.uid && state.sub) cons.push(where('subalbumId', '==', state.sub));
    cons.push(orderBy('takenAt'), limit(PAGE));
    if (state.cursor) cons.push(startAfter(state.cursor));
    try {
      const snap = await getDocs(query(collection(db, 'photos'), ...cons));
      state.cursor = snap.docs.at(-1) || state.cursor;
      state.done = snap.docs.length < PAGE;
      const fresh = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => byUid.has(p.photographerUid));
      const start = state.photos.length;
      state.photos.push(...fresh);
      $('#g-grid', box).insertAdjacentHTML('beforeend', fresh.map((p, i) =>
        `<button class="g-item" data-i="${start + i}" aria-label="Ver foto"><img src="${esc(p.thumbUrl)}" alt="" loading="lazy" decoding="async"></button>`).join(''));
      if (!state.photos.length) $('#g-grid', box).innerHTML = '<div class="empty" style="grid-column:1/-1">No hay fotos con este filtro.</div>';
      $('#g-more', box).innerHTML = state.done ? '' : '<button class="btn">Ver más fotos</button>';
      $('#g-more button', box)?.addEventListener('click', loadMore);
    } catch (e) {
      $('#g-more', box).innerHTML = '';
      toast(errMsg(e), 'error');
    } finally {
      state.loading = false;
    }
  }

  $('#g-grid', box).addEventListener('click', e => {
    const b = e.target.closest('.g-item');
    if (b) openViewer(+b.dataset.i);
  });

  const io = new IntersectionObserver(entries => {
    if (!document.body.contains(box)) return io.disconnect();
    if (entries.some(en => en.isIntersecting)) loadMore();
  }, { rootMargin: '600px' });
  io.observe($('#g-sentinel', box));

  // ------------------------------------------------ visor
  function openViewer(index) {
    let i = index;
    const lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.setAttribute('role', 'dialog');
    lb.innerHTML = `
      <div class="lb-top"><span class="small" id="lb-count"></span><span class="spacer"></span><button class="btn sm" id="lb-close" aria-label="Cerrar">✕</button></div>
      <div class="lb-stage"><button class="lb-nav lb-prev" aria-label="Anterior">‹</button><img id="lb-img" alt=""><button class="lb-nav lb-next" aria-label="Siguiente">›</button></div>
      <div class="lb-bottom"><span id="lb-info" class="small"></span><button class="btn primary" disabled title="Próximamente">🛒 Agregar al carrito</button></div>`;
    document.body.appendChild(lb);
    document.body.style.overflow = 'hidden';

    const show = () => {
      const p = state.photos[i];
      if (!p) return;
      const ph = byUid.get(p.photographerUid);
      const set = sets.get(p.photographerUid) || {};
      $('#lb-img', lb).src = p.previewUrl;
      $('#lb-count', lb).textContent = `${i + 1} / ${state.photos.length}${state.done ? '' : '+'}`;
      $('#lb-info', lb).innerHTML = `📷 ${esc(ph?.displayName || '')}${set.price ? ` · <strong>${fmtMoney(set.price)}</strong>` : ''}`;
      // precarga de la siguiente
      const n = state.photos[i + 1];
      if (n) new Image().src = n.previewUrl;
      if (i >= state.photos.length - 5) loadMore();
    };
    const go = d => {
      const j = i + d;
      if (j < 0 || j >= state.photos.length) return;
      i = j; show();
    };
    const close = () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('hashchange', close);
      document.body.style.overflow = '';
      lb.remove();
    };
    const onKey = e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('hashchange', close);
    $('#lb-close', lb).onclick = close;
    $('.lb-prev', lb).onclick = () => go(-1);
    $('.lb-next', lb).onclick = () => go(1);
    // swipe en celular
    let x0 = null;
    const stage = $('.lb-stage', lb);
    stage.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
    stage.addEventListener('touchend', e => {
      if (x0 == null) return;
      const dx = e.changedTouches[0].clientX - x0;
      if (Math.abs(dx) > 40) go(dx < 0 ? 1 : -1);
      x0 = null;
    });
    stage.addEventListener('click', e => { if (e.target === stage) close(); });
    // bloquear "guardar imagen" básico
    $('#lb-img', lb).addEventListener('contextmenu', e => e.preventDefault());
    show();
  }

  drawFilters();
  loadMore();
}
