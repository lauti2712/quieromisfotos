// Recordatorios y pausa de fotógrafos sin álbum (worker/src/onboarding.js): qué paso le toca a cada cuenta según los días.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nudgeStep, isOnboardingTick } from '../worker/src/onboarding.js';

const DAY = 86400_000;
const now = Date.UTC(2026, 10, 24, 13, 0);
const ago = d => now - d * DAY;

test('recién registrado: nada', () => {
  assert.equal(nudgeStep(ago(0.5), {}, now), null);
});

test('día 1 y día 3: recordatorios, una sola vez cada uno', () => {
  assert.equal(nudgeStep(ago(1), {}, now), 'r1');
  assert.equal(nudgeStep(ago(2), { r1: ago(1) }, now), null);
  assert.equal(nudgeStep(ago(3), { r1: ago(2) }, now), 'r2');
  assert.equal(nudgeStep(ago(5), { r1: ago(4), r2: ago(2) }, now), null);
});

test('si se saltea el día 1 (cuenta de 4 días), va directo al segundo', () => {
  assert.equal(nudgeStep(ago(4), {}, now), 'r2');
});

test('día 10: aviso de pausa (también a cuentas viejas que nunca recibieron nada)', () => {
  assert.equal(nudgeStep(ago(10), { r1: ago(9), r2: ago(7) }, now), 'warn');
  assert.equal(nudgeStep(ago(60), {}, now), 'warn');
});

test('nunca se pausa sin aviso previo de al menos 4 días', () => {
  assert.equal(nudgeStep(ago(14), { warn: ago(4) }, now), 'suspend');
  assert.equal(nudgeStep(ago(14), { warn: ago(3) }, now), null);
  assert.equal(nudgeStep(ago(60), { warn: ago(1) }, now), null);
  assert.equal(nudgeStep(ago(60), { warn: ago(5) }, now), 'suspend');
});

test('reactivada: el plazo arranca de nuevo desde la reactivación', () => {
  // El Worker pasa max(registro, reactivación) y borra los avisos anteriores.
  assert.equal(nudgeStep(Math.max(ago(90), ago(0.2)), {}, now), null);
});

test('sin fecha de registro: nada', () => {
  assert.equal(nudgeStep(0, {}, now), null);
});

test('el cron corre una vez por día, a las 10 de Argentina', () => {
  assert.equal(isOnboardingTick(Date.UTC(2026, 10, 24, 13, 0)), true);
  assert.equal(isOnboardingTick(Date.UTC(2026, 10, 24, 13, 5)), false);
  assert.equal(isOnboardingTick(Date.UTC(2026, 10, 24, 12, 0)), false);
});
