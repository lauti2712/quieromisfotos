// Seguimiento de fotógrafos nuevos que todavía no crearon su primer álbum, y limpieza de cuentas que no se usan.
// Todos los días a las 10 (Argentina), desde el registro (o desde que reactivó la cuenta), si sigue sin álbum:
//   día 1  → recordatorio "creá tu primer álbum"           (mail + aviso al celular)
//   día 3  → segundo recordatorio
//   día 10 → aviso: "si no la usás, la pausamos en 4 días"
//   día 14 → se pausa la cuenta (status 'suspended', suspendedReason 'inactividad'), con al menos 4 días desde el aviso.
// La pausa por inactividad la puede deshacer el propio fotógrafo desde el panel (POST /photographers/reactivate).
// Cada mail trae un link para dar de baja la cuenta (GET/POST /photographers/baja?t=…): se pausa con motivo 'baja' y
// no se le escribe más; también la puede reactivar desde el panel.
// No se tocan: cuentas con algún álbum, con plan pago vigente o suscripción mensual activa, colaboradores de una empresa
// ni cuentas de demo.
// Se prende con settings/platform.onboardingCleanup = true.
// El estado de los avisos va en onboardingNudges/{uid} (solo el Worker lo lee y escribe: las reglas no lo exponen).
import { adminGet, adminQuery, adminSet, adminUpdate, adminDelete } from './admin.js';
import { requireUser } from './firebase.js';
import { planOf } from './plans.js';
import { authEmails, sendMany, mailLayout } from './mail.js';
import { notifyUser, notifySuper } from './push.js';
import { json, httpError } from './http.js';
import { signToken, verifyToken } from './tokens.js';
import { esc } from '../../js/text-core.js';

const DAY = 86400_000;
export const NUDGE_DAYS = { r1: 1, r2: 3, warn: 10, suspend: 14, afterWarn: 4 };
const MAX_PER_RUN = 60; // el plan gratis de Resend permite 100 mails por día
const ms = v => (v instanceof Date ? v.getTime() : v ? Date.parse(v) || 0 : 0);

// Primer tic de las 13 UTC (10 de Argentina) del cron de cada 5 minutos.
export const isOnboardingTick = t => { const d = new Date(t); return d.getUTCHours() === 13 && d.getUTCMinutes() < 5; };

// Qué le toca hoy a una cuenta sin álbum. start: registro o reactivación (ms). nudge: { r1, r2, warn } (ms o vacío).
export function nudgeStep(start, nudge = {}, now = Date.now()) {
  if (!start) return null;
  const age = now - start, d = NUDGE_DAYS;
  if (nudge.warn) return age >= d.suspend * DAY && now - nudge.warn >= d.afterWarn * DAY ? 'suspend' : null;
  if (age >= d.warn * DAY) return 'warn';
  if (age >= d.r2 * DAY) return nudge.r2 ? null : 'r2';
  if (age >= d.r1 * DAY) return nudge.r1 || nudge.r2 ? null : 'r1';
  return null;
}

const panelUrl = env => env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';
const apiBase = env => (env.API_URL || 'https://api.quieromisfotos.com.ar').replace(/\/$/, '');
export const bajaUrl = async (env, uid) => `${apiBase(env)}/photographers/baja?t=${await signToken({ typ: 'baja', u: uid }, env.UPLOAD_SECRET)}`;
// Pausas que el propio fotógrafo puede deshacer (las que pone el superadmin a mano, no).
export const SELF_PAUSE = ['inactividad', 'baja'];

function message(env, step, name, baja) {
  const bajaFoot = `<br><br>¿No vas a usar Quiero Mis Fotos? <a href="${esc(baja)}" style="color:#6b7280">Dar de baja mi cuenta</a> y no te escribimos más.`;
  const hola = name ? `Hola ${esc(String(name).split(' ')[0])}, ` : 'Hola, ';
  const url = `${panelUrl(env)}#/bienvenida`;
  if (step === 'r1') return {
    subject: '📸 Tu primer álbum en 2 minutos',
    push: { title: '📸 Creá tu primer álbum', body: 'Ponele nombre, fecha y precio, y subí tus fotos: la marca de agua se pone sola.' },
    html: mailLayout({ title: 'Creá tu primer álbum', intro: `${hola}ya tenés tu cuenta en Quiero Mis Fotos. El siguiente paso es crear el álbum de tu último partido o evento y subir las fotos: la marca de agua se aplica sola y te queda un link para compartir.`, cta: { label: 'Crear mi primer álbum', url }, foot: 'Si te trabaste en algo, respondé este mail o escribinos por WhatsApp desde el panel.' + bajaFoot }),
  };
  if (step === 'r2') return {
    subject: '¿Te ayudamos a arrancar?',
    push: { title: '¿Te ayudamos a arrancar?', body: 'Subí las fotos de tu próximo evento y compartí el link: el que las compra, las paga en el momento.' },
    html: mailLayout({ title: '¿Te ayudamos a arrancar?', intro: `${hola}vimos que todavía no creaste ningún álbum. Lo más rápido: creá uno con las fotos de tu último partido, compartí el link en el grupo o en tus historias, y los padres o jugadores compran directo, con Mercado Pago.`, cta: { label: 'Ir a mi panel', url }, foot: 'Si algo no te funcionó, contanos respondiendo este mail: lo resolvemos.' + bajaFoot }),
  };
  if (step === 'warn') return {
    subject: 'Tu cuenta se va a pausar por inactividad',
    push: { title: 'Tu cuenta se va a pausar', body: `Si en ${NUDGE_DAYS.afterWarn} días no creás un álbum, la pausamos. Después la podés reactivar.` },
    html: mailLayout({ title: 'Tu cuenta se va a pausar', intro: `${hola}tu cuenta de fotógrafo todavía no tiene ningún álbum. Para mantener ordenado el directorio de fotógrafos, si en ${NUDGE_DAYS.afterWarn} días no creás uno la vamos a pausar. No se borra nada: la podés reactivar cuando quieras entrando al panel.`, cta: { label: 'Crear mi primer álbum', url }, foot: 'Si no la vas a usar, no hace falta que hagas nada.' + bajaFoot }),
  };
  return {
    subject: 'Pausamos tu cuenta de fotógrafo',
    push: { title: 'Pausamos tu cuenta', body: 'Cuando quieras volver, entrá al panel y tocá "Reactivar mi cuenta".' },
    html: mailLayout({ title: 'Pausamos tu cuenta', intro: `${hola}como no la usaste, pausamos tu cuenta de fotógrafo y tu perfil dejó de verse en el sitio. No se borró nada: cuando quieras volver, entrá al panel y tocá <strong>Reactivar mi cuenta</strong>.`, cta: { label: 'Reactivar mi cuenta', url: panelUrl(env) }, foot: 'Si no la querés más, no hagas nada: no te vamos a escribir de nuevo.' }),
  };
}

export async function onboardingCron(env, now = Date.now()) {
  // Interruptor: settings/platform.onboardingCleanup (apagado hasta que el superadmin lo prenda).
  const st = await adminGet(env, 'settings/platform');
  if (!st?.onboardingCleanup) return { off: true };
  const [users, events, teams, nudges, subs] = await Promise.all([
    adminQuery(env, 'users', { filters: [['role', '==', 'photographer']], limit: 2000 }),
    adminQuery(env, 'events', { limit: 5000 }),
    adminQuery(env, 'teams', { limit: 1000 }),
    adminQuery(env, 'onboardingNudges', { limit: 2000 }),
    adminQuery(env, 'subscriptions', { limit: 2000 }).catch(() => []),
  ]);
  // Suscripción mensual o anual activa en Mercado Pago: aunque el plan figure vencido (débito demorado), no se toca.
  const subscribed = new Set(subs.filter(x => x.status === 'authorized').map(x => x.id));
  const withAlbum = new Set(events.flatMap(e => [...(e.photographerUids || []), e.createdBy].filter(Boolean)));
  const inTeam = new Set(teams.flatMap(t => t.members || []));
  const nudgeOf = new Map(nudges.map(n => [n.id, n]));
  const todo = [];
  for (const u of users) {
    // Solo cuentas aprobadas: una pendiente (aprobación manual) todavía no puede crear álbumes.
    if (u.demo || u.status !== 'approved') continue;
    if (withAlbum.has(u.id) || inTeam.has(u.id) || subscribed.has(u.id) || planOf(u, now) !== 'free') continue;
    const n = nudgeOf.get(u.id) || {};
    const start = Math.max(ms(u.createdAt), ms(u.reactivatedAt));
    // Los avisos anteriores a una reactivación (hecha por el superadmin) no cuentan: el ciclo empieza de nuevo.
    const after = v => (ms(v) >= start ? ms(v) : 0);
    const step = nudgeStep(start, { r1: after(n.r1), r2: after(n.r2), warn: after(n.warn) }, now);
    if (step) todo.push({ u, step });
    if (todo.length >= MAX_PER_RUN) break;
  }
  if (!todo.length) return { sent: 0 };
  const emails = await authEmails(env, todo.map(t => t.u.id)).catch(() => ({}));
  const mails = [], at = new Date(now), count = { r1: 0, r2: 0, warn: 0, suspend: 0 };
  for (const { u, step } of todo) {
    // Primero se guarda el paso: si algo falla después, no se repite el mail mañana.
    await adminSet(env, `onboardingNudges/${u.id}`, { ...(nudgeOf.get(u.id) ? Object.fromEntries(Object.entries(nudgeOf.get(u.id)).filter(([k]) => k !== 'id')) : {}), [step]: at, updatedAt: at });
    if (step === 'suspend') {
      await adminUpdate(env, `users/${u.id}`, { status: 'suspended', statusChangedAt: at, suspendedReason: 'inactividad', suspendedAt: at });
    }
    count[step]++;
    const m = message(env, step, u.displayName, await bajaUrl(env, u.id));
    if (emails[u.id]) mails.push({ to: emails[u.id], subject: m.subject, html: m.html });
    await notifyUser(env, u.id, { ...m.push, link: `${panelUrl(env)}#/bienvenida` }).catch(() => {});
  }
  if (mails.length) await sendMany(env, mails).catch(e => console.error('mails onboarding', e));
  const parts = [count.r1 && `${count.r1} recordatorio${count.r1 === 1 ? '' : 's'} (día 1)`, count.r2 && `${count.r2} (día 3)`,
    count.warn && `${count.warn} aviso${count.warn === 1 ? '' : 's'} de pausa`, count.suspend && `${count.suspend} cuenta${count.suspend === 1 ? '' : 's'} pausada${count.suspend === 1 ? '' : 's'}`].filter(Boolean);
  await notifySuper(env, 'cleanup', { title: '🧹 Fotógrafos sin álbum', body: parts.join(' · '), link: `${panelUrl(env)}#/admin/fotografos` });
  return { sent: todo.length, ...count };
}

// POST /photographers/reactivate — el fotógrafo deshace la pausa por inactividad (no una suspensión del superadmin).
export async function reactivatePhotographer(req, env) {
  const claims = await requireUser(req, env);
  const user = await adminGet(env, `users/${claims.sub}`);
  if (!user || user.status !== 'suspended' || !SELF_PAUSE.includes(user.suspendedReason)) throw httpError(403, 'Esta cuenta no se puede reactivar desde acá. Escribinos por WhatsApp.');
  const st = await adminGet(env, 'settings/platform');
  const now = new Date();
  const status = st?.autoApprove ? 'approved' : 'pending';
  await adminUpdate(env, `users/${claims.sub}`, { status, statusChangedAt: now, suspendedReason: null, suspendedAt: null, reactivatedAt: now });
  await adminDelete(env, `onboardingNudges/${claims.sub}`).catch(() => {});
  return json({ status });
}

// GET/POST /photographers/baja?t=… — link "Dar de baja mi cuenta" de los mails. El GET solo muestra la confirmación
// (los lectores de mail abren los links solos); el POST la aplica: pausa con motivo 'baja' y no se le escribe más.
export async function bajaPage(req, env) {
  const t = new URL(req.url).searchParams.get('t') || '';
  const tok = await verifyToken(t, env.UPLOAD_SECRET, 'baja');
  const page = (title, body) => new Response(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)} · Quiero Mis Fotos</title></head>
<body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15181e"><div style="max-width:460px;margin:40px auto;background:#fff;border-radius:16px;padding:28px 24px">
<div style="color:#ff5a1f;font-weight:800;font-size:20px;margin-bottom:14px">quieromisfotos</div><h1 style="font-size:22px;margin:0 0 10px">${esc(title)}</h1>${body}</div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  if (!tok?.u) return page('Link inválido', '<p>Este link no es válido. Si querés dar de baja tu cuenta, respondé el mail que te llegó.</p>');
  const user = await adminGet(env, `users/${tok.u}`);
  if (!user || user.role !== 'photographer') return page('Cuenta no encontrada', '<p>No encontramos esta cuenta.</p>');
  const p = 'style="line-height:1.5;color:#374151"';
  if (user.status === 'suspended') return page('Tu cuenta ya está dada de baja', `<p ${p}>No te vamos a escribir más. Si algún día querés volver, entrá a <a href="${esc(panelUrl(env))}">tu panel</a> y tocá <strong>Reactivar mi cuenta</strong>.</p>`);
  if (req.method === 'POST') {
    const now = new Date();
    await adminUpdate(env, `users/${tok.u}`, { status: 'suspended', statusChangedAt: now, suspendedReason: 'baja', suspendedAt: now });
    await adminSet(env, `onboardingNudges/${tok.u}`, { optOut: now, updatedAt: now });
    await notifySuper(env, 'cleanup', { title: '👋 Un fotógrafo se dio de baja', body: user.displayName || '', link: `${panelUrl(env)}#/admin/fotografos` });
    return page('Listo, diste de baja tu cuenta', `<p ${p}>Tu perfil dejó de verse en el sitio y no te vamos a escribir más. No se borró nada: si cambiás de idea, entrá a <a href="${esc(panelUrl(env))}">tu panel</a> y tocá <strong>Reactivar mi cuenta</strong>.</p>`);
  }
  return page('¿Dar de baja tu cuenta?', `<p ${p}>Tu cuenta de fotógrafo <strong>${esc(user.displayName || '')}</strong> se va a pausar: tu perfil deja de verse en el sitio y no te escribimos más. No se borra nada y la podés reactivar cuando quieras.</p>
<form method="post"><button style="background:#ff5a1f;color:#fff;border:0;border-radius:12px;padding:13px 22px;font-size:16px;font-weight:700;cursor:pointer">Sí, dar de baja mi cuenta</button></form>
<p style="margin-top:16px"><a href="${esc(panelUrl(env))}" style="color:#6b7280">No, quiero seguir usándola</a></p>`);
}
