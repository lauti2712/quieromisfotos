// Alertas para el superadmin (pagos que no se pudieron registrar, cobros duplicados): alerts/{id}.
// Las ve y las marca como resueltas desde el panel (Métricas).
import { adminSet } from './admin.js';

export async function addAlert(env, { type, text, ref = '' }) {
  const id = `${type}_${String(ref).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60) || crypto.randomUUID().slice(0, 12)}`;
  await adminSet(env, `alerts/${id}`, { type, text: String(text).slice(0, 500), ref: String(ref), createdAt: new Date() })
    .catch(e => console.error('alerta', e));
}
