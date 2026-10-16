// Web Worker de procesamiento de imágenes (module worker).
import { processFile } from './image-proc.js';

self.onmessage = async ({ data }) => {
  const { id, file, wm, logo, optimize, scan } = data;
  try {
    const r = await processFile(file, wm, logo || null, { optimize, scan });
    self.postMessage({ id, ok: true, ...r });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message || e) });
  }
};
