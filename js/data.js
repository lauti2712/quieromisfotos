// Lecturas compartidas (taxonomía de etiquetas, settings).
import { db, doc, getDoc } from './fb.js';

export const DEFAULT_SETTINGS = {
  feePercent: 3,
  retentionDays: 14,
  extensionPlans: [],
  proPrice: 3000,
  freePortfolioLimit: 12,
  proPortfolioLimit: 200,
};

export const SERVICES = ['Deportes', 'Eventos sociales', 'Retratos / books', 'Institucional', 'Producto', 'Video'];

export function isPro(user) {
  const t = user?.proUntil?.toMillis ? user.proUntil.toMillis() : 0;
  return user?.plan === 'pro' && t > Date.now();
}

export function portfolioLimit(user, settings) {
  return isPro(user) ? settings.proPortfolioLimit : settings.freePortfolioLimit;
}

export const INITIAL_TAG_TYPES = ['Deporte', 'Club', 'Categoría', 'Lugar'];

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
