// Mails transaccionales con Resend (RESEND_API_KEY, dominio quieromisfotos.com.ar verificado).
//   - Compra aprobada → link a las descargas (orders.js).
//   - "Ya están las fotos" → seguidores del evento o del fotógrafo sin notificaciones activas (push.js).
// Plan gratis de Resend: 100 mails por día y 3.000 por mes; si falla o no hay clave, no corta nada (best-effort).
import { serviceToken } from './admin.js';

const FROM = 'Quiero Mis Fotos <fotos@quieromisfotos.com.ar>';
const REPLY_TO = 'desarrollo@solucionescotidianas.com.ar';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function mailLayout({ title, intro, cta, rows = [], foot = '' }) {
  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15181e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:16px;overflow:hidden">
    <tr><td style="background:#ff5a1f;padding:18px 24px;color:#fff;font-size:20px;font-weight:800">quieromisfotos</td></tr>
    <tr><td style="padding:24px">
      <h1 style="margin:0 0 10px;font-size:22px">${esc(title)}</h1>
      <p style="margin:0 0 18px;font-size:15px;line-height:1.5;color:#374151">${intro}</p>
      ${rows.length ? `<table role="presentation" width="100%" style="margin:0 0 18px;font-size:14px">${rows.map(([k, v]) => `<tr><td style="color:#6b7280;padding:3px 0">${esc(k)}</td><td align="right" style="padding:3px 0"><strong>${esc(v)}</strong></td></tr>`).join('')}</table>` : ''}
      ${cta ? `<a href="${esc(cta.url)}" style="display:inline-block;background:#ff5a1f;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:12px;font-size:16px">${esc(cta.label)}</a>` : ''}
      ${foot ? `<p style="margin:18px 0 0;font-size:13px;color:#6b7280;line-height:1.5">${foot}</p>` : ''}
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #eef0f4;font-size:12px;color:#9aa3b2">Quiero Mis Fotos · quieromisfotos.com.ar · Si tenés un problema, respondé este mail.</td></tr>
  </table></td></tr></table></body></html>`;
}

async function resend(env, path, body) {
  if (!env.RESEND_API_KEY) return null;
  const res = await fetch(`https://api.resend.com${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error('resend', res.status, (await res.text()).slice(0, 200));
  return res.ok;
}

export const sendMail = (env, { to, subject, html }) =>
  resend(env, '/emails', { from: FROM, reply_to: REPLY_TO, to: [to], subject, html });

// Hasta 100 mails en un pedido (cada uno con su destinatario: nadie ve los mails de los demás).
export async function sendMany(env, list) {
  for (let i = 0; i < list.length; i += 100) {
    await resend(env, '/emails/batch', list.slice(i, i + 100).map(m => ({ from: FROM, reply_to: REPLY_TO, to: [m.to], subject: m.subject, html: m.html })));
  }
}

// Mails de cuentas de Firebase Auth por uid (los seguidores no siempre tienen datos en Firestore).
export async function authEmails(env, uids) {
  const out = {};
  if (!uids.length) return out;
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  for (let i = 0; i < uids.length; i += 100) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uids.slice(i, i + 100) }),
    });
    if (!res.ok) { console.error('lookup', res.status); continue; }
    for (const u of (await res.json()).users || []) if (u.email && u.emailVerified !== false) out[u.localId] = u.email;
  }
  return out;
}

// Plataforma → "Enviarme un mail de prueba" (superadmin): confirma que Resend y el dominio andan.
//   POST /admin/mail/test
export async function mailTest(req, env, claims) {
  const ok = await sendMail(env, { to: claims.email, subject: '✅ Prueba de mails de Quiero Mis Fotos', html: mailLayout({ title: 'Los mails funcionan', intro: 'Si ves este mail, Resend y el dominio quieromisfotos.com.ar están bien configurados.', cta: { label: 'Ir al panel', url: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/admin/config` } }) });
  return ok;
}
