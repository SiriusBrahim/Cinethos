import test from 'node:test';
import assert from 'node:assert/strict';

import {
  asExternalRecord,
  isPlainRecord,
  readFiniteNumber,
  readPositiveInteger,
  readPositiveIntegerArray,
  readString,
} from '../src/server/external-json.ts';

test('dış yük nesne olmayan değerlerde reddedilir, düz nesnede kabul edilir', () => {
  assert.equal(asExternalRecord(null), null);
  assert.equal(asExternalRecord(undefined), null);
  assert.equal(asExternalRecord('metin'), null);
  assert.equal(asExternalRecord(42), null);
  assert.equal(asExternalRecord([{ id: 1 }]), null, 'dizi düz nesne değildir');
  assert.deepEqual(asExternalRecord({ id: 1 }), { id: 1 });

  assert.equal(isPlainRecord({}), true);
  assert.equal(isPlainRecord([]), false);
  assert.equal(isPlainRecord(new Date()), true, 'nesne prototipli değerler düz nesnedir');
});

test('metin alanları kırpılır, boşlar ve yanlış tipler elenir', () => {
  assert.equal(readString('  Kedi  '), 'Kedi');
  assert.equal(readString('   '), undefined);
  assert.equal(readString(12), undefined);
  assert.equal(readString(null), undefined);
  assert.equal(readString('abcdef', 3), 'abc', 'uzunluk sınırı uygulanır');
});

test('sayı alanları güvenli aralıkta daraltılır', () => {
  assert.equal(readPositiveInteger('42'), 42);
  assert.equal(readPositiveInteger(0), undefined);
  assert.equal(readPositiveInteger(-3), undefined);
  assert.equal(readPositiveInteger(1.5), undefined);
  assert.equal(readPositiveInteger('abc'), undefined);

  assert.equal(readFiniteNumber('8.7'), 8.7);
  assert.equal(readFiniteNumber(0), 0);
  assert.equal(readFiniteNumber('Infinity'), undefined);
  assert.equal(readFiniteNumber(undefined), undefined);
});

test('tam sayı dizileri yalnızca geçerli kimlikleri korur', () => {
  assert.deepEqual(readPositiveIntegerArray([28, '12', 0, -1, 1.5, null, 16]), [28, 12, 16]);
  assert.equal(readPositiveIntegerArray('28'), undefined);
  assert.deepEqual(readPositiveIntegerArray([]), []);
});
