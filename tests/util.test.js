import { test } from 'node:test';
import assert from 'node:assert/strict';

// util.js usa solo APIs del navegador dentro de funciones, se puede importar en Node.
const { waNumber } = await import('../js/util.js');

test('waNumber normaliza números argentinos', () => {
  assert.equal(waNumber('341 555-1234'), '5493415551234');
  assert.equal(waNumber('0341 15 555-1234'), '5493415551234');
  assert.equal(waNumber('+54 9 341 555 1234'), '5493415551234');
  assert.equal(waNumber('54 341 5551234'), '5493415551234');
  assert.equal(waNumber('11 2345-6789'), '5491123456789');
  assert.equal(waNumber('011 15 2345-6789'), '5491123456789');
});
