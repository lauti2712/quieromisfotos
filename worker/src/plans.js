// Reglas de planes del Worker: las mismas de js/plans-core.js (módulo compartido con el sitio).
import { planOf, rulesFor, albumLimitBytes as coreAlbumLimitBytes, albumPhotoLimit } from '../../js/plans-core.js';

export { planOf, rulesFor, albumPhotoLimit };
export const GRACE_DAYS = 7;
export const isFree = user => planOf(user) === 'free';
// Las reglas del plan Gratis (1 álbum, tope sin packs) rigen solo con planes nuevos.
export const freeLimited = (user, settings) => !!settings?.plansV2 && isFree(user);
export const feePercentFor = (user, settings) => rulesFor(user, settings).fee;
export const portfolioLimitFor = (user, settings) => rulesFor(user, settings).portfolio;
export const albumLimitBytes = (set, settings, user) => coreAlbumLimitBytes(set, settings, user);

// Álbum activo: con fotos y originales guardados (en venta o en los días de gracia).
export function setActive(set) {
  if (!set || !(set.photoCount > 0) || set.originalsDeleted) return false;
  const until = Math.max(set.expiresAt?.getTime?.() || 0, set.extendedUntil?.getTime?.() || 0);
  return !until || until + GRACE_DAYS * 86400_000 > Date.now();
}
