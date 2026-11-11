// Cálculo de precios. Módulo puro: lo usan el frontend (carrito) y el Worker (checkout).
//
// Packs: el comprador paga siempre la combinación más barata de packs y fotos sueltas.
// Fotos con precio propio (photo.price) o marcadas "fuera de packs" (photo.noPack) se cobran aparte, una por una.
// Tasa de servicio = comisión de la plataforma (feePercent sobre el subtotal) + comisión de Mercado Pago (mpPercent sobre
// lo que paga el comprador). El fotógrafo elige quién la paga (feeMode):
//   absorb -> la paga toda el fotógrafo: total = subtotal.
//   half   -> mitad y mitad: se suma al comprador lo justo para que cada uno pague la mitad de la tasa.
//   buyer  -> la paga toda el comprador: al fotógrafo le queda el subtotal completo.
// En transferencias no hay comisión de Mercado Pago (mpPercent = 0): la tasa es solo la de la plataforma.
export const FEE_MODES = ['absorb', 'half', 'buyer'];
export const normFeeMode = m => (FEE_MODES.includes(m) ? m : 'absorb');

// Lo que se le suma al comprador (pesos enteros, redondeando para arriba para que el reparto se cumpla).
export function serviceFeeFor(subtotal, platformFee, feeMode, mpPercent = 0) {
  const S = subtotal, m = Math.min(0.5, Math.max(0, Number(mpPercent) || 0) / 100);
  const mode = normFeeMode(feeMode);
  if (!(S > 0) || mode === 'absorb') return 0;
  // buyer: T − m·T − plataforma = S   →   T = (S + plataforma) / (1 − m)
  if (mode === 'buyer') return Math.max(0, Math.ceil((S + platformFee) / (1 - m)) - S);
  // half: el comprador suma X y el fotógrafo resigna X; la tasa total (plataforma + m·(S+X)) = 2X
  return Math.max(0, Math.ceil((platformFee + m * S) / (2 - m)));
}

export function bestPrice(count, unitPrice, packs = []) {
  const n = Math.max(0, Math.floor(count));
  const unit = Math.max(0, Math.round(Number(unitPrice) || 0));
  const valid = (packs || [])
    .map(p => ({ qty: Math.floor(p.qty), price: Math.round(p.price) }))
    .filter(p => p.qty >= 2 && p.price > 0);

  // dp[k] = costo mínimo para k fotos; choice[k] = pack usado al final (null = foto suelta)
  const dp = new Array(n + 1).fill(Infinity);
  const choice = new Array(n + 1).fill(null);
  dp[0] = 0;
  for (let k = 1; k <= n; k++) {
    if (dp[k - 1] + unit < dp[k]) { dp[k] = dp[k - 1] + unit; choice[k] = null; }
    for (const p of valid) {
      if (p.qty <= k && dp[k - p.qty] + p.price < dp[k]) { dp[k] = dp[k - p.qty] + p.price; choice[k] = p; }
    }
  }

  // Reconstrucción del desglose
  const used = new Map();
  let singles = 0;
  for (let k = n; k > 0;) {
    const c = choice[k];
    if (c) { used.set(c.qty, { ...c, times: (used.get(c.qty)?.times || 0) + 1 }); k -= c.qty; }
    else { singles++; k--; }
  }
  const lines = [...used.values()].sort((a, b) => b.qty - a.qty)
    .map(p => ({ label: `Pack ${p.qty} fotos`, times: p.times, amount: p.price * p.times }));
  if (singles) lines.push({ label: 'Foto suelta', times: singles, amount: singles * unit });

  const subtotal = dp[n] === Infinity ? 0 : dp[n];
  return { count: n, subtotal, lines, savings: Math.max(0, n * unit - subtotal) };
}

// Separa las fotos del carrito: las que entran en packs (count) y los precios de las que se cobran aparte (solo).
export function splitPhotos(photos, unitPrice) {
  const unit = Math.max(0, Math.round(Number(unitPrice) || 0));
  const solo = [];
  let count = 0;
  for (const p of photos || []) {
    if (p?.price > 0) solo.push(Math.round(p.price));
    else if (p?.noPack) solo.push(unit);
    else count++;
  }
  return { count, solo };
}

export function computeTotals({ count, price, packs, feeMode, feePercent, mpPercent = 0, solo = [] }) {
  const base = bestPrice(count, price, packs);
  const unit = Math.max(0, Math.round(Number(price) || 0));
  const extra = new Map();
  for (const a of solo) extra.set(a, (extra.get(a) || 0) + 1);
  const soloLines = [...extra].sort((x, y) => y[0] - x[0])
    .map(([a, times]) => ({ label: a === unit ? 'Foto fuera de pack' : `Foto especial ($${a.toLocaleString('es-AR')} c/u)`, times, amount: a * times }));
  const soloSum = solo.reduce((x, a) => x + a, 0);
  const b = { ...base, count: base.count + solo.length, subtotal: base.subtotal + soloSum, lines: [...base.lines, ...soloLines] };
  const fee = Math.round((b.subtotal * (Number(feePercent) || 0)) / 100);
  const mode = normFeeMode(feeMode);
  const serviceFee = serviceFeeFor(b.subtotal, fee, mode, mpPercent);
  return {
    ...b,
    feeMode: mode,
    serviceFee,
    platformFee: fee,
    total: b.subtotal + serviceFee,
    sellerNet: b.subtotal + serviceFee - fee, // antes de la comisión de Mercado Pago
  };
}

// Lo que le queda al fotógrafo de un subtotal, descontando la comisión de la plataforma
// y la de Mercado Pago (que MP cobra sobre el total que paga el comprador).
export function sellerNet(subtotal, { feeMode, feePercent, mpPercent = 0 }) {
  const platformFee = Math.round((subtotal * (Number(feePercent) || 0)) / 100);
  const total = subtotal + serviceFeeFor(subtotal, platformFee, feeMode, mpPercent);
  const mpFee = Math.round((total * (Number(mpPercent) || 0)) / 100);
  return { total, platformFee, mpFee, net: total - platformFee - mpFee };
}
