// Plan Empresas en el panel.
//   Empresa:      #/equipo                    -> lugares, link de invitación, colaboradores (sacar)
//   Colaborador:  #/equipos                   -> empresas de las que forma parte y sus eventos
//                 #/equipo-evento/{emp}/{eid} -> sube al álbum de la empresa; ve el precio y cuántas de sus fotos se vendieron
//   Invitación:   #/unirse/{token}
import { db, collection, doc, getDoc, getDocs, query, where } from './fb.js';
import { $, $$, esc, toast, errMsg, fmtMoney, fmtDate } from './util.js';
import { apiPost } from './api.js';
import { teamSeats, planSpec, bibsOn } from './data.js';
import { mountPhotos } from './panel-photos.js';
import { shareLink } from './share.js';

const SUPPORT_WA = '5493424856528';

// Empresas de las que el usuario es colaborador.
export async function loadMyTeams(uid) {
  const snap = await getDocs(query(collection(db, 'teams'), where('members', 'array-contains', uid))).catch(() => null);
  return (snap?.docs || []).map(d => ({ owner: d.id, ...d.data() }));
}

// ---------------------------------------------------------------- empresa
export async function viewTeam(view, { uid, profile, settings }) {
  const seats = teamSeats(profile, settings);
  const t = (await getDoc(doc(db, 'teams', uid)).catch(() => null))?.data() || {};
  const members = t.members || [];
  const info = t.memberInfo || {};
  const extra = planSpec('empresa', settings).seatPrice;
  view.innerHTML = `
    <h1>👥 Mi equipo</h1>
    ${!seats ? `<div class="notice">El equipo de fotógrafos es del plan <a href="#/web">Empresas</a>: tus fotógrafos suben a tus álbumes y vos cobrás todas las ventas.</div>` : ''}
    <div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">Fotógrafos</h2><span class="pill ${members.length >= seats ? 'warn' : ''}">${members.length} de ${seats} lugares</span></div>
      <p class="muted small" style="margin:0">Cada uno entra con su propia cuenta y sube fotos a los álbumes de tus eventos. Las ventas las cobrás vos; en cada evento ves cuánto vendió cada uno para liquidarles. Ellos ven el precio y cuántas de sus fotos se vendieron (no ven a los compradores).</p>
      ${members.length ? members.map(m => `
        <div class="item-row"><div class="grow"><strong>${esc(info[m]?.name || 'Fotógrafo')}</strong>${info[m]?.joinedAt?.toDate ? `<br><span class="muted small">En el equipo desde el ${esc(info[m].joinedAt.toDate().toLocaleDateString('es-AR'))}</span>` : ''}</div>
          <button class="btn sm danger ghost" data-rm="${esc(m)}">Sacar</button></div>`).join('') : '<p class="muted" style="margin:0">Todavía no sumaste fotógrafos.</p>'}
      ${seats ? `<div class="row">
        <button class="btn primary" id="tm-invite" ${members.length >= seats ? 'disabled' : ''}>🔗 Invitar fotógrafos</button>
        <a class="btn ghost sm" target="_blank" rel="noopener" href="https://wa.me/${SUPPORT_WA}?text=${encodeURIComponent(`Hola! Soy ${profile.displayName} (plan Empresas) y quiero sumar lugares a mi equipo.`)}">➕ Sumar lugares (${fmtMoney(extra)}/mes c/u)</a>
      </div>
      <div id="tm-link"></div>` : ''}
    </div>`;
  $('#tm-invite')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const { link, days } = await apiPost('/team/invite');
      $('#tm-link').innerHTML = `<div class="notice stack" style="margin:0">
        <span>Mandale este link a cada fotógrafo (vale ${days} días). Entra con su cuenta (o se crea una) y queda en tu equipo.</span>
        <input type="text" readonly value="${esc(link)}" onclick="this.select()">
        <div class="row"><button class="btn sm" id="tm-copy">📋 Copiar</button><button class="btn sm" id="tm-share">📤 Compartir</button></div></div>`;
      $('#tm-copy').onclick = () => navigator.clipboard.writeText(link).then(() => toast('Link copiado')).catch(() => {});
      $('#tm-share').onclick = () => shareLink({ title: `Sumate al equipo de ${profile.displayName}`, text: `📸 Sumate a mi equipo en Quiero Mis Fotos para subir fotos a mis eventos:`, url: link });
    } catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = members.length >= seats;
  });
  $$('[data-rm]').forEach(b => b.onclick = async () => {
    if (!confirm(`¿Sacar a ${info[b.dataset.rm]?.name || 'este fotógrafo'} del equipo? Sus fotos quedan en tus álbumes; solo deja de poder subir.`)) return;
    try { await apiPost('/team/remove', { team: uid, member: b.dataset.rm }); toast('Listo'); viewTeam(view, { uid, profile, settings }); }
    catch (err) { toast(errMsg(err), 'error'); }
  });
}

// Ventas por fotógrafo en un evento de la empresa (para liquidarles).
export async function teamSalesHtml(eid, uid, team) {
  const st = (await getDoc(doc(db, 'salesStats', `${eid}_${uid}`)).catch(() => null))?.data();
  const by = st?.byUploader || {};
  const rows = Object.entries(by).filter(([, v]) => (v.photos || 0) > 0).sort((a, b) => (b[1].amount || 0) - (a[1].amount || 0));
  if (!rows.length) return '';
  const name = u => (u === uid ? 'Vos' : team?.memberInfo?.[u]?.name || 'Fotógrafo (ya no está en el equipo)');
  return `<div class="card stack">
    <h2 style="margin:0">💰 Ventas por fotógrafo</h2>
    <p class="muted small" style="margin:0">Fotos vendidas de cada uno y su parte del subtotal (sin comisiones). Sirve para liquidarles.</p>
    <div class="table-wrap"><table class="list"><tr><th>Fotógrafo</th><th>Fotos vendidas</th><th>Monto</th></tr>
      ${rows.map(([u, v]) => `<tr><td>${esc(name(u))}</td><td>${v.photos || 0}</td><td>${fmtMoney(v.amount || 0)}</td></tr>`).join('')}
    </table></div></div>`;
}

// ---------------------------------------------------------------- colaborador
export async function viewTeams(view, { uid, teams }) {
  if (!teams.length) {
    view.innerHTML = '<h1>🤝 Equipos</h1><div class="empty">No sos parte de ningún equipo. Si una empresa te invita, abrí el link que te mande.</div>';
    return;
  }
  const owners = await Promise.all(teams.map(t => getDoc(doc(db, 'users', t.owner)).then(s => s.data() || {}).catch(() => ({}))));
  view.innerHTML = `<h1>🤝 Equipos</h1>
    <p class="muted">Empresas para las que sacás fotos: subís a sus álbumes y ellas cobran las ventas.</p>
    ${teams.map((t, i) => `<div class="card stack">
      <div class="row" style="justify-content:space-between"><h2 style="margin:0">${esc(owners[i].displayName || 'Empresa')}</h2>
        <button class="btn sm ghost danger" data-leave="${esc(t.owner)}">Salir del equipo</button></div>
      <div id="tm-evs-${i}"><div class="spinner"></div></div></div>`).join('')}`;
  teams.forEach(async (t, i) => {
    const box = $(`#tm-evs-${i}`);
    try {
      const { events } = await apiPost('/team/events', { team: t.owner });
      box.innerHTML = events.length ? `<div class="stack">${events.map(e => `
        <a class="item-row" href="#/equipo-evento/${esc(t.owner)}/${esc(e.id)}" style="text-decoration:none">
          <div class="grow"><strong>${esc(e.name)}</strong><br><span class="muted small">${esc(fmtDate(e.date))}${e.location ? ` · ${esc(e.location)}` : ''}${e.status !== 'published' ? ' · borrador' : ''}</span></div>
          <span class="btn sm">Subir fotos</span></a>`).join('')}</div>` : '<p class="muted" style="margin:0">Todavía no tiene eventos.</p>';
    } catch (err) { box.innerHTML = `<div class="notice danger">${esc(errMsg(err))}</div>`; }
  });
  $$('[data-leave]').forEach(b => b.onclick = async () => {
    if (!confirm('¿Salir de este equipo? Tus fotos quedan en sus álbumes; ya no vas a poder subir.')) return;
    try { await apiPost('/team/remove', { team: b.dataset.leave, member: uid }); location.reload(); }
    catch (err) { toast(errMsg(err), 'error'); }
  });
}

export async function viewTeamEvent(view, { owner, eid, uid, settings, tax }) {
  const [evS, setS, ownerS, salesS, teamS] = await Promise.all([
    getDoc(doc(db, 'events', eid)), getDoc(doc(db, 'events', eid, 'sets', owner)), getDoc(doc(db, 'users', owner)).catch(() => null),
    getDoc(doc(db, 'teamSales', `${eid}_${owner}_${uid}`)).catch(() => null), getDoc(doc(db, 'teams', owner)).catch(() => null),
  ]);
  if (!(teamS?.data()?.members || []).includes(uid)) { view.innerHTML = '<div class="notice danger">Ya no sos parte de este equipo.</div>'; return; }
  if (!evS.exists()) { view.innerHTML = '<div class="notice danger">El evento no existe.</div>'; return; }
  const ev = { id: eid, ...evS.data() };
  const set = setS.data();
  const company = ownerS?.data() || {};
  const sold = salesS?.data()?.soldPhotos || 0;
  if (!set) {
    view.innerHTML = `<a href="#/equipos" class="muted small" style="text-decoration:none">← Equipos</a><h1>${esc(ev.name)}</h1>
      <div class="notice">${esc(company.displayName || 'La empresa')} todavía no armó su álbum en este evento (precio y sub-álbumes). Avisale para poder subir.</div>`;
    return;
  }
  const packs = (set.packs || []).filter(k => k.qty > 1 && k.price > 0 && k.price < k.qty * set.price);
  view.innerHTML = `
    <a href="#/equipos" class="muted small" style="text-decoration:none">← Equipos</a>
    <h1 style="margin-bottom:4px">${esc(ev.name)}</h1>
    <p class="muted" style="margin-top:0">${esc(fmtDate(ev.date))}${ev.location ? ` · ${esc(ev.location)}` : ''} · para <strong>${esc(company.displayName || 'la empresa')}</strong></p>
    <div class="card stack">
      <div class="row">
        <span class="pill">💲 ${fmtMoney(set.price)} por foto</span>
        ${packs.map(k => `<span class="pill ok">${k.qty} fotos x ${fmtMoney(k.price)}</span>`).join('')}
        <span class="pill ${sold ? 'ok' : ''}">🛒 ${sold} foto${sold === 1 ? '' : 's'} tuya${sold === 1 ? '' : 's'} vendida${sold === 1 ? '' : 's'}</span>
      </div>
      <p class="muted small" style="margin:0">Las fotos que subas van al álbum de ${esc(company.displayName || 'la empresa')}, con su marca de agua y sus precios. Las ventas las cobra la empresa.</p>
    </div>
    <div id="tm-photos"></div>`;
  window.onqmfAlbumFull = () => toast(`El álbum de ${company.displayName || 'la empresa'} llegó a su tope de fotos. Avisale para que sume más.`, 'error');
  await mountPhotos($('#tm-photos'), { ev, set, uid: owner, me: uid, team: owner, profile: company, settings, bibs: bibsOn(set, ev, tax) });
}

// ---------------------------------------------------------------- invitación
function inviteTeam(token) {
  try { return JSON.parse(atob(token.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'))).team || ''; } catch { return ''; }
}

export async function viewJoin(view, { token, onJoined }) {
  const team = inviteTeam(token);
  const owner = team ? (await getDoc(doc(db, 'users', team)).catch(() => null))?.data() : null;
  view.innerHTML = `<div class="card stack" style="max-width:560px">
    <h1 style="margin:0">🤝 Invitación a un equipo</h1>
    <p style="margin:0">${owner?.displayName ? `<strong>${esc(owner.displayName)}</strong> te invita` : 'Te invitaron'} a sumarte a su equipo de fotógrafos en Quiero Mis Fotos.</p>
    <p class="muted small" style="margin:0">Vas a poder subir fotos a los álbumes de sus eventos con tu cuenta. Las ventas de esos álbumes las cobra la empresa (vos ves el precio y cuántas de tus fotos se vendieron). Tu cuenta, tus eventos y tus ventas propias siguen siendo tuyos.</p>
    <div class="row"><button class="btn primary" id="tm-join">Sumarme al equipo</button><a class="btn ghost" href="#/inicio">Ahora no</a></div>
  </div>`;
  $('#tm-join').onclick = async e => {
    e.target.disabled = true;
    try {
      const r = await apiPost('/team/join', { token });
      toast(r.already ? 'Ya eras parte de este equipo' : `¡Listo! Ya sos parte del equipo de ${r.name || 'la empresa'}`);
      await onJoined?.();
      location.hash = '#/equipos';
    } catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  };
}
