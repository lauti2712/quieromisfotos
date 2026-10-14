import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bestPrice, computeTotals } from '../js/pricing.js';

test('sin packs: precio unitario', () => {
  assert.equal(bestPrice(4, 3500).subtotal, 14000);
});
test('elige la combinación más barata', () => {
  const packs = [{ qty: 3, price: 9000 }, { qty: 5, price: 13000 }];
  assert.equal(bestPrice(3, 3500, packs).subtotal, 9000);
  assert.equal(bestPrice(7, 3500, packs).subtotal, 13000 + 7000); // 5 + 2 sueltas = 20000 < 3+3+1 = 21500
  assert.equal(bestPrice(6, 3500, packs).subtotal, 16500);         // 5 + 1 suelta < 3 + 3
});
test('desglose', () => {
  const r = bestPrice(8, 3500, [{ qty: 3, price: 9000 }, { qty: 5, price: 13000 }]);
  assert.equal(r.subtotal, 22000); // 5 + 3
  assert.deepEqual(r.lines.map(l => [l.label, l.times]), [['Pack 5 fotos', 1], ['Pack 3 fotos', 1]]);
});
test('pack más caro que sueltas se ignora', () => {
  assert.equal(bestPrice(3, 1000, [{ qty: 3, price: 5000 }]).subtotal, 3000);
});
test('comisión absorb vs buyer', () => {
  const a = computeTotals({ count: 2, price: 5000, packs: [], feeMode: 'absorb', feePercent: 3 });
  assert.deepEqual([a.total, a.serviceFee, a.platformFee, a.sellerNet], [10000, 0, 300, 9700]);
  const b = computeTotals({ count: 2, price: 5000, packs: [], feeMode: 'buyer', feePercent: 3 });
  assert.deepEqual([b.total, b.serviceFee, b.platformFee, b.sellerNet], [10300, 300, 300, 10000]);
});
