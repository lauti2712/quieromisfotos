// Reglas de planes compartidas por el Worker (mismas que js/data.js).
// Las reglas nuevas (Gratis: 1 álbum, tope de GB, comisión mayor) rigen solo con settings.plansV2 = true.
export const GRACE_DAYS = 7;
const PAID = ['pro', 'web', 'webdomain'];

export function planOf(user) {
  const t = user?.proUntil?.getTime?.() || 0;
  return PAID.includes(user?.plan) && t > Date.now() ? user.plan : 'free';
}
export const isFree = user => planOf(user) === 'free';
export const freeLimited = (user, settings) => !!settings?.plansV2 && isFree(user);
export const feePercentFor = (user, settings) => (freeLimited(user, settings) ? (settings?.freeFeePercent ?? 5) : (settings?.feePercent ?? 3));
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
