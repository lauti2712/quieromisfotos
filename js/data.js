// Lecturas compartidas (taxonomía de etiquetas, settings).
import { db, doc, getDoc } from './fb.js';

export const DEFAULT_SETTINGS = {
  feePercent: 3,
  retentionDays: 14,
  extensionPlans: [],
  proPrice: 4500,
  webPrice: 9000,
  webDomainPrice: 12000,
  freePortfolioLimit: 12,
  proPortfolioLimit: 200,
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
export const PLANS = {
  free: { label: 'Gratis' },
  pro: { label: 'Portfolio Pro', priceKey: 'proPrice' },
  web: { label: 'Web', priceKey: 'webPrice', web: true },
  webdomain: { label: 'Web + Dominio', priceKey: 'webDomainPrice', web: true, domain: true },
};

// Plan vigente (si venció, vuelve a gratis).
export function planOf(user) {
  const t = user?.proUntil?.toMillis ? user.proUntil.toMillis() : 0;
  return PLANS[user?.plan] && user.plan !== 'free' && t > Date.now() ? user.plan : 'free';
}

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

export function portfolioLimit(user, settings) {
  return isPro(user) ? settings.proPortfolioLimit : settings.freePortfolioLimit;
}

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
