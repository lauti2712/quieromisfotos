// Botón de arrepentimiento (Res. 424/2020): pedir la cancelación de una compra sin necesidad de tener cuenta.
// Queda en cancelRequests (lo ve el superadmin como alerta en el panel) y se muestra un código de trámite.
import { db, collection, addDoc, serverTimestamp, auth } from './fb.js';
import { $, esc, toast, errMsg } from './util.js';

const WA = '5493424856528';

export function renderCancel(app) {
  document.title = 'Botón de arrepentimiento · Quiero Mis Fotos';
  const u = auth.currentUser;
  app.innerHTML = `
    <div class="card stack" style="max-width:620px;margin:0 auto">
      <h1 style="margin:0">Botón de arrepentimiento</h1>
      <p class="muted" style="margin:0">Podés pedir la cancelación de una compra dentro de los 10 días corridos desde que la hiciste.
        Por tratarse de fotos digitales que se entregan al instante, si ya descargaste las fotos puede no corresponder la devolución
        (art. 1116 del Código Civil y Comercial); igual revisamos cada caso y te respondemos.</p>
      <form id="cx-form" class="stack">
        <label class="field">Nombre y apellido<input id="cx-name" required minlength="2" maxlength="100" value="${esc(u?.displayName || '')}" autocomplete="name"></label>
        <label class="field">Email<input id="cx-email" type="email" required maxlength="120" value="${esc(u?.email || '')}" autocomplete="email"></label>
        <label class="field">Número de pedido <span class="muted small">(está en Mis compras; si no lo tenés, dejalo vacío)</span><input id="cx-order" maxlength="40"></label>
        <label class="field">Motivo <span class="muted small">(opcional)</span><textarea id="cx-reason" rows="3" maxlength="1000"></textarea></label>
        <button class="btn primary" id="cx-send">Enviar pedido de cancelación</button>
      </form>
      <div id="cx-done"></div>
    </div>`;
  $('#cx-form').onsubmit = async e => {
    e.preventDefault();
    const btn = $('#cx-send');
    btn.disabled = true;
    try {
      const data = {
        name: $('#cx-name').value.trim(), email: $('#cx-email').value.trim().toLowerCase(),
        orderRef: $('#cx-order').value.trim().slice(0, 40), reason: $('#cx-reason').value.trim().slice(0, 1000),
        uid: auth.currentUser?.uid || '', createdAt: serverTimestamp(),
      };
      const ref = await addDoc(collection(db, 'cancelRequests'), data);
      const code = ref.id.slice(0, 8).toUpperCase();
      $('#cx-form').remove();
      const wa = `https://wa.me/${WA}?text=${encodeURIComponent(`Hola! Envié un pedido de cancelación (botón de arrepentimiento). Código ${code}${data.orderRef ? `, pedido ${data.orderRef}` : ''}.`)}`;
      $('#cx-done').innerHTML = `<div class="notice ok stack">
        <strong>✅ Recibimos tu pedido de cancelación.</strong>
        <span>Tu código de trámite es <strong style="font-size:1.2rem">${esc(code)}</strong>. Guardalo: te respondemos al email que dejaste dentro de las 24 horas hábiles.</span>
        <a class="btn" href="${esc(wa)}" target="_blank" rel="noopener">💬 Avisar también por WhatsApp</a>
      </div>`;
    } catch (err) { btn.disabled = false; toast(errMsg(err), 'error'); }
  };
}
