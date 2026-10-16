// Lecturas compartidas (taxonomía de etiquetas, settings).
import { db, doc, getDoc } from './fb.js';
import { planOf as corePlanOf, planSpec as corePlanSpec, rulesFor, albumPhotoLimit } from './plans-core.js';
export { albumPhotoLimit };
export { rulesFor };

// Las condiciones de cada plan (precios, comisiones, topes) están en js/plans-core.js con sus valores por defecto.
export const DEFAULT_SETTINGS = {
  retentionDays: 14,
  extensionPlans: [],
  // Recomprimir los originales al subir (JPEG 92%, misma resolución). Lo decide el superadmin.
  optimizeOriginals: true,
  // Mostrar "Fotógrafos" (directorio) en el menú del sitio.
  showDirectory: false,
  storagePlans: [], // packs de fotos extra para un álbum (planes pagos)
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
// Planes: Gratis · Profesional Lite · Profesional (id 'web') · Profesional Premium (id 'webdomain'). Condiciones: js/plans-core.js.
export const PLANS = {
  free: { label: 'Gratis' },
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
export const isFreePlan = user => planOf(user) === 'free';

export const feePercentFor = (user, settings) => rulesFor(user, settings).fee;

// Álbum activo: tiene fotos y todavía guarda los originales (en venta o en los días de gracia).
export const setActive = set => !!set && (set.photoCount || 0) > 0 && !set.originalsDeleted && (!setDeleteAt(set) || setDeleteAt(set) > Date.now());

// Qué incluye cada plan (planes nuevos): mismo texto en "Soy fotógrafo" y en el panel.
export function planFeatures(id, st) {
  const p = planSpec(id, st);
  const fee = `Comisión ${String(p.fee).replace('.', ',')}% por venta`;
  const gb = `${p.albumPhotos.toLocaleString('es-AR')} fotos por álbum`;
  const days = `Cada álbum se vende ${p.days} días`;
  if (id === 'free') return ['Vendé tus fotos en eventos', '1 álbum activo a la vez', `Hasta ${gb}`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas básicas', fee];
  if (id === 'lite') return ['Álbumes ilimitados', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Estadísticas por evento', 'Foto de portada en tu perfil',
    ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  if (id === 'web') return ['Todo lo de Lite', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`, 'Tu web: tunombre.quieromisfotos.com.ar',
    'Fotos de tu web sin marca de agua', 'Links cortos para tus eventos', 'Estadísticas completas', ...(p.featured ? ['Destacado en el directorio'] : []), fee];
  return ['Todo lo de Profesional', 'Tu propio dominio (tunombre.com.ar)', `${gb} (ampliable)`, days, `Portfolio de ${p.portfolio} fotos`,
    ...(p.featured ? ['Destacado en el directorio'] : []), 'Estadísticas avanzadas', 'Atención prioritaria', fee];
}

// Dorsales: se leen solos en carreras (running, ciclismo, triatlón…). El fotógrafo lo puede cambiar en su álbum.
const ENDURANCE = /run|marat|carrera|calle|ciclis|bici|mtb|rural|triat|duat|trail|aventura|aguas abiertas|nataci|cross/i;
export function bibsDefault(ev, tax) {
  return (ev?.tagIds || []).some(id => ENDURANCE.test((tax?.tags || []).find(t => t.id === id)?.name || id));
}
export const bibsOn = (set, ev, tax) => set?.detectBibs ?? bibsDefault(ev, tax);
