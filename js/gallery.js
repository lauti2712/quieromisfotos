// Galería pública de un evento: filtros por fotógrafo y sub-álbum, scroll infinito y visor.
import { db, collection, getDocs, query, where, orderBy, limit, startAfter } from './fb.js';
import { $, $$, esc, fmtMoney, toast, errMsg } from './util.js';
import { cart } from './cart.js';
import { openViewer } from './viewer.js';

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
        `<div class="g-item ${cart.has(p.id) ? 'in-cart' : ''}" data-i="${start + i}" data-id="${p.id}" role="button" tabindex="0" aria-label="Ver foto">
          <img src="${esc(p.thumbUrl)}" alt="" loading="lazy" decoding="async">
          <button class="g-add" data-add="${start + i}" aria-label="Agregar al carrito">${cart.has(p.id) ? '✓' : '+'}</button>
        </div>`).join(''));
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
    const add = e.target.closest('[data-add]');
    if (add) { toggleCart(state.photos[+add.dataset.add]); return; }
    const b = e.target.closest('.g-item');
    if (b) openGalleryViewer(+b.dataset.i);
  });
  $('#g-grid', box).addEventListener('keydown', e => {
    const b = e.target.closest('.g-item');
    if (b && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openGalleryViewer(+b.dataset.i); }
  });

  function toggleCart(p) {
    if (!p) return;
    const added = cart.toggle(p);
    toast(added ? 'Foto agregada al carrito' : 'Foto quitada del carrito');
    syncCartMarks();
  }
  function syncCartMarks() {
    $$('.g-item', box).forEach(el => {
      const inCart = cart.has(el.dataset.id);
      el.classList.toggle('in-cart', inCart);
      el.querySelector('.g-add').textContent = inCart ? '✓' : '+';
    });
  }
  window.addEventListener('cart:change', () => document.body.contains(box) && syncCartMarks());

  const io = new IntersectionObserver(entries => {
    if (!document.body.contains(box)) return io.disconnect();
    if (entries.some(en => en.isIntersecting)) loadMore();
  }, { rootMargin: '600px' });
  io.observe($('#g-sentinel', box));

  // ------------------------------------------------ visor
  function openGalleryViewer(index) {
    openViewer({
      index,
      src: i => state.photos[i].previewUrl,
      count: () => state.photos.length,
      total: () => `${state.photos.length}${state.done ? '' : '+'}`,
      onIndex: i => { if (i >= state.photos.length - 5) loadMore(); },
      footer: (i, el, rerender) => {
        const p = state.photos[i];
        const ph = byUid.get(p.photographerUid);
        const set = sets.get(p.photographerUid) || {};
        const packs = (set.packs || []).map(k => `${k.qty} x ${fmtMoney(k.price)}`).join(' · ');
        const inCart = cart.has(p.id);
        el.innerHTML = `
          <span class="small">📷 ${esc(ph?.displayName || '')}${set.price ? ` · <strong>${fmtMoney(set.price)}</strong>` : ''}${packs ? `<br><span style="opacity:.75">Packs: ${packs}</span>` : ''}</span>
          <span class="row"><a class="btn sm" href="#/carrito">Ver carrito</a>
            <button class="btn ${inCart ? '' : 'primary'}" id="lb-add" ${set.price ? '' : 'disabled'}>${inCart ? '✓ En el carrito' : '🛒 Agregar al carrito'}</button></span>`;
        $('#lb-add', el).onclick = () => { toggleCart(p); rerender(); };
      },
    });
  }

  drawFilters();
  loadMore();
}
