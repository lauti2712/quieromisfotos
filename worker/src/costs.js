// Uso y costos de la plataforma (panel del superadmin → 💰 Costos, y aviso diario si algo pasa lo gratis).
//   GET /admin/costs[?fresh=1]  (superadmin)  -> uso del mes por servicio, cupo gratis y costo estimado en USD
// Fuentes:
//   Firestore  → Cloud Monitoring (la cuenta de servicio necesita el rol "Visor de Monitoring")
//   Cloudflare → API GraphQL de analíticas (CF_API_TOKEN necesita el permiso "Account Analytics: Read")
//   R2 (espacio) → adminStats/storage, que mide el cron diario (storage.js)
// Cada fuente falla por separado: si falta un permiso, esa parte vuelve con `error` y el resto se muestra igual.
// Precios de lista (USD), del lado caro cuando dependen de la región: es una estimación, la factura manda.
import { adminGet, serviceToken } from './admin.js';
import { requireUser } from './firebase.js';
import { notifySuper } from './push.js';
import { json, httpError } from './http.js';

const DAY = 86400000;
export const PRICES = {
  firestore: { read: { free: 50000, per100k: 0.06 }, write: { free: 20000, per100k: 0.18 }, delete: { free: 20000, per100k: 0.02 } },
  workers: { freePerDay: 100000 },                                   // plan gratis: pasado el tope, los pedidos fallan (no se cobra)
  r2: { freeGB: 10, perGB: 0.015, classA: { free: 1e6, perM: 4.5 }, classB: { free: 1e7, perM: 0.36 } },
  ai: { freePerDay: 10000, per1k: 0.011 },                           // neuronas de Workers AI (lectura de dorsales)
};
const isSuper = c => c.email === 'lautarom87@gmail.com' && c.email_verified === true;
const iso = d => d.toISOString().slice(0, 10);
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ Firestore (Cloud Monitoring)
async function firestoreUsage(env, start, end) {
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/monitoring.read');
  const kinds = { read: 'read_count', write: 'write_count', delete: 'delete_count' };
  const out = {};
  await Promise.all(Object.entries(kinds).map(async ([k, metric]) => {
    const q = new URLSearchParams({
      filter: `metric.type="firestore.googleapis.com/document/${metric}"`,
      'interval.startTime': start.toISOString(), 'interval.endTime': end.toISOString(),
      'aggregation.alignmentPeriod': '86400s', 'aggregation.perSeriesAligner': 'ALIGN_SUM', 'aggregation.crossSeriesReducer': 'REDUCE_SUM',
    });
    const res = await fetch(`https://monitoring.googleapis.com/v3/projects/${env.FIREBASE_PROJECT_ID}/timeSeries?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 403) throw httpError(403, 'Falta el permiso: dale a la cuenta de servicio de Firebase el rol "Visor de Monitoring" (Monitoring Viewer) en Google Cloud → IAM.');
    if (!res.ok) throw httpError(502, `Cloud Monitoring ${res.status}: ${(await res.text()).slice(0, 160)}`);
    const d = await res.json();
    const days = {};
    for (const s of d.timeSeries || []) for (const p of s.points || []) {
      const day = iso(new Date(new Date(p.interval.endTime).getTime() - 1));
      days[day] = (days[day] || 0) + Number(p.value.int64Value || p.value.doubleValue || 0);
    }
    out[k] = days;
  }));
  const all = [...new Set(Object.values(out).flatMap(o => Object.keys(o)))].sort();
  const daily = all.map(day => ({ day, read: out.read[day] || 0, write: out.write[day] || 0, delete: out.delete[day] || 0 }));
  // El cupo gratis es por día: solo se paga lo que pasa del cupo de cada día.
  let usd = 0;
  const totals = { read: 0, write: 0, delete: 0 }, over = { read: 0, write: 0, delete: 0 };
  for (const r of daily) for (const k of Object.keys(totals)) {
    totals[k] += r[k];
    const extra = Math.max(0, r[k] - PRICES.firestore[k].free);
    over[k] += extra;
    usd += (extra / 1e5) * PRICES.firestore[k].per100k;
  }
  return { daily, totals, over, usd: round(usd) };
}

// ------------------------------------------------------------------ Cloudflare (GraphQL)
async function cfGraphql(env, query, variables) {
  if (!env.CF_API_TOKEN) throw httpError(503, 'Falta el token de Cloudflare (CF_API_TOKEN).');
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST', headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const d = await res.json().catch(() => ({}));
  if (d.errors?.length) {
    const msg = d.errors.map(e => e.message).join(', ');
    if (/auth|permission|access/i.test(msg)) throw httpError(403, 'Falta el permiso "Account Analytics: Read" en el token de Cloudflare (CF_API_TOKEN).');
    throw httpError(502, `Cloudflare: ${msg.slice(0, 200)}`);
  }
  return d.data?.viewer?.accounts?.[0] || {};
}

async function workersUsage(env, from, to) {
  const a = await cfGraphql(env, `query($a: String!, $f: Date!, $t: Date!, $s: String!) { viewer { accounts(filter: {accountTag: $a}) {
    workersInvocationsAdaptive(limit: 1000, filter: {date_geq: $f, date_leq: $t, scriptName: $s}) { sum { requests errors } dimensions { date } } } } }`,
  { a: env.CF_ACCOUNT_ID, f: from, t: to, s: env.WORKER_NAME || 'qmf-api' });
  const days = {};
  for (const g of a.workersInvocationsAdaptive || []) {
    const r = (days[g.dimensions.date] ||= { day: g.dimensions.date, requests: 0, errors: 0 });
    r.requests += g.sum.requests; r.errors += g.sum.errors;
  }
  const daily = Object.values(days).sort((x, y) => x.day.localeCompare(y.day));
  return { daily, total: daily.reduce((s, r) => s + r.requests, 0), maxDay: Math.max(0, ...daily.map(r => r.requests)), freePerDay: PRICES.workers.freePerDay };
}

// Operaciones de R2. Clase A: escribir y listar. Clase B: leer. Borrar es gratis.
const opClass = t => /^(Delete|Abort)/.test(t) ? '' : /^(Get|Head)/.test(t) ? 'B' : 'A';
async function r2Ops(env, from, to) {
  const a = await cfGraphql(env, `query($a: String!, $f: Date!, $t: Date!) { viewer { accounts(filter: {accountTag: $a}) {
    r2OperationsAdaptiveGroups(limit: 5000, filter: {date_geq: $f, date_leq: $t}) { sum { requests } dimensions { actionType } } } } }`,
  { a: env.CF_ACCOUNT_ID, f: from, t: to });
  const ops = { A: 0, B: 0 };
  for (const g of a.r2OperationsAdaptiveGroups || []) { const c = opClass(g.dimensions.actionType); if (c) ops[c] += g.sum.requests; }
  const usd = Math.max(0, ops.A - PRICES.r2.classA.free) / 1e6 * PRICES.r2.classA.perM + Math.max(0, ops.B - PRICES.r2.classB.free) / 1e6 * PRICES.r2.classB.perM;
  return { classA: ops.A, classB: ops.B, usd: round(usd) };
}

async function aiUsage(env, from, to) {
  const a = await cfGraphql(env, `query($a: String!, $f: Date!, $t: Date!) { viewer { accounts(filter: {accountTag: $a}) {
    aiInferenceAdaptiveGroups(limit: 1000, filter: {date_geq: $f, date_leq: $t}) { sum { totalNeurons } dimensions { date } } } } }`,
  { a: env.CF_ACCOUNT_ID, f: from, t: to });
  const days = {};
  for (const g of a.aiInferenceAdaptiveGroups || []) days[g.dimensions.date] = (days[g.dimensions.date] || 0) + (g.sum.totalNeurons || 0);
  const daily = Object.entries(days).map(([day, neurons]) => ({ day, neurons: Math.round(neurons) })).sort((x, y) => x.day.localeCompare(y.day));
  const usd = daily.reduce((s, r) => s + Math.max(0, r.neurons - PRICES.ai.freePerDay) / 1000 * PRICES.ai.per1k, 0);
  return { daily, total: daily.reduce((s, r) => s + r.neurons, 0), maxDay: Math.max(0, ...daily.map(r => r.neurons)), freePerDay: PRICES.ai.freePerDay, usd: round(usd) };
}

async function r2Storage(env, month) {
  const st = await adminGet(env, 'adminStats/storage');
  if (!st) return { error: 'Todavía no se midió (corre todos los días, o "Recalcular" en Almacenamiento).' };
  const h = (st.history || []).filter(x => x.d.startsWith(month));
  const avg = h.length ? h.reduce((s, x) => s + x.b, 0) / h.length : st.total || 0;
  const gb = avg / 1e9;
  return { avgGB: round(gb, 2), nowGB: round((st.total || 0) / 1e9, 2), freeGB: PRICES.r2.freeGB, usd: round(Math.max(0, gb - PRICES.r2.freeGB) * PRICES.r2.perGB) };
}

const settle = async p => { try { return await p; } catch (e) { return { error: e.message || String(e) }; } };

export async function computeCosts(env) {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = iso(start).slice(0, 7);
  const from = iso(start), to = iso(now);
  const [firestore, workers, r2ops, ai, storage] = await Promise.all([
    settle(firestoreUsage(env, start, now)), settle(workersUsage(env, from, to)), settle(r2Ops(env, from, to)),
    settle(aiUsage(env, from, to)), settle(r2Storage(env, month)),
  ]);
  const usd = round([firestore, r2ops, ai, storage].reduce((s, x) => s + (x.usd || 0), 0));
  // Proyección a fin de mes con el ritmo de los días que van.
  const dayOfMonth = now.getUTCDate(), daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  return { month, at: now.toISOString(), usd, projectedUsd: round(usd / dayOfMonth * daysInMonth), firestore, workers, r2ops, ai, storage, prices: PRICES };
}

export async function costsRequest(req, env, ctx) {
  const c = await requireUser(req, env);
  if (!isSuper(c)) throw httpError(403, 'Solo superadmin');
  const key = new Request('https://qmf-costs.internal/v1');
  if (!new URL(req.url).searchParams.has('fresh')) {
    const hit = await caches.default.match(key);
    if (hit) return json(await hit.json());
  }
  const data = await computeCosts(env);
  ctx.waitUntil(caches.default.put(key, new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=1800' } })));
  return json(data);
}

// Cron diario: avisa si ayer algo pasó el cupo gratis del día o si el mes ya genera costo.
export async function checkCosts(env) {
  const d = await computeCosts(env);
  const ayer = iso(new Date(Date.now() - DAY));
  const fsY = (d.firestore.daily || []).find(r => r.day === ayer);
  const alerts = [];
  if (fsY) for (const k of ['read', 'write', 'delete']) if (fsY[k] > PRICES.firestore[k].free) alerts.push(`Firestore ${({ read: 'lecturas', write: 'escrituras', delete: 'borrados' })[k]}: ${fsY[k].toLocaleString('es-AR')} (gratis ${PRICES.firestore[k].free.toLocaleString('es-AR')})`);
  const wY = (d.workers.daily || []).find(r => r.day === ayer);
  if (wY && wY.requests > PRICES.workers.freePerDay * 0.8) alerts.push(`Servidor: ${wY.requests.toLocaleString('es-AR')} pedidos (tope gratis ${PRICES.workers.freePerDay.toLocaleString('es-AR')}/día)`);
  const aY = (d.ai.daily || []).find(r => r.day === ayer);
  if (aY && aY.neurons > PRICES.ai.freePerDay) alerts.push(`Dorsales (IA): ${aY.neurons.toLocaleString('es-AR')} neuronas (gratis ${PRICES.ai.freePerDay.toLocaleString('es-AR')})`);
  if (d.storage.avgGB > PRICES.r2.freeGB) alerts.push(`Fotos: ${d.storage.avgGB} GB (gratis ${PRICES.r2.freeGB} GB)`);
  if (!alerts.length && !(d.usd > 0)) return;
  await notifySuper(env, 'costos', {
    title: `💰 Costos: US$ ${d.usd} en el mes (proyección US$ ${d.projectedUsd})`,
    body: alerts.length ? alerts.join(' · ') : 'Hay consumo por encima del cupo gratis este mes.',
    link: `${env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html'}#/admin/costos`,
  });
}
