// Plan Empresas: equipo de fotógrafos. Cada colaborador tiene su propia cuenta y sube fotos a los álbumes de la empresa;
// las ventas las cobra la empresa y quedan registradas por fotógrafo (salesStats.byUploader / teamSales) para liquidarles.
//   POST /team/invite                (Bearer empresa)        -> { link } invitación válida 7 días
//   POST /team/join   {token}        (Bearer fotógrafo)      -> se suma al equipo (si hay lugar)
//   POST /team/remove {team, member} (Bearer empresa o el propio colaborador)
//   POST /team/events {team}         (Bearer colaborador)    -> eventos de la empresa donde puede subir
// teams/{uidEmpresa}: { members: [uid], memberInfo: { uid: { name, joinedAt } }, updatedAt }
import { adminGet, adminGetMany, adminQuery, adminCommit } from './admin.js';
import { requireUser } from './firebase.js';
import { teamSeats } from './plans.js';
import { signToken, verifyToken } from './tokens.js';
import { notifyUser } from './push.js';
import { json, httpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const INVITE_DAYS = 7;

const panelUrl = env => env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';

export async function teamInvite(req, env) {
  const claims = await requireUser(req, env);
  const [user, st] = await adminGetMany(env, [`users/${claims.sub}`, 'settings/platform']);
  if (!user || user.status === 'suspended') throw httpError(403, 'Cuenta no habilitada');
  if (!teamSeats(user, st || {})) throw httpError(403, 'El equipo de fotógrafos es del plan Empresas');
  const token = await signToken({ typ: 'team', team: claims.sub, exp: Math.floor(Date.now() / 1000) + INVITE_DAYS * 86400, n: crypto.randomUUID().slice(0, 8) }, env.UPLOAD_SECRET);
  return json({ link: `${panelUrl(env)}#/unirse/${token}`, days: INVITE_DAYS });
}

export async function teamJoin(req, env) {
  const claims = await requireUser(req, env);
  const { token } = await req.json().catch(() => ({}));
  const t = await verifyToken(String(token || ''), env.UPLOAD_SECRET, 'team');
  if (!t || t.exp < Date.now() / 1000) throw httpError(410, 'La invitación venció. Pedile a la empresa un link nuevo.');
  if (t.team === claims.sub) throw httpError(409, 'Esta es tu propia empresa');
  const [owner, me, team, st] = await adminGetMany(env, [`users/${t.team}`, `users/${claims.sub}`, `teams/${t.team}`, 'settings/platform']);
  if (!owner || owner.status === 'suspended') throw httpError(404, 'La empresa no está disponible');
  if (!me || me.role !== 'photographer') throw httpError(409, 'Primero creá tu perfil de fotógrafo');
  if (me.status === 'suspended') throw httpError(403, 'Tu cuenta está suspendida');
  const members = team?.members || [];
  if (members.includes(claims.sub)) return json({ ok: true, team: t.team, name: owner.displayName || '', already: true });
  const seats = teamSeats(owner, st || {});
  if (!seats) throw httpError(409, 'La empresa no tiene el plan Empresas activo');
  if (members.length >= seats) throw httpError(409, `El equipo está completo (${seats} fotógrafos). Pedile a la empresa que sume un lugar.`);
  const now = new Date();
  await adminCommit(env, [
    { upsert: `teams/${t.team}`, data: { memberInfo: { [claims.sub]: { name: me.displayName || '', joinedAt: now } }, updatedAt: now }, mask: [`memberInfo.${claims.sub}`, 'updatedAt'] },
    { union: `teams/${t.team}`, field: 'members', values: [claims.sub] },
  ]);
  await notifyUser(env, t.team, { title: '👥 Se sumó un fotógrafo a tu equipo', body: `${me.displayName || 'Un fotógrafo'} ya puede subir fotos a tus álbumes.`, link: `${panelUrl(env)}#/equipo` }).catch(() => {});
  return json({ ok: true, team: t.team, name: owner.displayName || '' });
}

export async function teamRemove(req, env) {
  const claims = await requireUser(req, env);
  const { team, member } = await req.json().catch(() => ({}));
  if (!ID_RE.test(team || '') || !ID_RE.test(member || '')) throw httpError(400, 'Pedido inválido');
  if (claims.sub !== team && claims.sub !== member) throw httpError(403, 'No podés modificar este equipo');
  const now = new Date();
  // Sus fotos quedan en los álbumes de la empresa; solo deja de poder subir.
  await adminCommit(env, [
    { upsert: `teams/${team}`, data: { updatedAt: now }, mask: [`memberInfo.${member}`, 'updatedAt'] },
    { remove: `teams/${team}`, field: 'members', values: [member] },
  ]);
  return json({ ok: true });
}

// Eventos de la empresa (también borradores): el colaborador no los puede listar desde el navegador.
export async function teamEvents(req, env) {
  const claims = await requireUser(req, env);
  const { team } = await req.json().catch(() => ({}));
  if (!ID_RE.test(team || '')) throw httpError(400, 'Pedido inválido');
  const t = await adminGet(env, `teams/${team}`);
  if (!(t?.members || []).includes(claims.sub)) throw httpError(403, 'No sos parte de este equipo');
  const evs = await adminQuery(env, 'events', { filters: [['photographerUids', 'array-contains', team]], orderBy: [['date', 'desc']], limit: 100 });
  return json({ events: evs.map(e => ({ id: e.id, name: e.name || '', date: e.date || '', location: e.location || '', status: e.status || '', coverUrl: e.coverUrl || '' })) });
}

// Para la sesión de subida: ¿uid puede subir a los álbumes de la empresa `team` en este evento?
export async function canUploadForTeam(env, uid, team, ev) {
  const [t, owner, st] = await adminGetMany(env, [`teams/${team}`, `users/${team}`, 'settings/platform']);
  if (!(t?.members || []).includes(uid)) throw httpError(403, 'No sos parte del equipo de esta empresa');
  if (!owner || owner.status !== 'approved' || !teamSeats(owner, st || {})) throw httpError(403, 'La empresa no tiene el plan Empresas activo');
  if (!(ev.photographerUids || []).includes(team)) throw httpError(403, 'La empresa no participa de este evento');
}
