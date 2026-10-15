// Calendario público de eventos (pasados y próximos): vista mensual en pantallas grandes y agenda en el celular,
// con filtros por actividad, club y lugar.
import { db, collection, getDocs, query, where, orderBy, limit } from './fb.js';
import { $, $$, esc, todayIso } from './util.js';
import { loadTaxonomy } from './data.js';

const state = { month: todayIso().slice(0, 7), tags: {} };
const DOW = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const pad = n => String(n).padStart(2, '0');
function shift(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export async function renderCalendar(app) {
  document.title = 'Calendario de eventos · Quiero Mis Fotos';
  const tax = await loadTaxonomy();
  const [y, m] = state.month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const from = `${state.month}-01`, to = `${state.month}-${pad(last)}`;
  const title = new Date(y, m - 1, 1).toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });
  const titleCap = title.charAt(0).toUpperCase() + title.slice(1);

  app.innerHTML = `
    <a href="#/" class="muted small" style="text-decoration:none">← Inicio</a>
    <div class="row" style="justify-content:space-between;margin:10px 0 14px">
      <h1 style="margin:0">📅 Calendario</h1>
      <div class="row cal-nav">
        <button class="btn sm" data-m="-1" aria-label="Mes anterior">‹</button>
        <strong class="cal-title">${esc(titleCap)}</strong>
        <button class="btn sm" data-m="1" aria-label="Mes siguiente">›</button>
        ${state.month !== todayIso().slice(0, 7) ? '<button class="btn sm" data-today>Hoy</button>' : ''}
      </div>
    </div>
    <div class="filters cal-filters">
      ${tax.types.map(t => `
        <select data-type="${t.id}">
          <option value="">${esc(t.name)}: todos</option>
          ${tax.tags.filter(g => g.typeId === t.id).map(g => `<option value="${g.id}" ${state.tags[t.id] === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}
        </select>`).join('')}
    </div>
    <div id="cal"><div class="spinner"></div></div>
    <p class="muted small">Tocá un evento para ver sus fotos o, si todavía no se hizo, activar el aviso 🔔 para cuando las suban.</p>`;

  $$('[data-m]').forEach(b => b.onclick = () => { state.month = shift(state.month, Number(b.dataset.m)); renderCalendar(app); });
  $('[data-today]')?.addEventListener('click', () => { state.month = todayIso().slice(0, 7); renderCalendar(app); });
  $$('select[data-type]').forEach(s => s.onchange = () => {
    if (s.value) state.tags[s.dataset.type] = s.value; else delete state.tags[s.dataset.type];
    renderCalendar(app);
  });

  let evs = [];
  try {
    const snap = await getDocs(query(collection(db, 'events'), where('status', '==', 'published'),
      where('date', '>=', from), where('date', '<=', to), orderBy('date'), limit(500)));
    const want = Object.values(state.tags);
    evs = snap.docs.map(d => ({ id: d.id, ...d.data() })).filter(ev => want.every(id => (ev.tagIds || []).includes(id)));
  } catch (e) {
    $('#cal').innerHTML = `<div class="notice danger">No se pudo cargar el calendario.</div>`;
    return;
  }
  const byDay = new Map();
  evs.forEach(ev => { const k = ev.date; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(ev); });
  const today = todayIso();
  const tagName = id => tax.tagById.get(id)?.name;
  const chip = ev => `<a class="cal-ev ${ev.date > today ? 'future' : ''}" href="#/evento/${ev.id}" title="${esc(ev.name)}">${ev.date > today ? '📅 ' : '📷 '}${esc(ev.name)}</a>`;

  // Grilla mensual (lunes primero).
  const first = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<div class="cal-cell empty"></div>');
  for (let d = 1; d <= last; d++) {
    const k = `${state.month}-${pad(d)}`;
    cells.push(`<div class="cal-cell ${k === today ? 'today' : ''} ${k < today ? 'past' : ''}"><span class="cal-d">${d}</span>${(byDay.get(k) || []).map(chip).join('')}</div>`);
  }
  // Agenda (celular).
  const agenda = [...byDay.entries()].map(([k, list]) => {
    const d = new Date(`${k}T12:00:00`);
    return `<div class="cal-day ${k === today ? 'today' : ''}">
      <div class="cal-day-h"><strong>${d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric' })}</strong>${k > today ? ' <span class="pill accent">Próximo</span>' : ''}</div>
      ${list.map(ev => `<a class="cal-item" href="#/evento/${ev.id}"><strong>${esc(ev.name)}</strong>
        <span class="muted small">${[ev.location ? `📍 ${ev.location}` : '', ...(ev.tagIds || []).map(tagName).filter(Boolean).slice(0, 3)].map(esc).join(' · ')}</span></a>`).join('')}
    </div>`;
  }).join('');

  $('#cal').innerHTML = `
    <div class="cal-grid">${DOW.map(d => `<div class="cal-dow">${d}</div>`).join('')}${cells.join('')}</div>
    <div class="cal-agenda">${agenda || '<div class="empty">No hay eventos este mes con esos filtros.</div>'}</div>
    ${!evs.length ? '<p class="muted small cal-none">No hay eventos este mes con esos filtros.</p>' : ''}`;
}
