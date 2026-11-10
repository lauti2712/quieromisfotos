// Resumen semanal para el superadmin: un mail los lunes con la semana anterior (lunes a domingo, hora de Argentina).
//   GET  /admin/weekly[?week=YYYY-MM-DD][&format=html]  (superadmin)  -> métricas de esa semana (JSON o el mail en HTML)
//   POST /admin/weekly/send {week?}                      (superadmin)  -> te manda el resumen ahora (para probar o reenviar)
// Cron: lo dispara el de cada 5 minutos los lunes a las 08:00 (Argentina), con reintentos a las 09 y 10 si falló.
// Cada envío queda en adminStats/weekly-{lunes}: no se manda dos veces y sirve de historial.
// Lee solo los campos que usa (select) para no gastar CPU del plan gratis.
import { accessToken, serviceToken, adminGet, adminSet } from './admin.js';
import { decodeFields, requireUser } from './firebase.js';
import { sendMail } from './mail.js';
import { json, httpError } from './http.js';

const DAY = 86400000;
const AR = 3 * 3600000; // Argentina: UTC-3, sin horario de verano
const INACTIVE_DAYS = 10;
const STUCK_DAYS = 7;   // fotógrafos aprobados hace más de esto y sin ningún álbum
const MAX_LIST = 15;    // nombres por lista en el mail
const DEAD = ['suspended', 'rejected', 'deleted'];
const isSuper = c => c.email === 'lautarom87@gmail.com' && c.email_verified === true;
const reportTo = env => env.REPORT_EMAIL || 'lautarom87@gmail.com';
const panel = env => env.PANEL_URL || 'https://quieromisfotos.com.ar/panel.html';

// ------------------------------------------------------------------ semana
// Lunes 00:00 (Argentina) de la semana que contiene `t`, en ms UTC.
function mondayOf(t) {
  const local = new Date(t - AR);
  const midnight = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return midnight - ((local.getUTCDay() + 6) % 7) * DAY + AR;
}
// Sin `week`: la última semana completa. Con `week` (cualquier día YYYY-MM-DD): la semana que lo contiene.
export function weekBounds(week, now = Date.now()) {
  let start;
  if (week) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) throw httpError(400, 'Semana inválida (usá YYYY-MM-DD)');
    start = mondayOf(Date.parse(`${week}T12:00:00-03:00`));
  } else start = mondayOf(now) - 7 * DAY;
  const day = t => new Date(t - AR).toISOString().slice(0, 10);
  return { start, end: start + 7 * DAY, label: day(start), lastDay: day(start + 6 * DAY) };
}
// El cron de cada 5 minutos dispara el resumen los lunes a las 08, 09 y 10 (Argentina), en el primer tic de la hora.
export const isWeeklyTick = t => { const d = new Date(t); return d.getUTCDay() === 1 && [11, 12, 13].includes(d.getUTCHours()) && d.getUTCMinutes() < 5; };

// ------------------------------------------------------------------ Firestore
const root = env => `${env.FIREBASE_EMULATOR ? 'http://127.0.0.1:8085' : 'https://firestore.googleapis.com'}/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const str = v => ({ stringValue: v });
const tsv = ms => ({ timestampValue: new Date(ms).toISOString() });
const filter = (fieldPath, op, value) => ({ fieldFilter: { field: { fieldPath }, op, value } });

async function fsPost(env, suffix, body) {
  const res = await fetch(`${root(env)}${suffix}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(env)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(502, `Firestore ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

// Toda la colección (o todas las subcolecciones con ese nombre), solo con los campos pedidos.
async function fetchAll(env, collectionId, fields, { allDescendants = false, where } = {}) {
  const structuredQuery = { from: [{ collectionId, allDescendants }], select: { fields: fields.map(fieldPath => ({ fieldPath })) }, ...(where ? { where } : {}) };
  const out = await fsPost(env, ':runQuery', { structuredQuery });
  return (out || []).filter(r => r.document).map(r => {
    const path = r.document.name.split('/documents/')[1];
    return { id: path.split('/').pop(), path, ...decodeFields(r.document.fields || {}) };
  });
}

// Fotos subidas entre dos momentos (cuenta en el servidor, sin bajar las fotos).
async function countPhotos(env, from, to) {
  const out = await fsPost(env, ':runAggregationQuery', { structuredAggregationQuery: {
    structuredQuery: { from: [{ collectionId: 'photos' }], where: { compositeFilter: { op: 'AND', filters: [
      filter('createdAt', 'GREATER_THAN_OR_EQUAL', tsv(from)), filter('createdAt', 'LESS_THAN', tsv(to))] } } },
    aggregations: [{ alias: 'n', count: {} }],
  } });
  return Number(out?.[0]?.result?.aggregateFields?.n?.integerValue || 0);
}

// Espacio usado en R2 (lo mide el cron diario): solo el total y el historial, no el detalle por álbum.
async function storageInfo(env) {
  const res = await fetch(`${root(env)}/adminStats/storage?mask.fieldPaths=total&mask.fieldPaths=history`, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  if (!res.ok) return null;
  return decodeFields((await res.json()).fields || {});
}

// Última actividad de cada cuenta en Firebase Auth: el último ingreso o la última renovación de sesión
// (quien deja el panel abierto no vuelve a "iniciar sesión", pero renueva el token cada hora que lo usa).
async function authActivity(env, uids) {
  if (!uids.length || env.FIREBASE_EMULATOR) return {};
  const token = await serviceToken(env, 'https://www.googleapis.com/auth/cloud-platform');
  const out = {};
  for (let i = 0; i < uids.length; i += 100) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/accounts:lookup`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ localId: uids.slice(i, i + 100) }),
    });
    if (!res.ok) throw new Error(`Auth lookup ${res.status}`);
    for (const u of (await res.json()).users || []) out[u.localId] = Math.max(Number(u.lastLoginAt || 0), Date.parse(u.lastRefreshAt || '') || 0);
  }
  return out;
}

// ------------------------------------------------------------------ cálculo
const ms = d => d?.getTime?.() || 0;
const sum = (l, f) => l.reduce((a, x) => a + (Number(f(x)) || 0), 0);

export async function buildReport(env, week, now = Date.now()) {
  const { start, end, label, lastDay } = weekBounds(week, now);
  const pStart = start - 7 * DAY;
  const inW = t => t >= start && t < end;
  const inP = t => t >= pStart && t < start;

  const [usersAll, setsAll, orders, customers, exts, fees, photosW, photosP, storage] = await Promise.all([
    fetchAll(env, 'users', ['displayName', 'slug', 'status', 'mpConnected', 'createdAt', 'demo'], { where: filter('role', 'EQUAL', str('photographer')) }),
    fetchAll(env, 'sets', ['createdAt', 'photoCount'], { allDescendants: true }),
    fetchAll(env, 'orders', ['status', 'createdAt', 'paidAt', 'buyerUid', 'photographerUid', 'photographerName', 'eventId', 'eventName', 'count', 'total', 'platformFee', 'payMethod']),
    fetchAll(env, 'customers', ['createdAt']),
    fetchAll(env, 'extensions', ['price', 'paidAt'], { where: filter('status', 'EQUAL', str('approved')) }),
    fetchAll(env, 'feeBalance', ['accrued', 'paid']),
    countPhotos(env, start, end).catch(e => { console.error('semanal fotos', e); return null; }),
    countPhotos(env, pStart, start).catch(() => null),
    storageInfo(env).catch(() => null),
  ]);

  const users = usersAll.filter(u => !u.demo);
  const byUid = new Map(users.map(u => [u.id, u]));
  const name = uid => { const u = byUid.get(uid); return u?.displayName || u?.slug || `(${String(uid).slice(0, 6)})`; };
  const daysAgo = t => Math.floor((now - t) / DAY);

  // Álbumes: events/{eid}/sets/{uid} (cada fotógrafo tiene su álbum dentro del evento).
  const sets = setsAll.filter(s => s.path.startsWith('events/'));
  const albumsOf = new Map();
  for (const s of sets) {
    const a = albumsOf.get(s.id) || { n: 0, photos: 0 };
    a.n++; a.photos += s.photoCount || 0;
    albumsOf.set(s.id, a);
  }

  // Ventas aprobadas (fecha de pago; las viejas sin paidAt usan la de creación, igual que Métricas del panel).
  const when = o => ms(o.paidAt) || ms(o.createdAt);
  const paid = orders.filter(o => o.status === 'approved' && when(o) < end);
  const salesW = paid.filter(o => inW(when(o)));
  const salesP = paid.filter(o => inP(when(o)));
  const soldEver = new Set(paid.map(o => o.photographerUid));
  const firstBuy = new Map();
  for (const o of paid) if (o.buyerUid) firstBuy.set(o.buyerUid, Math.min(firstBuy.get(o.buyerUid) ?? Infinity, when(o)));
  // Primera compra: su primer pedido pagado cae en la semana. Volvieron a comprar: algún pedido de la semana no es el primero
  // que hicieron (incluye a quien compró por primera vez y repitió en la misma semana).
  const buyerStats = (list, from) => {
    const buyers = [...new Set(list.map(o => o.buyerUid).filter(Boolean))];
    const repeat = new Set(list.filter(o => o.buyerUid && when(o) > firstBuy.get(o.buyerUid)).map(o => o.buyerUid));
    return { buyers: buyers.length, firstTime: buyers.filter(b => firstBuy.get(b) >= from).length, repeat: repeat.size };
  };
  const money = list => ({ orders: list.length, photos: sum(list, o => o.count), gmv: sum(list, o => o.total), fee: sum(list, o => o.platformFee) });
  const mW = money(salesW), mP = money(salesP);
  const extW = sum(exts.filter(x => inW(ms(x.paidAt))), x => x.price), extP = sum(exts.filter(x => inP(ms(x.paidAt))), x => x.price);
  const bW = buyerStats(salesW, start), bP = buyerStats(salesP, pStart);

  // Fotógrafos nuevos de la semana y hasta dónde llegaron.
  const newPh = users.filter(u => inW(ms(u.createdAt))).map(u => {
    const a = albumsOf.get(u.id);
    const stage = soldEver.has(u.id) ? 'sold' : a?.photos ? 'photos' : a ? 'album' : 'none';
    return { uid: u.id, name: name(u.id), status: u.status, mp: !!u.mpConnected, albums: a?.n || 0, photos: a?.photos || 0, stage };
  });
  const newPhPrev = users.filter(u => inP(ms(u.createdAt))).length;

  // Pendientes de tu atención.
  const live = users.filter(u => !DEAD.includes(u.status));
  const approved = live.filter(u => u.status === 'approved');
  const pendingApproval = live.filter(u => u.status === 'pending').map(u => ({ name: name(u.id), days: daysAgo(ms(u.createdAt)) })).sort((a, b) => b.days - a.days);
  const noMp = approved.filter(u => !u.mpConnected).map(u => ({ name: name(u.id), days: daysAgo(ms(u.createdAt)) })).sort((a, b) => b.days - a.days);
  const stuck = approved.filter(u => !albumsOf.has(u.id) && daysAgo(ms(u.createdAt)) >= STUCK_DAYS).map(u => ({ name: name(u.id), days: daysAgo(ms(u.createdAt)) })).sort((a, b) => b.days - a.days);
  let inactive = null;
  try {
    const act = await authActivity(env, live.map(u => u.id));
    if (Object.keys(act).length) {
      inactive = live.filter(u => act[u.id] && now - act[u.id] > INACTIVE_DAYS * DAY)
        .map(u => ({ name: name(u.id), days: daysAgo(act[u.id]), albums: albumsOf.get(u.id)?.n || 0, sold: soldEver.has(u.id) }))
        .sort((a, b) => b.days - a.days);
    }
  } catch (e) { console.error('semanal auth', e); }

  // Pedidos que no se cobraron (creados en la semana) y transferencias que esperan confirmación (todas las abiertas).
  const createdW = orders.filter(o => inW(ms(o.createdAt)));
  const unpaid = {
    abandoned: createdW.filter(o => o.status === 'pending' && o.payMethod !== 'transfer').length,
    rejected: createdW.filter(o => o.status === 'rejected').length,
    refunded: orders.filter(o => o.status === 'refunded' && inW(when(o))).length,
    transfersOpen: orders.filter(o => o.status === 'pending' && o.payMethod === 'transfer').length,
  };

  const top = (key, nameKey) => {
    const m = new Map();
    for (const o of salesW) {
      const g = m.get(o[key]) || { name: key === 'photographerUid' ? (o[nameKey] || name(o[key])) : (o[nameKey] || o[key]), orders: 0, photos: 0, gmv: 0 };
      g.orders++; g.photos += o.count || 0; g.gmv += o.total || 0;
      m.set(o[key], g);
    }
    return [...m.values()].sort((a, b) => b.gmv - a.gmv).slice(0, 3);
  };

  const owed = fees.map(f => ({ name: name(f.id), amount: Math.max(0, (f.accrued || 0) - (f.paid || 0)) })).filter(f => f.amount > 0).sort((a, b) => b.amount - a.amount);

  let storageGB = null;
  if (storage?.total) {
    const weekAgo = new Date(start - AR).toISOString().slice(0, 10);
    const h = (storage.history || []).filter(x => x.d <= weekAgo).pop();
    storageGB = { now: storage.total / 1e9, before: h ? h.b / 1e9 : null };
  }

  const albumsW = sets.filter(s => inW(ms(s.createdAt)));
  const summary = {
    newPhotographers: newPh.length, newPhotographersPrev: newPhPrev,
    newWithAlbum: newPh.filter(p => p.stage !== 'none').length, newSold: newPh.filter(p => p.stage === 'sold').length,
    newNoAlbum: newPh.filter(p => p.stage === 'none').length,
    albums: albumsW.length, albumsPrev: sets.filter(s => inP(ms(s.createdAt))).length, albumsEmpty: albumsW.filter(s => !s.photoCount).length,
    photosUploaded: photosW, photosUploadedPrev: photosP,
    customers: customers.filter(c => inW(ms(c.createdAt))).length, customersPrev: customers.filter(c => inP(ms(c.createdAt))).length,
    buyers: bW.buyers, firstTimeBuyers: bW.firstTime, firstTimeBuyersPrev: bP.firstTime, repeatBuyers: bW.repeat, repeatBuyersPrev: bP.repeat,
    orders: mW.orders, ordersPrev: mP.orders, photosSold: mW.photos, photosSoldPrev: mP.photos,
    gmv: mW.gmv, gmvPrev: mP.gmv, fee: mW.fee, feePrev: mP.fee, extensions: extW, extensionsPrev: extP,
    income: mW.fee + extW, incomePrev: mP.fee + extP,
    avgTicket: mW.orders ? mW.gmv / mW.orders : 0, avgTicketPrev: mP.orders ? mP.gmv / mP.orders : 0,
    ...unpaid, feeOwed: sum(owed, f => f.amount),
    pendingApproval: pendingApproval.length, noMp: noMp.length, stuck: stuck.length, inactive: inactive ? inactive.length : null,
  };
  return { label, lastDay, generatedAt: new Date(now).toISOString(), summary, newPh, pendingApproval, noMp, stuck, inactive,
    topPhotographers: top('photographerUid', 'photographerName'), topEvents: top('eventId', 'eventName'), owed, storageGB };
}

// ------------------------------------------------------------------ mail
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = n => Math.round(n || 0).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
const $$ = n => `$ ${int(n)}`;
const gb = n => n.toFixed(1).replace('.', ',');
const shortDate = d => { const [, m, day] = d.split('-'); return `${Number(day)}/${Number(m)}`; };
function delta(cur, prev) {
  if (prev == null || cur == null) return '';
  if (cur === prev) return '<span style="color:#9aa3b2">=</span>';
  if (!prev) return '<span style="color:#16a34a">nuevo</span>';
  const p = Math.round(((cur - prev) / prev) * 100);
  return `<span style="color:${p >= 0 ? '#16a34a' : '#dc2626'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p)}%</span>`;
}
const row = (k, v, d = '', sub = false) => `<tr><td style="padding:5px 0;color:${sub ? '#6b7280' : '#374151'};${sub ? 'padding-left:14px;font-size:13px' : ''}">${k}</td><td align="right" style="padding:5px 0;white-space:nowrap"><strong>${v}</strong></td><td align="right" style="padding:5px 0 5px 10px;font-size:12px;white-space:nowrap;width:64px">${d}</td></tr>`;
const section = (title, inner) => `<h2 style="margin:22px 0 6px;font-size:16px;color:#15181e">${title}</h2>${inner}`;
const table = rows => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">${rows.join('')}</table>`;
const names = (list, fmt) => {
  if (!list?.length) return '<p style="margin:2px 0;font-size:13px;color:#9aa3b2">Nadie 🎉</p>';
  const more = list.length > MAX_LIST ? ` y ${list.length - MAX_LIST} más` : '';
  return `<p style="margin:2px 0;font-size:13px;line-height:1.6;color:#374151">${list.slice(0, MAX_LIST).map(fmt).join(' · ')}${esc(more)}</p>`;
};
const STAGE = { sold: '💰 vendió', photos: '📷 subió fotos', album: '📁 creó álbum sin fotos', none: '⏸️ no avanzó' };

export function reportHtml(env, r) {
  const s = r.summary;
  const parts = [];
  parts.push(section('💵 Ventas', table([
    row('Vendido por los fotógrafos', $$(s.gmv), delta(s.gmv, s.gmvPrev)),
    row('<strong>Tu ganancia</strong>', $$(s.income), delta(s.income, s.incomePrev)),
    row('Comisiones', $$(s.fee), '', true),
    ...(s.extensions || s.extensionsPrev ? [row('Extensiones de plazo', $$(s.extensions), '', true)] : []),
    row('Pedidos pagados', int(s.orders), delta(s.orders, s.ordersPrev)),
    row('Fotos vendidas', int(s.photosSold), delta(s.photosSold, s.photosSoldPrev)),
    row('Ticket promedio', s.orders ? $$(s.avgTicket) : '—', s.orders ? delta(Math.round(s.avgTicket), Math.round(s.avgTicketPrev)) : ''),
  ])));
  parts.push(section('🛒 Compradores', table([
    row('Compraron por primera vez', int(s.firstTimeBuyers), delta(s.firstTimeBuyers, s.firstTimeBuyersPrev)),
    row('Volvieron a comprar', int(s.repeatBuyers), delta(s.repeatBuyers, s.repeatBuyersPrev)),
    row('Cuentas de cliente nuevas', int(s.customers), delta(s.customers, s.customersPrev)),
    row('Pedidos iniciados sin pagar', int(s.abandoned)),
    ...(s.rejected ? [row('Pagos rechazados', int(s.rejected))] : []),
    ...(s.refunded ? [row('Reembolsos / contracargos', int(s.refunded))] : []),
  ])));
  parts.push(section('📸 Fotógrafos nuevos', table([
    row('Se registraron', int(s.newPhotographers), delta(s.newPhotographers, s.newPhotographersPrev)),
    row('Crearon al menos un álbum', int(s.newWithAlbum), '', true),
    row('Ya vendieron', int(s.newSold), '', true),
    row('No crearon álbumes (no avanzaron)', int(s.newNoAlbum), '', true),
  ])) + (r.newPh.length ? names(r.newPh, p => `${esc(p.name)} <span style="color:#6b7280">(${STAGE[p.stage]}${p.status === 'pending' ? ', sin aprobar' : ''}${!p.mp && p.stage !== 'none' ? ', sin MP' : ''})</span>`) : ''));
  parts.push(section('🗂️ Actividad', table([
    row('Álbumes creados', int(s.albums), delta(s.albums, s.albumsPrev)),
    ...(s.albumsEmpty ? [row('Todavía sin fotos', int(s.albumsEmpty), '', true)] : []),
    row('Fotos subidas', s.photosUploaded == null ? '—' : int(s.photosUploaded), delta(s.photosUploaded, s.photosUploadedPrev)),
    ...(r.storageGB ? [row('Espacio en uso', `${gb(r.storageGB.now)} GB`, r.storageGB.before != null ? `<span style="color:#6b7280">${r.storageGB.now >= r.storageGB.before ? '+' : ''}${gb(r.storageGB.now - r.storageGB.before)} GB</span>` : '')] : []),
  ])));
  if (r.topPhotographers.length) {
    parts.push(section('🏆 Lo que más vendió', table([
      ...r.topPhotographers.map((t, i) => row(`${i + 1}. ${esc(t.name)}`, $$(t.gmv), `<span style="color:#6b7280">${t.photos} foto${t.photos === 1 ? '' : 's'}</span>`)),
      ...r.topEvents.map((t, i) => row(`🏟️ ${esc(t.name)}`, $$(t.gmv), `<span style="color:#6b7280">${t.photos} foto${t.photos === 1 ? '' : 's'}</span>`, true)),
    ])));
  }
  const days = d => (d < 1 ? 'hoy' : `${d} día${d === 1 ? '' : 's'}`);
  parts.push(section('👀 Para revisar', '' +
    `<p style="margin:10px 0 2px;font-size:14px"><strong>Esperan tu aprobación: ${s.pendingApproval}</strong></p>` + names(r.pendingApproval, p => `${esc(p.name)} <span style="color:#6b7280">(${days(p.days)})</span>`) +
    `<p style="margin:10px 0 2px;font-size:14px"><strong>Sin entrar hace más de ${INACTIVE_DAYS} días: ${r.inactive == null ? '—' : r.inactive.length}</strong></p>` +
      (r.inactive == null ? '<p style="margin:2px 0;font-size:13px;color:#9aa3b2">No se pudo consultar Firebase Auth esta vez.</p>' : names(r.inactive, p => `${esc(p.name)} <span style="color:#6b7280">(${days(p.days)}${p.sold ? ', ya vendió' : p.albums ? '' : ', sin álbumes'})</span>`)) +
    `<p style="margin:10px 0 2px;font-size:14px"><strong>Aprobados sin ningún álbum (más de ${STUCK_DAYS} días): ${s.stuck}</strong></p>` + names(r.stuck, p => `${esc(p.name)} <span style="color:#6b7280">(${days(p.days)})</span>`) +
    `<p style="margin:10px 0 2px;font-size:14px"><strong>Aprobados sin Mercado Pago conectado: ${s.noMp}</strong></p>` + names(r.noMp, p => esc(p.name)) +
    (s.transfersOpen ? `<p style="margin:10px 0 2px;font-size:14px"><strong>Transferencias esperando confirmación: ${s.transfersOpen}</strong></p>` : '') +
    (r.owed.length ? `<p style="margin:10px 0 2px;font-size:14px"><strong>Te deben de comisiones (cobro por transferencia): ${$$(s.feeOwed)}</strong></p>` + names(r.owed, f => `${esc(f.name)} ${$$(f.amount)}`) : '')));

  return `<!doctype html><html lang="es"><body style="margin:0;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#15181e">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px 12px"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:16px;overflow:hidden">
    <tr><td style="background:#ff5a1f;padding:18px 24px;color:#fff;font-size:20px;font-weight:800">quieromisfotos <span style="font-weight:400;font-size:15px;opacity:.9">· resumen semanal</span></td></tr>
    <tr><td style="padding:22px 24px">
      <h1 style="margin:0 0 4px;font-size:22px">Semana del ${shortDate(r.label)} al ${shortDate(r.lastDay)}</h1>
      <p style="margin:0;font-size:13px;color:#6b7280">Las flechas comparan con la semana anterior.</p>
      ${parts.join('')}
      <p style="margin:24px 0 0"><a href="${esc(panel(env))}#/admin/metricas" style="display:inline-block;background:#ff5a1f;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px;font-size:15px">Abrir Métricas</a></p>
    </td></tr>
    <tr><td style="padding:14px 24px;border-top:1px solid #eef0f4;font-size:12px;color:#9aa3b2">Se manda solo todos los lunes a las 8. Para reenviarlo: Panel → ⚙️ Plataforma.</td></tr>
  </table></td></tr></table></body></html>`;
}
const subject = r => `📊 Semana ${shortDate(r.label)}–${shortDate(r.lastDay)}: ${$$(r.summary.income)} de ganancia · ${r.summary.photosSold} fotos vendidas`;

// ------------------------------------------------------------------ envío
export async function weeklyCron(env, now = Date.now()) {
  const { label } = weekBounds(undefined, now);
  const key = `adminStats/weekly-${label}`;
  if (await adminGet(env, key)) return false; // ya se mandó
  const r = await buildReport(env, undefined, now);
  if (!await sendMail(env, { to: reportTo(env), subject: subject(r), html: reportHtml(env, r) })) throw new Error('Resend no mandó el resumen semanal');
  await adminSet(env, key, { sentAt: new Date(), to: reportTo(env), week: r.label, summary: r.summary });
  return true;
}

export async function weeklyRequest(req, env) {
  const c = await requireUser(req, env);
  if (!isSuper(c)) throw httpError(403, 'Solo superadmin');
  const url = new URL(req.url);
  if (req.method === 'POST') {
    if (!env.RESEND_API_KEY) throw httpError(503, 'Falta la clave de Resend (RESEND_API_KEY)');
    const { week } = await req.json().catch(() => ({}));
    const r = await buildReport(env, week || undefined);
    if (!await sendMail(env, { to: c.email, subject: subject(r), html: reportHtml(env, r) })) throw httpError(502, 'Resend rechazó el envío');
    return json({ ok: true, to: c.email, week: r.label });
  }
  const r = await buildReport(env, url.searchParams.get('week') || undefined);
  if (url.searchParams.get('format') === 'html') return new Response(reportHtml(env, r), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  return json(r);
}
