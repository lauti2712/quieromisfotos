// Página del pedido: estado del pago en vivo y descarga de los originales.
import { db, doc, getDoc, watchDoc } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg } from './util.js';
import { apiPost, API_BASE } from './api.js';
import { cart } from './cart.js';
import { currentUser, guestUser, requireLogin, guestSaveHtml, bindGuestSave } from './account.js';

let unsub = null;
let payerEmail = ''; // invitado: el email con el que pagó en Mercado Pago
let orderKey = '';   // llave del pedido (link de vuelta de MP / mail): se abre sin cuenta, en cualquier navegador

// Con llave: los datos y las descargas vienen del Worker (no hace falta ingresar).
async function guestApi(orderId, body = {}) {
  const res = await fetch(`${API_BASE}/orders/${orderId}/guest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ k: orderKey, ...body }) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(d.error || 'No se pudo abrir el pedido');
  return d;
}
const asTs = iso => (iso ? { toMillis: () => Date.parse(iso), toDate: () => new Date(iso) } : null);

// Celular con "Compartir archivos" (iPhone, Android): las fotos se guardan directo en la galería.
function canShareFiles() {
  try {
    return matchMedia('(pointer: coarse)').matches && !!navigator.canShare
      && navigator.canShare({ files: [new File([new Blob(['x'], { type: 'image/jpeg' })], 'x.jpg', { type: 'image/jpeg' })] });
  } catch { return false; }
}
const SHARE_GROUP = 10;
window.addEventListener('hashchange', () => { unsub?.(); unsub = null; });

export async function renderOrder(app, orderId, query) {
  document.title = 'Tu pedido · Quiero Mis Fotos';
  unsub?.();
  app.innerHTML = '<div class="spinner"></div>';
  // Link con llave (sin cuenta, o en otro navegador que el de la compra).
  orderKey = query.get('k') || '';
  if (orderKey && !currentUser()) {
    const paymentId0 = query.get('payment_id') || query.get('collection_id');
    let firstLoad = true;
    const load = async () => {
      if (!location.hash.startsWith(`#/pedido/${orderId}`)) return;
      try {
        const r = await guestApi(orderId, firstLoad && paymentId0 ? { paymentId: paymentId0 } : {});
        firstLoad = false;
        payerEmail = r.payerEmail || payerEmail;
        const o = { ...r.order, createdAt: asTs(r.order.createdAt), paidAt: asTs(r.order.paidAt), downloadExpiresAt: asTs(r.order.downloadExpiresAt), transferExpiresAt: asTs(r.order.transferExpiresAt) };
        if (o.status === 'approved') o.items.forEach(i => cart.has(i.photoId) && cart.remove(i.photoId));
        draw(app, o);
        if (o.status === 'pending') setTimeout(load, 4000);
      } catch (e) { app.innerHTML = `<div class="empty"><h2>No pudimos abrir tu pedido</h2><p class="muted">${esc(errMsg(e))}</p></div>`; }
    };
    return load();
  }
  if (!currentUser() && !guestUser()) {
    app.innerHTML = `<div class="empty"><h2>Ingresá para ver tu pedido</h2><button class="btn primary" id="go">Ingresar</button></div>`;
    $('#go').onclick = () => requireLogin().then(() => renderOrder(app, orderId, query));
    return;
  }

  // Al volver de Mercado Pago el webhook puede tardar unos segundos: consultamos el pago directamente.
  const paymentId = query.get('payment_id') || query.get('collection_id');
  let synced = false;
  const sync = () => apiPost(`/orders/${orderId}/sync`, { paymentId }).catch(() => {});
  if (paymentId) { synced = true; sync(); }

  let first = true;
  payerEmail = '';
  if (!currentUser()) getDoc(doc(db, 'orderPrivate', orderId)).then(s => { payerEmail = s.data()?.mpPayerEmail || ''; }).catch(() => {});
  unsub = watchDoc(doc(db, 'orders', orderId), snap => {
    if (!snap.exists()) { app.innerHTML = '<div class="empty"><h2>Pedido no encontrado</h2></div>'; return; }
    const o = { id: snap.id, ...snap.data() };
    if (o.status === 'approved') o.items.forEach(i => cart.has(i.photoId) && cart.remove(i.photoId));
    if (first && o.status === 'pending' && !synced) { synced = true; sync(); }
    first = false;
    draw(app, o);
  }, err => {
    // Corte pasajero con el pedido ya en pantalla (ej. Chrome de iPhone corta las consultas al arrancar una descarga):
    // se deja lo que se ve y la próxima consulta lo actualiza.
    if (!first) return;
    // Sin permiso: el link es de otra cuenta (o se pasó la dirección sin la llave del pedido).
    if (/permission|permiso/i.test(String(err?.code || err?.message || ''))) {
      app.innerHTML = `<div class="empty"><h2>No podemos mostrarte esta compra</h2>
        <p class="muted" style="max-width:46ch;margin:0 auto 12px">Este link es para ver la compra con la cuenta con la que se hizo. Si compraste sin cuenta, usá el botón <strong>Descargar mis fotos</strong> del mail de la compra, o pedile al fotógrafo el <strong>link de descarga</strong>.</p>
        ${currentUser() ? '' : '<button class="btn primary" id="go">Ingresar con mi cuenta</button>'}</div>`;
      $('#go')?.addEventListener('click', () => requireLogin().then(() => renderOrder(app, orderId, query)));
      return;
    }
    app.innerHTML = `<div class="notice danger">${esc(errMsg(err))}</div>`;
  });
}

// Datos para transferir: alias del fotógrafo y monto exacto (los centavos identifican el pedido).
function transferBox(o) {
  const amount = Number(o.transferAmount || 0);
  const txt = amount.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const [ent, dec] = txt.split(',');
  // Cuánto falta para que venza (se recalcula cada vez que la página se actualiza).
  const left = Math.max(0, (o.transferExpiresAt?.toMillis?.() || 0) - Date.now());
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  const leftTxt = left ? (h ? `${h} h ${m} min` : `${m} min`) : 'vencido';
  return `<div class="card stack" style="margin:0;border:2px solid var(--accent)">
    <div class="tr-amount">
      <span class="small muted">Transferí exactamente</span>
      <strong>$ ${esc(ent)}<span class="tr-cents">,${esc(dec)}</span></strong>
      <span class="small">⏳ Te quedan <strong>${esc(leftTxt)}</strong> para transferir</span>
    </div>
    <div class="row" style="justify-content:space-between"><span>Alias</span><span class="row" style="gap:6px"><strong style="font-size:1.1rem">${esc(o.transferAlias)}</strong><button class="btn sm" data-copy="${esc(o.transferAlias)}">📋 Copiar</button></span></div>
    ${o.transferHolder ? `<div class="row" style="justify-content:space-between"><span>Titular</span><span>${esc(o.transferHolder)}</span></div>` : ''}
    <div class="row" style="justify-content:space-between"><span>Monto exacto</span><span class="row" style="gap:6px"><strong>$ ${esc(txt)}</strong><button class="btn sm" data-copy="${esc(amount.toFixed(2).replace('.', ','))}">📋 Copiar monto</button></span></div>
    <div class="notice warn small" style="margin:0">⚠️ Hacé <strong>una sola transferencia</strong> por el total. Los <strong>,${esc(dec)} son ${esc(String(Number(dec)))} centavos</strong> (no $${esc(String(Number(dec)))} aparte).</div>
    <div class="notice warn small" style="margin:0">⚠️ <strong>Los centavos (,${esc(dec)}) son importantes:</strong> así reconocemos tu pago solo, en minutos. Si mandás otro monto, el fotógrafo lo tiene que confirmar a mano y puede tardar.</div>
    <div class="row end"><button class="btn primary" id="tr-done">✅ Ya transferí</button></div>
  </div>`;
}

// Imagen 1080×1920: la foto entera sobre fondo oscuro, el evento arriba y el crédito del fotógrafo abajo.
async function storyImage(blob, o) {
  const W = 1080, H = 1920;
  const bmp = await createImageBitmap(blob, { resizeWidth: W, resizeQuality: 'high', imageOrientation: 'from-image' });
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(W / 2, 200, 50, W / 2, 200, 1400);
  g.addColorStop(0, '#3a1a0e'); g.addColorStop(1, '#0f1115');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const k = Math.min((W - 80) / bmp.width, (H - 520) / bmp.height);
  const w = bmp.width * k, h = bmp.height * k, x = (W - w) / 2, y = (H - h) / 2;
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 28); ctx.clip(); ctx.drawImage(bmp, x, y, w, h); ctx.restore();
  const font = '-apple-system, "Segoe UI", Roboto, Arial, sans-serif';
  ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
  ctx.font = `800 58px ${font}`; ctx.fillText(o.eventName || '', W / 2, y - 60, W - 100);
  ctx.font = `600 40px ${font}`; ctx.fillText(`📸 ${o.photographerName || ''}`, W / 2, y + h + 90, W - 100);
  ctx.fillStyle = '#ff5a1f'; ctx.font = `800 38px ${font}`; ctx.fillText('quieromisfotos.com.ar', W / 2, y + h + 150);
  const out = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
  return new File([out], `historia-${o.id.slice(0, 6)}.jpg`, { type: 'image/jpeg' });
}

function draw(app, o) {
  const expired = o.downloadExpiresAt && o.downloadExpiresAt.toMillis() < Date.now();
  const head = {
    approved: ['✅ ¡Pago aprobado!', 'Ya podés descargar tus fotos en alta calidad, sin marca de agua.', 'ok'],
    pending: o.payMethod === 'transfer'
      ? ['🏦 Falta tu transferencia', `Transferí el monto exacto y se acredita solo en unos minutos. Tenés tiempo hasta el ${fmtTs(o.transferExpiresAt)}.`, 'warn']
      : ['⏳ Esperando la confirmación del pago', 'Esto suele tardar unos segundos. Esta página se actualiza sola.', 'warn'],
    rejected: ['❌ El pago no se aprobó', 'Podés intentar de nuevo con otro medio de pago.', 'danger'],
    expired: ['⌛ El plazo para transferir venció', 'Si ya transferiste, escribile al fotógrafo para que lo confirme. Si no, volvé a armar el pedido desde el evento.', 'danger'],
    refunded: ['↩️ Pago reembolsado', 'Este pedido fue reembolsado.', ''],
  }[o.status] || [o.status, '', ''];

  const review = currentUser() && o.buyerUid !== currentUser().uid;
  app.innerHTML = `
    ${review ? `<div class="notice small stack">👁️ <span><strong>Vista de revisión:</strong> ves este pedido como lo ve el comprador y descargás los mismos archivos que recibió.</span>
      ${o.status === 'approved' ? '<div><button class="btn sm primary" id="buyer-link">🔗 Link de descarga para el comprador</button></div><div id="buyer-link-out"></div>' : ''}</div>` : ''}
    <a href="#/cuenta" class="muted small" style="text-decoration:none">← Mis compras</a>
    <div class="notice ${head[2]}" style="margin-top:10px"><strong>${head[0]}</strong><br>${head[1]}</div>
    ${!currentUser() && (guestUser() || orderKey) && o.status === 'approved' ? guestSaveHtml(payerEmail) : ''}
    <div class="card stack">
      <div class="row" style="justify-content:space-between;align-items:flex-start">
        <div>
          <h2 style="margin:0 0 2px">${esc(o.eventName)}</h2>
          <div class="muted small">📷 ${esc(o.photographerName)} · Pedido ${esc(o.id.slice(0, 8))} · ${esc(fmtTs(o.createdAt))}</div>
        </div>
        <strong style="font-size:1.2rem">${fmtMoney(o.total)}</strong>
      </div>
      ${o.status === 'approved' ? `
        ${expired ? '<div class="notice danger">El plazo de descarga venció.</div>' : `
          ${canShareFiles() ? `<button class="btn primary big-cta" id="dl-share">📲 Guardar en la galería del celular (${o.items.length})</button>
          <div id="dl-share-steps" class="stack"></div>` : ''}
          <button class="btn ${canShareFiles() ? '' : 'primary big-cta'}" id="dl-all">⬇️ Descargar todas las fotos (${o.items.length})</button>
          <div class="notice stack" style="margin:0">
            <span>📌 <strong>Tus fotos quedan guardadas hasta el ${esc(fmtTs(o.downloadExpiresAt))}.</strong> Podés volver a descargarlas cuando quieras desde <a href="#/cuenta">Mis compras</a> (arriba, en el ícono de tu cuenta).</span>
            <span class="small">📱 En el celular se guardan en <em>Descargas</em> / <em>Archivos</em>. Para pasarlas a la galería: abrí la foto y tocá <em>Compartir → Guardar imagen</em>.</span>
          </div>`}
        <div class="row"><a class="btn sm" href="#/evento/${esc(o.eventId)}">📷 Ver más fotos del evento</a></div>` : ''}
      ${o.payMethod === 'transfer' && o.status === 'pending' ? transferBox(o) : ''}
      ${o.payMethod !== 'transfer' && (o.status === 'rejected' || o.status === 'pending') ? `<div class="row end"><button class="btn ${o.status === 'rejected' ? 'primary' : ''}" id="retry">${o.status === 'rejected' ? 'Intentar de nuevo' : 'Volver a Mercado Pago'}</button></div>` : ''}
      <div class="order-grid">
        ${o.items.map((it, i) => `
          <div class="order-item">
            <img src="${esc(it.thumbUrl)}" alt="" loading="lazy">
            ${o.status === 'approved' && !expired ? `<button class="btn sm" data-dl="${i}">⬇️ Descargar</button>${navigator.share ? `<button class="btn sm" data-story="${i}" title="Imagen vertical para tus historias de Instagram o WhatsApp">📲 Historia</button>` : ''}` : ''}
          </div>`).join('')}
      </div>
    </div>`;

  bindGuestSave(app);
  // Si el comprador guarda la cuenta desde este link (otro navegador), la compra pasa a esa cuenta.
  if (orderKey) { try { sessionStorage.setItem('qmf.orderKey', orderKey); } catch { /* nada */ } }
  $('#buyer-link')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      const { url } = await apiPost(`/orders/${o.id}/link`);
      const msg = `Hola! Te dejo el link para descargar tus fotos de ${o.eventName || 'tu evento'} (funciona en cualquier celular): ${url}`;
      $('#buyer-link-out', app).innerHTML = `<code style="display:block;word-break:break-all;font-size:.8rem;margin:6px 0">${esc(url)}</code>
        <div class="row"><button class="btn sm" id="bl-copy">Copiar link</button><a class="btn sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(msg)}">💬 Mandar por WhatsApp</a></div>`;
      $('#bl-copy', app).onclick = () => navigator.clipboard.writeText(url).then(() => toast('Link copiado'), () => toast('No se pudo copiar', 'error'));
    } catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false;
  });
  $$('[data-copy]', app).forEach(b => b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.dataset.copy); toast('Copiado'); } catch { toast(b.dataset.copy); }
  });
  $('#tr-done')?.addEventListener('click', async e => {
    e.target.disabled = true; e.target.textContent = 'Buscando tu transferencia…';
    try {
      const r = orderKey && !currentUser() ? (await guestApi(o.id)).order : await apiPost(`/orders/${o.id}/sync`);
      if (r.status !== 'approved') toast('Todavía no la vemos. A veces tarda unos minutos: esta página se actualiza sola.');
    } catch (err) { toast(errMsg(err), 'error'); }
    e.target.disabled = false; e.target.textContent = '✅ Ya transferí';
  });
  $('#retry')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { const { initPoint } = await apiPost(`/orders/${o.id}/checkout`); location.href = initPoint; }
    catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  });

  let links = null;
  const getLinks = async () => {
    if (links && links.exp * 1000 > Date.now() + 30_000) return links;
    links = orderKey && !currentUser() ? await guestApi(o.id, { links: true }) : await apiPost(`/orders/${o.id}/downloads`);
    return links;
  };
  const fire = url => { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); };

  $$('[data-dl]', app).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const l = await getLinks(); fire(l.links[+b.dataset.dl].url); b.textContent = '✓ Descargada'; }
    catch (err) { toast(errMsg(err), 'error'); }
    b.disabled = false;
  });
  // Historia: la foto comprada en formato vertical con el crédito del fotógrafo, lista para compartir.
  $$('[data-story]', app).forEach(b => b.onclick = async () => {
    b.disabled = true; const label = b.textContent; b.textContent = 'Preparando…';
    try {
      const l = await getLinks();
      const res = await fetch(l.links[+b.dataset.story].url);
      if (!res.ok) throw new Error('No se pudo bajar la foto. Probá de nuevo.');
      const file = await storyImage(await res.blob(), o);
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: o.eventName });
      else { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; a.click(); }
    } catch (err) { if (err.name !== 'AbortError') toast(errMsg(err), 'error'); }
    b.disabled = false; b.textContent = label;
  });
  // Dos pasos: primero se bajan (puede tardar) y después un toque abre "Compartir → Guardar imágenes"
  // (el navegador solo deja compartir como respuesta directa a un toque). De a 10 fotos para no llenar la memoria.
  $('#dl-share')?.addEventListener('click', async e => {
    const btn = e.target;
    btn.disabled = true;
    const steps = $('#dl-share-steps', app);
    try {
      const l = await getLinks();
      const groups = [];
      for (let i = 0; i < l.links.length; i += SHARE_GROUP) groups.push(l.links.slice(i, i + SHARE_GROUP));
      steps.innerHTML = groups.map((g, k) => `<button class="btn" data-group="${k}" disabled>Preparando fotos ${k * SHARE_GROUP + 1} a ${k * SHARE_GROUP + g.length}…</button>`).join('');
      btn.textContent = 'Tocá cada botón para guardarlas 👇';
      for (const [k, g] of groups.entries()) {
        const files = [];
        for (const [j, link] of g.entries()) {
          const res = await fetch(link.url);
          if (!res.ok) throw new Error('No se pudo bajar una foto. Probá de nuevo.');
          const blob = await res.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          files.push(new File([blob], `quieromisfotos-${o.id.slice(0, 6)}-${String(k * SHARE_GROUP + j + 1).padStart(3, '0')}.${ext}`, { type: blob.type || 'image/jpeg' }));
        }
        const b = $(`[data-group="${k}"]`, steps);
        b.disabled = false; b.classList.add('primary');
        b.textContent = `📲 Guardar fotos ${k * SHARE_GROUP + 1} a ${k * SHARE_GROUP + g.length}`;
        b.onclick = async () => {
          try { await navigator.share({ files, title: o.eventName }); b.textContent = '✓ Listo'; b.classList.remove('primary'); }
          catch (err) { if (err.name !== 'AbortError') toast('Tu celular no dejó guardarlas así: usá Descargar.', 'error'); }
        };
      }
    } catch (err) { btn.disabled = false; btn.textContent = '📲 Reintentar'; toast(errMsg(err), 'error'); }
  });
  $('#dl-all')?.addEventListener('click', async e => {
    const btn = e.target;
    btn.disabled = true;
    try {
      const l = await getLinks();
      for (const [i, link] of l.links.entries()) {
        btn.textContent = `Descargando ${i + 1} de ${l.links.length}…`;
        fire(link.url);
        await new Promise(r => setTimeout(r, 900)); // de a una: los navegadores bloquean muchas descargas simultáneas
      }
      btn.textContent = '✓ Descargas iniciadas';
      toast('Si tu navegador pregunta, permití las descargas múltiples.');
    } catch (err) { btn.textContent = 'Reintentar'; toast(errMsg(err), 'error'); }
    btn.disabled = false;
  });
}
