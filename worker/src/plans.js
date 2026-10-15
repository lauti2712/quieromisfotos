// Reglas de planes compartidas por el Worker (mismas que js/data.js).
// Las reglas nuevas (Gratis: 1 álbum, tope de GB, comisión mayor) rigen solo con settings.plansV2 = true.
export const GRACE_DAYS = 7;
const PAID = ['pro', 'lite', 'web', 'webdomain'];

export function planOf(user) {
  const t = user?.proUntil?.getTime?.() || 0;
  return PAID.includes(user?.plan) && t > Date.now() ? user.plan : 'free';
}
export const isFree = user => planOf(user) === 'free';
export const freeLimited = (user, settings) => !!settings?.plansV2 && isFree(user);
// Comisión por plan con los planes nuevos (mismos valores por defecto que planSpec en js/data.js).
const FEE = { free: ['freeFeePercent', 5], lite: ['liteFeePercent', 4], web: ['webFeePercent', 4], webdomain: ['webDomainFeePercent', 3], pro: ['feePercent', 3] };
export function feePercentFor(user, settings) {
  if (!settings?.plansV2) return settings?.feePercent ?? 3;
  const [key, def] = FEE[planOf(user)];
  return settings?.[key] ?? def;
}
const PORTFOLIO = { free: ['freePortfolioLimit', 12], lite: ['litePortfolioLimit', 20], web: ['webPortfolioLimit', 40], webdomain: ['webDomainPortfolioLimit', 80], pro: ['proPortfolioLimit', 80] };
export function portfolioLimitFor(user, settings) {
  if (!settings?.plansV2) return settings?.proPortfolioLimit || 80;
  const [key, def] = PORTFOLIO[planOf(user)];
  return settings?.[key] ?? def;
}
export function albumLimitBytes(set, settings, user) {
  if (freeLimited(user, settings)) return (Number(settings?.freeAlbumLimitGB) || 3) * 1e9;
  const gb = Number(settings?.albumLimitGB) || 0;
  return gb > 0 ? gb * 1e9 + (set?.extraBytes || 0) : 0;
}
// Mismo criterio que setActive del frontend.
export function setActive(set) {
  if (!set || !(set.photoCount > 0) || set.originalsDeleted) return false;
  const until = Math.max(set.expiresAt?.getTime?.() || 0, set.extendedUntil?.getTime?.() || 0);
  return !until || until + GRACE_DAYS * 86400_000 > Date.now();
}
