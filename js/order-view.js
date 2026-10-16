// Página del pedido: estado del pago en vivo y descarga de los originales.
import { db, doc, onSnapshot } from './fb.js';
import { $, $$, esc, fmtMoney, fmtTs, toast, errMsg } from './util.js';
import { apiPost } from './api.js';
import { cart } from './cart.js';
import { currentUser, requireLogin } from './account.js';

let unsub = null;

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
  if (!currentUser()) {
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
  unsub = onSnapshot(doc(db, 'orders', orderId), snap => {
    if (!snap.exists()) { app.innerHTML = '<div class="empty"><h2>Pedido no encontrado</h2></div>'; return; }
    const o = { id: snap.id, ...snap.data() };
    if (o.status === 'approved') o.items.forEach(i => cart.has(i.photoId) && cart.remove(i.photoId));
    if (first && o.status === 'pending' && !synced) { synced = true; sync(); }
    first = false;
    draw(app, o);
  }, err => { app.innerHTML = `<div class="notice danger">${esc(errMsg(err))}</div>`; });
}

function draw(app, o) {
  const expired = o.downloadExpiresAt && o.downloadExpiresAt.toMillis() < Date.now();
  const head = {
    approved: ['✅ ¡Pago aprobado!', 'Ya podés descargar tus fotos en alta calidad, sin marca de agua.', 'ok'],
    pending: ['⏳ Esperando la confirmación del pago', 'Esto suele tardar unos segundos. Esta página se actualiza sola.', 'warn'],
    rejected: ['❌ El pago no se aprobó', 'Podés intentar de nuevo con otro medio de pago.', 'danger'],
    refunded: ['↩️ Pago reembolsado', 'Este pedido fue reembolsado.', ''],
  }[o.status] || [o.status, '', ''];

  app.innerHTML = `
    <a href="#/cuenta" class="muted small" style="text-decoration:none">← Mis compras</a>
    <div class="notice ${head[2]}" style="margin-top:10px"><strong>${head[0]}</strong><br>${head[1]}</div>
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
      ${o.status === 'rejected' || o.status === 'pending' ? `<div class="row end"><button class="btn ${o.status === 'rejected' ? 'primary' : ''}" id="retry">${o.status === 'rejected' ? 'Intentar de nuevo' : 'Volver a Mercado Pago'}</button></div>` : ''}
      <div class="order-grid">
        ${o.items.map((it, i) => `
          <div class="order-item">
            <img src="${esc(it.thumbUrl)}" alt="" loading="lazy">
            ${o.status === 'approved' && !expired ? `<button class="btn sm" data-dl="${i}">⬇️ Descargar</button>` : ''}
          </div>`).join('')}
      </div>
    </div>`;

  $('#retry')?.addEventListener('click', async e => {
    e.target.disabled = true;
    try { const { initPoint } = await apiPost(`/orders/${o.id}/checkout`); location.href = initPoint; }
    catch (err) { e.target.disabled = false; toast(errMsg(err), 'error'); }
  });

  let links = null;
  const getLinks = async () => {
    if (links && links.exp * 1000 > Date.now() + 30_000) return links;
    links = await apiPost(`/orders/${o.id}/downloads`);
    return links;
  };
  const fire = url => { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); };

  $$('[data-dl]', app).forEach(b => b.onclick = async () => {
    b.disabled = true;
    try { const l = await getLinks(); fire(l.links[+b.dataset.dl].url); b.textContent = '✓ Descargada'; }
    catch (err) { toast(errMsg(err), 'error'); }
    b.disabled = false;
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
