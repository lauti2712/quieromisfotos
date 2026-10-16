// Mercado Pago: vinculación OAuth del fotógrafo (marketplace) y manejo de sus tokens.
// Los tokens se guardan en Firestore `mpTokens/{uid}` (sin reglas de cliente: nadie los lee desde el navegador).
import { adminGet, adminSet, adminUpdate, adminDelete, adminQuery } from './admin.js';
import { requireUser } from './firebase.js';
import { signToken, verifyToken } from './tokens.js';
import { json, httpError } from './http.js';

const MP_API = 'https://api.mercadopago.com';
const REFRESH_BEFORE = 7 * 86400_000;

export const panelUrl = env => env.PANEL_URL || 'https://solucionescotidianas.com.ar/quieromisfotos/panel.html';
export const siteUrl = env => env.SITE_URL || 'https://solucionescotidianas.com.ar/quieromisfotos/';

// POST /mp/connect-url  (Bearer) -> { url }
export async function connectUrl(req, env) {
  const claims = await requireUser(req, env);
  const user = await adminGet(env, `users/${claims.sub}`);
  if (!user || user.role !== 'photographer') throw httpError(403, 'Solo fotógrafos pueden vincular Mercado Pago');
  const state = await signToken({ typ: 'mp', uid: claims.sub, exp: Math.floor(Date.now() / 1000) + 900, n: crypto.randomUUID().slice(0, 8) }, env.UPLOAD_SECRET);
  const url = new URL('https://auth.mercadopago.com.ar/authorization');
  url.search = new URLSearchParams({
    client_id: env.MP_CLIENT_ID, response_type: 'code', platform_id: 'mp', state, redirect_uri: env.MP_REDIRECT_URI,
  });
  return json({ url: url.toString() });
}

// GET /mp/callback?code&state -> intercambia el code, guarda tokens y vuelve al panel
export async function callback(req, env) {
  const url = new URL(req.url);
  const back = (status, msg = '') => new Response(null, { status: 302, headers: { Location: `${panelUrl(env)}#/mp?mp=${status}${msg ? `&m=${encodeURIComponent(msg)}` : ''}` } });
  const st = await verifyToken(url.searchParams.get('state') || '', env.UPLOAD_SECRET, 'mp');
  if (!st || st.exp < Date.now() / 1000) return back('error', 'El enlace venció. Probá de nuevo.');
  const code = url.searchParams.get('code');
  if (!code) return back('error', url.searchParams.get('error_description') || 'Autorización cancelada');

  const res = await fetch(`${MP_API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.MP_CLIENT_ID, client_secret: env.MP_CLIENT_SECRET, grant_type: 'authorization_code',
      code, redirect_uri: env.MP_REDIRECT_URI,
      // test_token pide credenciales sandbox (TEST-…): MP las está discontinuando y su checkout deja el botón Pagar deshabilitado.
      // Para probar se usan las credenciales normales de una cuenta de prueba (plata ficticia en el checkout común).
      ...(env.MP_SANDBOX_TOKEN === '1' ? { test_token: true } : {}),
    }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok || !d.access_token) {
    console.error('mp oauth', res.status, JSON.stringify(d).slice(0, 300));
    return back('error', d.message || 'Mercado Pago rechazó la vinculación');
  }
  await saveTokens(env, st.uid, d);
  await adminUpdate(env, `users/${st.uid}`, { mpConnected: true, mpUserId: String(d.user_id) });
  return back('ok');
}

async function saveTokens(env, uid, d) {
  await adminSet(env, `mpTokens/${uid}`, {
    accessToken: d.access_token, refreshToken: d.refresh_token || '', userId: String(d.user_id || ''),
    publicKey: d.public_key || '', liveMode: !!d.live_mode,
    expiresAt: new Date(Date.now() + (d.expires_in || 15552000) * 1000), updatedAt: new Date(),
  });
}

// POST /mp/disconnect (Bearer)
export async function disconnect(req, env) {
  const claims = await requireUser(req, env);
  // Con pagos en curso (la preferencia de MP dura 2 horas) no se desvincula: el pago no se podría registrar.
  const pend = await adminQuery(env, 'orders', { filters: [['photographerUid', '==', claims.sub], ['status', '==', 'pending']], limit: 200 });
  if (pend.some(o => (o.createdAt?.getTime?.() || 0) > Date.now() - 3 * 3600_000)) {
    throw httpError(409, 'Hay compras en curso de tus fotos. Probá de nuevo en unas horas para no perder esos pagos.');
  }
  await adminDelete(env, `mpTokens/${claims.sub}`);
  await adminUpdate(env, `users/${claims.sub}`, { mpConnected: false, mpUserId: null });
  return json({ ok: true });
}

// Access token vigente del fotógrafo (lo renueva si vence en menos de 7 días).
export async function sellerToken(env, uid) {
  const t = await adminGet(env, `mpTokens/${uid}`);
  if (!t?.accessToken) throw httpError(409, 'El fotógrafo no tiene Mercado Pago vinculado');
  if (t.refreshToken && t.expiresAt && t.expiresAt.getTime() - Date.now() < REFRESH_BEFORE) {
    const res = await fetch(`${MP_API}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.MP_CLIENT_ID, client_secret: env.MP_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: t.refreshToken }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.access_token) { await saveTokens(env, uid, d); return d.access_token; }
    console.error('mp refresh', uid, res.status);
  }
  return t.accessToken;
}

export async function mpFetch(token, path, init = {}) {
  const res = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(httpError(502, d.message || `Mercado Pago ${res.status}`), { mp: d });
  return d;
}
