import test from 'node:test';
import assert from 'node:assert/strict';
import { protectOf, PROTECT_DEFAULTS } from '../js/protect.js';

test('protectOf: sin configuración usa los valores recomendados', () => {
  assert.deepEqual(protectOf({}), PROTECT_DEFAULTS);
  assert.deepEqual(protectOf(null), PROTECT_DEFAULTS);
});
test('protectOf: valores fuera de rango vuelven al límite y los inválidos al recomendado', () => {
  const c = protectOf({ protect: { previewSide: 5000, thumbQuality: 0.05, previewBlur: 'x', thumbBlur: -3 } });
  assert.equal(c.previewSide, 1200);
  assert.equal(c.thumbQuality, 0.3);
  assert.equal(c.previewBlur, PROTECT_DEFAULTS.previewBlur);
  assert.equal(c.thumbBlur, 0);
});
test('protectOf: el nivel del álbum escala solo el desenfoque', () => {
  const hi = protectOf({}, 'high'), mid = protectOf({}, 'mid'), low = protectOf({}, 'low'), none = protectOf({}, 'x');
  assert.equal(hi.previewBlur, PROTECT_DEFAULTS.previewBlur);
  assert.equal(none.previewBlur, PROTECT_DEFAULTS.previewBlur);
  assert.ok(Math.abs(mid.previewBlur - PROTECT_DEFAULTS.previewBlur * 0.75) < 1e-9);
  assert.ok(Math.abs(low.thumbBlur - PROTECT_DEFAULTS.thumbBlur * 0.5) < 1e-9);
  assert.equal(low.previewSide, PROTECT_DEFAULTS.previewSide);
});
