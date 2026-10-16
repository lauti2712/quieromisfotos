// Dorsales: lee los números de dorsal de una foto con Workers AI (modelo de visión) y los guarda en photos/{pid}.bibs.
// El navegador del fotógrafo manda una copia SIN marca de agua (1280px) apenas guarda la foto; no se almacena.
//   PUT /bibs/{eid}/{pid}   X-Upload-Token   body: image/jpeg  -> { bibs }
import { adminGetMany, adminUpdate, adminIncrement } from './admin.js';
import { json, httpError } from './http.js';

const MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const MAX_BYTES = 2e6;
const PROMPT = 'List the race bib numbers (numbers printed on the paper bibs pinned to runners\' or cyclists\' chests, or on bike plates) '
  + 'that are clearly readable in this photo. Ignore watermarks, clocks, jersey sponsor logos and any other text. '
  + 'Reply ONLY with JSON like {"bibs":["123","4567"]}; use {"bibs":[]} if none is readable.';

// Normaliza la respuesta: solo números de 1 a 6 cifras, sin ceros a la izquierda; descarta listas inventadas (1234, 1235, 1236…).
export function parseBibs(text) {
  let arr = [];
  try { arr = JSON.parse(String(text).match(/\{[\s\S]*\}/)?.[0] || '{}').bibs || []; } catch { arr = []; }
  const out = new Set();
  for (const b of Array.isArray(arr) ? arr : []) {
    for (const m of String(b).matchAll(/\d{1,6}/g)) {
      const n = String(parseInt(m[0], 10));
      if (n !== '0') out.add(n);
    }
  }
  const nums = [...out].map(Number).sort((a, b) => a - b);
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    if (run >= 4) return [];
  }
  return [...out].slice(0, 15);
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function readBibs(env, jpeg) {
  const r = await env.AI.run(MODEL, {
    messages: [{ role: 'user', content: [
      { type: 'text', text: PROMPT },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${toBase64(jpeg)}` } },
    ] }],
    max_tokens: 120,
    temperature: 0,
  });
  return parseBibs(r?.choices?.[0]?.message?.content ?? r?.response ?? '');
}

export async function scanBibsRequest(req, env, s, eid, pid) {
  if (s.eid !== eid || s.role !== 'member') throw httpError(403, 'Token no válido para este evento');
  const len = Number(req.headers.get('Content-Length') || 0);
  if (!len) throw httpError(411, 'Falta Content-Length');
  if (len > MAX_BYTES) throw httpError(413, 'Imagen demasiado grande');
  const [photo, st] = await adminGetMany(env, [`photos/${pid}`, 'settings/platform']);
  if (!photo || photo.eventId !== eid || photo.photographerUid !== s.uid) throw httpError(404, 'Foto no encontrada');
  if (st?.bibsEnabled === false) return json({ bibs: [], disabled: true });
  if (photo.bibScanAt) return json({ bibs: photo.bibs || [] }); // ya se leyó (reintento)
  if (!env.AI) throw httpError(503, 'Lectura de dorsales no disponible');

  const bibs = await readBibs(env, await req.arrayBuffer());
  await adminUpdate(env, `photos/${pid}`, { bibs, bibScanAt: new Date() });
  await adminIncrement(env, `events/${eid}/sets/${s.uid}`, { bibScans: 1, ...(bibs.length ? { bibPhotos: 1 } : {}) });
  return json({ bibs });
}
