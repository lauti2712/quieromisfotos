// Dominio propio del plan Premium. Lo registra la plataforma (titular: Quiero Mis Fotos) y lo conecta a la web del fotógrafo.
//   GET  /domains/check?name=tunombre        (Bearer)            -> disponibilidad de tunombre.com.ar y tunombre.com
//   POST /domains/request {domain}            (Bearer Premium)    -> guarda el pedido y avisa al superadmin
//   POST /admin/domains/activate {uid}        (superadmin)        -> agrega el dominio a Cloudflare, lo apunta al Worker y lo activa
//   POST /admin/domains/status {uid}          (superadmin)        -> estado de la delegación (NIC.ar → Cloudflare)
// El registro en NIC.ar lo hace el superadmin a mano (con su clave fiscal), cargando los servidores de nombres que devuelve activate.
import { adminGet, adminCommit, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { planOf } from './plans.js';
import { addAlert } from './alerts.js';
import { notifyUser } from './push.js';
import { json, httpError } from './http.js';

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLDS = ['com.ar', 'com'];
// .com: registro oficial (RDAP de Verisign), exacto. .com.ar: NIC.ar no responde a consultas desde Cloudflare (RDAP ni WHOIS),
// así que se mira el DNS: si el dominio no existe ahí, casi seguro está libre ('probable'); se confirma al registrarlo.
const RDAP_COM = d => `https://rdap.verisign.com/com/v1/domain/${d}`;
const CF = 'https://api.cloudflare.com/client/v4';
const isSuper = c => c.email === 'lautarom87@gmail.com' && c.email_verified === true;

export const tldOf = d => TLDS.find(t => d.endsWith(`.${t}`)) || '';
const labelOf = d => d.slice(0, -(tldOf(d).length + 1));
export function validDomain(d) {
  const t = tldOf(d);
  return !!t && LABEL_RE.test(labelOf(d)) && !labelOf(d).includes('.');
}

// true = libre · false = registrado · 'probable' = parece libre (.com.ar) · null = no se pudo consultar.
async function available(domain) {
  try {
    if (tldOf(domain) === 'com') {
      const res = await fetch(RDAP_COM(domain), { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(6000) });
      return res.status === 404 ? true : res.ok ? false : null;
    }
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=NS`, { headers: { Accept: 'application/dns-json' }, signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const d = await res.json();
    return d.Status === 3 ? 'probable' : d.Status === 0 ? false : null; // 3 = NXDOMAIN (no existe)
  } catch { return null; }
}

export async function checkDomains(req, env) {
  await requireUser(req, env);
  const name = new URL(req.url).searchParams.get('name') || '';
  const label = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').replace(/\.(com\.ar|com)$/, '');
  if (!LABEL_RE.test(label)) throw httpError(400, 'Usá solo letras sin acentos, números y guiones (sin espacios).');
  const results = await Promise.all(TLDS.map(async t => ({ domain: `${label}.${t}`, tld: t, available: await available(`${label}.${t}`) })));
  return json({ results });
}

export async function requestDomain(req, env) {
  const claims = await requireUser(req, env);
  const { domain } = await req.json().catch(() => ({}));
  const d = String(domain || '').trim().toLowerCase();
  if (!validDomain(d)) throw httpError(400, 'Dominio inválido');
  const user = await adminGet(env, `users/${claims.sub}`);
  if (!user || planOf(user) !== 'webdomain') throw httpError(403, 'El dominio propio es del plan Profesional Premium');
  if (user.domainActive) throw httpError(409, 'Ya tenés un dominio activo');
  if ((await available(d)) === false) throw httpError(409, 'Ese dominio ya está registrado. Probá con otro nombre.');
  await adminCommit(env, [{ update: `users/${claims.sub}`, data: { site: { requestedDomain: d }, domainRequestedAt: new Date() }, mask: ['site.requestedDomain', 'domainRequestedAt'] }]);
  await addAlert(env, { type: 'dominio', ref: claims.sub, text: `${user.displayName || 'Un fotógrafo'} pidió el dominio ${d}${tldOf(d) === 'com' ? ' (.com: cobrarle la diferencia)' : ''}. Registralo en ${tldOf(d) === 'com' ? 'Cloudflare' : 'NIC.ar'} y tocá "Activar dominio" en Fotógrafos.` });
  return json({ ok: true, domain: d });
}

// ------------------------------------------------------------------ Cloudflare
async function cf(env, path, init = {}) {
  if (!env.CF_API_TOKEN) throw httpError(503, 'Falta el token de Cloudflare (wrangler secret put CF_API_TOKEN)');
  const res = await fetch(`${CF}${path}`, { ...init, headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const d = await res.json().catch(() => ({}));
  if (!d.success) throw httpError(502, `Cloudflare: ${(d.errors || []).map(e => e.message).join(', ') || res.status}`);
  return d.result;
}

async function ensureZone(env, domain) {
  const [found] = await cf(env, `/zones?name=${encodeURIComponent(domain)}`);
  if (found) return found;
  return cf(env, '/zones', { method: 'POST', body: JSON.stringify({ name: domain, account: { id: env.CF_ACCOUNT_ID }, type: 'full' }) });
}

async function ensureRecords(env, zoneId, domain) {
  for (const name of [domain, `www.${domain}`]) {
    const existing = await cf(env, `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`);
    if (existing.length) continue;
    // Dirección "vacía" con proxy: Cloudflare atiende y el Worker responde (no hay servidor detrás).
    await cf(env, `/zones/${zoneId}/dns_records`, { method: 'POST', body: JSON.stringify({ type: 'AAAA', name, content: '100::', proxied: true, comment: 'Quiero Mis Fotos: web del fotógrafo' }) });
  }
  const routes = await cf(env, `/zones/${zoneId}/workers/routes`);
  for (const pattern of [`${domain}/*`, `www.${domain}/*`]) {
    if (routes.some(r => r.pattern === pattern)) continue;
    await cf(env, `/zones/${zoneId}/workers/routes`, { method: 'POST', body: JSON.stringify({ pattern, script: env.WORKER_NAME || 'qmf-api' }) });
  }
}

async function requireSuper(req, env) {
  const c = await requireUser(req, env);
  if (!isSuper(c)) throw httpError(403, 'Solo superadmin');
  return c;
}

export async function activateDomain(req, env) {
  await requireSuper(req, env);
  const { uid } = await req.json().catch(() => ({}));
  const user = uid && await adminGet(env, `users/${uid}`);
  const d = user?.site?.requestedDomain || user?.siteDomain;
  if (!user || !d || !validDomain(d)) throw httpError(404, 'El fotógrafo no tiene un dominio pedido');
  const owner = await adminGet(env, `domains/${d}`);
  if (owner && owner.uid !== uid) throw httpError(409, 'Ese dominio ya está asignado a otro fotógrafo');

  const zone = await ensureZone(env, d);
  await ensureRecords(env, zone.id, d);
  const setup = { zoneId: zone.id, nameServers: zone.name_servers || [], status: zone.status || 'pending', at: new Date() };
  const now = new Date();
  await adminCommit(env, [
    { set: `domains/${d}`, data: { uid, createdAt: now } },
    { set: `domains/www.${d}`, data: { uid, createdAt: now } },
    { update: `users/${uid}`, data: { domainActive: true, siteDomain: d, domainSetup: setup } },
  ]);
  await notifyUser(env, uid, {
    title: '🌐 Estamos conectando tu dominio',
    body: `${d}: queda andando en unas horas. Te avisamos cuando esté listo.`,
    link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/web`,
  }).catch(() => {});
  return json({ ok: true, domain: d, ...setup });
}

// Revisa la zona en Cloudflare y, si quedó activa (NIC.ar ya delegó), lo marca y le avisa al fotógrafo.
async function refreshStatus(env, uid, user) {
  const zone = await cf(env, `/zones/${user.domainSetup.zoneId}`);
  if (zone.status !== user.domainSetup.status) {
    await adminCommit(env, [{ update: `users/${uid}`, data: { domainSetup: { status: zone.status } }, mask: ['domainSetup.status'] }]);
    if (zone.status === 'active') {
      await notifyUser(env, uid, { title: '✅ Tu dominio ya está andando', body: `Tu web está en https://${user.siteDomain}`, link: `https://${user.siteDomain}` }).catch(() => {});
    }
  }
  return zone;
}

export async function domainStatus(req, env) {
  await requireSuper(req, env);
  const { uid } = await req.json().catch(() => ({}));
  const user = uid && await adminGet(env, `users/${uid}`);
  if (!user?.domainSetup?.zoneId) throw httpError(404, 'Sin dominio configurado');
  const zone = await refreshStatus(env, uid, user);
  return json({ status: zone.status, nameServers: zone.name_servers || [] });
}

// Cron diario: dominios esperando la delegación de NIC.ar.
export async function checkPendingDomains(env) {
  if (!env.CF_API_TOKEN) return;
  const users = await adminQuery(env, 'users', { filters: [['domainActive', '==', true]], limit: 200 });
  for (const u of users.filter(x => x.domainSetup?.zoneId && x.domainSetup.status !== 'active').slice(0, 10)) {
    await refreshStatus(env, u.id, u).catch(e => console.error('dominio', u.id, e));
  }
}
