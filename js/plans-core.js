// Condiciones de cada plan (planes nuevos, settings.plansV2). Módulo puro: lo usan el sitio, el panel y el Worker.
// Todos los valores se editan en Plataforma; acá están los de por defecto.
//   price: abono mensual · first: primer mes (Premium: incluye el dominio) · year: abono anual
//   fee: comisión % · portfolio: fotos · albumGB: espacio por álbum · days: días de venta · stats: nivel de estadísticas (1-4)
export const PAID_PLANS = ['pro', 'lite', 'web', 'webdomain'];

export function planOf(user, now = Date.now()) {
  const t = user?.proUntil?.toMillis?.() ?? user?.proUntil?.getTime?.() ?? 0;
  return PAID_PLANS.includes(user?.plan) && t > now ? user.plan : 'free';
}

export function planSpec(planId, st = {}) {
  const base = st.retentionDays ?? 14;
  switch (planId) {
    case 'lite': return { price: st.litePrice ?? 4900, year: st.liteYearPrice ?? 49000, fee: st.liteFeePercent ?? 5, portfolio: st.litePortfolioLimit ?? 30,
      albumGB: st.liteAlbumGB ?? 5, days: st.liteRetentionDays ?? base, featured: !!(st.liteFeatured ?? false), stats: 2, profileCustom: true };
    case 'web': return { price: st.webPrice ?? 9900, year: st.webYearPrice ?? 99000, fee: st.webFeePercent ?? 4, portfolio: st.webPortfolioLimit ?? 60,
      albumGB: st.webAlbumGB ?? 10, days: st.webRetentionDays ?? 21, featured: !!(st.webFeatured ?? false), stats: 3, profileCustom: true, shortLinks: true, web: true };
    case 'webdomain': return { price: st.webDomainPrice ?? 12900, first: st.webDomainFirstPrice ?? 18000, year: st.webDomainYearPrice ?? 129000,
      fee: st.webDomainFeePercent ?? 3, portfolio: st.webDomainPortfolioLimit ?? 100, albumGB: st.webDomainAlbumGB ?? 20, days: st.webDomainRetentionDays ?? 30,
      featured: !!(st.webDomainFeatured ?? true), stats: 4, profileCustom: true, shortLinks: true, web: true, domain: true, priority: true };
    case 'pro': return { price: st.proPrice ?? 4500, fee: st.feePercent ?? 3, portfolio: st.proPortfolioLimit ?? 80, albumGB: st.albumLimitGB ?? 0,
      days: base, featured: true, stats: 2, profileCustom: true };
    default: return { price: 0, fee: st.freeFeePercent ?? 7, portfolio: st.freePortfolioLimit ?? 12, albumGB: st.freeAlbumLimitGB ?? 3,
      days: st.freeRetentionDays ?? base, featured: false, stats: 1, albums: 1 };
  }
}

// Lo que rige hoy para un fotógrafo (con los planes nuevos apagados, las reglas anteriores).
export function rulesFor(user, st = {}) {
  const plan = planOf(user);
  if (st.plansV2) return { plan, ...planSpec(plan, st) };
  const paid = plan !== 'free';
  return { plan, fee: st.feePercent ?? 3, portfolio: paid ? (st.proPortfolioLimit ?? 80) : (st.freePortfolioLimit ?? 12),
    albumGB: st.albumLimitGB ?? 0, days: st.retentionDays ?? 14, featured: paid, stats: 4, profileCustom: true, shortLinks: paid, web: ['web', 'webdomain'].includes(plan),
    domain: plan === 'webdomain', priority: false };
}

// Límite de espacio del álbum en bytes (0 = sin límite). El plan Gratis no suma packs comprados.
export function albumLimitBytes(set, st, user) {
  const r = rulesFor(user, st);
  if (!(r.albumGB > 0)) return 0;
  return r.albumGB * 1e9 + (r.plan === 'free' && st?.plansV2 ? 0 : (set?.extraBytes || 0));
}
