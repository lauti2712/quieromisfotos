// Mails transaccionales con Resend (RESEND_API_KEY, dominio quieromisfotos.com.ar verificado).
//   - Compra aprobada → link a las descargas (orders.js).
//   - "Ya están las fotos" → seguidores del evento o del fotógrafo sin notificaciones activas (push.js).
// Plan gratis de Resend: 100 mails por día y 3.000 por mes; si falla o no hay clave, no corta nada (best-effort).
import { serviceToken, adminQuery, adminSet } from './admin.js';
import { httpError } from './http.js';
import { esc } from '../../js/text-core.js';

const FROM = 'Quiero Mis Fotos <fotos@quieromisfotos.com.ar>';
const REPLY_TO = 'desarrollo@solucionescotidianas.com.ar';

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

// Novedades para todos los fotógrafos (superadmin). Primero {test: true} manda solo a tu casilla;
// el envío real queda registrado en broadcasts/{key} y no se puede repetir.
//   POST /admin/mail/news {test?}
const NEWS = {
  key: 'novedades-2026-11-caras-marca-tasa',
  subject: 'Tocá una cara y aparecen todas sus fotos, y más novedades 📸',
  items: [
    ['👆 Tocá una cara y aparecen todas sus fotos', 'En la foto ampliada, tu cliente toca la cara de alguien y ve todas las fotos del evento donde aparece esa persona: el papá encuentra a su hijo en segundos y compra más. Se prepara sola al subir. Para álbumes que subiste antes, entrá al álbum y tocá <strong>"Prepararlas ahora"</strong>. Si es un evento con chicos (escolar, infantil), te recomendamos apagarla en la configuración de ese álbum.'],
    ['🛡️ Marca de agua más fuerte y a tu gusto', 'Ahora va tu nombre o tu logo en 3 a 5 sellos, una malla fina y un sello sobre la persona que complican mucho borrarla con IA, y un código en cada foto. Si alguien intenta guardar una foto, le aparece un aviso con el botón para comprarla. Elegí tu logo y la intensidad en <strong>⚙️ Precios y marca</strong>, y el nivel de protección en cada álbum.'],
    ['💸 Vos elegís quién paga la tasa de servicio', 'En los precios de cada álbum elegí si la tasa (nuestra comisión más la de Mercado Pago) la pagás vos, mitad y mitad, o el comprador.'],
    ['📅 Publicá cuando quieras', 'Al crear un álbum elegí: publicarlo ahora, apenas termine la subida, en una fecha y hora, o dejarlo como borrador. Arriba de cada álbum tenés <strong>🚀 Publicar ahora</strong> y <strong>📅 Programar</strong>.'],
    ['📦 Cerrá el álbum y mirá sus visitas', 'Cuando terminás de vender, cerrá el álbum: liberás el lugar y queda en tu historial con 10 fotos de muestra. Además, al lado del nombre de cada álbum ves cuánta gente lo visitó.'],
  ],
};
const newsHtml = (env, name) => mailLayout({
  title: `¡Hola${name ? ' ' + name.split(' ')[0] : ''}!`,
  intro: 'Sumamos herramientas a Quiero Mis Fotos. Ya están funcionando en tu panel:' +
    NEWS.items.map(([h, t]) => `<br><br><strong style="color:#15181e">${esc(h)}</strong><br>${t}`).join(''),
  cta: { label: 'Entrar a mi panel', url: env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html' },
  foot: '¿Dudas? Escribinos por WhatsApp desde el botón verde del panel, o respondé este mail.<br>El equipo de Quiero Mis Fotos',
});

export async function mailNews(req, env, claims) {
  const { test } = await req.json().catch(() => ({}));
  if (test) {
    const ok = await sendMail(env, { to: claims.email, subject: `[Prueba] ${NEWS.subject}`, html: newsHtml(env, 'Lauti') });
    return { ok, sent: ok ? 1 : 0, test: true };
  }
  const users = await adminQuery(env, 'users', { filters: [['role', '==', 'photographer']], limit: 500 });
  const live = users.filter(u => !['suspended', 'rejected', 'deleted'].includes(u.status));
  const emails = await authEmails(env, live.map(u => u.id));
  const list = live.map(u => ({ to: emails[u.id] || u.email, name: u.displayName })).filter(m => m.to && m.to !== claims.email);
  // Marca primero: si ya se mandó, falla y no se repite.
  await adminSet(env, `broadcasts/${NEWS.key}`, { sentAt: new Date(), count: list.length, by: claims.email }, { mustNotExist: true })
    .catch(() => { throw httpError(409, 'Estas novedades ya se enviaron (o no se pudo registrar el envío)'); });
  await sendMany(env, list.map(m => ({ to: m.to, subject: NEWS.subject, html: newsHtml(env, m.name) })));
  return { ok: true, sent: list.length, skipped: live.length - list.length };
}
