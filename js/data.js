// Lecturas compartidas (taxonomía de etiquetas, settings).
import { db, doc, getDoc } from './fb.js';
import { planOf as corePlanOf, planSpec as corePlanSpec, rulesFor, albumLimitBytes } from './plans-core.js';
export { rulesFor };

export const DEFAULT_SETTINGS = {
  feePercent: 3,       // comisión de los planes pagos
  freeFeePercent: 7,   // comisión del plan Gratis (planes nuevos)
  freeAlbumLimitGB: 3, // tope de espacio por álbum en el plan Gratis (sin packs)
  freeActiveAlbums: 1, // álbumes activos a la vez en el plan Gratis
  retentionDays: 14,
  extensionPlans: [],
  // Límite de espacio por álbum en GB (0 = sin límite) y packs de espacio adicional que compra el fotógrafo.
  albumLimitGB: 0,
  // Recomprimir los originales al subir (JPEG 92%, misma resolución). Lo decide el superadmin.
  optimizeOriginals: true,
  // Mostrar "Fotógrafos" (directorio) en el menú del sitio.
  showDirectory: false,
  storagePlans: [],
  proPrice: 4500,
  webPrice: 9000,
  webDomainPrice: 12000,
  freePortfolioLimit: 12,
  proPortfolioLimit: 80,
  // Comisión de Mercado Pago por plazo de acreditación (tarjeta de crédito, IVA incluido). Editable por el superadmin.
  mpFeePlans: [
    { id: '0', label: 'Al instante', percent: 7.85 },
    { id: '10', label: 'A 10 días', percent: 5.19 },
    { id: '18', label: 'A 18 días', percent: 4.10 },
    { id: '35', label: 'A 35 días', percent: 2.17 },
    { id: '70', label: 'A 70 días', percent: 0 },
  ],
};

// Plan de acreditación de MP elegido por el fotógrafo (por defecto, al instante).
export function mpPlanOf(user, settings) {
  const plans = settings.mpFeePlans?.length ? settings.mpFeePlans : DEFAULT_SETTINGS.mpFeePlans;
  return plans.find(p => p.id === user?.mpReleasePlan) || plans[0];
}

// Equipo del fotógrafo (sección "Cámaras" del perfil).
export const GEAR_TYPES = ['Cámara', 'Lente', 'Drone', 'Flash / iluminación', 'Otro'];
export const GEAR_PLURAL = { 'Cámara': 'Cámaras', 'Lente': 'Lentes', 'Drone': 'Drones', 'Flash / iluminación': 'Flash / iluminación', 'Otro': 'Otros' };

export const SERVICES = ['Deportes', 'Eventos sociales', 'Retratos / books', 'Institucional', 'Producto', 'Video'];

// Planes pagos. `proUntil` es la fecha hasta la que está pago el plan (cualquiera de los pagos).
// Desde oct-2026: Gratis (1 álbum activo, tope de GB, comisión mayor) · Profesional (id 'web') · Profesional + Dominio.
// 'pro' (Portfolio Pro) queda solo por compatibilidad con planes dados antes: no se ofrece.
export const PLANS = {
  free: { label: 'Gratis' },
  pro: { label: 'Portfolio Pro (anterior)', priceKey: 'proPrice', legacy: true },
  lite: { label: 'Profesional Lite', priceKey: 'litePrice' },
  web: { label: 'Profesional', priceKey: 'webPrice', web: true },
  webdomain: { label: 'Profesional Premium', priceKey: 'webDomainPrice', web: true, domain: true },
};

// Plan vigente (si venció, vuelve a gratis).
export const planOf = user => corePlanOf(user);

// Pro, Web y Web + Dominio incluyen todo lo de Pro (más fotos, destacado).
export function isPro(user) {
  return planOf(user) !== 'free';
}

export function hasWeb(user) {
  return !!PLANS[planOf(user)].web;
}

// Dirección de la web personal: {slug}.quieromisfotos.com.ar (o su dominio propio, si está activado).
export const WEB_SUBDOMAINS_READY = true;
export function siteUrlOf(user) {
  if (!user?.slug) return '';
  if (user.domainActive && user.siteDomain) return `https://${user.siteDomain}`;
  return WEB_SUBDOMAINS_READY ? `https://${user.slug}.quieromisfotos.com.ar` : `https://qmf-api.solucionescotidianas.com.ar/w/${user.slug}`;
}

// Condiciones de cada plan (planes nuevos): ver js/plans-core.js.
export const planSpec = corePlanSpec;

export const portfolioLimit = (user, settings) => rulesFor(user, settings).portfolio;

// Destacado en el directorio (con los planes nuevos depende del plan).
export const isFeatured = (user, settings) => rulesFor(user, settings).featured;

// Tipos de etiqueta iniciales (ids fijos). "deporte" se muestra como "Actividad".
export const INITIAL_TAG_TYPES = [{ id: 'deporte', name: 'Actividad' }, { id: 'club', name: 'Club' }, { id: 'lugar', name: 'Lugar' }];
export const ACTIVITY_TYPE = 'deporte';
// Tipos en los que los fotógrafos pueden agregar etiquetas nuevas (el Worker valida lo mismo).
export const USER_TAG_TYPES = ['deporte', 'club', 'lugar'];

let taxonomyPromise = null;

// settings/tags es un snapshot desnormalizado de tagTypes + tags (1 sola lectura).
// Lo regenera el superadmin cada vez que edita etiquetas.
export function loadTaxonomy(force = false) {
  if (!taxonomyPromise || force) {
    taxonomyPromise = getDoc(doc(db, 'settings', 'tags')).then(snap => {
      const d = snap.exists() ? snap.data() : {};
      const types = (d.types || []).slice().sort((a, b) => a.order - b.order);
      const tags = (d.tags || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'es'));
      const tagById = new Map(tags.map(t => [t.id, t]));
      return { types, tags, tagById };
    }).catch(() => ({ types: [], tags: [], tagById: new Map() }));
  }
  return taxonomyPromise;
}

export async function loadSettings() {
  try {
    const snap = await getDoc(doc(db, 'settings', 'platform'));
    return { ...DEFAULT_SETTINGS, ...(snap.exists() ? snap.data() : {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function tagPills(tagIds, taxonomy, max = 99) {
  return (tagIds || []).map(id => taxonomy.tagById.get(id)).filter(Boolean).slice(0, max);
}

// ---------- retención de originales
// Se venden hasta expiresAt (primera subida + retentionDays) o extendedUntil si pagó una extensión.
// Después quedan GRACE_DAYS más (para que descarguen las compras de último momento y para extender) y se borran.
export const GRACE_DAYS = 7;
const ms = t => t?.toMillis?.() || (t instanceof Date ? t.getTime() : 0);
export const setUntil = set => Math.max(ms(set?.expiresAt), ms(set?.extendedUntil)) || 0;
export const setDeleteAt = set => (setUntil(set) ? setUntil(set) + GRACE_DAYS * 86400000 : 0);
export const setForSale = set => !!set && set.price > 0 && !set.originalsDeleted && (!setUntil(set) || setUntil(set) > Date.now());

// Límite de espacio del álbum en bytes (0 = sin límite): el general + lo que compró el fotógrafo.
// Plan Gratis: tope fijo (freeAlbumLimitGB), sin packs. Planes pagos: albumLimitGB + lo comprado (0 = sin límite).
// Las reglas nuevas del plan Gratis rigen solo con settings.plansV2 (interruptor en Plataforma).
export const freeLimited = (user, settings) => !!settings?.plansV2 && planOf(user) === 'free';
export const albumLimit = (set, settings, user) => albumLimitBytes(set, settings, user);

// Comisión de la plataforma según el plan del fotógrafo.
export const feePercentFor = (user, settings) => rulesFor(user, settings).fee;

// Álbum activo: tiene fotos y todavía guarda los originales (en venta o en los días de gracia).
export const setActive = set => !!set && (set.photoCount || 0) > 0 && !set.originalsDeleted && (!setDeleteAt(set) || setDeleteAt(set) > Date.now());

// Qué incluye cada plan (planes nuevos): mismo texto en "Soy fotógrafo" y en el panel.
export function planFeatures(id, st) {
  const p = planSpec(id, st);
  const fee = `Comisión ${String(p.fee).replace('.', ',')}% por venta`;
  const gb = `${String(p.albumGB).replace('.', ',')} GB por álbum`;
  const days = `Cada álbum se vende ${p.days} días`;
  if (id === 'free') return ['Vendé tus fotos en eventos', '1 álbum activo a la vez', `Hasta ${gb}`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas básicas', fee];
  if (id === 'lite') return ['Álbumes ilimitados', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas por evento', 'Portada y color en tu perfil',
    ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  if (id === 'web') return ['Todo lo de Lite', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Tu web: tunombre.quieromisfotos.com.ar',
    'Fotos de tu web sin marca de agua', 'Links cortos para tus eventos', 'Estadísticas completas', ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  return ['Todo lo de Profesional', 'Tu propio dominio (tunombre.com.ar)', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`,
    ...(p.featured ? ['Destacado en el directorio'] : []), 'Estadísticas avanzadas', 'Atención prioritaria', fee];
}
