// Reconocimiento facial en el navegador para "Buscarme con una selfie" (face-api 1.7.15, copiado en js/vendor; modelos en
// assets/models/face). Se carga solo al usarlo (~8 MB la primera vez, después queda en la caché del navegador).
// Cada cara se resume en una huella de 128 números; se guarda comprimida (1 byte por número, en base64).
// La foto de la cara no se guarda nunca: ni la de los álbumes ni la selfie del cliente.
let fa = null, loading = null;

export function loadFaceApi() {
  loading ||= (async () => {
    const mod = await import('./vendor/face-api.esm.js');
    await mod.tf.setBackend('webgl').catch(() => mod.tf.setBackend('cpu'));
    await mod.tf.ready();
    const M = new URL('../assets/models/face/', import.meta.url).href;
    await Promise.all([mod.nets.tinyFaceDetector.loadFromUri(M), mod.nets.faceLandmark68TinyNet.loadFromUri(M), mod.nets.faceRecognitionNet.loadFromUri(M)]);
    fa = mod;
    return mod;
  })().catch(e => { loading = null; throw e; });
  return loading;
}

const SCALE = 400; // los valores de la huella andan entre ±0,3: a int8 con poca pérdida
export function packDescriptor(d) {
  const b = new Int8Array(128);
  for (let i = 0; i < 128; i++) b[i] = Math.max(-127, Math.min(127, Math.round(d[i] * SCALE)));
  return btoa(String.fromCharCode(...new Uint8Array(b.buffer)));
}
export function unpackDescriptor(s) {
  const raw = atob(s), out = new Float32Array(128);
  for (let i = 0; i < 128; i++) { const v = raw.charCodeAt(i); out[i] = (v > 127 ? v - 256 : v) / SCALE; }
  return out;
}
export function faceDistance(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const d = a[i] - b[i]; s += d * d; }
  return Math.sqrt(s);
}

// Todas las caras de una foto que se ven lo suficientemente grandes para reconocerlas (en px del lado menor de la cara).
export async function photoFaces(source, { minSize = 36, max = 15 } = {}) {
  const api = await loadFaceApi();
  const det = await api.detectAllFaces(source, new api.TinyFaceDetectorOptions({ inputSize: 608, scoreThreshold: 0.55 }))
    .withFaceLandmarks(true).withFaceDescriptors();
  return det.filter(d => Math.min(d.detection.box.width, d.detection.box.height) >= minSize)
    .sort((a, b) => b.detection.box.height - a.detection.box.height).slice(0, max)
    .map(d => packDescriptor(d.descriptor));
}

// La cara de la selfie: la más grande. null si no encontró ninguna.
export async function selfieFace(source) {
  const api = await loadFaceApi();
  const det = await api.detectAllFaces(source, new api.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }))
    .withFaceLandmarks(true).withFaceDescriptors();
  if (!det.length) return null;
  det.sort((a, b) => b.detection.box.height - a.detection.box.height);
  return det[0].descriptor;
}

// Fotos donde aparece la cara: distancia menor al umbral, de la más parecida a la menos. index = [[photoId, huella], …]
export const MATCH = 0.55;
export function matchFaces(selfie, index, threshold = MATCH) {
  const best = new Map();
  for (const [pid, s] of index) {
    const d = faceDistance(selfie, unpackDescriptor(s));
    if (d < threshold && d < (best.get(pid) ?? 9)) best.set(pid, d);
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([pid, d]) => ({ pid, d }));
}
