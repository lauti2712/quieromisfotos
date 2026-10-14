// Verificación de ID tokens de Firebase y lectura de Firestore como el usuario (aplican las reglas).
import { b64urlDecode } from './tokens.js';
import { httpError } from './http.js';

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let jwks = null; // { keys: Map(kid -> CryptoKey), exp }

async function getKey(kid) {
  if (!jwks || jwks.exp < Date.now() || !jwks.keys.has(kid)) {
    const res = await fetch(JWKS_URL);
    if (!res.ok) throw httpError(503, 'No se pudieron obtener las claves de Firebase');
    const maxAge = Number((res.headers.get('Cache-Control') || '').match(/max-age=(\d+)/)?.[1] || 3600);
    const { keys } = await res.json();
    const map = new Map();
    for (const k of keys) {
      map.set(k.kid, await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
    }
    jwks = { keys: map, exp: Date.now() + maxAge * 1000 };
  }
  return jwks.keys.get(kid);
}

export async function verifyIdToken(token, env) {
  const [h, p, s] = token.split('.');
  let header, claims;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    claims = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  } catch {
    throw httpError(401, 'Token inválido');
  }
  const pid = env.FIREBASE_PROJECT_ID;
  const now = Date.now() / 1000;

  if (env.FIREBASE_EMULATOR) {
    // Emulador de Auth: tokens sin firma (alg "none"). Solo en desarrollo (.dev.vars).
    if (claims.aud !== pid) throw httpError(401, 'Token inválido');
    return claims;
  }
  if (header.alg !== 'RS256' || !header.kid) throw httpError(401, 'Token inválido');
  const key = await getKey(header.kid);
  if (!key) throw httpError(401, 'Token inválido');
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlDecode(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw httpError(401, 'Firma inválida');
  if (claims.aud !== pid || claims.iss !== `https://securetoken.google.com/${pid}`) throw httpError(401, 'Token de otro proyecto');
  if (claims.exp < now || claims.iat > now + 300 || !claims.sub) throw httpError(401, 'Token vencido');
  return claims;
}

function firestoreBase(env) {
  const root = env.FIREBASE_EMULATOR ? 'http://127.0.0.1:8085' : 'https://firestore.googleapis.com';
  return `${root}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
}

// Lee un documento con el ID token del usuario. Devuelve null si no existe o no tiene permiso.
export async function getDocAsUser(env, idToken, path) {
  const res = await fetch(`${firestoreBase(env)}/${path}`, { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw httpError(502, `Firestore ${res.status}`);
  const d = await res.json();
  return decodeFields(d.fields || {});
}

export function decodeFields(fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

function decodeValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return new Date(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields || {});
  return undefined;
}

