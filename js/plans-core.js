// Planes de Quiero Mis Fotos: Gratis, Profesional Lite, Profesional y Profesional Premium.
// Módulo puro: lo usan el sitio, el panel y el Worker. Los valores se editan en Plataforma; acá están los de por defecto.
//   price: abono mensual · first: primer mes (Premium: incluye el dominio) · year: abono anual
//   fee: comisión % · portfolio: fotos · albumPhotos: tope de fotos por álbum · days: días de venta · stats: nivel de estadísticas (1-4)
export const PAID_PLANS = ['lite', 'web', 'webdomain'];

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
