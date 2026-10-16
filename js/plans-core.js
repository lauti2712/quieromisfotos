// Condiciones de cada plan (planes nuevos, settings.plansV2). Módulo puro: lo usan el sitio, el panel y el Worker.
// Todos los valores se editan en Plataforma; acá están los de por defecto.
//   price: abono mensual · first: primer mes (Premium: incluye el dominio) · year: abono anual
//   fee: comisión % · portfolio: fotos · albumPhotos: fotos por álbum · days: días de venta · stats: nivel de estadísticas (1-4)
//   (con los planes nuevos el tope del álbum es por cantidad de fotos: las fotos se comprimen, el peso ya no importa)
export const PAID_PLANS = ['pro', 'lite', 'web', 'webdomain'];

export function planOf(user, now = Date.now()) {
  const t = user?.proUntil?.toMillis?.() ?? user?.proUntil?.getTime?.() ?? 0;
  return PAID_PLANS.includes(user?.plan) && t > now ? user.plan : 'free';
}

export function planSpec(planId, st = {}) {
  const base = st.retentionDays ?? 14;
  switch (planId) {
    case 'lite': return { price: st.litePrice ?? 4900, year: st.liteYearPrice ?? 49000, fee: st.liteFeePercent ?? 5, portfolio: st.litePortfolioLimit ?? 30,
      albumPhotos: st.liteAlbumPhotos ?? 800, days: st.liteRetentionDays ?? base, featured: !!(st.liteFeatured ?? false), stats: 2, profileCustom: true };
    case 'web': return { price: st.webPrice ?? 9900, year: st.webYearPrice ?? 99000, fee: st.webFeePercent ?? 4, portfolio: st.webPortfolioLimit ?? 60,
      albumPhotos: st.webAlbumPhotos ?? 1500, days: st.webRetentionDays ?? 21, featured: !!(st.webFeatured ?? false), stats: 3, profileCustom: true, shortLinks: true, web: true };
    case 'webdomain': return { price: st.webDomainPrice ?? 12900, first: st.webDomainFirstPrice ?? 18000, year: st.webDomainYearPrice ?? 129000,
      fee: st.webDomainFeePercent ?? 3, portfolio: st.webDomainPortfolioLimit ?? 100, albumPhotos: st.webDomainAlbumPhotos ?? 3000, days: st.webDomainRetentionDays ?? 30,
      featured: !!(st.webDomainFeatured ?? true), stats: 4, profileCustom: true, shortLinks: true, web: true, domain: true, priority: true };
    case 'pro': return { price: st.proPrice ?? 4500, fee: st.feePercent ?? 3, portfolio: st.proPortfolioLimit ?? 80, albumPhotos: st.proAlbumPhotos ?? 800,
      days: base, featured: true, stats: 2, profileCustom: true };
    default: return { price: 0, fee: st.freeFeePercent ?? 7, portfolio: st.freePortfolioLimit ?? 12, albumPhotos: st.freeAlbumPhotos ?? 300,
      days: st.freeRetentionDays ?? base, featured: false, stats: 1, albums: 1 };
  }
}

// Lo que rige hoy para un fotógrafo (con los planes nuevos apagados, las reglas anteriores).
export function rulesFor(user, st = {}) {
  const plan = planOf(user);
  if (st.plansV2) return { plan, ...planSpec(plan, st) };
  const paid = plan !== 'free';
  return { plan, fee: st.feePercent ?? 3, portfolio: paid ? (st.proPortfolioLimit ?? 80) : (st.freePortfolioLimit ?? 12),
    days: st.retentionDays ?? 14, featured: paid, stats: 4, profileCustom: true, shortLinks: paid, web: ['web', 'webdomain'].includes(plan),
    domain: plan === 'webdomain', priority: false };
}

// Planes nuevos: tope del álbum en cantidad de fotos (0 = sin tope). El plan Gratis no suma packs comprados.
export function albumPhotoLimit(set, st, user) {
  if (!st?.plansV2) return 0;
  const r = rulesFor(user, st);
  if (!(r.albumPhotos > 0)) return 0;
  return r.albumPhotos + (r.plan === 'free' ? 0 : (set?.extraPhotos || 0));
}

// Esquema anterior (planes nuevos apagados): tope del álbum en bytes, igual para todos (0 = sin límite) + packs comprados.
export function albumLimitBytes(set, st) {
  if (st?.plansV2) return 0;
  const gb = Number(st?.albumLimitGB) || 0;
  return gb > 0 ? gb * 1e9 + (set?.extraBytes || 0) : 0;
}
