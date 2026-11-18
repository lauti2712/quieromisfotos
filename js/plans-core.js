// Planes de Quiero Mis Fotos: Gratis, Profesional Lite, Profesional, Profesional Premium y Empresas (equipo de fotógrafos).
// Módulo puro: lo usan el sitio, el panel y el Worker. Los valores se editan en Plataforma; acá están los de por defecto.
//   price: abono mensual · first: primer mes (Premium: incluye el dominio) · year: abono anual
//   fee: comisión % · portfolio: fotos · albumPhotos: tope de fotos por álbum · days: días de venta · stats: nivel de estadísticas (1-4)
//   web: web propia · domain: dominio propio · team: colaboradores incluidos (pueden subir a los álbumes de la cuenta)
export const PAID_PLANS = ['lite', 'web', 'webdomain', 'empresa'];
// Períodos de pago de la suscripción: meses que cubre cada cobro y campo de precio en planSpec.
export const PERIODS = { month: { months: 1, key: 'price', label: 'Mensual' }, quarter: { months: 3, key: 'quarter', label: 'Trimestral' }, year: { months: 12, key: 'year', label: 'Anual' } };

export function planOf(user, now = Date.now()) {
  const t = user?.proUntil?.toMillis?.() ?? user?.proUntil?.getTime?.() ?? 0;
  return PAID_PLANS.includes(user?.plan) && t > now ? user.plan : 'free';
}

// Promo de comisión (Plataforma): hasta promoUntil (inclusive, hora Argentina) la comisión de todos los planes
// baja a promoFee si es menor. 0 o sin fecha = sin promo. Por defecto: 3% hasta el 15/11/2026 (lanzamiento).
export function promoOf(st, now = Date.now()) {
  st = st || {};
  const fee = 'promoFee' in st ? Number(st.promoFee) || 0 : 3;
  const until = 'promoUntil' in st ? String(st.promoUntil || '') : '2026-11-15';
  if (!(fee > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(until)) return null;
  return now <= Date.parse(`${until}T23:59:59-03:00`) ? { fee, until } : null;
}

export function planSpec(planId, st, now = Date.now()) {
  const p = basePlanSpec(planId, st);
  const promo = promoOf(st, now);
  return promo && promo.fee < p.fee ? { ...p, baseFee: p.fee, fee: promo.fee, promoUntil: promo.until } : { ...p, baseFee: p.fee };
}

// Cupo de fotos de la cuenta (todas las fotos con original guardado, entre todos los álbumes) y álbumes activos a la vez
// (0 = sin tope). Se editan en Plataforma: {prefijo}TotalPhotos y {prefijo}Albums.
const PLAN_PREFIX = { free: 'free', lite: 'lite', web: 'web', webdomain: 'webDomain', empresa: 'empresa' };
const TOTAL_PHOTOS = { free: 300, lite: 1500, web: 4000, webdomain: 9000, empresa: 25000 };
function basePlanSpec(planId, st) {
  st = st || {};
  const id = PLAN_PREFIX[planId] ? planId : 'free', px = PLAN_PREFIX[id];
  const lim = { totalPhotos: Number(st[`${px}TotalPhotos`] ?? TOTAL_PHOTOS[id]) || 0, albums: Number(st[`${px}Albums`] ?? (id === 'free' ? 1 : 0)) || 0,
    // Abono trimestral (3 meses juntos): 0 = no se ofrece.
    quarter: id === 'free' ? 0 : Number(st[`${px}QuarterPrice`]) || 0 };
  const raw = planSpecRaw(planId, st);
  // Planes con dominio: adicional que se cobra una sola vez en el primer pago (sea mensual, trimestral o anual).
  // {prefijo}SetupPrice; si no está, sale del viejo "primer mes" (first − mensual). first = mensual + adicional.
  if (raw.first != null) {
    const setup = Math.max(0, Number(st[`${px}SetupPrice`] ?? (raw.first - raw.price)) || 0);
    Object.assign(raw, { setup, first: raw.price + setup });
  }
  return { ...raw, ...lim };
}
function planSpecRaw(planId, st) {
  const base = st.retentionDays ?? 14;
  switch (planId) {
    case 'lite': return { price: st.litePrice ?? 4900, year: st.liteYearPrice ?? 49000, fee: st.liteFeePercent ?? 5, portfolio: st.litePortfolioLimit ?? 30,
      albumPhotos: st.liteAlbumPhotos ?? 800, days: st.liteRetentionDays ?? base, featured: !!(st.liteFeatured ?? false), stats: 2, profileCustom: true };
    case 'web': return { price: st.webPrice ?? 9900, year: st.webYearPrice ?? 99000, fee: st.webFeePercent ?? 4, portfolio: st.webPortfolioLimit ?? 60,
      albumPhotos: st.webAlbumPhotos ?? 1500, days: st.webRetentionDays ?? 21, featured: !!(st.webFeatured ?? false), stats: 3, profileCustom: true, shortLinks: true, web: true };
    case 'webdomain': return { price: st.webDomainPrice ?? 12900, first: st.webDomainFirstPrice ?? 21900, year: st.webDomainYearPrice ?? 129000,
      fee: st.webDomainFeePercent ?? 3, portfolio: st.webDomainPortfolioLimit ?? 100, albumPhotos: st.webDomainAlbumPhotos ?? 3000, days: st.webDomainRetentionDays ?? 30,
      featured: !!(st.webDomainFeatured ?? true), stats: 4, profileCustom: true, shortLinks: true, web: true, domain: true, priority: true };
    case 'empresa': return { price: st.empresaPrice ?? 24900, first: st.empresaFirstPrice ?? 33900, year: st.empresaYearPrice ?? 249000,
      fee: st.empresaFeePercent ?? 3, portfolio: st.empresaPortfolioLimit ?? 100, albumPhotos: st.empresaAlbumPhotos ?? 5000, days: st.empresaRetentionDays ?? 30,
      featured: !!(st.empresaFeatured ?? true), stats: 4, profileCustom: true, shortLinks: true, web: true, domain: true, priority: true,
      team: st.empresaSeats ?? 5, seatPrice: st.empresaSeatPrice ?? 3000 };
    default: return { price: 0, fee: st.freeFeePercent ?? 7, portfolio: st.freePortfolioLimit ?? 12, albumPhotos: st.freeAlbumPhotos ?? 300,
      days: st.freeRetentionDays ?? base, featured: false, stats: 1 };
  }
}

// Álbumes activos a la vez: ilimitado en los planes pagos; en Gratis, 1 + los álbumes de prueba que dio el superadmin
// (users.albumBonus = { count, until }) mientras estén vigentes.
export function albumBonusOf(user, now = Date.now()) {
  const b = user?.albumBonus;
  const until = b?.until?.toMillis?.() ?? b?.until?.getTime?.() ?? 0;
  return b && b.count > 0 && until > now ? { count: b.count, until } : null;
}
// Fotos de prueba: más fotos por álbum, por un tiempo (users.photoBonus = { photos, until }, solo superadmin).
export function photoBonusOf(user, now = Date.now()) {
  const b = user?.photoBonus;
  const until = b?.until?.toMillis?.() ?? b?.until?.getTime?.() ?? 0;
  return b && b.photos > 0 && until > now ? { photos: b.photos, until } : null;
}
export function activeAlbumLimit(user, st, now = Date.now()) {
  const n = planSpec(planOf(user, now), st, now).albums;
  return n > 0 ? n + (albumBonusOf(user, now)?.count || 0) : Infinity;
}

// Lo que rige hoy para un fotógrafo, según su plan vigente.
export function rulesFor(user, st = {}) {
  const plan = planOf(user);
  return { plan, ...planSpec(plan, st) };
}

// Cupo de fotos de la cuenta: cuentan las fotos de todos sus álbumes mientras exista el original (al borrarse, se libera).
// Los packs de fotos extra (sets.extraPhotos, no en Gratis) suman mientras exista el álbum donde se compraron.
// sets: los sets de la cuenta (cualquier orden; los nulos se ignoran). max 0 = sin tope.
export function photoQuota(user, st, sets) {
  const r = rulesFor(user, st);
  const live = (sets || []).filter(s => s && !s.originalsDeleted);
  const used = live.reduce((a, s) => a + (s.photoCount || 0), 0);
  if (!(r.totalPhotos > 0)) return { max: 0, used };
  const extra = r.plan === 'free' ? 0 : live.reduce((a, s) => a + (s.extraPhotos || 0), 0);
  return { max: r.totalPhotos + extra + (photoBonusOf(user)?.photos || 0), used };
}
// Cuántas fotos puede tener este álbum (0 = sin tope): las que ya tiene + lo que queda libre del cupo de la cuenta.
// others: los demás sets de la cuenta (sin este).
export function albumPhotoLimit(set, st, user, others = []) {
  const q = photoQuota(user, st, [set, ...others]);
  return q.max ? (set?.photoCount || 0) + Math.max(0, q.max - q.used) : 0;
}

// Colaboradores que puede tener la cuenta (0 si su plan no es Empresas).
// teamExtraSeats: lugares que da el superadmin · teamPaidSeats: lugares que la empresa paga en su suscripción.
export function teamSeats(user, st) {
  const r = rulesFor(user, st);
  return r.team ? r.team + (user?.teamExtraSeats || 0) + (user?.teamPaidSeats || 0) : 0;
}

// Beneficio destacado de los planes con cobro por transferencia (se muestra resaltado en las tarjetas de planes).
export const TRANSFER_FEATURE = 'Cobrá por transferencia a tu Mercado Pago y ahorrate la comisión de MP';
// Cobro por transferencia habilitado para su plan (Plataforma) o conservado de antes (users.transferKeep, lo pone el
// superadmin al sacarle la opción a un plan: los que ya la usaban la mantienen).
export const transferPlanOk = (user, st) => (st?.transfer?.plans || []).includes(planOf(user)) || !!user?.transferKeep;

// Qué incluye cada plan: mismo texto en "Soy fotógrafo", en el panel y en la página estática para Google.
export function planFeatures(id, st) {
  const p = planSpec(id, st);
  const pct = n => String(n).replace('.', ',');
  const fee = p.promoUntil
    ? `Comisión ${pct(p.fee)}% por venta hasta el ${p.promoUntil.slice(8, 10)}/${p.promoUntil.slice(5, 7)} (después ${pct(p.baseFee)}%) + la de Mercado Pago`
    : `Comisión ${pct(p.fee)}% por venta + la de Mercado Pago`;
  const gb = p.totalPhotos > 0 ? `${p.totalPhotos.toLocaleString('es-AR')} fotos en total` : 'Fotos sin tope';
  const albums = p.albums > 0 ? `${p.albums} álbum${p.albums === 1 ? '' : 'es'} activo${p.albums === 1 ? '' : 's'} a la vez` : 'Álbumes ilimitados';
  const days = `Cada álbum se vende ${p.days} días`;
  // Cobro por transferencia: solo en los planes elegidos en Plataforma.
  const tr = (st?.transfer?.plans || []).includes(id) ? [TRANSFER_FEATURE] : [];
  if (id === 'free') return ['Vendé tus fotos en eventos', albums, `Hasta ${gb}`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas básicas', fee];
  if (id === 'lite') return [albums, `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas por evento', 'Foto de portada en tu perfil',
    ...(p.featured ? ['Destacado en el directorio'] : []), ...tr, fee];
  if (id === 'web') return ['Todo lo de Lite', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Tu web: tunombre.quieromisfotos.com.ar',
    'Fotos de tu web sin marca de agua', 'Links cortos para tus eventos', 'Estadísticas completas', ...(p.featured ? ['Destacado en el directorio'] : []), ...tr, fee];
  if (id === 'empresa') return ['Todo lo de Premium', `Equipo de ${p.team} fotógrafos (cada uno con su cuenta)`, 'Suben a tus álbumes; vos cobrás todo', 'Ventas por fotógrafo para liquidarles',
    `${gb} (ampliable)`, days, `Lugar extra: ${'$'}${Number(p.seatPrice).toLocaleString('es-AR')}/mes`, ...tr, fee];
  return ['Todo lo de Profesional', 'Tu dominio .com.ar incluido (lo registramos y conectamos nosotros)', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`,
    ...(p.featured ? ['Destacado en el directorio'] : []), 'Estadísticas avanzadas', 'Atención prioritaria', ...tr, fee];
}

// Comisión de Mercado Pago del fotógrafo (%), según el plazo de acreditación que eligió (users.mpReleasePlan).
export const DEFAULT_MP_FEE_PLANS = [
  { id: '0', label: 'Al instante', percent: 7.85 },
  { id: '10', label: 'A 10 días', percent: 5.19 },
  { id: '18', label: 'A 18 días', percent: 4.10 },
  { id: '35', label: 'A 35 días', percent: 2.17 },
  { id: '70', label: 'A 70 días', percent: 0 },
];
export function mpPercentFor(user, settings) {
  const plans = settings?.mpFeePlans?.length ? settings.mpFeePlans : DEFAULT_MP_FEE_PLANS;
  return Number((plans.find(p => p.id === user?.mpReleasePlan) || plans[0])?.percent) || 0;
}

// Lectura de dorsales con IA: la plataforma cobra un % extra de comisión en los álbumes donde se usó (sets.bibScans > 0).
export const BIB_FEE_PERCENT = 1;
export const bibFeeFor = (set, settings) => ((set?.bibScans || 0) > 0 ? Number(settings?.bibFeePercent ?? BIB_FEE_PERCENT) || 0 : 0);
