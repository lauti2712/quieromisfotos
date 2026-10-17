// Reglas de planes del Worker: las mismas de js/plans-core.js (módulo compartido con el sitio).
import { planOf, rulesFor, albumPhotoLimit, teamSeats } from '../../js/plans-core.js';

export { planOf, rulesFor, albumPhotoLimit, teamSeats };
export const GRACE_DAYS = 7;
export const isFree = user => planOf(user) === 'free';
export const feePercentFor = (user, settings) => rulesFor(user, settings).fee;
export const portfolioLimitFor = (user, settings) => rulesFor(user, settings).portfolio;

// Álbum activo: con fotos y originales guardados (en venta o en los días de gracia).
export function setActive(set) {
  if (!set || !(set.photoCount > 0) || set.originalsDeleted) return false;
  const until = Math.max(set.expiresAt?.getTime?.() || 0, set.extendedUntil?.getTime?.() || 0);
  return !until || until + GRACE_DAYS * 86400_000 > Date.now();
}
