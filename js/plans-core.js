// Planes de Quiero Mis Fotos: Gratis, Profesional Lite, Profesional, Profesional Premium y Empresas (equipo de fotógrafos).
// Módulo puro: lo usan el sitio, el panel y el Worker. Los valores se editan en Plataforma; acá están los de por defecto.
//   price: abono mensual · first: primer mes (Premium: incluye el dominio) · year: abono anual
//   fee: comisión % · portfolio: fotos · albumPhotos: tope de fotos por álbum · days: días de venta · stats: nivel de estadísticas (1-4)
//   web: web propia · domain: dominio propio · team: colaboradores incluidos (pueden subir a los álbumes de la cuenta)
export const PAID_PLANS = ['lite', 'web', 'webdomain', 'empresa'];

export function planOf(user, now = Date.now()) {
  const t = user?.proUntil?.toMillis?.() ?? user?.proUntil?.getTime?.() ?? 0;
  return PAID_PLANS.includes(user?.plan) && t > now ? user.plan : 'free';
}

export function planSpec(planId, st) {
  st = st || {};
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
      days: st.freeRetentionDays ?? base, featured: false, stats: 1, albums: 1 };
  }
}

// Lo que rige hoy para un fotógrafo, según su plan vigente.
export function rulesFor(user, st = {}) {
  const plan = planOf(user);
  return { plan, ...planSpec(plan, st) };
}

// Tope de fotos del álbum (0 = sin tope). El plan Gratis no suma packs comprados.
export function albumPhotoLimit(set, st, user) {
  const r = rulesFor(user, st);
  if (!(r.albumPhotos > 0)) return 0;
  return r.albumPhotos + (r.plan === 'free' ? 0 : (set?.extraPhotos || 0));
}

// Colaboradores que puede tener la cuenta (0 si su plan no es Empresas).
// teamExtraSeats: lugares que da el superadmin · teamPaidSeats: lugares que la empresa paga en su suscripción.
export function teamSeats(user, st) {
  const r = rulesFor(user, st);
  return r.team ? r.team + (user?.teamExtraSeats || 0) + (user?.teamPaidSeats || 0) : 0;
}

// Qué incluye cada plan: mismo texto en "Soy fotógrafo", en el panel y en la página estática para Google.
export function planFeatures(id, st) {
  const p = planSpec(id, st);
  const fee = `Comisión ${String(p.fee).replace('.', ',')}% por venta + la de Mercado Pago`;
  const gb = `${p.albumPhotos.toLocaleString('es-AR')} fotos por álbum`;
  const days = `Cada álbum se vende ${p.days} días`;
  if (id === 'free') return ['Vendé tus fotos en eventos', '1 álbum activo a la vez', `Hasta ${gb}`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas básicas', fee];
  if (id === 'lite') return ['Álbumes ilimitados', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas por evento', 'Foto de portada en tu perfil',
    ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  if (id === 'web') return ['Todo lo de Lite', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Tu web: tunombre.quieromisfotos.com.ar',
    'Fotos de tu web sin marca de agua', 'Links cortos para tus eventos', 'Estadísticas completas', ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  if (id === 'empresa') return ['Todo lo de Premium', `Equipo de ${p.team} fotógrafos (cada uno con su cuenta)`, 'Suben a tus álbumes; vos cobrás todo', 'Ventas por fotógrafo para liquidarles',
    `${gb} (ampliable)`, days, `Lugar extra: ${'$'}${Number(p.seatPrice).toLocaleString('es-AR')}/mes`, fee];
  return ['Todo lo de Profesional', 'Tu dominio .com.ar incluido (lo registramos y conectamos nosotros)', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`,
    ...(p.featured ? ['Destacado en el directorio'] : []), 'Estadísticas avanzadas', 'Atención prioritaria', fee];
}
