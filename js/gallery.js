// Galería pública de un evento: filtros por fotógrafo y sub-álbum, scroll infinito y visor.
import { db, collection, getDocs, query, where, orderBy, limit, startAfter, Timestamp, getCountFromServer, doc, getDoc } from './fb.js';
import { $, $$, esc, fmtMoney, toast, errMsg, todayIso, fmtDate } from './util.js';
import { cart } from './cart.js';
import { openViewer } from './viewer.js';
import { setForSale, setUntil } from './data.js';
import { favs } from './favs.js';
import { shareLink, eventUrl } from './share.js';
import { trackPhotoView, trackCartAdd } from './stats.js';

const PAGE = 60;

export function mountGallery(box, { ev, photographers, sets, initialUid = '', initialPhoto = '', initialBib = '' }) {
  const byUid = new Map(photographers.map(p => [p.uid, p]));
  const withPhotos = photographers.filter(p => (sets.get(p.uid)?.photoCount || 0) > 0);
  const state = { uid: '', sub: '', hour: 0, fav: false, bib: '', photos: [], cursor: null, done: false, loading: false };
  // Búsqueda por dorsal: aparece si algún fotógrafo tiene fotos con dorsales leídos.
  const hasBibs = withPhotos.some(p => (sets.get(p.uid)?.bibPhotos || 0) > 0);
  const cleanBib = v => { const n = (String(v || '').match(/\d{1,6}/) || [''])[0]; return n ? String(parseInt(n, 10)) : ''; };
  // Link con dorsal (#/evento/{id}?dorsal=123): abre directo con la búsqueda hecha.
  if (hasBibs && cleanBib(initialBib) && cleanBib(initialBib) !== '0') state.bib = cleanBib(initialBib);
  let hours = []; // inicio (ms) de cada hora que tiene fotos
  let hourCount = new Map();

  // Link de álbum de un fotógrafo (#/evento/{id}?f={uid}): arranca filtrado por él.
  if (initialUid && withPhotos.some(p => p.uid === initialUid)) state.uid = initialUid;

  if (!withPhotos.length) {
    box.innerHTML = ev.date > todayIso()
      ? `<div class="empty">📅 Este evento es el <strong>${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</strong>.<br>Tocá <strong>🔔 Avisarme</strong> arriba y te avisamos apenas suban las fotos.</div>`
      : '<div class="empty">📷 Las fotos de este evento van a estar disponibles muy pronto.<br>Tocá <strong>🔔 Avisarme</strong> arriba y te avisamos.</div>';
    return;
  }

  // Álbumes vencidos: se pueden ver, pero ya no se venden.
  const forSale = uid => setForSale(sets.get(uid));
  const expired = withPhotos.filter(p => !forSale(p.uid) && setUntil(sets.get(p.uid)));
  box.innerHTML = `
    ${expired.length ? `<div class="notice warn">${expired.length === withPhotos.length ? 'Las fotos de este evento' : `Las fotos de ${expired.map(p => esc(p.displayName)).join(', ')}`} ya no están a la venta (venció el plazo de disponibilidad).</div>` : ''}
    ${hasBibs ? `<form class="g-bib" id="g-bib" role="search">
      <label for="g-bib-in">🔢 Buscá tus fotos por número de dorsal</label>
      <div class="row"><input id="g-bib-in" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="Ej: 1234" autocomplete="off" value="${esc(state.bib)}">
      <button class="btn primary">Buscar</button><button type="button" class="btn hidden" id="g-bib-x">Ver todas</button></div>
    </form>` : ''}
    <div class="g-price" id="g-price"></div>
    <div class="filter-row" id="g-ph"></div>
    <div class="filter-row" id="g-sub"></div>
    <div class="filter-row" id="g-hour"></div>
    <div class="filter-row" id="g-fav"></div>
    <div class="gallery" id="g-grid"></div>
    <div id="g-sentinel" style="height:1px"></div>
    <div class="row" style="justify-content:center;margin-top:14px" id="g-more"></div>
    <a class="g-cartbar hidden" id="g-cartbar" href="#/carrito"></a>`;

  function drawFilters() {
    ['g-ph', 'g-sub', 'g-hour', 'g-fav'].forEach(id => $('#' + id, box).classList.toggle('hidden', !!state.bib));
    $('#g-bib-x', box)?.classList.toggle('hidden', !state.bib);
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
    // Horario: chips por hora entre la primera y la última foto (usa la hora en que se sacó cada foto).
    const multiDay = hours.length && new Date(hours[0]).toDateString() !== new Date(hours.at(-1)).toDateString();
    const hourLabel = ms => {
      const d = new Date(ms);
      return `${multiDay ? `${d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' })} ` : ''}${String(d.getHours()).padStart(2, '0')}:00 a ${String((d.getHours() + 1) % 24).padStart(2, '0')}:00`;
    };
    // Cada fotógrafo decide en su álbum si muestra el filtro (con varios fotógrafos, se muestra si todos lo tienen activo).
    const hoursOn = (state.uid ? [state.uid] : withPhotos.map(p => p.uid)).every(uid => sets.get(uid)?.showHours !== false);
    if (!hoursOn && state.hour) state.hour = 0;
    $('#g-hour', box).innerHTML = hoursOn && hours.length > 1
      ? [`<span class="muted small" style="align-self:center">🕒 Horario:</span><button class="chip ${!state.hour ? 'on' : ''}" data-hour="0">Todo</button>`,
        ...hours.map(h => `<button class="chip ${state.hour === h ? 'on' : ''}" data-hour="${h}">${hourLabel(h)} <span class="muted small">${hourCount.get(h) || ''}</span></button>`)].join('')
      : '';
    $$('[data-hour]', box).forEach(b => b.onclick = () => { state.hour = Number(b.dataset.hour); state.fav = false; reset(); });

    const nFav = favs.forEvent(ev.id).length;
    $('#g-fav', box).innerHTML = nFav || state.fav
      ? `<button class="chip ${state.fav ? 'on' : ''}" data-fav>♥ Mis favoritas (${nFav})</button>${state.fav ? '<span class="muted small" style="align-self:center">Guardadas en este dispositivo</span>' : ''}`
      : '';
    $('[data-fav]', box)?.addEventListener('click', () => { state.fav = !state.fav; reset(); });

    // Precio y packs de cada fotógrafo, arriba de las fotos.
    const shown = (state.uid ? withPhotos.filter(p => p.uid === state.uid) : withPhotos).filter(p => forSale(p.uid));
    $('#g-price', box).innerHTML = shown.map(p => {
      const st = sets.get(p.uid) || {};
      const packs = (st.packs || []).filter(k => k.qty > 1 && k.price > 0).sort((a, b) => a.qty - b.qty);
      return `<div class="g-price-row">💲 ${withPhotos.length > 1 ? `<strong>${esc(p.displayName)}</strong> · ` : ''}<strong>${fmtMoney(st.price)}</strong> por foto
        ${packs.map(k => `<span class="pill ok">${k.qty} fotos x ${fmtMoney(k.price)}</span>`).join(' ')}</div>`;
    }).join('') + (shown.length ? '<div class="muted small">Si llevás varias, se aplica solo la combinación más barata.</div>' : '');
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
    if (state.fav) {
      const list = favs.forEvent(ev.id).filter(p => byUid.has(p.photographerUid) && (!state.uid || p.photographerUid === state.uid)).sort((a, b) => a.takenAt - b.takenAt);
      state.photos = list; state.done = true;
      $('#g-grid', box).innerHTML = list.length ? list.map((p, i) => itemHtml(p, i)).join('') : '<div class="empty" style="grid-column:1/-1">Todavía no marcaste favoritas. Tocá ♡ en las fotos que te gusten.</div>';
      $('#g-more', box).innerHTML = '';
      return;
    }
    state.loading = true;
    $('#g-more', box).innerHTML = '<div class="spinner" style="margin:6px auto"></div>';
    const cons = [where('eventId', '==', ev.id), where('hidden', '==', false)];
    if (state.bib) cons.push(where('bibs', 'array-contains', state.bib));
    else if (state.uid) cons.push(where('photographerUid', '==', state.uid));
    if (!state.bib && state.uid && state.sub) cons.push(where('subalbumId', '==', state.sub));
    if (!state.bib && state.hour) cons.push(where('takenAt', '>=', Timestamp.fromMillis(state.hour)), where('takenAt', '<', Timestamp.fromMillis(state.hour + 3600000)));
    cons.push(orderBy('takenAt'), limit(PAGE));
    if (state.cursor) cons.push(startAfter(state.cursor));
    try {
      const snap = await getDocs(query(collection(db, 'photos'), ...cons));
      state.cursor = snap.docs.at(-1) || state.cursor;
      state.done = snap.docs.length < PAGE;
      const fresh = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => byUid.has(p.photographerUid));
      const start = state.photos.length;
      state.photos.push(...fresh);
      $('#g-grid', box).insertAdjacentHTML('beforeend', fresh.map((p, i) => itemHtml(p, start + i)).join(''));
      if (!state.photos.length) $('#g-grid', box).innerHTML = state.bib
        ? `<div class="empty" style="grid-column:1/-1">No encontramos fotos con el dorsal <strong>${esc(state.bib)}</strong>.<br>Puede que el número haya quedado tapado en la foto: probá buscando por horario.</div>`
        : '<div class="empty" style="grid-column:1/-1">No hay fotos con este filtro.</div>';
      else if (state.bib && !start) {
        $('#g-grid', box).insertAdjacentHTML('afterbegin', `<div class="g-bib-found"><span>${state.done ? state.photos.length : `${state.photos.length}+`} foto${state.photos.length === 1 ? '' : 's'} con el dorsal <strong>${esc(state.bib)}</strong></span>
          <button type="button" class="btn sm" id="g-bib-share">🔗 Compartir</button></div>`);
        const bib = state.bib;
        $('#g-bib-share', box).onclick = () => shareLink({
          title: `Fotos del dorsal ${bib} · ${ev.name}`, text: `📸 Mirá las fotos del dorsal ${bib} en ${ev.name}:`,
          url: `${eventUrl(ev.id)}${eventUrl(ev.id).includes('?') ? '&' : '?'}dorsal=${bib}`,
        });
      }
      $('#g-more', box).innerHTML = state.done ? '' : '<button class="btn">Ver más fotos</button>';
      $('#g-more button', box)?.addEventListener('click', loadMore);
    } catch (e) {
      $('#g-more', box).innerHTML = '';
      toast(errMsg(e), 'error');
    } finally {
      state.loading = false;
    }
  }

  function itemHtml(p, i) {
    return `<div class="g-item ${cart.has(p.id) ? 'in-cart' : ''}" data-i="${i}" data-id="${p.id}" role="button" tabindex="0" aria-label="Ver foto">
      <img src="${esc(p.thumbUrl)}" alt="" loading="lazy" decoding="async">
      <button class="g-fav ${favs.has(p.id) ? 'on' : ''}" data-favi="${i}" aria-label="Favorita">${favs.has(p.id) ? '♥' : '♡'}</button>
      ${forSale(p.photographerUid) ? `<button class="g-add" data-add="${i}" aria-label="Agregar al carrito">${cart.has(p.id) ? '✓' : '+'}</button>` : ''}
    </div>`;
  }
  function toggleFav(p) {
    if (!p) return;
    const on = favs.toggle({ ...p, eventId: ev.id });
    toast(on ? '♥ Guardada en tus favoritas' : 'Quitada de favoritas');
  }
  window.addEventListener('favs:change', () => {
    if (!document.body.contains(box)) return;
    $$('.g-fav', box).forEach(b => { const on = favs.has(b.closest('.g-item').dataset.id); b.classList.toggle('on', on); b.textContent = on ? '♥' : '♡'; });
    drawFilters();
  });

  $('#g-grid', box).addEventListener('click', e => {
    const fv = e.target.closest('[data-favi]');
    if (fv) { toggleFav(state.photos[+fv.dataset.favi]); return; }
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
    if (added) trackCartAdd(ev.id, p.photographerUid);
    toast(added ? 'Foto agregada al carrito' : 'Foto quitada del carrito');
    syncCartMarks();
  }
  // Barra fija abajo con lo que lleva en el carrito (en el celular el botón del carrito queda lejos).
  function syncCartBar() {
    const n = cart.count();
    const bar = $('#g-cartbar', box);
    bar.classList.toggle('hidden', !n);
    bar.innerHTML = `<span>🛒 <strong>${n}</strong> foto${n === 1 ? '' : 's'} en el carrito</span><span class="g-cartbar-go">Ver carrito y pagar</span>`;
  }
  function syncCartMarks() {
    syncCartBar();
    $$('.g-item', box).forEach(el => {
      const inCart = cart.has(el.dataset.id);
      el.classList.toggle('in-cart', inCart);
      const btn = el.querySelector('.g-add');
      if (btn) btn.textContent = inCart ? '✓' : '+';
    });
  }
  window.addEventListener('cart:change', () => document.body.contains(box) && syncCartMarks());

  const io = new IntersectionObserver(entries => {
    if (!document.body.contains(box)) return io.disconnect();
    if (entries.some(en => en.isIntersecting)) loadMore();
  }, { rootMargin: '600px' });
  io.observe($('#g-sentinel', box));

  // Horario: si todos los álbumes tienen el conteo por hora (lo lleva el Worker al subir), no hace falta consultar nada.
  const counted = withPhotos.every(p => sets.get(p.uid)?.hourCounts);
  if (counted) {
    const sum = new Map();
    for (const p of withPhotos) {
      for (const [h, n] of Object.entries(sets.get(p.uid).hourCounts || {})) if (n > 0) sum.set(Number(h), (sum.get(Number(h)) || 0) + n);
    }
    hours = [...sum.keys()].sort((a, b) => a - b).slice(0, 48);
    hourCount = sum;
  }
  // Álbumes viejos sin conteo: primera y última foto visibles (2 lecturas) y un conteo por hora. Máximo 48 chips.
  if (!counted) (async () => {
    const base = [where('eventId', '==', ev.id), where('hidden', '==', false)];
    const [a, b] = await Promise.all([
      getDocs(query(collection(db, 'photos'), ...base, orderBy('takenAt'), limit(1))),
      getDocs(query(collection(db, 'photos'), ...base, orderBy('takenAt', 'desc'), limit(1))),
    ]);
    const first = a.docs[0]?.data().takenAt?.toMillis(), last = b.docs[0]?.data().takenAt?.toMillis();
    if (!first || !last) return;
    const start = new Date(first); start.setMinutes(0, 0, 0);
    const all = [];
    for (let h = start.getTime(); h <= last && all.length < 48; h += 3600000) all.push(h);
    // Solo las horas que tienen fotos (conteo: 1 lectura cada 1000 fotos).
    const counts = await Promise.all(all.map(h => getCountFromServer(query(collection(db, 'photos'), ...base,
      where('takenAt', '>=', Timestamp.fromMillis(h)), where('takenAt', '<', Timestamp.fromMillis(h + 3600000)))).then(r => r.data().count).catch(() => 1)));
    hours = all.filter((h, i) => counts[i] > 0);
    hourCount = new Map(all.map((h, i) => [h, counts[i]]));
    if (document.body.contains(box)) drawFilters();
  })().catch(() => {});

  // ------------------------------------------------ visor
  let seenIdx = -1;
  function openGalleryViewer(index) {
    seenIdx = -1;
    openViewer({
      index,
      src: i => state.photos[i].previewUrl,
      count: () => state.photos.length,
      total: () => `${state.photos.length}${state.done ? '' : '+'}`,
      // Cuenta la foto vista una vez (el visor también redibuja al tocar ♥ o carrito).
      onIndex: i => { if (i >= state.photos.length - 5) loadMore(); if (i !== seenIdx) { seenIdx = i; trackPhotoView(ev.id, state.photos[i]?.photographerUid); } },
      footer: (i, el, rerender) => viewerFooter(state.photos[i], el, rerender),
    });
  }

  // Foto suelta (link compartido de una foto).
  function openSingle(p) {
    openViewer({ index: 0, src: () => p.previewUrl, count: () => 1, total: () => '1', footer: (i, el, rerender) => viewerFooter(p, el, rerender) });
  }

  function viewerFooter(p, el, rerender) {
    const ph = byUid.get(p.photographerUid);
    const set = sets.get(p.photographerUid) || {};
    const packs = (set.packs || []).map(k => `${k.qty} x ${fmtMoney(k.price)}`).join(' · ');
    const inCart = cart.has(p.id);
    const fav = favs.has(p.id);
    el.innerHTML = `
      <span class="small">📷 ${esc(ph?.displayName || '')}${set.price ? ` · <strong>${fmtMoney(set.price)}</strong>` : ''}${packs ? `<br><span style="opacity:.75">Packs: ${packs}</span>` : ''}</span>
      <span class="row">
        <button class="btn sm" id="lb-fav" title="Favorita">${fav ? '♥' : '♡'}</button>
        <button class="btn sm" id="lb-share" title="Compartir esta foto">🔗</button>
        <a class="btn sm" href="#/carrito">Ver carrito</a>
        ${forSale(p.photographerUid)
          ? `<button class="btn ${inCart ? '' : 'primary'}" id="lb-add">${inCart ? '✓ En el carrito' : '🛒 Agregar al carrito'}</button>`
          : '<button class="btn" disabled>Ya no está a la venta</button>'}</span>`;
    $('#lb-add', el)?.addEventListener('click', () => { toggleCart(p); rerender(); });
    $('#lb-fav', el).onclick = () => { toggleFav(p); rerender(); };
    $('#lb-share', el).onclick = () => shareLink({
      title: `Foto de ${ev.name}`, text: `📸 Mirá esta foto de ${ev.name}:`,
      url: `${eventUrl(ev.id)}${eventUrl(ev.id).includes('?') ? '&' : '?'}foto=${encodeURIComponent(p.id)}`,
    });
  }

  // Link a una foto puntual (?foto=): se abre sola arriba de la galería.
  if (initialPhoto) {
    getDoc(doc(db, 'photos', initialPhoto)).then(s => {
      const d = s.data();
      if (s.exists() && d.eventId === ev.id && !d.hidden) openSingle({ id: s.id, ...d });
    }).catch(() => {});
  }

  const bibForm = $('#g-bib', box);
  if (bibForm) {
    bibForm.onsubmit = e => {
      e.preventDefault();
      const n = cleanBib($('#g-bib-in', box).value);
      state.bib = n === '0' ? '' : n;
      Object.assign(state, { fav: false, hour: 0 });
      $('#g-bib-in', box).blur();
      reset();
    };
    $('#g-bib-x', box).onclick = () => { state.bib = ''; $('#g-bib-in', box).value = ''; reset(); };
  }

  syncCartBar();
  drawFilters();
  loadMore();
}
