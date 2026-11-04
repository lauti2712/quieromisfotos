// Localidades reales de Argentina (lista oficial Georef, assets/data/localidades.json; la arma tools/localidades.py).
// placeInput(input) convierte un campo de texto en un buscador: hay que elegir una de la lista ("Rosario, Santa Fe").
// isPlace(texto) dice si el texto es una localidad de la lista.
let list = null, loading = null;

const norm = t => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

export function loadPlaces() {
  loading ||= fetch(new URL('../assets/data/localidades.json', import.meta.url))
    .then(r => r.json())
    .then(({ p, l }) => (list = l.map(([n, i]) => { const label = `${n}, ${p[i]}`; return { label, key: norm(label), name: norm(n) }; })))
    .catch(e => { loading = null; throw e; });
  return loading;
}

export async function isPlace(text) {
  await loadPlaces();
  const k = norm(text);
  return !!k && list.some(x => x.key === k);
}

// La forma exacta de la lista (con tildes y mayúsculas) para un texto que coincide, o ''.
export async function canonicalPlace(text) {
  await loadPlaces();
  const k = norm(text);
  return list.find(x => x.key === k)?.label || '';
}

// Texto viejo escrito a mano ("Rosario, Funes y Roldán"): las que se reconocen sin dudas (un solo nombre en todo el país,
// o el que coincide con la provincia de su localidad).
export async function guessPlaces(text, prov = '') {
  await loadPlaces();
  const out = [];
  for (const t of String(text || '').split(/,| y |\/|;|·/)) {
    const k = norm(t);
    if (k.length < 3) continue;
    const exact = list.find(x => x.key === k);
    const same = exact ? [exact] : list.filter(x => x.name === k);
    const pick = same.length === 1 ? same[0] : same.find(x => prov && x.key.endsWith(', ' + norm(prov)));
    if (pick && !out.includes(pick.label)) out.push(pick.label);
  }
  return out;
}

// Varias localidades como etiquetas: input de búsqueda + lista. get() devuelve las elegidas.
export function multiPlaceInput(input, chipsBox, initial = [], { max = 12, onChange } = {}) {
  let items = [...initial];
  const draw = () => {
    chipsBox.innerHTML = items.map((x, i) => `<span class="chip on">${x.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))} <button type="button" data-rm="${i}" aria-label="Quitar" style="border:0;background:none;color:inherit;cursor:pointer;padding:0 0 0 4px">✕</button></span>`).join('');
    chipsBox.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { items.splice(+b.dataset.rm, 1); draw(); onChange?.(items); });
    input.disabled = items.length >= max;
    input.placeholder = items.length >= max ? `Hasta ${max} localidades` : 'Sumá una localidad: empezá a escribir y elegí de la lista';
  };
  placeInput(input);
  input.addEventListener('change', async () => {
    const c = await canonicalPlace(input.value);
    if (!c) return;
    if (!items.includes(c) && items.length < max) items.push(c);
    input.value = ''; input.setCustomValidity('');
    draw(); onChange?.(items);
  });
  draw();
  return { get: () => [...items] };
}

function search(q, max = 8) {
  const k = norm(q);
  if (k.length < 2) return [];
  // Primero las que empiezan con lo escrito, después las que lo contienen. Permite "rosario santa fe" o "rosario, sf".
  const words = k.split(/[ ,]+/).filter(Boolean);
  const starts = [], contains = [];
  for (const x of list) {
    if (!words.every(w => x.key.includes(w))) continue;
    (x.name.startsWith(words[0]) ? starts : contains).push(x);
    if (starts.length >= max) break;
  }
  const byLen = (a, b) => a.label.length - b.label.length;
  return [...starts.sort(byLen), ...contains.sort(byLen)].slice(0, max);
}

export function placeInput(input) {
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  const wrap = document.createElement('div');
  wrap.className = 'place-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const ul = document.createElement('ul');
  ul.className = 'place-list';
  ul.setAttribute('role', 'listbox');
  ul.hidden = true;
  wrap.appendChild(ul);
  let items = [], active = -1;

  const close = () => { ul.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const pick = label => { input.value = label; input.setCustomValidity(''); close(); input.dispatchEvent(new Event('change', { bubbles: true })); };
  const draw = () => {
    ul.innerHTML = items.length
      ? items.map((x, i) => `<li role="option" data-i="${i}" class="${i === active ? 'on' : ''}">${x.label.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</li>`).join('')
      : '<li class="none">No encontramos esa localidad. Probá escribirla de otra forma.</li>';
    ul.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  };
  input.addEventListener('input', async () => {
    input.setCustomValidity('');
    await loadPlaces().catch(() => null);
    if (!list) return;
    items = search(input.value);
    active = -1;
    if (norm(input.value).length < 2) return close();
    draw();
  });
  input.addEventListener('keydown', e => {
    if (ul.hidden || !items.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % items.length; draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + items.length) % items.length; draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(items[Math.max(0, active)].label); }
    else if (e.key === 'Escape') close();
  });
  // mousedown (antes del blur) para que el toque en la lista no se pierda.
  ul.addEventListener('mousedown', e => {
    const li = e.target.closest('li[data-i]');
    if (li) { e.preventDefault(); pick(items[+li.dataset.i].label); }
  });
  input.addEventListener('blur', async () => {
    close();
    if (!input.value.trim()) return;
    const c = await canonicalPlace(input.value).catch(() => '');
    if (c) input.value = c;
    else input.setCustomValidity('Elegí una localidad de la lista.');
  });
  loadPlaces().catch(() => {});
}
