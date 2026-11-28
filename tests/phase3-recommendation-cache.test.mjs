/**
 * Aşama 3 — B-22: öneri önbelleği sınırlandırması.
 *
 * Kanıtlananlar: sabit boyut (LRU), TTL, profil revizyonu, katalog imzası, kapsam
 * (film/dizi), filtre değişikliği, eşzamanlı istek tekilleştirme, geç gelen eski
 * sonucun yeni durumu ezmemesi ve soğuk/sıcak önbellek tutarlılığı.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRecommendationService } from '../src/modules/recommendations/index.ts';

const PREFERENCES = { disliked: [], hidden: [], providers: [], mood: '', reminders: false, notified: [] };
const GENRES = { 18: 'Drama', 35: 'Comedy' };

function items() {
  return [
    { id: 1, media_type: 'movie', title: 'Film 1', genre_ids: [18], vote_average: 7, vote_count: 800, popularity: 90 },
    { id: 2, media_type: 'movie', title: 'Film 2', genre_ids: [35], vote_average: 7, vote_count: 800, popularity: 80 },
    { id: 3, media_type: 'movie', title: 'Film 3', genre_ids: [18], vote_average: 7, vote_count: 800, popularity: 70 },
    { id: 4, media_type: 'tv', title: 'Dizi 1', genre_ids: [18], vote_average: 7, vote_count: 800, popularity: 60 },
    { id: 5, media_type: 'tv', title: 'Dizi 2', genre_ids: [35], vote_average: 7, vote_count: 800, popularity: 50 },
  ];
}

function snapshot(overrides = {}) {
  return {
    items: items(),
    savedItems: [],
    preferences: PREFERENCES,
    genresMap: GENRES,
    tasteMap: null,
    ...overrides,
  };
}

test('B-22: önbellek sabit üst sınırı aşmaz (LRU tahliyesi)', async () => {
  const service = createRecommendationService({
    loadSnapshot: async () => snapshot(),
    maxEntries: 2,
  });
  const ref = { profileId: 'p1', revision: 1 };
  await service.getRecommendations(ref, 10);
  await service.getRecommendations(ref, 11);
  await service.getRecommendations(ref, 12);
  assert.equal(service.cacheSize, 2, 'önbellek en fazla maxEntries girdi tutmalı');
});

test('B-22: TTL dolan girdi yeniden hesaplanır', async () => {
  let loads = 0;
  let clock = 1000;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot();
    },
    ttlMs: 500,
    now: () => clock,
  });
  const ref = { profileId: 'p1', revision: 1 };
  await service.getRecommendations(ref, 10);
  assert.equal(loads, 1);
  clock += 100;
  await service.getRecommendations(ref, 10);
  assert.equal(loads, 1, 'TTL içinde önbellekten dönmeli');
  clock += 500;
  await service.getRecommendations(ref, 10);
  assert.equal(loads, 2, 'TTL dolunca yeniden yüklenmeli');
});

test('B-22: profil revizyonu değişince eski sonuç kullanılmaz', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot();
    },
  });
  await service.getRecommendations({ profileId: 'p1', revision: 1 }, 10);
  await service.getRecommendations({ profileId: 'p1', revision: 2 }, 10);
  assert.equal(loads, 2);
});

test('B-22: katalog imzası değişince önbellek anahtarı ayrışır', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot({ catalogSignature: serviceSignature });
    },
  });
  let serviceSignature = 'catalog-a';
  const ref = { profileId: 'p1', revision: 1 };
  await service.getRecommendations(ref, 10);
  serviceSignature = 'catalog-b';
  await service.getRecommendations(ref, 10);
  assert.equal(loads, 2, 'katalog revizyonu değişince yeniden hesaplanmalı');
});

test('B-22: film-only ve TV-only sonuçları birbirine karışmaz', async () => {
  const service = createRecommendationService({ loadSnapshot: async () => snapshot() });
  const ref = { profileId: 'p1', revision: 1 };
  const movies = await service.getRecommendations(ref, 10, { scope: 'movie' });
  const tv = await service.getRecommendations(ref, 10, { scope: 'tv' });
  assert.ok(movies.length > 0 && tv.length > 0);
  assert.ok(movies.every((row) => row.mediaKey.startsWith('movie:')));
  assert.ok(tv.every((row) => row.mediaKey.startsWith('tv:')));
});

test('B-22: izleme listesi değiştiğinde geçersiz öneri dönmez', async () => {
  let saved = [];
  const service = createRecommendationService({
    loadSnapshot: async () => snapshot({ savedItems: saved, catalogSignature: `saved-${saved.length}` }),
  });
  const ref = { profileId: 'p1', revision: 1 };
  const before = await service.getRecommendations(ref, 10);
  assert.ok(before.some((row) => row.mediaKey === 'movie:1'));

  saved = [{ id: 1, media_type: 'movie', status: 'completed' }];
  const after = await service.getRecommendations(ref, 10);
  assert.equal(after.some((row) => row.mediaKey === 'movie:1'), false, 'izlenen içerik önerilmemeli');
});

test('B-22: eşzamanlı aynı istek tek hesaplamaya indirgenir', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return snapshot();
    },
  });
  const ref = { profileId: 'p1', revision: 1 };
  const [a, b] = await Promise.all([
    service.getRecommendations(ref, 10),
    service.getRecommendations(ref, 10),
  ]);
  assert.deepEqual(a, b);
  assert.equal(loads, 1, 'aynı anahtar için tek yükleme yapılmalı');
});

test('B-22: geç gelen eski hesaplama yeni profil durumunun üzerine yazmaz', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      if (loads === 1) await gate;
      return snapshot({ catalogSignature: 'sig-stable' });
    },
  });
  const ref = { profileId: 'p1', revision: 1 };
  const options = { catalogSignature: 'sig-stable' };

  const slow = service.getRecommendations(ref, 10, options);
  await new Promise((resolve) => setTimeout(resolve, 5));
  service.invalidateProfile('p1');
  const fresh = await service.getRecommendations(ref, 10, options);

  release();
  await slow;

  const cachedFresh = await service.getRecommendations(ref, 10, options);
  assert.deepEqual(cachedFresh, fresh, 'geç gelen eski sonuç yeni nesli ezmemeli');
  assert.equal(loads, 2);
});

test('B-22: soğuk ve sıcak önbellek aynı sonucu verir', async () => {
  let loads = 0;
  const service = createRecommendationService({
    loadSnapshot: async () => {
      loads += 1;
      return snapshot();
    },
  });
  const ref = { profileId: 'p1', revision: 3 };
  const cold = await service.getRecommendations(ref, 5);
  const warm = await service.getRecommendations(ref, 5);
  assert.deepEqual(cold, warm);
  assert.equal(loads, 1);
});

test('B-22: önbellek temizliği kalıcı kullanıcı verisini değiştirmez', async () => {
  const persistent = {
    savedItems: [{ id: 1, media_type: 'movie', status: 'completed' }],
    preferences: { ...PREFERENCES, disliked: ['movie:2'] },
    tasteMap: { profileId: 'p1', entries: { 'movie:1': { tasteScore: 80 } }, lastRecommendedKeys: ['movie:3'] },
  };
  const dataCopy = JSON.parse(JSON.stringify(persistent));
  const service = createRecommendationService({
    loadSnapshot: async () => ({ ...snapshot(), ...persistent }),
  });
  const ref = { profileId: 'p1', revision: 1 };
  await service.getRecommendations(ref, 10);
  assert.equal(service.cacheSize > 0, true);
  service.clear();
  assert.equal(service.cacheSize, 0);
  assert.deepEqual(persistent, dataCopy, 'önbellek temizliği kullanıcı listelerini/tercihlerini değiştirmemeli');
});
