/**
 * Aşama 3 — B-12: ana seçim ve top-up/overflow yolu AYNI uygunluk politikasını
 * uygular.
 *
 * Kanıt: gizlenen/ilgilenilmeyen/izlenen içerikler, son önerilenler, medya kapsamı
 * ve yinelenen kimlikler her iki yolda da aynı şekilde elenir.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { makeMediaKey } from '../src/core/cinetrack-core.ts';
import {
  filterEligibleSelectionEntries,
  selectRecommendationBatch,
} from '../src/modules/recommendations/index.ts';

const TASTE_MAP = { profileId: 'phase3', entries: {}, lastRecommendedKeys: [] };

function candidate(id, mediaType = 'movie', extra = {}) {
  return {
    id,
    media_type: mediaType,
    title: `Yapım ${id}`,
    name: `Yapım ${id}`,
    genre_ids: [extra.genre ?? 18],
    popularity: extra.popularity ?? 100 - id,
    vote_average: 7,
    release_date: '2020-01-01',
    ...extra,
  };
}

function entry(id, mediaType = 'movie', score = 100 - id, extra = {}) {
  return { candidate: candidate(id, mediaType, extra), score };
}

function basePreferences(overrides = {}) {
  return {
    disliked: [],
    hidden: [],
    providers: [],
    mood: '',
    reminders: false,
    notified: [],
    ...overrides,
  };
}

function selectInput(overrides = {}) {
  return {
    targetType: 'movie',
    isFilteredView: false,
    tasteMap: TASTE_MAP,
    lastRecommendedKeys: [],
    savedItems: [],
    preferences: basePreferences(),
    enrichedMovies: [],
    enrichedTv: [],
    remainingMovies: [],
    remainingTv: [],
    targetTotal: 20,
    ...overrides,
  };
}

test('B-12/1: ana seçim yeterli sonuç ürettiğinde yalnızca kendi türünü döndürür', () => {
  const enrichedMovies = Array.from({ length: 30 }, (_, i) => entry(i + 1, 'movie', 100 - i));
  const result = selectRecommendationBatch(selectInput({ enrichedMovies }));
  assert.equal(result.picked.length, 20);
  assert.ok(result.picked.every((row) => (row.candidate ?? row).media_type === 'movie'));
});

test('B-12/2: ana seçim yetersizse kalan havuzdan tamamlanır', () => {
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      enrichedMovies: [entry(1, 'movie', 90)],
      remainingMovies: Array.from({ length: 10 }, (_, i) => entry(10 + i, 'movie', 80 - i)),
    })
  );
  assert.equal(result.picked.length, 11);
});

test('B-12/3: gizlenen içerik overflow yolunda da elenir', () => {
  const hidden = entry(50, 'movie', 99);
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      enrichedMovies: [entry(1, 'movie', 90)],
      remainingMovies: [hidden, entry(2, 'movie', 85)],
      preferences: basePreferences({ hidden: [makeMediaKey(candidate(50))] }),
    })
  );
  const keys = result.picked.map((row) => makeMediaKey(row.candidate ?? row));
  assert.ok(keys.includes('movie:1'));
  assert.ok(keys.includes('movie:2'));
  assert.equal(keys.includes('movie:50'), false, 'gizlenen içerik overflow ile geri gelmemeli');
});

test('B-12/4: izlenen/izlenecek içerikler yeniden önerilmez', () => {
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      savedItems: [
        { id: 1, media_type: 'movie', status: 'completed' },
        { id: 2, media_type: 'movie', status: 'watchlist' },
        { id: 3, media_type: 'movie', status: 'watching' },
      ],
      enrichedMovies: [entry(1, 'movie', 100), entry(2, 'movie', 99), entry(3, 'movie', 98)],
      remainingMovies: [entry(4, 'movie', 97)],
    })
  );
  const keys = result.picked.map((row) => makeMediaKey(row.candidate ?? row));
  assert.deepEqual(keys, ['movie:4']);
});

test('B-12/5: film-only istekte overflow TV içeriği eklemez', () => {
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      enrichedMovies: [entry(1, 'movie', 90)],
      remainingTv: Array.from({ length: 5 }, (_, i) => entry(30 + i, 'tv', 95 - i)),
      enrichedTv: [entry(40, 'tv', 99)],
    })
  );
  assert.ok(result.picked.length >= 1);
  assert.ok(result.picked.every((row) => (row.candidate ?? row).media_type === 'movie'));
});

test('B-12/6: TV sonuçları film hedef sayısını azaltmaz', () => {
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'all',
      isFilteredView: true,
      enrichedMovies: Array.from({ length: 10 }, (_, i) => entry(i + 1, 'movie', 100 - i)),
      enrichedTv: Array.from({ length: 10 }, (_, i) => entry(i + 101, 'tv', 99 - i)),
    })
  );
  const movies = result.picked.filter((row) => (row.candidate ?? row).media_type === 'movie');
  const tv = result.picked.filter((row) => (row.candidate ?? row).media_type === 'tv');
  assert.equal(movies.length, 10);
  assert.equal(tv.length, 10);
  assert.equal(result.picked.length, 20);
});

test('B-12/7: aynı içerik ana seçim ve overflow üzerinden iki kez gelmez', () => {
  const duplicate = entry(7, 'movie', 99);
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      enrichedMovies: [duplicate],
      remainingMovies: [duplicate, entry(8, 'movie', 80)],
    })
  );
  const keys = result.picked.map((row) => makeMediaKey(row.candidate ?? row));
  assert.equal(new Set(keys).size, keys.length);
});

test('B-12/8: tüm adaylar elendiğinde boş sonuç ve açıklama döner', () => {
  const result = selectRecommendationBatch(
    selectInput({
      targetType: 'movie',
      isFilteredView: true,
      preferences: basePreferences({ disliked: ['movie:1', 'movie:2'] }),
      enrichedMovies: [entry(1, 'movie'), entry(2, 'movie')],
      remainingMovies: [entry(3, 'movie')],
      lastRecommendedKeys: ['movie:3'],
    })
  );
  assert.equal(result.picked.length, 0);
  assert.equal(result.displayItems.length, 0);
  assert.equal(typeof result.explanation, 'string');
});

test('B-12: ortak uygunluk fonksiyonu tüm kuralları tek yerde uygular', () => {
  const entries = [
    entry(1, 'movie'),
    entry(1, 'movie'),
    entry(2, 'movie'),
    entry(3, 'tv'),
    { candidate: { id: 4 }, score: 10 },
    { candidate: candidate(5, 'movie'), score: 10 },
  ];
  const eligible = filterEligibleSelectionEntries({
    entries,
    savedItems: [{ id: 2, media_type: 'movie', status: 'completed' }],
    preferences: basePreferences({ disliked: ['movie:5'], hidden: [] }),
    lastRecommendedKeys: ['movie:1'],
    targetType: 'movie',
  });
  assert.deepEqual(
    eligible.map((row) => makeMediaKey(row.candidate ?? row)),
    [],
    'tüm film adayları elenmiş olmalı (yinelenen, izlenen, yanlış tür, belirsiz tür, ilgilenilmeyen, son önerilen)'
  );
});
