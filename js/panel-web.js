// Panel: planes (Gratis / Lite / Profesional / Premium) y configuración de la web personal del fotógrafo.
import { db, collection, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where, serverTimestamp } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg, parseHash } from './util.js';
import { apiPost } from './api.js';
import { auth } from './fb.js';
import { PLANS, planOf, hasWeb, siteUrlOf, planSpec, planFeatures } from './data.js';
import { shareLink } from './share.js';

const TEMPLATES = [
  { id: 'clasica', name: 'Clásica', desc: 'Foto grande de portada, fondo claro.', bg: '#ffffff', fg: '#14161b' },
  { id: 'oscura', name: 'Oscura', desc: 'Fondo negro, ideal para deportes nocturnos.', bg: '#0d0f13', fg: '#f1f2f4' },
  { id: 'minimal', name: 'Minimal', desc: 'Sin portada: tus fotos son las protagonistas.', bg: '#ffffff', fg: '#14161b' },
];

// Planes que se ofrecen (el viejo "Portfolio Pro" ya no). Condiciones de cada uno: planSpec (editable en Plataforma).
const planInfo = st => {

  return ['free', 'lite', 'web', 'webdomain'].map(id => ({ id, items: planFeatures(id, st) }));
};

export async function viewWeb(view, { uid, profile, settings }) {
  // Vuelta de Mercado Pago después de suscribirse.
  if (parseHash().query.get('sub')) {
    history.replaceState(null, '', '#/web');
    try {
      const r = await apiPost('/plans/sync');
      if (r.status === 'authorized') {
        toast('🎉 ¡Suscripción activa! Ya tenés tu plan.');
        const fresh = await getDoc(doc(db, 'users', uid));
        Object.assign(profile, fresh.data());
      } else if (r.status === 'pending') toast('Tu suscripción todavía se está procesando. Se activa sola cuando Mercado Pago la confirme.');
    } catch (e) { toast(errMsg(e), 'error'); }
  }
  const plan = planOf(profile);
  const [reqSnap, subSnap] = await Promise.all([
    getDoc(doc(db, 'planRequests', uid)).catch(() => null),
    getDoc(doc(db, 'subscriptions', uid)).catch(() => null),
  ]);
  const pending = reqSnap?.exists() ? reqSnap.data() : null;
  const sub = subSnap?.exists() ? subSnap.data() : null;
  const subActive = sub?.status === 'authorized';
  // Sin planes nuevos: precios guardados en Plataforma, sin "primer mes" (se cobra el mensual).
  const first = id => (id === 'webdomain' && planSpec(id, settings).first > planSpec(id, settings).price ? planSpec(id, settings).first : 0);
  const price = id => (id === 'free' ? 'Gratis' : fmtMoney(planSpec(id, settings).price) + '/mes');

  view.innerHTML = `
    <h1>Planes y mi web</h1>
    <p class="muted">Con el plan Profesional vendés sin límite de álbumes, pagás menos comisión y tenés tu propia web con tus fotos, servicios y contacto.</p>
    <div class="plans">
      ${planInfo(settings).map(p => `
        <div class="plan-card ${p.id === plan ? 'current' : ''}">
          <div class="row" style="justify-content:space-between"><strong>${PLANS[p.id].label}</strong>${p.id === plan ? '<span class="pill ok">Tu plan</span>' : ''}</div>
          <div class="plan-price">${price(p.id)}</div>
          ${first(p.id) ? `<div class="muted small">Primer mes ${fmtMoney(first(p.id))} (incluye el registro de tu dominio)</div>` : ''}
          ${p.id !== 'free' && planSpec(p.id, settings).year ? `<div class="muted small">o ${fmtMoney(planSpec(p.id, settings).year)}/año (2 meses gratis)</div>` : ''}
          <ul>${p.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>
          ${p.id !== 'free' && p.id !== plan ? `<button class="btn ${p.id === 'web' ? 'primary' : ''} sm" data-sub="${p.id}">${plan === 'free' ? 'Suscribirme' : 'Cambiar a este plan'}</button>` : ''}
        </div>`).join('')}
    </div>
    ${plan !== 'free' ? `<p class="muted small">${profile.courtesy ? '🎁 Tenés este plan de cortesía, sin costo y sin vencimiento' : `${profile.trial ? '🎁 Estás usando la prueba gratis, hasta' : 'Tu plan está activo hasta'} el ${esc(fmtTs(profile.proUntil))}`}${subActive ? ` y se renueva solo ${sub.period === 'year' ? 'cada año' : 'cada mes'} con Mercado Pago` : profile.trial ? '. Suscribite antes para no perder tu web' : ''}.
      ${subActive ? '<button class="btn sm ghost" id="sub-cancel">Cancelar suscripción</button>' : ''}</p>` : ''}
    ${sub?.status === 'pending' ? `<div class="notice">Tu suscripción al plan <strong>${esc(PLANS[sub.plan]?.label)}</strong> está esperando la confirmación de Mercado Pago.</div>` : ''}
    ${pending && pending.plan !== plan && !sub ? `<div class="notice">Pediste el plan <strong>${esc(PLANS[pending.plan]?.label)}</strong>. Te vamos a contactar para activarlo. <button class="btn sm ghost" id="req-cancel">Cancelar pedido</button></div>` : ''}
    <div id="web-config"></div>`;

  $$('[data-sub]').forEach(b => b.onclick = () => subscribeDialog(b.dataset.sub));
  $('#sub-cancel')?.addEventListener('click', async () => {
    if (!confirm(`¿Cancelar la suscripción? Tu plan sigue activo hasta el ${fmtTs(profile.proUntil)} y después vuelve a Gratis.`)) return;
    try { await apiPost('/plans/cancel'); toast('Suscripción cancelada'); viewWeb(view, { uid, profile, settings }); } catch (e) { toast(errMsg(e), 'error'); }
  });

  function subscribeDialog(want) {
    const dlg = document.createElement('dialog');
    dlg.innerHTML = `
      <div class="dlg-head"><h2>Plan ${esc(PLANS[want].label)}</h2><button class="btn ghost sm" data-close>✕</button></div>
      <div class="dlg-body stack">
        ${planSpec(want, settings).year ? `<div class="stack" style="gap:8px">
          <label class="check card" style="margin:0;padding:12px"><input type="radio" name="sub-period" value="month" checked>
            <span><strong>Mensual: ${price(want)}</strong>${first(want) ? `<br><span class="muted small">Primer mes ${fmtMoney(first(want))} (incluye el registro de tu dominio)</span>` : ''}</span></label>
          <label class="check card" style="margin:0;padding:12px"><input type="radio" name="sub-period" value="year">
            <span><strong>Anual: ${fmtMoney(planSpec(want, settings).year)}/año</strong> · 2 meses gratis${first(want) ? `<br><span class="muted small">El primer pago suma ${fmtMoney(first(want) - planSpec(want, settings).price)} del registro del dominio</span>` : ''}</span></label>
        </div>` : `<p style="margin:0">${first(want) ? `<strong>${fmtMoney(first(want))} el primer mes</strong> (incluye el registro de tu dominio) y después <strong>${price(want)}</strong>` : `<strong>${price(want)}</strong>`}</p>`}
        <p class="muted small" style="margin:0">Se debita automáticamente con Mercado Pago. Lo cancelás cuando quieras desde acá y el plan sigue hasta el final del período pagado.</p>
        <label class="field">Email de tu cuenta de Mercado Pago<input type="email" id="sub-email" value="${esc(auth.currentUser?.email || '')}" required>
          <span class="hint">Tiene que ser el mismo email con el que entrás a Mercado Pago para pagar.</span></label>
        ${plan !== 'free' ? '<p class="muted small" style="margin:0">Tu plan actual se cancela cuando se active el nuevo.</p>' : ''}
      </div>
      <div class="dlg-foot"><button class="btn primary" id="sub-go">Suscribirme con Mercado Pago</button></div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('close', () => dlg.remove());
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.showModal();
    dlg.querySelector('#sub-go').onclick = async e => {
      const btn = e.target; btn.disabled = true; btn.textContent = 'Abriendo Mercado Pago…';
      try {
        const period = dlg.querySelector('input[name="sub-period"]:checked')?.value || 'month';
        const { initPoint } = await apiPost('/plans/subscribe', { plan: want, payerEmail: dlg.querySelector('#sub-email').value, period });
        location.href = initPoint;
      } catch (err) { toast(errMsg(err), 'error'); btn.disabled = false; btn.textContent = 'Suscribirme con Mercado Pago'; }
    };
  }
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
