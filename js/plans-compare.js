// Comparativa de planes (tabla en la compu, tarjetas deslizables en el celular, mensual/anual).
// Módulo puro (sin Firebase ni DOM): lo usan el panel (Planes y mi web), el sitio (#/soy-fotografo)
// y tools/build-seo.py (la /soy-fotografo/ estática, vía node). Precios y condiciones: los de Plataforma.
import { planSpec, BIB_FEE_PERCENT } from './plans-core.js';

export const PLAN_IDS = ['free', 'lite', 'web', 'webdomain', 'empresa'];
export const PLAN_LABELS = { free: 'Gratis', lite: 'Profesional Lite', web: 'Profesional', webdomain: 'Profesional Premium', empresa: 'Empresas' };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => '$' + Math.round(Number(n) || 0).toLocaleString('es-AR').replace(/,/g, '.');

// Filas: [característica, valor por plan]. true = ✓, false/'' = no incluido, texto = valor.
export function planRows(st) {
  const sp = Object.fromEntries(PLAN_IDS.map(id => [id, planSpec(id, st)]));
  const pct = n => `${String(n).replace('.', ',')}%`;
  const now = new Date().toISOString().slice(0, 10);
  const fee = id => { const p = sp[id]; return p.promoUntil && p.promoUntil >= now ? `${pct(p.fee)} <span class="muted small">(${pct(p.baseFee)} desde el ${p.promoUntil.slice(8, 10)}/${p.promoUntil.slice(5, 7)})</span>` : pct(p.fee); };
  const v = f => Object.fromEntries(PLAN_IDS.map(id => [id, f(id, sp[id])]));
  const paid = id => id !== 'free';
  const webs = id => ['web', 'webdomain', 'empresa'].includes(id);
  const top = id => ['webdomain', 'empresa'].includes(id);
  const bib = Number(st?.bibFeePercent ?? BIB_FEE_PERCENT) || 0;
  return [
    ['Comisión por venta*', v(id => fee(id))],
    ['Álbumes', v(id => (paid(id) ? 'Ilimitados' : '1 a la vez'))],
    ['Fotos por álbum', v((id, p) => `${Number(p.albumPhotos).toLocaleString('es-AR')}${paid(id) ? ' <span class="muted small">(ampliable)</span>' : ''}`)],
    ['Días de venta por álbum', v((id, p) => `${p.days} días`)],
    ['Elegís quién paga la tasa de servicio', v(() => true)],
    ['Marca de agua y protección de tus fotos', v(() => true)],
    ['Publicación programada', v(() => true)],
    ['Lectura de dorsales con IA', v(() => (bib ? `+${pct(bib)} <span class="muted small">solo si la usás</span>` : true))],
    ['Cobro por transferencia (sin comisión de MP)', v(id => (st?.transfer?.plans || []).includes(id))],
    ['Fotos en tu portfolio', v((id, p) => String(p.portfolio))],
    ['Foto de portada en tu perfil', v(id => paid(id))],
    ['Estadísticas', v(id => ({ free: 'Básicas', lite: 'Por evento', web: 'Completas' }[id] || 'Avanzadas'))],
    ['Tu web (tunombre.quieromisfotos.com.ar)', v(id => webs(id))],
    ['Fotos de tu web sin marca de agua', v(id => webs(id))],
    ['Links cortos para tus álbumes', v(id => webs(id))],
    ['Tu dominio .com.ar incluido', v(id => top(id))],
    ['Destacado en el directorio', v((id, p) => !!p.featured)],
    ['Atención prioritaria', v(id => top(id))],
    ['Equipo de fotógrafos (cada uno con su cuenta)', v((id, p) => (id === 'empresa' ? `${p.team} fotógrafos` : false))],
  ];
}
const cell = x => (x === true ? '<span class="pc-yes" aria-label="Incluido">✓</span>' : x ? x : '<span class="pc-no" aria-label="No incluido">—</span>');

// cta(id): HTML del botón de cada plan. current: plan actual del fotógrafo (en el panel).
export function plansCompareHtml(st, { current = '', cta = () => '' } = {}) {
  const rows = planRows(st);
  const head = id => {
    const p = planSpec(id, st);
    const first = ['webdomain', 'empresa'].includes(id) && p.first > p.price ? p.first : 0;
    return `<div class="pc-name">${esc(PLAN_LABELS[id])}${id === 'web' ? ' <span class="pill accent pc-rec">Recomendado</span>' : ''}</div>
      <div class="pc-price">${id === 'free' ? '<span>Gratis</span>' : `<span class="pc-m">${money(p.price)}<small>/mes</small></span><span class="pc-y">${p.year ? `${money(p.year)}<small>/año</small>` : `${money(p.price)}<small>/mes</small>`}</span>`}</div>
      ${first ? `<div class="muted small">Primer mes ${money(first)} (incluye el dominio)</div>` : ''}
      <div class="pc-cta">${cta(id)}</div>`;
  };
  const cls = id => `${id === current ? 'pc-cur' : ''} ${id === 'web' ? 'pc-hl' : ''}`;
  return `<div class="plans-wrap" data-period="month">
    <div class="table-wrap pc-table-wrap"><table class="plan-compare">
      <thead><tr><th></th>${PLAN_IDS.map(id => `<th class="${cls(id)}">${head(id)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map(([label, vals]) => `<tr><th scope="row">${label}</th>${PLAN_IDS.map(id => `<td class="${cls(id)}">${cell(vals[id])}</td>`).join('')}</tr>`).join('')}</tbody>
    </table></div>
    <div class="pc-cards">${PLAN_IDS.map(id => `<div class="pc-card ${cls(id)}">${head(id)}
      <ul>${rows.filter(([, vals]) => vals[id]).map(([label, vals]) => `<li>${vals[id] === true ? `✓ ${label.replace('*', '')}` : `<span class="muted small">${label.replace('*', '')}:</span> ${vals[id]}`}</li>`).join('')}</ul></div>`).join('')}</div>
  </div>`;
}

// Botones Mensual / Anual (data-period) que cambian el precio que se muestra.
export const periodToggleHtml = () => `<div class="plan-period" role="group" aria-label="Forma de pago">
      <button type="button" class="chip on" data-period="month">Mensual</button>
      <button type="button" class="chip" data-period="year">Anual <span class="muted small">· 2 meses gratis</span></button>
    </div>`;
