// Cliente de la API (Cloudflare Worker).
import { auth } from './fb.js';

export const API_BASE = location.hostname === 'localhost'
  ? 'http://localhost:8787'
  : 'https://qmf-api.solucionescotidianas.com.ar';

const sessions = new Map(); // eventId|'' -> { token, exp, publicBase }

export async function uploadSession(eventId = null) {
  const key = eventId || '';
  const s = sessions.get(key);
  if (s && s.exp - 300 > Date.now() / 1000) return s;
  const idToken = await auth.currentUser.getIdToken();
  const res = await fetch(`${API_BASE}/upload-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  sessions.set(key, data);
  return data;
}

export function invalidateSession(eventId = null) {
  sessions.delete(eventId || '');
}

// PUT con progreso (fetch no informa progreso de subida).
export function putBlob(path, blob, token, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}${path}`);
    xhr.setRequestHeader('X-Upload-Token', token);
    if (blob.type) xhr.setRequestHeader('Content-Type', blob.type);
    xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded, e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* vacío */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(Object.assign(new Error(data.error || `Error ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('Error de red'));
    xhr.send(blob);
  });
}

export async function apiDelete(path, token) {
  const res = await fetch(`${API_BASE}${path}`, { method: 'DELETE', headers: { 'X-Upload-Token': token } });
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Error ${res.status}`);
  }
}

// Sube una imagen suelta (avatar, logo o portada). Devuelve { url, key }.
export async function uploadAsset(kind, blob, eventId = null) {
  const s = await uploadSession(eventId);
  return putBlob(`/asset/${kind}`, blob, s.token);
}
