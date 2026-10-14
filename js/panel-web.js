// Panel: planes (Gratis / Pro / Web / Web + Dominio) y configuración de la web personal del fotógrafo.
import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg } from './util.js';
import { PLANS, planOf, hasWeb, siteUrlOf } from './data.js';
import { shareLink } from './share.js';

const TEMPLATES = [
  { id: 'clasica', name: 'Clásica', desc: 'Foto grande de portada, fondo claro.', bg: '#ffffff', fg: '#14161b' },
  { id: 'oscura', name: 'Oscura', desc: 'Fondo negro, ideal para deportes nocturnos.', bg: '#0d0f13', fg: '#f1f2f4' },
  { id: 'minimal', name: 'Minimal', desc: 'Sin portada: tus fotos son las protagonistas.', bg: '#ffffff', fg: '#14161b' },
];

const PLAN_INFO = [
  { id: 'free', items: ['Perfil en Quiero Mis Fotos', 'Portfolio de 12 fotos', 'Venta de fotos en eventos'] },
  { id: 'pro', items: ['Todo lo de Gratis', 'Portfolio de 200 fotos', 'Destacado en el directorio'] },
  { id: 'web', items: ['Todo lo de Pro', 'Tu web: tunombre.quieromisfotos.com.ar', '3 plantillas, galerías y servicios', 'Fotos de tu web sin marca de agua'] },
  { id: 'webdomain', items: ['Todo lo de Web', 'Tu propio dominio (ej: tunombre.com.ar)'] },
];

export async function viewWeb(view, { uid, profile, settings }) {
  const plan = planOf(profile);
  const reqSnap = await getDoc(doc(db, 'planRequests', uid)).catch(() => null);
  const pending = reqSnap?.exists() ? reqSnap.data() : null;
  const price = id => (PLANS[id].priceKey ? fmtMoney(settings[PLANS[id].priceKey]) + '/mes' : 'Gratis');

  view.innerHTML = `
    <h1>Mi web</h1>
    <p class="muted">Tu propia web de fotógrafo, con tus fotos, tus servicios y tu contacto. Se arma sola con lo que cargás en tu perfil y tu portfolio.</p>
    <div class="plans">
      ${PLAN_INFO.map(p => `
        <div class="plan-card ${p.id === plan ? 'current' : ''}">
          <div class="row" style="justify-content:space-between"><strong>${PLANS[p.id].label}</strong>${p.id === plan ? '<span class="pill ok">Tu plan</span>' : ''}</div>
          <div class="plan-price">${price(p.id)}</div>
          <ul>${p.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
          ${p.id !== 'free' && p.id !== plan ? `<button class="btn ${p.id === 'web' ? 'primary' : ''} sm" data-req="${p.id}">${pending?.plan === p.id ? '✓ Pedido enviado' : 'Lo quiero'}</button>` : ''}
        </div>`).join('')}
    </div>
    ${plan !== 'free' ? `<p class="muted small">Tu plan está activo hasta el ${esc(fmtTs(profile.proUntil))}.</p>` : ''}
    ${pending && pending.plan !== plan ? `<div class="notice">Pediste el plan <strong>${esc(PLANS[pending.plan]?.label)}</strong>. Te vamos a contactar para activarlo. <button class="btn sm ghost" id="req-cancel">Cancelar pedido</button></div>` : ''}
    <div id="web-config"></div>`;

  $$('[data-req]').forEach(b => b.onclick = async () => {
    const want = b.dataset.req;
    try {
      await setDoc(doc(db, 'planRequests', uid), { plan: want, displayName: profile.displayName || '', createdAt: serverTimestamp() });
      toast('¡Listo! Te vamos a contactar para activar tu plan.');
      viewWeb(view, { uid, profile, settings });
    } catch (e) { toast(errMsg(e), 'error'); }
  });
  $('#req-cancel')?.addEventListener('click', async () => {
    try { await deleteDoc(doc(db, 'planRequests', uid)); viewWeb(view, { uid, profile, settings }); } catch (e) { toast(errMsg(e), 'error'); }
  });

  if (!hasWeb(profile)) return;
  await drawConfig($('#web-config'), { uid, profile, settings });
}

async function drawConfig(box, { uid, profile }) {
  const site = { template: 'clasica', accent: '#ff5a1f', tagline: '', heroUrl: '', services: [], clean: false, showEvents: true, ...(profile.site || {}) };
  const snap = await getDocs(query(collection(db, 'portfolio'), where('photographerUid', '==', uid)));
  const photos = snap.docs.map(d => d.data()).sort((a, b) => (a.order || 0) - (b.order || 0) || a.slot - b.slot);
  const url = siteUrlOf(profile);
  let services = (site.services || []).map(s => ({ ...s }));

  box.innerHTML = `
    <div class="card stack">
      <div class="row" style="justify-content:space-between">
        <div><h2 style="margin:0">Tu web</h2><a href="${esc(url)}" target="_blank" class="small">${esc(url.replace(/^https:\/\//, ''))}</a></div>
        <div class="row"><a class="btn" id="web-open" href="${esc(url)}?v=${Date.now()}" target="_blank">Ver mi web</a><button class="btn" id="web-share">🔗 Compartir</button></div>
      </div>
      ${photos.length ? '' : '<div class="notice warn">Tu web muestra las fotos de tu <a href="#/portfolio">portfolio</a>: subí algunas para que se vea completa.</div>'}
    </div>
    <form class="card stack" id="web-form">
      <h2 style="margin:0">Diseño</h2>
      <div class="tpl-grid">${TEMPLATES.map(t => `
        <label class="tpl ${site.template === t.id ? 'on' : ''}">
          <input type="radio" name="tpl" value="${t.id}" ${site.template === t.id ? 'checked' : ''} hidden>
          <span class="tpl-prev" style="background:${t.bg};color:${t.fg}"><i style="background:var(--tpl-accent)"></i><b></b><b></b></span>
          <strong>${t.name}</strong><span class="muted small">${t.desc}</span>
        </label>`).join('')}</div>
      <div class="grid2">
        <label class="field">Color principal<input type="color" id="w-accent" value="${esc(site.accent)}" style="height:44px;padding:4px"></label>
        <label class="field">Frase de portada<input type="text" id="w-tagline" maxlength="90" value="${esc(site.tagline)}" placeholder="Ej: Fotografía deportiva en Santa Fe"></label>
      </div>
      <div class="field"><span>Foto de portada</span>
        <div class="hero-pick">${photos.length ? photos.map(p => `<button type="button" class="hp ${site.heroUrl === (site.clean && p.cleanUrl ? p.cleanUrl : p.url) || site.heroUrl === p.url || site.heroUrl === p.cleanUrl ? 'on' : ''}" data-url="${esc(p.url)}" data-clean="${esc(p.cleanUrl || '')}"><img src="${esc(p.thumbUrl)}" alt="" loading="lazy"></button>`).join('') : '<span class="muted small">Subí fotos a tu portfolio para elegir una.</span>'}</div>
        <span class="hint">Si no elegís, se usa la primera foto del portfolio.</span>
      </div>
      <label class="check"><input type="checkbox" id="w-clean" ${site.clean ? 'checked' : ''}> Mostrar mis fotos <strong>sin marca de agua</strong> en mi web</label>
      <p class="muted small" style="margin:0 0 0 26px">Aplica a las fotos que subas al portfolio desde ahora (las anteriores tienen la marca incluida; volvé a subirlas si las querés limpias).</p>
      <label class="check"><input type="checkbox" id="w-events" ${site.showEvents !== false ? 'checked' : ''}> Mostrar mis eventos con fotos a la venta</label>

      <h2 style="margin:10px 0 0">Servicios y precios</h2>
      <p class="muted small" style="margin:0">Precios de referencia que aparecen en tu web. Ej: "Book deportivo · 30 fotos editadas · $40.000".</p>
      <div id="w-services" class="stack"></div>
      <button type="button" class="btn sm" id="w-svc-add" style="justify-self:start">+ Agregar servicio</button>

      <div class="row end"><button class="btn primary" type="submit">Guardar mi web</button></div>
    </form>
    ${planOf(profile) === 'webdomain' ? domainHtml(profile) : ''}`;

  box.style.setProperty('--tpl-accent', site.accent);
  $$('.tpl input', box).forEach(r => r.onchange = () => $$('.tpl', box).forEach(l => l.classList.toggle('on', l.querySelector('input').checked)));
  $('#w-accent').oninput = e => box.style.setProperty('--tpl-accent', e.target.value);
  $$('.hp', box).forEach(b => b.onclick = () => { $$('.hp', box).forEach(x => x.classList.remove('on')); b.classList.add('on'); });
  $('#web-share').onclick = () => shareLink({ title: profile.displayName, text: `📸 Mirá mi trabajo:`, url });

  const drawSvc = () => {
    $('#w-services').innerHTML = services.length ? services.map((s, i) => `
      <div class="svc-row">
        <input type="text" data-si="${i}" data-sk="name" maxlength="50" value="${esc(s.name || '')}" placeholder="Servicio (ej: Cobertura de partido)">
        <input type="text" data-si="${i}" data-sk="detail" maxlength="80" value="${esc(s.detail || '')}" placeholder="Detalle (ej: 2 horas, 80 fotos)">
        <input type="text" data-si="${i}" data-sk="price" maxlength="30" value="${esc(s.price || '')}" placeholder="Precio (ej: $35.000)">
        <button type="button" class="btn sm danger" data-srm="${i}" aria-label="Quitar">✕</button>
      </div>`).join('') : '<p class="muted small" style="margin:0">Sin servicios cargados.</p>';
    $$('[data-si]', box).forEach(inp => inp.oninput = () => { services[inp.dataset.si][inp.dataset.sk] = inp.value; });
    $$('[data-srm]', box).forEach(b => b.onclick = () => { services.splice(+b.dataset.srm, 1); drawSvc(); });
  };
  drawSvc();
  $('#w-svc-add').onclick = () => { if (services.length >= 12) return; services.push({ name: '', detail: '', price: '' }); drawSvc(); };

  $('#web-form').onsubmit = async e => {
    e.preventDefault();
    const clean = $('#w-clean').checked;
    const hp = $('.hp.on', box);
    const upd = {
      site: {
        template: $('input[name=tpl]:checked', box)?.value || 'clasica',
        accent: $('#w-accent').value,
        tagline: $('#w-tagline').value.trim(),
        heroUrl: hp ? (clean && hp.dataset.clean ? hp.dataset.clean : hp.dataset.url) : '',
        clean,
        showEvents: $('#w-events').checked,
        services: services.map(s => ({ name: (s.name || '').trim(), detail: (s.detail || '').trim(), price: (s.price || '').trim() })).filter(s => s.name),
        requestedDomain: profile.site?.requestedDomain || '',
      },
    };
    try {
      await updateDoc(doc(db, 'users', uid), upd);
      Object.assign(profile, upd);
      $('#web-open').href = `${url}?v=${Date.now()}`;
      toast('Web guardada. Los cambios se ven en tu web en unos minutos.');
    } catch (err) { toast(errMsg(err), 'error'); }
  };

  $('#dom-form')?.addEventListener('submit', async e => {
    e.preventDefault();
    const d = $('#dom-input').value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) return toast('Escribí un dominio válido, ej: tunombre.com.ar', 'error');
    try {
      const site2 = { ...(profile.site || {}), requestedDomain: d };
      await updateDoc(doc(db, 'users', uid), { site: site2 });
      profile.site = site2;
      toast('Dominio guardado. Seguí los pasos para apuntarlo.');
      drawConfig(box, { uid, profile });
    } catch (err) { toast(errMsg(err), 'error'); }
  });
}

function domainHtml(profile) {
  const req = profile.site?.requestedDomain || '';
  const active = profile.domainActive && profile.siteDomain;
  return `
    <form class="card stack" id="dom-form">
      <h2 style="margin:0">Tu dominio propio</h2>
      ${active ? `<div class="notice ok">✅ Tu web está activa en <a href="https://${esc(profile.siteDomain)}" target="_blank">${esc(profile.siteDomain)}</a>.</div>` : ''}
      <div class="row"><input type="text" id="dom-input" value="${esc(req)}" placeholder="tunombre.com.ar" style="max-width:300px"><button class="btn">Guardar</button></div>
      ${req && !active ? `
        <div class="notice">
          <strong>Para conectar ${esc(req)}:</strong>
          <ol style="margin:8px 0 0;padding-left:20px">
            <li>Entrá a donde compraste el dominio (por ejemplo NIC Argentina o tu proveedor de DNS).</li>
            <li>Creá un registro <strong>CNAME</strong> para <strong>www</strong> que apunte a <code>sites.quieromisfotos.com.ar</code>.</li>
            <li>Avisanos por WhatsApp: nosotros terminamos la conexión y te confirmamos cuando esté activa.</li>
          </ol>
        </div>` : ''}
    </form>`;
}
