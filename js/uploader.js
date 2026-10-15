// Cola de subida masiva: procesa (Web Worker) y sube muestra, miniatura y original; crea el doc en `photos`.
import { db, doc, collection, writeBatch, increment, serverTimestamp, Timestamp, getDoc } from './fb.js';
import { uploadSession, invalidateSession, putBlob } from './api.js';
import { processFile } from './image-proc.js';

const ACCEPT = /^image\/(jpeg|png|webp)$/;
const MAX_ATTEMPTS = 5;
export const fileKey = f => `${f.name}|${f.size}`;

export function createUploader({ eventId, uid, wm, logo = null, optimize = false, onChange, onPhoto }) {
  // Se pueden reemplazar (setHandlers) si el fotógrafo sale y vuelve al evento mientras sube.
  const lowEnd = (navigator.deviceMemory && navigator.deviceMemory <= 4) || (navigator.hardwareConcurrency || 4) <= 4;
  const concurrency = lowEnd ? 2 : 3;
  const items = [];
  let running = 0;
  let workers = null;
  let seq = 0;
  const waiting = new Map();

  // ---- pool de Web Workers (si el navegador no soporta module workers, se procesa en el hilo principal)
  function pool() {
    if (workers !== null) return workers;
    try {
      workers = Array.from({ length: concurrency }, () => {
        const w = new Worker(new URL('./image-worker.js', import.meta.url), { type: 'module' });
        w.busy = false;
        w.onmessage = ({ data }) => { const cb = waiting.get(data.id); waiting.delete(data.id); w.busy = false; cb?.(data); };
        // Si el worker no carga (navegador viejo), se descarta el pool y la foto se procesa en el hilo principal.
        w.onerror = (e) => {
          e.preventDefault?.();
          const cb = waiting.get(w.current); waiting.delete(w.current);
          workers = [];
          cb?.({ ok: false, fallback: true });
        };
        return w;
      });
    } catch {
      workers = [];
    }
    return workers;
  }

  function process(file) {
    const w = pool().find(x => !x.busy);
    if (!w) return processFile(file, wm, logo, { optimize });
    w.busy = true;
    const id = ++seq;
    w.current = id;
    return new Promise((resolve, reject) => {
      waiting.set(id, data => {
        if (data.ok) resolve(data);
        else if (data.fallback) processFile(file, wm, logo, { optimize }).then(resolve, reject);
        else reject(new Error(data.error));
      });
      w.postMessage({ id, file, wm, logo, optimize });
    });
  }

  const emit = () => { onChange?.(summary()); keepAwake(); };

  // Celular: mientras sube, la pantalla no se apaga (si se apaga, el navegador frena la subida).
  let wakeLock = null;
  async function keepAwake() {
    const busy = items.some(i => ['queued', 'processing', 'uploading', 'retrying'].includes(i.status));
    if (busy && !wakeLock && document.visibilityState === 'visible' && navigator.wakeLock) {
      wakeLock = 'pending';
      try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); }
      catch { wakeLock = null; }
    } else if (!busy && wakeLock && wakeLock !== 'pending') {
      wakeLock.release().catch(() => {}); wakeLock = null;
    }
  }
  // Al volver a la pestaña o recuperar la conexión, retoma lo pendiente.
  const resume = () => {
    if (document.visibilityState !== 'visible') return;
    items.filter(i => i.status === 'retrying' && i.waitingNet).forEach(i => { i.status = 'queued'; i.waitingNet = false; });
    pump();
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);

  function summary() {
    const total = items.length;
    const done = items.filter(i => i.status === 'done').length;
    const failed = items.filter(i => i.status === 'error').length;
    const bytes = items.reduce((a, i) => a + i.file.size, 0);
    const sent = items.reduce((a, i) => a + (i.status === 'done' ? i.file.size : i.loaded || 0), 0);
    return { items, total, done, failed, active: total - done - failed, pct: bytes ? Math.round((sent / bytes) * 100) : 0 };
  }

  async function runItem(it) {
    it.status = 'processing'; it.error = ''; it.loaded = 0; emit();
    // Reintento: si el intento anterior llegó a guardar la foto (se cortó la conexión justo después), ya está.
    if (it.pid && (await getDoc(doc(db, 'photos', it.pid)).catch(() => null))?.exists()) {
      it.status = 'done'; it.loaded = it.file.size; emit();
      return;
    }
    const r = await process(it.file);
    const s = await uploadSession(eventId);
    const pid = it.pid || (it.pid = doc(collection(db, 'photos')).id);
    it.status = 'uploading'; emit();

    const extra = r.preview.size + r.thumb.size;
    const orig = r.original || it.file; // optimizado si achicó; si no, el archivo tal cual
    const progress = (base) => (l) => { it.loaded = Math.min(it.file.size, ((base + l) / (extra + orig.size)) * it.file.size); emit(); };
    const p = await putBlob(`/upload/preview/${eventId}/${pid}`, r.preview, s.token, progress(0));
    const t = await putBlob(`/upload/thumb/${eventId}/${pid}`, r.thumb, s.token, progress(r.preview.size));
    await putBlob(`/upload/original/${eventId}/${pid}`, orig, s.token, progress(extra));

    const photo = {
      eventId, photographerUid: uid, subalbumId: it.subalbumId || '',
      previewUrl: p.url, thumbUrl: t.url,
      width: r.width, height: r.height, bytes: orig.size, fileBytes: it.file.size, bytesPublic: extra,
      takenAt: Timestamp.fromMillis(r.takenAt), fileName: it.file.name.slice(0, 120),
      bibs: [], hidden: false, originalDeleted: false, createdAt: serverTimestamp(),
    };
    const b = writeBatch(db);
    b.set(doc(db, 'photos', pid), photo);
    b.update(doc(db, 'events', eventId, 'sets', uid), { photoCount: increment(1), bytesOriginal: increment(orig.size), bytesPublic: increment(extra) });
    await b.commit();
    it.status = 'done'; it.loaded = it.file.size;
    onPhoto?.({ id: pid, ...photo, takenAt: photo.takenAt });
  }

  function pump() {
    while (running < concurrency) {
      const it = items.find(i => i.status === 'queued');
      if (!it) break;
      running++;
      runItem(it)
        .catch(e => {
          // Sin conexión: espera a que vuelva sin gastar intentos.
          if (!navigator.onLine) { it.status = 'retrying'; it.waitingNet = true; it.error = 'Sin conexión: se retoma sola'; return; }
          it.attempts = (it.attempts || 0) + 1;
          if (e.status === 401) invalidateSession(eventId);
          // Álbum lleno: se frena toda la cola (se reintenta después de comprar espacio).
          if (e.status === 402) {
            items.filter(i => i.status === 'queued' || i === it).forEach(i => { i.status = 'error'; i.error = e.message; i.full = true; });
            return;
          }
          const retriable = !e.status || e.status >= 500 || e.status === 401 || e.status === 429;
          if (retriable && it.attempts < MAX_ATTEMPTS) {
            it.status = 'retrying'; it.error = e.message;
            setTimeout(() => { it.status = 'queued'; pump(); }, 1500 * 2 ** it.attempts);
          } else {
            it.status = 'error'; it.error = e.message || String(e);
          }
        })
        .finally(() => { running--; emit(); pump(); });
    }
    emit();
  }

  return {
    eventId,
    setHandlers(h) { ({ onChange, onPhoto } = { onChange, onPhoto, ...h }); emit(); },
    // Devuelve cuántos archivos se saltearon por estar ya en la cola.
    add(files, subalbumId = '') {
      const inQueue = new Set(items.filter(i => i.status !== 'error').map(i => fileKey(i.file)));
      let skipped = 0;
      for (const file of files) {
        if (inQueue.has(fileKey(file))) { skipped++; continue; }
        inQueue.add(fileKey(file));
        const ok = ACCEPT.test(file.type);
        items.push({ file, subalbumId, status: ok ? 'queued' : 'error', error: ok ? '' : 'Formato no soportado (usá JPG, PNG o WEBP)', loaded: 0 });
      }
      pump();
      return skipped;
    },
    retryFailed() {
      items.filter(i => i.status === 'error' && ACCEPT.test(i.file.type)).forEach(i => { i.status = 'queued'; i.attempts = 0; });
      pump();
    },
    clearDone() {
      for (let i = items.length - 1; i >= 0; i--) if (items[i].status === 'done') items.splice(i, 1);
      emit();
    },
    busy: () => items.some(i => ['queued', 'processing', 'uploading', 'retrying'].includes(i.status)),
    summary,
    destroy() {
      (workers || []).forEach(w => w.terminate()); workers = null;
      document.removeEventListener('visibilitychange', resume);
      window.removeEventListener('online', resume);
      if (wakeLock && wakeLock !== 'pending') wakeLock.release().catch(() => {});
    },
  };
}
