/**
 * F5.3-08 — Stok havuzu sayaçları.
 *
 * `App.tsx` içinde iki kez kopyalanan stok/TVDB sayımı `src/app/stock-stats.ts`
 * modülüne taşındı. Bu testler gerçek üretim fonksiyonunu çağırır: sayaçlar,
 * `source === 'tvdb'` kuralı, geçersiz girdilerin güvenli ele alınması ve
 * girdinin değiştirilmemesi.
 *
 * React render edilmez, dosya/ağ kullanılmaz, kullanıcı verisi okunmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { summarizeStockPool } from '../src/app/stock-stats.ts';

test('F5.3-08 boş ve eksik listeler sıfır sayaç üretir', () => {
  assert.deepEqual(summarizeStockPool([], []), { movieCount: 0, tvCount: 0, tvdbCount: 0 });
  assert.deepEqual(summarizeStockPool(null, undefined), {
    movieCount: 0,
    tvCount: 0,
    tvdbCount: 0,
  });
});

test('F5.3-08 film ve dizi sayaçları ayrı tutulur', () => {
  const stats = summarizeStockPool(
    [{ id: 1 }, { id: 2 }, { id: 3 }],
    [{ id: 101 }, { id: 102 }]
  );
  assert.equal(stats.movieCount, 3);
  assert.equal(stats.tvCount, 2);
  assert.equal(stats.tvdbCount, 0);
});

test('F5.3-08 TVDB sayacı yalnızca source === "tvdb" kayıtlarını sayar', () => {
  const stats = summarizeStockPool(
    [{ id: 1, source: 'tvdb' }, { id: 2, source: 'tmdb' }, { id: 3 }],
    [{ id: 101, source: 'tvdb' }, { id: 102, source: 'TVDB' }, { id: 103, source: 'tvdb' }]
  );
  assert.equal(stats.movieCount, 3);
  assert.equal(stats.tvCount, 3);
  assert.equal(stats.tvdbCount, 3);
});

test('F5.3-08 geçersiz kayıtlar sayaçta hata üretmez, yalnızca TVDB sayımında atlanır', () => {
  const stats = summarizeStockPool(
    [null, undefined, 'bozuk', 42, [], { id: 1, source: 'tvdb' }],
    [null, { id: 2, source: 'tvdb' }]
  );
  // Liste uzunluğu korunur (önceki `cleanMovies.length` davranışı).
  assert.equal(stats.movieCount, 6);
  assert.equal(stats.tvCount, 2);
  // Yalnızca nesne olan kayıtlar TVDB sayılır.
  assert.equal(stats.tvdbCount, 2);
});

test('F5.3-08 girdi listeleri değiştirilmez', () => {
  const movies = [{ id: 1, source: 'tvdb' }];
  const tv = [{ id: 2 }];
  summarizeStockPool(movies, tv);
  assert.deepEqual(movies, [{ id: 1, source: 'tvdb' }]);
  assert.deepEqual(tv, [{ id: 2 }]);
});
