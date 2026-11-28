/**
 * F5.3-07 — Liste sayacı davranış testleri.
 *
 * `App.tsx` içindeki beş kopya `filter` çağrısı `src/app/list-counts.ts`
 * modülüne taşındı. Bu testler sayacı gerçek üretim fonksiyonu üzerinden
 * doğrular: tür yüklemi, durum sayaçları, "yaklaşan" tarih sınırı ve geçersiz
 * kayıtların güvenli şekilde atlanması.
 *
 * React render edilmez; modül saf olduğu için doğrudan çağrılır. Kullanıcı
 * verisi kullanılmaz, hiçbir dosya yazılmaz.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { computeListCounts } from '../src/app/list-counts.ts';

const TODAY = '2026-11-26';

function item(overrides = {}) {
  return { id: 1, media_type: 'movie', title: 'Film', status: 'watchlist', ...overrides };
}

test('F5.3-07 boş liste: tüm sayaçlar sıfır', () => {
  assert.deepEqual(computeListCounts({ savedItems: [], selectedType: 'all', today: TODAY }), {
    allListCount: 0,
    watchingCount: 0,
    watchlistCount: 0,
    completedCount: 0,
    upcomingCount: 0,
  });
});

test('F5.3-07 tür yüklemi: film/dizi/all filtreleri tek kaynaktan uygulanır', () => {
  const savedItems = [
    item({ id: 1, media_type: 'movie', status: 'watching' }),
    item({ id: 2, media_type: 'tv', status: 'watchlist' }),
    item({ id: 3, media_type: 'movie', status: 'completed' }),
  ];

  const all = computeListCounts({ savedItems, selectedType: 'all', today: TODAY });
  assert.equal(all.allListCount, 3);
  assert.equal(all.watchingCount, 1);
  assert.equal(all.watchlistCount, 1);
  assert.equal(all.completedCount, 1);

  const movies = computeListCounts({ savedItems, selectedType: 'movie', today: TODAY });
  assert.equal(movies.allListCount, 2);
  assert.equal(movies.watchingCount, 1);
  assert.equal(movies.watchlistCount, 0);
  assert.equal(movies.completedCount, 1);

  const tv = computeListCounts({ savedItems, selectedType: 'tv', today: TODAY });
  assert.equal(tv.allListCount, 1);
  assert.equal(tv.watchingCount, 0);
  assert.equal(tv.watchlistCount, 1);
});

test('F5.3-07 yaklaşanlar: bugün dahil, geçmiş hariç, tarih yoksa sayılmaz', () => {
  const savedItems = [
    item({ id: 1, release_date: TODAY }),
    item({ id: 2, release_date: '2099-01-01' }),
    item({ id: 3, release_date: '2020-01-01' }),
    item({ id: 4, release_date: '' }),
    item({ id: 5 }),
    item({ id: 6, media_type: 'tv', next_episode_to_air: { air_date: TODAY } }),
    item({ id: 7, media_type: 'tv', first_air_date: '2099-05-05' }),
    item({ id: 8, media_type: 'tv', next_episode_to_air: { air_date: '2020-05-05' } }),
  ];

  const counts = computeListCounts({ savedItems, selectedType: 'all', today: TODAY });
  // 1 (bugün), 2 (gelecek), 6 (dizi bugün), 7 (dizi ilk yayın gelecek)
  assert.equal(counts.upcomingCount, 4);
  assert.equal(counts.allListCount, 8);

  const movies = computeListCounts({ savedItems, selectedType: 'movie', today: TODAY });
  assert.equal(movies.upcomingCount, 2);

  const tv = computeListCounts({ savedItems, selectedType: 'tv', today: TODAY });
  assert.equal(tv.upcomingCount, 2);
});

test('F5.3-07 geçersiz kayıtlar: eksik alanlı ve bozuk girdiler atlanır, hata fırlatılmaz', () => {
  const savedItems = [
    null,
    undefined,
    'bozuk',
    42,
    [],
    { id: 1, media_type: 'movie' }, // durum yok: yalnızca allList
    { id: 2, media_type: 'movie', status: 'bilinmeyen-durum' },
    { id: 3, media_type: 'movie', status: 'watching', release_date: 12345 },
    { id: 4, media_type: 'tv', status: 'completed', next_episode_to_air: null },
    { id: 5, media_type: 'movie', status: 'watchlist', release_date: 'geçersiz-tarih' },
  ];

  let counts;
  assert.doesNotThrow(() => {
    counts = computeListCounts({ savedItems, selectedType: 'all', today: TODAY });
  });
  assert.equal(counts.allListCount, 5);
  assert.equal(counts.watchingCount, 1);
  assert.equal(counts.watchlistCount, 1);
  assert.equal(counts.completedCount, 1);
  // Sayısal tarih ve boş dizi tarihi "yaklaşan" sayılmaz; sayı olmayan
  // dize tarihler eski davranış gereği leksikografik karşılaştırmaya girer
  // (App.tsx'teki `airDate >= todayStr` kuralı birebir korunur).
  assert.equal(counts.upcomingCount, 1);
});

test('F5.3-07 bilinmeyen tür seçimi hiçbir kaydı saymaz (eski davranış korunur)', () => {
  const counts = computeListCounts({
    savedItems: [item({ id: 1 }), item({ id: 2, media_type: 'tv' })],
    selectedType: 'anime',
    today: TODAY,
  });
  assert.deepEqual(counts, {
    allListCount: 0,
    watchingCount: 0,
    watchlistCount: 0,
    completedCount: 0,
    upcomingCount: 0,
  });
});
