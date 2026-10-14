// Acceso de servidor a Firestore (cuenta de servicio, sin reglas). Solo para datos que el cliente no puede escribir:
// órdenes, tokens de Mercado Pago, estado de vinculación.
import { b64url } from './tokens.js';
import { decodeFields } from './firebase.js';
import { httpError } from './http.js';

let cached = null; // { token, exp }

async function accessToken(env) {
  if (env.FIREBASE_EMULATOR) return 'owner';
  if (cached && cached.exp > Date.now() + 60_000) return cached.token;
  const sa = JSON.parse(env.FIREBASE_SA);
  const enc = new TextEncoder();
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: sa.private_key_id })));
  const claims = b64url(enc.encode(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const der = Uint8Array.from(atob(sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${header}.${claims}`));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${b64url(sig)}` }),
  });
  if (!res.ok) throw httpError(502, `Google OAuth ${res.status}`);
  const d = await res.json();
  cached = { token: d.access_token, exp: Date.now() + d.expires_in * 1000 };
  return cached.token;
}

const root = env => `${env.FIREBASE_EMULATOR ? 'http://127.0.0.1:8085' : 'https://firestore.googleapis.com'}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const docName = (env, path) => `projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/${path}`;

async function call(env, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 404) return null;
  if (!res.ok) throw httpError(502, `Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? {} : res.json();
}

export function encodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v) } };
  throw new Error(`Tipo no soportado: ${typeof v}`);
}
const encodeFields = obj => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeValue(v)]));

export async function adminGet(env, path) {
  const d = await call(env, 'GET', `${root(env)}/${path}`);
  return d ? { id: path.split('/').pop(), ...decodeFields(d.fields || {}) } : null;
}

export async function adminGetMany(env, paths) {
  if (!paths.length) return [];
  const out = await call(env, 'POST', `${root(env)}:batchGet`, { documents: paths.map(p => docName(env, p)) });
  const byName = new Map((out || []).filter(r => r.found).map(r => [r.found.name.split('/documents/')[1], { id: r.found.name.split('/').pop(), ...decodeFields(r.found.fields || {}) }]));
  return paths.map(p => byName.get(p) || null);
}

// Crea o reemplaza el documento completo. mustNotExist: falla si ya existe.
export async function adminSet(env, path, data, { mustNotExist = false } = {}) {
  const q = mustNotExist ? '?currentDocument.exists=false' : '';
  return call(env, 'PATCH', `${root(env)}/${path}${q}`, { fields: encodeFields(data) });
}

// Actualiza solo los campos indicados (de primer nivel). El documento tiene que existir.
export async function adminUpdate(env, path, data) {
  const mask = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  return call(env, 'PATCH', `${root(env)}/${path}?${mask}&currentDocument.exists=true`, { fields: encodeFields(data) });
}

// Suma `by` a campos numéricos (atómico, no pisa otros campos). fields: { campo: número }
export async function adminIncrement(env, path, fields) {
  return call(env, 'POST', `${root(env)}:commit`, {
    writes: [{
      transform: {
        document: docName(env, path),
        fieldTransforms: Object.entries(fields).map(([fieldPath, n]) => ({ fieldPath, increment: encodeValue(n) })),
      },
      currentDocument: { exists: true },
    }],
  });
}

export async function adminDelete(env, path) {
  return call(env, 'DELETE', `${root(env)}/${path}`);
}
