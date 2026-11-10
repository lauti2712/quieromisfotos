// Galería pública de un evento: filtros por fotógrafo y sub-álbum, scroll infinito y visor.
import { db, collection, getDocs, query, where, orderBy, limit, startAfter, Timestamp, getCountFromServer, doc, getDoc, SUPERADMIN_EMAIL } from './fb.js';
import { $, $$, esc, fmtMoney, toast, errMsg, todayIso, fmtDate, waLink } from './util.js';
import { cart } from './cart.js';
import { openViewer } from './viewer.js';
import { setForSale, setUntil, loadSettings, feePercentFor } from './data.js';
import { computeTotals, splitPhotos, bestPrice } from './pricing.js';
import { favs } from './favs.js';
import { shareLink, eventUrl } from './share.js';
import { trackPhotoView, trackCartAdd } from './stats.js';
import { API_BASE, apiPost } from './api.js';
import { currentUser, requireLogin } from './account.js';

const PAGE = 60;

// Cómo comprar + quién es quién (la plataforma no es la dueña de las fotos): ventana al abrir el álbum.
// Se cierra con "Continuar" o tocando afuera; vuelve a aparecer en ese celular a los 30 días.
const HOWTO_KEY = 'qmf-howto-hidden';
function showHowTo(phs, evName = '') {
  try { if (Date.now() - Number(localStorage.getItem(HOWTO_KEY) || 0) < 30 * 86400000) return; } catch { /* nada */ }
  if (document.querySelector('dialog.howto-dlg')) return;
  const names = phs.map(u => u.displayName).filter(Boolean);
  const dlg = document.createElement('dialog');
  dlg.className = 'howto-dlg';
  dlg.innerHTML = `<div class="dlg-body stack howto">
      <h2 style="margin:0">📸 Cómo comprar tus fotos</h2>
      <ol class="howto-steps">
        <li>Tocá <strong>＋</strong> en las fotos que quieras (o <strong>Elegir varias</strong>).</li>
        <li>Tocá <strong>🛒 Ver carrito</strong>.</li>
        <li>Pagá con <strong>Mercado Pago</strong> y descargalas al instante, en alta calidad y sin marca de agua. No hace falta crear una cuenta.</li>
      </ol>
      <p class="muted small" style="margin:0">ℹ️ <strong>Quiero Mis Fotos</strong> es la plataforma donde los fotógrafos venden sus fotos: no somos los autores${names.length ? `. Las fotos de este evento son de <strong>${esc(names.join(', '))}</strong>` : ''}. Si tenés un problema con el pago o la descarga, <a target="_blank" rel="noopener" href="https://wa.me/5493424856528?text=${encodeURIComponent(`Hola! Tengo un problema con mi compra en el evento "${evName}"`)}">escribinos</a>.</p>
    </div>
    <div class="dlg-foot"><button class="btn primary block" id="howto-ok">Continuar</button></div>`;
  document.body.appendChild(dlg);
  const close = () => { try { localStorage.setItem(HOWTO_KEY, String(Date.now())); } catch { /* nada */ } if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.addEventListener('close', () => { try { localStorage.setItem(HOWTO_KEY, String(Date.now())); } catch { /* nada */ } dlg.remove(); });
  dlg.querySelector('#howto-ok').onclick = close;
  // Tocar afuera del recuadro (el fondo es el propio <dialog>) también cierra.
  dlg.addEventListener('click', e => { if (e.target === dlg) close(); });
  dlg.showModal();
}

export function mountGallery(box, { ev, photographers, sets, initialUid = '', initialPhoto = '', initialBib = '', onFirstPhoto }) {
  const byUid = new Map(photographers.map(p => [p.uid, p]));
  const withPhotos = photographers.filter(p => (sets.get(p.uid)?.photoCount || 0) > 0);
  const state = { uid: '', sub: '', hour: 0, fav: false, bib: '', photos: [], cursor: null, done: false, loading: false };
  // Búsqueda por dorsal: aparece si algún fotógrafo tiene fotos con dorsales leídos.
  const hasBibs = withPhotos.some(p => (sets.get(p.uid)?.bibPhotos || 0) > 0);
  // Búsqueda por selfie: algún álbum a la venta con la opción activada (la apaga el fotógrafo o el superadmin).
  const selfieOn = !ev.demo && withPhotos.some(p => sets.get(p.uid)?.selfie !== false && (sets.get(p.uid)?.facesPhotos || 0) > 0 && setForSale(sets.get(p.uid)));
  const cleanBib = v => { const n = (String(v || '').match(/\d{1,6}/) || [''])[0]; return n ? String(parseInt(n, 10)) : ''; };
  // Link con dorsal (#/evento/{id}?dorsal=123): abre directo con la búsqueda hecha.
  if (hasBibs && cleanBib(initialBib) && cleanBib(initialBib) !== '0') state.bib = cleanBib(initialBib);
  let hours = []; // inicio (ms) de cada hora que tiene fotos
  let hourCount = new Map();

  // Link de álbum de un fotógrafo (#/evento/{id}?f={uid}): arranca filtrado por él.
  if (initialUid && withPhotos.some(p => p.uid === initialUid)) state.uid = initialUid;

  if (!withPhotos.length) {
    // Sin fotos todavía: lo principal es que se anote para el aviso (botón grande que usa el 🔔 de arriba).
    box.innerHTML = `<div class="empty stack" style="gap:14px;justify-items:center">
      <span>${ev.date > todayIso()
        ? `📅 Este evento es el <strong>${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long' }))}</strong>.`
        : '📷 Las fotos de este evento van a estar disponibles muy pronto.'}</span>
      <button class="btn primary big-cta" id="g-follow-cta">🔔 Avisarme cuando estén las fotos</button>
      <span class="muted small">Te mandamos una notificación apenas el fotógrafo las sube.</span></div>`;
    const cta = $('#g-follow-cta', box), top = document.getElementById('ev-follow');
    const sync = () => { const on = top?.classList.contains('on'); cta.textContent = on ? '✅ Te vamos a avisar' : '🔔 Avisarme cuando estén las fotos'; cta.classList.toggle('primary', !on); };
    if (top) { new MutationObserver(sync).observe(top, { attributes: true, attributeFilter: ['class'] }); sync(); cta.onclick = () => top.click(); } else cta.remove();
    return;
  }

  // Álbumes vencidos: se pueden ver, pero ya no se venden.
  // Sin Mercado Pago vinculado no se puede cobrar: se ven las fotos pero no se agregan al carrito (el ejemplo sí, para mostrar).
  const canCharge = uid => !!ev.demo || !!byUid.get(uid)?.mpConnected;
  const forSale = uid => setForSale(sets.get(uid)) && canCharge(uid);
  const isExpired = set => !!set && (set.originalsDeleted || (setUntil(set) > 0 && setUntil(set) <= Date.now()));
  const expired = withPhotos.filter(p => isExpired(sets.get(p.uid)));
  // Con fotos pero sin precio cargado: todavía no se pueden comprar (no es que vencieron).
  const noPrice = withPhotos.filter(p => { const s = sets.get(p.uid); return s && !isExpired(s) && !(s.price > 0); });
  const noPay = withPhotos.filter(p => setForSale(sets.get(p.uid)) && !canCharge(p.uid));
  // Subida en curso: llegó una foto en los últimos 15 minutos (lo marca el Worker en el set).
  const uploading = withPhotos.filter(p => Date.now() - (sets.get(p.uid)?.lastUploadAt?.toMillis?.() || 0) < 15 * 60000);
  box.innerHTML = `
    ${expired.length ? `<div class="notice warn stack" style="gap:8px"><span>${expired.length === withPhotos.length ? 'Las fotos de este evento' : `Las fotos de ${expired.map(p => esc(p.displayName)).join(', ')}`} ya no están a la venta en la plataforma (${expired.every(p => sets.get(p.uid)?.closedAt) ? 'el álbum se cerró' : 'venció el plazo de disponibilidad'})${expired.some(p => sets.get(p.uid)?.samplesKept) ? '. Quedan algunas fotos de muestra para que veas el trabajo' : ''}.</span>
      </div>` : ''}
    ${hasBibs ? `<form class="g-bib" id="g-bib" role="search">
      <label for="g-bib-in">🔢 Buscá tus fotos por número de dorsal</label>
      <div class="row"><input id="g-bib-in" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" placeholder="Ej: 1234" autocomplete="off" value="${esc(state.bib)}">
      <button class="btn primary">Buscar</button><button type="button" class="btn hidden" id="g-bib-x">Ver todas</button></div>
    </form>` : ''}
    ${uploading.length ? `<div class="notice ok small">📤 <strong>${uploading.map(p => esc(p.displayName)).join(', ')} está${uploading.length > 1 ? 'n' : ''} subiendo fotos ahora</strong> (van ${uploading.reduce((a, p) => a + (sets.get(p.uid)?.photoCount || 0), 0)}). Volvé en un rato o tocá <strong>🔔 Avisarme</strong> arriba.</div>` : ''}
    ${noPrice.length ? `<div class="notice">⏳ ${noPrice.length === withPhotos.length ? 'Las fotos de este evento todavía no están a la venta' : `Las fotos de ${noPrice.map(p => esc(p.displayName)).join(', ')} todavía no están a la venta`}: el fotógrafo está terminando de cargar los precios. Tocá <strong>🔔 Avisarme</strong> arriba y te avisamos.</div>` : ''}
    ${noPay.length ? `<div class="notice">⏳ ${noPay.length === withPhotos.length ? 'Las fotos de este evento todavía no están a la venta' : `Las fotos de ${noPay.map(p => esc(p.displayName)).join(', ')} todavía no están a la venta`}: el fotógrafo está terminando de configurar los pagos. Tocá <strong>🔔 Avisarme</strong> arriba y te avisamos.</div>` : ''}
    ${selfieOn ? `<div class="g-selfie" id="g-selfie"><button class="btn primary" id="g-selfie-go">🤳 Buscarme con una selfie</button><span class="muted small">Te mostramos las fotos donde aparecés.</span>
      <input type="file" id="g-selfie-in" accept="image/*" capture="user" hidden></div>` : ''}
    <div class="g-price" id="g-price"></div>
    <div class="filter-row" id="g-ph"></div>
    <div class="filter-row" id="g-sub"></div>
    <div class="filter-row" id="g-hour"></div>
    <div class="filter-row" id="g-fav"></div>
    <div class="g-tools" id="g-tools"></div>
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
    $$('[data-hour]', box).forEach(b => b.onclick = () => { state.hour = Number(b.dataset.hour); state.fav = false; state.selfie = null; reset(); });

    const nFav = favs.forEvent(ev.id).length;
    $('#g-fav', box).innerHTML = nFav || state.fav
      ? `<button class="chip ${state.fav ? 'on' : ''}" data-fav>♥ Mis favoritas (${nFav})</button>${state.fav ? '<span class="muted small" style="align-self:center">Guardadas en este dispositivo</span>' : ''}`
      : '';
    $('[data-fav]', box)?.addEventListener('click', () => { state.fav = !state.fav; state.selfie = null; reset(); });

    // Precio y packs de cada fotógrafo, arriba de las fotos.
    const shown = (state.uid ? withPhotos.filter(p => p.uid === state.uid) : withPhotos).filter(p => forSale(p.uid));
    $('#g-price', box).innerHTML = shown.map(p => {
      const st = sets.get(p.uid) || {};
      const packs = (st.packs || []).filter(k => k.qty > 1 && k.price > 0 && k.price < k.qty * st.price).sort((a, b) => a.qty - b.qty);
      return `<div class="g-price-row">💲 ${withPhotos.length > 1 ? `<strong>${esc(p.displayName)}</strong> · ` : ''}<strong>${fmtMoney(st.price)}</strong> por foto
        ${packs.map(k => `<span class="pill ok">${k.qty} fotos x ${fmtMoney(k.price)}</span>`).join(' ')}</div>`;
    }).join('') + (shown.length ? '<div class="muted small">Si llevás varias, se aplica solo la combinación más barata.</div>' : '');
    $$('[data-uid]', box).forEach(b => b.onclick = () => { state.uid = b.dataset.uid; state.sub = ''; state.selfie = null; reset(); });
    $$('[data-sub]', box).forEach(b => b.onclick = () => {
      state.sub = b.dataset.sub;
      if (!state.uid && withPhotos.length === 1) state.uid = withPhotos[0].uid;
      reset();
    });
  }

  function reset() {
    Object.assign(state, { photos: [], cursor: null, done: false, noTime: false, noTimeShown: false });
    $('#g-grid', box).innerHTML = '';
    drawFilters();
    loadMore();
  }

  async function loadMore() {
    if (state.loading || state.done) return;
    if (state.selfie) {
      const list = state.selfie;
      state.photos = list; state.done = true;
      $('#g-grid', box).innerHTML = list.length
        ? `<div class="g-bib-found"><span>🤳 Encontramos <strong>${list.length}</strong> foto${list.length === 1 ? '' : 's'} donde parecés estar (de la más parecida a la menos)</span><button type="button" class="btn sm" id="g-selfie-x">Ver todas</button></div>${list.map((p, i) => itemHtml(p, i)).join('')}`
        : `<div class="empty" style="grid-column:1/-1">No encontramos fotos tuyas con esa selfie.<br>Puede que no estés de frente en ninguna: probá con otra selfie con buena luz, o buscá por horario.<br><button type="button" class="btn sm" id="g-selfie-x" style="margin-top:8px">Ver todas</button></div>`;
      $('#g-selfie-x', box).onclick = () => { state.selfie = null; reset(); };
      $('#g-more', box).innerHTML = state.selfieD ? `<div class="notice row" id="g-face-save" style="justify-content:space-between;margin-top:12px"><span>🔔 ¿Querés que te avisemos cuando aparezcas en fotos nuevas de cualquier evento?</span><button type="button" class="btn sm primary">Avisarme</button></div>` : '';
      $('#g-face-save button', box)?.addEventListener('click', () => saveMyFace(state.selfieD));
      return;
    }
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
    // Filtro por hora: después de las fotos de esa hora se suman las que no tienen hora de cámara (sin EXIF:
    // su hora es la del archivo y pueden ser de cualquier momento del evento), para que no queden afuera.
    if (!state.bib && state.hour && state.noTime) cons.push(where('takenAtExact', '==', false), limit(PAGE));
    else {
      if (!state.bib && state.hour) cons.push(where('takenAt', '>=', Timestamp.fromMillis(state.hour)), where('takenAt', '<', Timestamp.fromMillis(state.hour + 3600000)));
      cons.push(orderBy('takenAt'), limit(PAGE));
    }
    if (state.cursor) cons.push(startAfter(state.cursor));
    try {
      const snap = await getDocs(query(collection(db, 'photos'), ...cons));
      state.cursor = snap.docs.at(-1) || state.cursor;
      state.done = snap.docs.length < PAGE;
      const seen = new Set(state.photos.map(p => p.id));
      const fresh = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(p => byUid.has(p.photographerUid) && !seen.has(p.id));
      const start = state.photos.length;
      if (!start && fresh[0] && onFirstPhoto) { onFirstPhoto(fresh[0]); onFirstPhoto = null; }
      if (state.noTime && fresh.length && !state.noTimeShown) {
        state.noTimeShown = true;
        $('#g-grid', box).insertAdjacentHTML('beforeend', '<div class="g-notime muted small" style="grid-column:1/-1;padding:10px 2px 2px">🕒 Fotos sin hora de cámara: pueden ser de cualquier momento del evento.</div>');
      }
      state.photos.push(...fresh);
      $('#g-grid', box).insertAdjacentHTML('beforeend', fresh.map((p, i) => itemHtml(p, start + i)).join(''));
      if (state.done && !state.noTime && !state.bib && state.hour) {
        Object.assign(state, { noTime: true, noTimeShown: false, cursor: null, done: false });
        setTimeout(loadMore); // sigue con las sin hora cuando termine esta carga
        return;
      }
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

  // Herramientas: elegir varias (tocar agrega/quita del carrito) y 2 o 3 columnas (se recuerda en el dispositivo).
  function drawTools() {
    const sale = withPhotos.some(p => forSale(p.uid));
    $('#g-tools', box).innerHTML = `
      ${sale ? `<button class="chip ${state.pick ? 'on' : ''}" id="g-pick">${state.pick ? '✓ Listo' : '☑️ Elegir varias'}</button>` : ''}
      <span class="g-cols" role="group" aria-label="Tamaño de las fotos">
        <button class="chip ${cols === 2 ? 'on' : ''}" data-cols="2" title="Fotos grandes">▢▢</button><button class="chip ${cols === 3 ? 'on' : ''}" data-cols="3" title="Fotos chicas">▫▫▫</button>
      </span>`;
    $('#g-pick', box)?.addEventListener('click', () => {
      state.pick = !state.pick;
      $('#g-grid', box).classList.toggle('picking', state.pick);
      if (state.pick) toast('Tocá las fotos que querés: se van sumando al carrito');
      drawTools(); syncCartBar();
    });
    $$('[data-cols]', box).forEach(b => b.onclick = () => {
      cols = Number(b.dataset.cols);
      try { localStorage.setItem('qmf-cols', String(cols)); } catch { /* nada */ }
      $('#g-grid', box).classList.toggle('cols3', cols === 3);
      drawTools();
    });
  }
  let cols = 2;
  try { cols = localStorage.getItem('qmf-cols') === '3' ? 3 : 2; } catch { /* nada */ }
  $('#g-grid', box).classList.toggle('cols3', cols === 3);
  drawTools();

  function itemHtml(p, i) {
    return `<div class="g-item ${cart.has(p.id) ? 'in-cart' : ''}" data-i="${i}" data-id="${p.id}" role="button" tabindex="0" aria-label="Ver foto">
      <img src="${esc(p.thumbUrl)}" alt="" loading="lazy" decoding="async">
      ${p.price > 0 ? `<span class="g-tag">${fmtMoney(p.price)}</span>` : ''}
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
    if (b && state.pick) { const p = state.photos[+b.dataset.i]; if (p && forSale(p.photographerUid)) toggleCart(p); return; }
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
    if (!state.pick) toast(added ? 'Foto agregada al carrito' : 'Foto quitada del carrito'); // eligiendo varias, alcanza con la barra
    syncCartMarks();
  }
  // Barra fija abajo con lo que lleva en el carrito (en el celular el botón del carrito queda lejos).
  // Total estimado del carrito (packs y costo de servicio aplicados; lo confirma el carrito al pagar) y sugerencia de pack.
  let settings = null;
  loadSettings().then(s => {
    settings = s;
    if (s.selfieEnabled === false) $('#g-selfie', box)?.remove(); // apagada para toda la plataforma
    if (document.body.contains(box)) syncCartBar();
  }).catch(() => {});
  function cartSummary() {
    let total = 0, tip = '';
    for (const g of cart.groups()) {
      const set = sets.get(g.photographerUid), ph = byUid.get(g.photographerUid);
      if (g.eventId !== ev.id || !set?.price || !settings) {
        total += g.items.reduce((a, it) => a + (it.price || set?.price || 0), 0);
        continue;
      }
      const split = splitPhotos(g.items, set.price);
      const t = computeTotals({ ...split, price: set.price, packs: set.packs, feeMode: set.feeMode, feePercent: feePercentFor(ph, settings) });
      total += t.total;
      tip ||= packTip(split.count, set);
    }
    return { n: cart.count(), total, tip };
  }
  // "Con 1 más llevás 5 por $6.000" si el pack siguiente sale casi lo mismo.
  function packTip(n, set) {
    const now = bestPrice(n, set.price, set.packs).subtotal;
    for (const p of (set.packs || []).filter(k => k.qty > n).sort((a, b) => a.qty - b.qty)) {
      const extra = p.qty - n;
      if (extra > 3) break;
      const then = bestPrice(p.qty, set.price, set.packs).subtotal;
      if (then - now < set.price * extra) return `💡 Con ${extra} más llevás ${p.qty} por ${fmtMoney(then)} (solo ${fmtMoney(then - now)} más)`;
    }
    return '';
  }
  function syncCartBar() {
    const { n, total, tip } = cartSummary();
    const bar = $('#g-cartbar', box);
    bar.classList.toggle('hidden', !n && !state.pick);
    bar.innerHTML = n
      ? `<span class="g-cartbar-txt"><span>🛒 <strong>${n}</strong> foto${n === 1 ? '' : 's'} · <strong>${fmtMoney(total)}</strong></span>${tip ? `<small>${esc(tip)}</small>` : ''}</span><span class="g-cartbar-go">Ver carrito y pagar</span>`
      : '<span>☑️ Tocá las fotos que querés comprar</span>';
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
      thumb: i => state.photos[i].thumbUrl,
      count: () => state.photos.length,
      total: () => `${state.photos.length}${state.done ? '' : '+'}`,
      // Cuenta la foto vista una vez (el visor también redibuja al tocar ♥ o carrito).
      onIndex: i => { if (i >= state.photos.length - 5) loadMore(); if (i !== seenIdx) { seenIdx = i; trackPhotoView(ev.id, state.photos[i]?.photographerUid); } },
      footer: (i, el, rerender) => viewerFooter(state.photos[i], el, rerender),
    });
  }

  // Foto suelta (link compartido de una foto).
  function openSingle(p) {
    openViewer({ index: 0, src: () => p.previewUrl, thumb: () => p.thumbUrl, count: () => 1, total: () => '1', footer: (i, el, rerender) => viewerFooter(p, el, rerender) });
  }

  // Crédito: en el plan Empresas, quién sacó la foto ("Juan Pérez para Productora X").
  function credit(p, ph) {
    const by = p.uploadedBy && p.uploadedBy !== p.photographerUid ? (ph?.teamPublic || []).find(m => m.uid === p.uploadedBy) : null;
    return by ? `${esc(by.name)} <span style="opacity:.75">para ${esc(ph?.displayName || '')}</span>` : esc(ph?.displayName || '');
  }

  // Revisión de calidad: el superadmin y el fotógrafo de la foto pueden bajar el original desde el visor.
  function canReview(p) {
    const u = currentUser();
    return !!u && ((u.email === SUPERADMIN_EMAIL && u.emailVerified) || u.uid === p.photographerUid || u.uid === p.uploadedBy);
  }
  function viewerFooter(p, el, rerender) {
    const ph = byUid.get(p.photographerUid);
    const set = sets.get(p.photographerUid) || {};
    const packs = (set.packs || []).filter(k => k.qty > 1 && k.price > 0 && k.price < k.qty * set.price).map(k => `${k.qty} x ${fmtMoney(k.price)}`).join(' · ');
    const inCart = cart.has(p.id);
    const fav = favs.has(p.id);
    el.innerHTML = `
      <span class="small">📷 ${credit(p, ph)}${set.price ? ` · <strong>${fmtMoney(p.price > 0 ? p.price : set.price)}</strong>` : ''}${p.price > 0 || p.noPack ? '<br><span style="opacity:.75">Esta foto no entra en packs</span>' : packs ? `<br><span style="opacity:.75">Packs: ${packs}</span>` : ''}</span>
      <span class="row">
        <button class="btn sm" id="lb-fav" title="Favorita">${fav ? '♥' : '♡'}</button>
        <button class="btn sm" id="lb-share" title="Compartir esta foto">🔗</button>
        ${canReview(p) ? '<button class="btn sm" id="lb-orig" title="Descargar el original para revisar la calidad (solo vos lo ves)">⬇️ Original</button>' : ''}
        <a class="btn sm" href="#/carrito">${cart.count() ? `🛒 ${cart.count()} · ${fmtMoney(cartSummary().total)}` : 'Ver carrito'}</a>
        ${forSale(p.photographerUid)
          ? `<button class="btn ${inCart ? '' : 'primary'}" id="lb-add">${inCart ? '✓ En el carrito' : '🛒 Agregar al carrito'}</button>`
          : '<button class="btn" disabled>Ya no está a la venta</button>'}</span>
      ${forSale(p.photographerUid) ? '<span class="lb-note">🛡️ <strong>Vista previa con marca de agua.</strong> Al comprar descargás la foto original en alta calidad, sin marca. · 🔒 Pago seguro con Mercado Pago</span>' : ''}
      ${forSale(p.photographerUid) && cartSummary().tip ? `<span class="lb-note lb-tip">${esc(cartSummary().tip)}</span>` : ''}`;
    $('#lb-add', el)?.addEventListener('click', () => { toggleCart(p); rerender(); });
    $('#lb-fav', el).onclick = () => { toggleFav(p); rerender(); };
    $('#lb-orig', el)?.addEventListener('click', async e => {
      e.target.disabled = true;
      try {
        const r = await apiPost(`/review/original/${p.id}`);
        const mb = n => `${(n / 1e6).toLocaleString('es-AR', { maximumFractionDigits: 1 })} MB`;
        toast(`Original: ${r.width}×${r.height} px · ${mb(r.bytes)}${r.fileBytes && r.fileBytes !== r.bytes ? ` (el archivo subido pesaba ${mb(r.fileBytes)})` : ''}`);
        const a = document.createElement('a'); a.href = r.url; a.download = ''; document.body.appendChild(a); a.click(); a.remove();
      } catch (err) { toast(errMsg(err), 'error'); }
      e.target.disabled = false;
    });
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

  // ---- buscarme con una selfie: aviso (una vez por dispositivo), selfie, huella en el celular y comparación en el servidor
  $('#g-selfie-go', box)?.addEventListener('click', () => {
    let ok = false;
    try { ok = localStorage.getItem('qmf-selfie-ok') === '1'; } catch { /* nada */ }
    if (ok) return $('#g-selfie-in', box).click();
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dlg-head"><h2>🤳 Buscarme con una selfie</h2><button class="btn ghost sm" data-close>✕</button></div>
      <div class="dlg-body stack">
        <p style="margin:0">Te sacás una selfie y te mostramos las fotos del evento donde aparecés.</p>
        <ul class="small" style="margin:0;padding-left:18px">
          <li>Tu celular calcula una <strong>huella numérica de tu cara</strong>. <strong>La selfie no se sube ni se guarda.</strong></li>
          <li>Esa huella se compara con las caras de las fotos del evento y <strong>no se guarda</strong> después de la búsqueda.</li>
          <li>Es un dato biométrico: lo usamos solo para esta búsqueda. Más info en <a href="privacidad/" target="_blank">Privacidad</a>.</li>
        </ul>
        <label class="check"><input type="checkbox" id="sf-ok"> Acepto que se use mi selfie para buscar mis fotos</label>
      </div>
      <div class="dlg-foot"><button class="btn primary" id="sf-go" disabled>Sacarme la selfie</button></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('#sf-ok').onchange = e => { dlg.querySelector('#sf-go').disabled = !e.target.checked; };
    dlg.querySelector('#sf-go').onclick = () => { try { localStorage.setItem('qmf-selfie-ok', '1'); } catch { /* nada */ } dlg.close(); $('#g-selfie-in', box).click(); };
    dlg.showModal();
  });
  $('#g-selfie-in', box)?.addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const btn = $('#g-selfie-go', box);
    btn.disabled = true; btn.textContent = '🤳 Buscando… (la primera vez tarda unos segundos)';
    try {
      const { selfieFace } = await import('./faces.js');
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const d = await selfieFace(bmp);
      bmp.close?.();
      if (!d) throw new Error('No encontramos una cara en la selfie. Probá de frente, con buena luz y sin anteojos de sol.');
      const res = await fetch(`${API_BASE}/faces/${ev.id}/match`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ d: Array.from(d) }) });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || 'No se pudo buscar. Probá de nuevo.');
      // Las fotos encontradas, en el orden de parecido (las borradas u ocultas se saltean).
      const docs = await Promise.all((r.photos || []).map(x => getDoc(doc(db, 'photos', x.p)).then(s => (s.exists() ? { id: s.id, ...s.data() } : null)).catch(() => null)));
      state.selfie = docs.filter(p => p && !p.hidden && p.eventId === ev.id && byUid.has(p.photographerUid));
      state.selfieD = Array.from(d);
      Object.assign(state, { fav: false, bib: '', hour: 0 });
      reset();
      $('#g-grid', box).scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { toast(errMsg(err), 'error'); }
    btn.disabled = false; btn.textContent = '🤳 Buscarme con una selfie';
  });

  // Guardar la cara (con consentimiento aparte) para avisarle cuando aparezca en fotos nuevas. Se borra desde Mi cuenta.
  function saveMyFace(d) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `<div class="dlg-head"><h2>🔔 Avisarme cuando aparezca</h2><button class="btn ghost sm" data-close>✕</button></div>
      <div class="dlg-body stack">
        <p style="margin:0">Guardamos la huella numérica de tu cara en tu cuenta y, cuando un fotógrafo sube fotos donde parecés estar, te avisamos.</p>
        <ul class="small" style="margin:0;padding-left:18px">
          <li>Se guarda solo la huella numérica, <strong>nunca la selfie</strong>.</li>
          <li>Es un dato biométrico: lo usamos solo para avisarte. No lo compartimos con nadie.</li>
          <li>La podés borrar cuando quieras desde <strong>Mi cuenta</strong>. Más info en <a href="privacidad/" target="_blank">Privacidad</a>.</li>
        </ul>
        <label class="check"><input type="checkbox" id="fs-ok"> Acepto que se guarde la huella de mi cara para avisarme</label>
      </div>
      <div class="dlg-foot"><button class="btn primary" id="fs-go" disabled>Guardar y avisarme</button></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('#fs-ok').onchange = e => { dlg.querySelector('#fs-go').disabled = !e.target.checked; };
    dlg.querySelector('#fs-go').onclick = async () => {
      dlg.close();
      try {
        await requireLogin('Ingresá para que te avisemos cuando aparezcas en fotos nuevas.');
        await apiPost('/faces/me', { d });
        $('#g-face-save', box)?.remove();
        toast('🔔 Listo. Te avisamos cuando aparezcas en fotos nuevas.');
        const { pushAvailable, pushOn, enablePush } = await import('./push.js');
        if (!pushOn() && await pushAvailable()) enablePush(currentUser().uid).catch(() => {});
      } catch (err) { toast(errMsg(err), 'error'); }
    };
    dlg.showModal();
  }

  if (!ev.demo && withPhotos.some(p => forSale(p.uid))) showHowTo(withPhotos.filter(p => forSale(p.uid)).map(p => byUid.get(p.uid) || { displayName: p.displayName }), ev.name);
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
