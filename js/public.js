// Sitio público: inicio con filtros, página de evento y perfil de fotógrafo.
import {
  db, collection, doc, getDoc, getDocs, query, where, orderBy, limit, startAfter,
} from './fb.js';
import {
  $, $$, esc, fmtDate, parseHash, queryWords, avatarHtml, coverHtml, SOCIALS, toast, errMsg, waLink, normalize,
} from './util.js';
import { loadTaxonomy, tagPills, loadSettings, isPro, portfolioLimit } from './data.js';
import { openViewer } from './viewer.js';
import { mountGallery } from './gallery.js';
import { renderCart } from './cart-view.js';
import { renderAccount } from './account.js';
import { renderOrder } from './order-view.js';
import { cart } from './cart.js';

const updateCartBadge = () => {
  const n = cart.count();
  const el = document.getElementById('cart-count');
  el.textContent = n;
  el.classList.toggle('hidden', !n);
};
window.addEventListener('cart:change', updateCartBadge);
updateCartBadge();

const app = $('#app');
const PAGE = 24;

window.addEventListener('hashchange', route);
// Al ingresar/salir se re-dibujan las vistas que dependen de la cuenta.
window.addEventListener('account:change', () => { const p = parseHash().parts[0]; if (p === 'cuenta' || p === 'carrito' || p === 'pedido') route(); });
route();

function route() {
  const { parts } = parseHash();
  document.title = 'Quiero Mis Fotos';
  window.scrollTo(0, 0);
  if (parts[0] === 'evento' && parts[1]) return renderEvent(parts[1]);
  if (parts[0] === 'f' && parts[1]) return renderProfile(parts[1]);
  if (parts[0] === 'carrito') return renderCart(app);
  if (parts[0] === 'cuenta') return renderAccount(app);
  if (parts[0] === 'pedido' && parts[1]) return renderOrder(app, parts[1], parseHash().query);
  if (parts[0] === 'fotografos') return renderDirectory();
  return renderHome();
}

// ---------------------------------------------------------------- inicio
const filters = { q: '', from: '', to: '', tags: {} }; // tags: { typeId: tagId }
let cursor = null;
let loading = false;

async function renderHome() {
  const tax = await loadTaxonomy();
  app.innerHTML = `
    <section style="margin-bottom:18px">
      <h1>Encontrá tus fotos</h1>
      <p class="muted">Buscá el evento donde participaste y comprá tus fotos en alta calidad.</p>
    </section>
    <div class="filters">
      <input class="search" type="text" id="f-q" placeholder="Buscar evento por nombre o lugar…" value="${esc(filters.q)}">
      ${tax.types.map(t => `
        <select data-type="${t.id}">
          <option value="">${esc(t.name)}: todos</option>
          ${tax.tags.filter(g => g.typeId === t.id).map(g =>
            `<option value="${g.id}" ${filters.tags[t.id] === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>`).join('')}
      <div class="dates">
        <input type="date" id="f-from" value="${filters.from}" title="Desde" aria-label="Desde">
        <input type="date" id="f-to" value="${filters.to}" title="Hasta" aria-label="Hasta">
      </div>
    </div>
    <div id="results" class="events-grid"></div>
    <div id="more" class="row" style="justify-content:center;margin-top:20px"></div>`;

  const reload = () => { cursor = null; $('#results').innerHTML = ''; loadEvents(tax); };
  let t;
  $('#f-q').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { filters.q = e.target.value; reload(); }, 350); });
  $('#f-from').addEventListener('change', e => { filters.from = e.target.value; reload(); });
  $('#f-to').addEventListener('change', e => { filters.to = e.target.value; reload(); });
  app.querySelectorAll('select[data-type]').forEach(s => s.addEventListener('change', () => {
    if (s.value) filters.tags[s.dataset.type] = s.value; else delete filters.tags[s.dataset.type];
    reload();
  }));
  reload();
}

async function loadEvents(tax) {
  if (loading) return;
  loading = true;
  const results = $('#results');
  const more = $('#more');
  more.innerHTML = '<div class="spinner" style="margin:10px auto"></div>';

  const words = queryWords(filters.q);
  const tagIds = Object.values(filters.tags);
  const cons = [where('status', '==', 'published')];
  // Firestore admite un solo array-contains por consulta: el resto se filtra en el cliente.
  if (words.length) cons.push(where('searchTokens', 'array-contains', words[0]));
  else if (tagIds.length) cons.push(where('tagIds', 'array-contains', tagIds[0]));
  if (filters.from) cons.push(where('date', '>=', filters.from));
  if (filters.to) cons.push(where('date', '<=', filters.to));
  cons.push(orderBy('date', 'desc'));
  if (cursor) cons.push(startAfter(cursor));
  cons.push(limit(PAGE));

  try {
    const snap = await getDocs(query(collection(db, 'events'), ...cons));
    cursor = snap.docs[snap.docs.length - 1] || cursor;
    const evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(ev =>
      tagIds.every(id => (ev.tagIds || []).includes(id)) &&
      words.every(w => (ev.searchTokens || []).includes(w)));
    results.insertAdjacentHTML('beforeend', evs.map(ev => eventCard(ev, tax)).join(''));
    if (!results.children.length && snap.docs.length < PAGE) {
      results.innerHTML = `<div class="empty" style="grid-column:1/-1">No encontramos eventos con esos filtros.</div>`;
    }
    more.innerHTML = snap.docs.length === PAGE ? '<button class="btn" id="load-more">Ver más eventos</button>' : '';
    $('#load-more')?.addEventListener('click', () => loadEvents(tax));
  } catch (e) {
    more.innerHTML = '';
    results.innerHTML = `<div class="empty" style="grid-column:1/-1">No se pudieron cargar los eventos.<br><span class="small">${esc(errMsg(e))}</span></div>`;
  } finally {
    loading = false;
  }
}

function eventCard(ev, tax) {
  const tags = tagPills(ev.tagIds, tax, 3);
  return `
    <a class="event-card" href="#/evento/${ev.id}">
      ${coverHtml(ev)}
      <div class="body">
        <span class="date">${esc(fmtDate(ev.date))}</span>
        <span class="name">${esc(ev.name)}</span>
        ${ev.location ? `<span class="muted small">📍 ${esc(ev.location)}</span>` : ''}
        ${tags.length ? `<div class="pills">${tags.map(t => `<span class="pill">${esc(t.name)}</span>`).join('')}</div>` : ''}
      </div>
    </a>`;
}

// ---------------------------------------------------------------- evento
async function renderEvent(id) {
  app.innerHTML = '<div class="spinner"></div>';
  let ev;
  try {
    const snap = await getDoc(doc(db, 'events', id));
    if (!snap.exists()) throw new Error('not-found');
    ev = { id, ...snap.data() };
  } catch {
    app.innerHTML = `<div class="empty"><h2>Evento no encontrado</h2><p>Puede que todavía no esté publicado.</p><a class="btn" href="#/">Volver al inicio</a></div>`;
    return;
  }
  const [tax, photographers, setsSnap] = await Promise.all([
    loadTaxonomy(), loadUsers(ev.photographerUids || []), getDocs(collection(db, 'events', id, 'sets')).catch(() => null),
  ]);
  const sets = new Map((setsSnap?.docs || []).map(d => [d.id, d.data()]));
  const tags = tagPills(ev.tagIds, tax);
  document.title = `${ev.name} · Quiero Mis Fotos`;

  app.innerHTML = `
    <a href="#/" class="muted small" style="text-decoration:none">← Todos los eventos</a>
    <div class="event-hero" style="margin-top:10px">
      <div class="cover">
        ${ev.coverUrl ? `<img src="${esc(ev.coverUrl)}" alt="">` : ''}
        <div class="meta">
          <h1>${esc(ev.name)}</h1>
          <div>${esc(fmtDate(ev.date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))}${ev.location ? ` · 📍 ${esc(ev.location)}` : ''}</div>
        </div>
      </div>
    </div>
    ${tags.length ? `<div class="pills" style="margin-bottom:18px">${tags.map(t => `<span class="pill accent">${esc(t.name)}</span>`).join('')}</div>` : ''}
    ${ev.demo ? '<div class="notice warn">👀 <strong>Evento de ejemplo.</strong> Está para que veas cómo funciona la plataforma: podés ver las fotos y armar el carrito, pero no se pueden comprar.</div>' : ''}
    <section class="card">
      <h2>Fotógrafos</h2>
      ${photographers.length
        ? `<div class="people">${photographers.map(p => `<a class="person" href="#/f/${esc(p.slug)}">${avatarHtml(p)}<span><strong>${esc(p.displayName)}</strong>${p.zone ? `<br><span class="muted small">${esc(p.zone)}</span>` : ''}</span></a>`).join('')}</div>`
        : '<p class="muted">Todavía no hay fotógrafos en este evento.</p>'}
    </section>
    <section class="card">
      <h2>Fotos</h2>
      <div id="gallery"></div>
    </section>`;
  mountGallery($('#gallery'), { ev, photographers, sets });
}

async function loadPortfolio(user, settings) {
  const box = $('#p-portfolio');
  try {
    const snap = await getDocs(query(collection(db, 'portfolio'), where('photographerUid', '==', user.uid)));
    const max = portfolioLimit(user, settings);
    const items = snap.docs.map(d => d.data()).filter(p => p.slot < max)
      .sort((a, b) => (a.order || 0) - (b.order || 0) || a.slot - b.slot);
    if (!items.length) return;
    box.innerHTML = `<h2>Portfolio</h2><div class="gallery" style="margin-bottom:26px">${items.map((p, i) =>
      `<div class="g-item" data-i="${i}" role="button" tabindex="0"><img src="${esc(p.thumbUrl)}" alt="${esc(p.caption || '')}" loading="lazy"></div>`).join('')}</div>`;
    const open = i => openViewer({
      index: i, src: k => items[k].url, count: () => items.length,
      footer: (k, el) => { el.innerHTML = `<span class="small">${esc(items[k].caption || '')}</span><span class="muted small">Portfolio · no disponible para compra</span>`; },
    });
    $$('.g-item', box).forEach(el => {
      el.onclick = () => open(+el.dataset.i);
      el.onkeydown = e => { if (e.key === 'Enter') open(+el.dataset.i); };
    });
  } catch { /* sin portfolio */ }
}

// ---------------------------------------------------------------- directorio
async function renderDirectory() {
  document.title = 'Fotógrafos · Quiero Mis Fotos';
  app.innerHTML = '<div class="spinner"></div>';
  const [tax, snap] = await Promise.all([
    loadTaxonomy(),
    getDocs(query(collection(db, 'users'), where('status', '==', 'approved'), limit(500))).catch(() => null),
  ]);
  const all = (snap?.docs || []).map(d => ({ uid: d.id, ...d.data() })).filter(u => u.role === 'photographer');
  const sportType = tax.types.find(t => normalize(t.name) === 'deporte');
  const sports = sportType ? tax.tags.filter(g => g.typeId === sportType.id) : [];
  const f = { q: '', sport: '', service: '' };

  app.innerHTML = `
    <h1>Fotógrafos</h1>
    <p class="muted">Encontrá un fotógrafo para tu evento, partido o sesión y pedile presupuesto.</p>
    <div class="filters">
      <input class="search" type="text" id="d-q" placeholder="Buscar por nombre o zona…">
      ${sports.length ? `<select id="d-sport"><option value="">Deporte: todos</option>${sports.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>` : ''}
      <select id="d-service"><option value="">Tipo de trabajo: todos</option>${['Deportes', 'Eventos sociales', 'Retratos / books', 'Institucional', 'Producto', 'Video'].map(v => `<option>${esc(v)}</option>`).join('')}</select>
    </div>
    <div id="d-list" class="dir-grid"></div>`;

  const draw = () => {
    const words = normalize(f.q).split(/\s+/).filter(Boolean);
    const list = all.filter(u =>
      (!f.sport || (u.specialties || []).includes(f.sport)) &&
      (!f.service || (u.services || []).includes(f.service)) &&
      words.every(w => normalize(`${u.displayName} ${u.zone} ${u.workZones || ''}`).includes(w)))
      .sort((a, b) => (isPro(b) - isPro(a)) || a.displayName.localeCompare(b.displayName, 'es'));
    $('#d-list').innerHTML = list.length ? list.map(u => {
      const sp = (u.specialties || []).map(id => tax.tagById.get(id)).filter(Boolean).slice(0, 4);
      return `
        <div class="dir-card ${isPro(u) ? 'pro' : ''}">
          <a class="row" href="#/f/${esc(u.slug)}" style="text-decoration:none;flex-wrap:nowrap">${avatarHtml(u)}
            <span style="min-width:0"><strong>${esc(u.displayName)}</strong>${isPro(u) ? ' <span class="pill accent">⭐ Destacado</span>' : ''}${u.demo ? ' <span class="pill warn">Ejemplo</span>' : ''}<br>
            <span class="muted small">${esc(u.zone || '')}</span></span></a>
          ${sp.length || u.services?.length ? `<div class="pills">${sp.map(t => `<span class="pill accent">${esc(t.name)}</span>`).join('')}${(u.services || []).slice(0, 3).map(v => `<span class="pill">${esc(v)}</span>`).join('')}</div>` : ''}
          <div class="row" style="margin-top:auto">
            <a class="btn sm" href="#/f/${esc(u.slug)}">Ver perfil</a>
            ${u.demo ? '<button class="btn sm primary" data-demo-quote>💬 Presupuesto</button>' : u.socials?.whatsapp ? `<a class="btn sm primary" target="_blank" rel="noopener" href="${esc(waLink(u.socials.whatsapp, `¡Hola ${u.displayName}! Te encontré en Quiero Mis Fotos y quería pedirte un presupuesto para `))}">💬 Presupuesto</a>` : ''}
          </div>
        </div>`;
    }).join('') : '<div class="empty" style="grid-column:1/-1">No encontramos fotógrafos con esos filtros.</div>';
    $$('[data-demo-quote]').forEach(b => b.onclick = () => toast('Es un perfil de ejemplo: en un perfil real este botón abre el WhatsApp del fotógrafo.'));
  };
  let t;
  $('#d-q').oninput = e => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value; draw(); }, 200); };
  $('#d-sport')?.addEventListener('change', e => { f.sport = e.target.value; draw(); });
  $('#d-service').onchange = e => { f.service = e.target.value; draw(); };
  draw();
}

async function loadUsers(uids) {
  const out = await Promise.all(uids.map(uid =>
    getDoc(doc(db, 'users', uid)).then(s => (s.exists() ? { uid, ...s.data() } : null)).catch(() => null)));
  return out.filter(u => u && u.status === 'approved');
}

// ---------------------------------------------------------------- perfil
async function renderProfile(slug) {
  app.innerHTML = '<div class="spinner"></div>';
  let user;
  try {
    const s = await getDoc(doc(db, 'slugs', slug));
    if (!s.exists()) throw new Error('nf');
    const u = await getDoc(doc(db, 'users', s.data().uid));
    if (!u.exists()) throw new Error('nf');
    user = { uid: u.id, ...u.data() };
  } catch {
    app.innerHTML = `<div class="empty"><h2>Fotógrafo no encontrado</h2><a class="btn" href="#/">Volver al inicio</a></div>`;
    return;
  }
  document.title = `${user.displayName} · Quiero Mis Fotos`;
  const [tax, settings] = await Promise.all([loadTaxonomy(), loadSettings()]);
  const socials = SOCIALS.filter(s => user.socials?.[s.key] && s.key !== 'whatsapp');
  const sports = (user.specialties || []).map(id => tax.tagById.get(id)).filter(Boolean);
  const wa = user.socials?.whatsapp;
  const quoteMsg = `¡Hola ${user.displayName}! Te encontré en Quiero Mis Fotos y quería pedirte un presupuesto para `;
  app.innerHTML = `
    <div class="profile-head">
      ${avatarHtml(user, 'lg')}
      <div style="flex:1;min-width:220px">
        <h1 style="margin-bottom:4px">${esc(user.displayName)} ${isPro(user) ? '<span class="pill accent" style="vertical-align:middle">⭐ Pro</span>' : ''}</h1>
        ${user.zone ? `<div class="muted">📍 ${esc(user.zone)}${user.workZones ? ` · Trabaja en ${esc(user.workZones)}` : ''}</div>` : ''}
        ${user.bio ? `<p style="margin-top:8px;white-space:pre-line">${esc(user.bio)}</p>` : ''}
        ${sports.length || user.services?.length ? `<div class="pills" style="margin-bottom:10px">
          ${sports.map(t => `<span class="pill accent">${esc(t.name)}</span>`).join('')}
          ${(user.services || []).map(v => `<span class="pill">${esc(v)}</span>`).join('')}</div>` : ''}
        <div class="row">
          ${user.demo ? '<button class="btn primary" data-demo-quote>💬 Pedir presupuesto</button>'
            : wa ? `<a class="btn primary" target="_blank" rel="noopener" href="${esc(waLink(wa, quoteMsg))}">💬 Pedir presupuesto</a>` : ''}
          ${socials.map(s => user.demo
            ? `<button class="btn sm" data-demo-quote>${s.label}</button>`
            : `<a class="btn sm" target="_blank" rel="noopener" href="${esc(s.url(user.socials[s.key]))}">${s.label}</a>`).join('')}
        </div>
      </div>
    </div>
    ${user.demo ? '<div class="notice warn">👀 <strong>Perfil de ejemplo.</strong> Así se ve el perfil de un fotógrafo: portfolio, especialidades, contacto y sus eventos.</div>' : ''}
    <section id="p-portfolio"></section>
    <h2>Eventos</h2>
    <div id="p-events" class="events-grid"><div class="spinner"></div></div>`;

  $$('[data-demo-quote]').forEach(b => b.addEventListener('click', () => toast('Es un perfil de ejemplo: en un perfil real este botón abre el contacto del fotógrafo.')));
  loadPortfolio(user, settings);
  try {
    const [snap] = await Promise.all([
      getDocs(query(collection(db, 'events'),
        where('photographerUids', 'array-contains', user.uid),
        where('status', '==', 'published'),
        orderBy('date', 'desc'), limit(60))),
    ]);
    const evs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    $('#p-events').innerHTML = evs.length
      ? evs.map(ev => eventCard(ev, tax)).join('')
      : '<div class="empty" style="grid-column:1/-1">Todavía no publicó eventos.</div>';
  } catch (e) {
    $('#p-events').innerHTML = '';
    toast(errMsg(e), 'error');
  }
}
