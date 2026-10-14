// Cálculo de precios. Módulo puro: lo usan el frontend (carrito) y el Worker (checkout).
//
// Packs: el comprador paga siempre la combinación más barata de packs y fotos sueltas.
// Comisión (feePercent sobre el subtotal):
//   absorb -> total = subtotal; la plataforma retiene el % del vendedor.
//   buyer  -> se suma "costo de servicio" = subtotal × %; total = subtotal + costo.

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

export function computeTotals({ count, price, packs, feeMode, feePercent }) {
  const b = bestPrice(count, price, packs);
  const fee = Math.round((b.subtotal * (Number(feePercent) || 0)) / 100);
  const buyer = feeMode === 'buyer';
  return {
    ...b,
    feeMode: buyer ? 'buyer' : 'absorb',
    serviceFee: buyer ? fee : 0,
    platformFee: fee,
    total: b.subtotal + (buyer ? fee : 0),
    sellerNet: b.subtotal - (buyer ? 0 : fee),
  };
}
