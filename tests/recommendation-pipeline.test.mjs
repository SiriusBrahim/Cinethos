import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTasteProfileV3,
  makeMediaKey,
  scoreCandidatesV3,
  RECOMMENDATION_WEIGHTS_V3,
} from '../src/core/cinetrack-core.ts';
import {
  rescoreShortlist,
  scoreRecommendationPool,
  selectRecommendationBatch,
  toServerTasteInput,
} from '../src/modules/recommendations/index.ts';
import {
  buildServerTasteSignal,
  genreMetricIdFor,
} from '../src/modules/recommendations/taste-signal.ts';
import {
  CATALOG_ITEMS,
  GENRES_MAP,
  PREFERENCES,
  REFERENCE_NOW,
  SAVED_ITEMS,
  TASTE_MAP,
} from './fixtures/faz6-recommendation-dataset.mjs';

const profile = buildTasteProfileV3(SAVED_ITEMS, { lambda: 1, dislikedKeys: [] });
const movieCandidates = CATALOG_ITEMS.filter((item) => item.media_type === 'movie');
const tvCandidates = CATALOG_ITEMS.filter((item) => item.media_type === 'tv');

function baseInput(overrides = {}) {
  return {
    candidates: movieCandidates,
    activeCandidates: movieCandidates,
    profile,
    savedItems: SAVED_ITEMS,
    preferences: PREFERENCES,
    genresMap: GENRES_MAP,
    tasteMap: TASTE_MAP,
    targetType: 'movie',
    isFilteredView: false,
    shortlistSize: 24,
    now: REFERENCE_NOW,
    ...overrides,
  };
}

function scoreMap(result) {
  const map = new Map();
  for (const entry of result.scored) map.set(makeMediaKey(entry.candidate), entry.score);
  return map;
}

test('tek hat: havuz puanlama azalan sırada ve yalnızca kendi medya tipinde sonuç verir', () => {
  const result = scoreRecommendationPool(baseInput());
  assert.ok(result.scored.length > 0);
  assert.ok(result.scored.every((entry) => entry.candidate.media_type === 'movie'));
  for (let i = 1; i < result.scored.length; i += 1) {
    assert.ok(result.scored[i - 1].score >= result.scored[i].score, 'puanlar azalan olmalı');
  }
  assert.ok(result.shortlist.length > 0);
  assert.ok(result.shortlist.every((entry) => entry.ring !== 'ring1'));
});

test('geriye dönük uyum: sunucu sinyali ve anlamsal ipucu yokken puanlar doğrudan motorla birebir aynı', () => {
  const result = scoreRecommendationPool(baseInput());
  const direct = scoreCandidatesV3(movieCandidates, profile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    genreNames: GENRES_MAP,
    mood: PREFERENCES.mood,
    tasteMap: TASTE_MAP,
    now: REFERENCE_NOW,
  }).sort((a, b) => b.score - a.score);

  assert.deepEqual(scoreMap(result), scoreMap({ scored: direct }));
});

test('sunucu zevk profili nihai sıralamayı gerçekten etkiler', () => {
  const baseline = scoreMap(scoreRecommendationPool(baseInput()));

  const dramaKey = 'genre.drama';
  const bias = { [dramaKey]: 1 };
  const signal = {
    profileId: 'PROFILE-TEST',
    generationId: 'gen-1',
    confidence: 1,
    genreAffinity: bias,
    moodAffinity: null,
    updatedAt: REFERENCE_NOW,
    metricIdFor: genreMetricIdFor,
  };
  const biased = scoreRecommendationPool(baseInput({ serverTaste: signal }));

  const changed = biased.scored.filter(
    (entry) => entry.score !== (baseline.get(makeMediaKey(entry.candidate)) ?? 0)
  );
  assert.ok(changed.length > 0, 'sunucu tür afinitesi en az bir adayın puanını değiştirmeli');
  assert.ok(
    changed.some((entry) => entry.score > (baseline.get(makeMediaKey(entry.candidate)) ?? 0)),
    'yüksek güvenli olumlu afinite puanı artırmalı'
  );
  assert.ok(
    changed.some((entry) =>
      (entry.candidate.tags ?? []).includes('Sunucu zevk profilinle uyumlu')
    ),
    'gerekçe etiketi üretilmeli'
  );
});

test('düşük güvenli sunucu sinyali sıralamayı değiştirmez', () => {
  const baseline = scoreMap(scoreRecommendationPool(baseInput()));
  const signal = {
    profileId: 'PROFILE-TEST',
    generationId: 'gen-low',
    confidence: 0.1,
    genreAffinity: { 'genre.drama': 1 },
    moodAffinity: 1,
    updatedAt: REFERENCE_NOW,
    metricIdFor: genreMetricIdFor,
  };
  assert.equal(toServerTasteInput(signal)?.confidence, 0.1);
  assert.deepEqual(scoreMap(scoreRecommendationPool(baseInput({ serverTaste: signal }))), baseline);
});

test('içerik zekâsı anlamsal ipucu puanı ve gerekçeyi besler', () => {
  const baseline = scoreMap(scoreRecommendationPool(baseInput()));
  const target = movieCandidates[0];
  const hints = new Map([[makeMediaKey(target), 0.9]]);
  const result = scoreRecommendationPool(baseInput({ semanticHints: hints }));
  const boosted = result.scored.find((entry) => makeMediaKey(entry.candidate) === makeMediaKey(target));
  assert.ok(boosted);
  assert.ok(boosted.score > (baseline.get(makeMediaKey(target)) ?? 0));
  assert.ok((boosted.candidate.tags ?? []).includes('Sunucu anlamsal analiziyle ilişkili'));
});

test('film/dizi havuzları ayrı kalır ve seçim 20 öneriyi aşmaz, yinelenmez', () => {
  const movieScored = scoreRecommendationPool(baseInput());
  const tvScored = scoreRecommendationPool(
    baseInput({ candidates: tvCandidates, activeCandidates: tvCandidates, targetType: 'tv' })
  );

  const movieSelection = selectRecommendationBatch({
    targetType: 'movie',
    isFilteredView: false,
    tasteMap: TASTE_MAP,
    lastRecommendedKeys: TASTE_MAP.lastRecommendedKeys ?? [],
    savedItems: SAVED_ITEMS,
    preferences: PREFERENCES,
    enrichedMovies: movieScored.scored.slice(0, 10),
    enrichedTv: tvScored.scored.slice(0, 10),
  });

  assert.ok(movieSelection.picked.length <= 20);
  const keys = movieSelection.picked.map((entry) => makeMediaKey(entry.candidate ?? entry));
  assert.equal(new Set(keys).size, keys.length, 'aynı içerik iki kez seçilmemeli');
  assert.ok(
    movieSelection.picked.every((entry) => (entry.candidate ?? entry).media_type === 'movie'),
    'film filtresinde dizi sonucu olmamalı'
  );
  assert.equal(typeof movieSelection.explanation, 'string');
});

test('zenginleştirme sonrası yeniden puanlama da tek motoru kullanır', () => {
  const rescored = rescoreShortlist({
    shortlist: movieCandidates.slice(0, 5).map((candidate) => ({ candidate, score: 50 })),
    profile,
    savedItems: SAVED_ITEMS,
    preferences: PREFERENCES,
    genresMap: GENRES_MAP,
    tasteMap: TASTE_MAP,
    now: REFERENCE_NOW,
  });
  assert.ok(rescored.length > 0);
  for (let i = 1; i < rescored.length; i += 1) {
    assert.ok(rescored[i - 1].score >= rescored[i].score);
  }
});

test('sunucu profilinden yalnızca yönlü tür afiniteleri sinyale girer', () => {
  const signal = buildServerTasteSignal(
    {
      profileId: 'PROFILE-TEST',
      confidenceLevel: 'high',
      metrics: {
        'genre.drama': { metricId: 'genre.drama', affinity: 80, status: 'directional' },
        'genre.comedy': { metricId: 'genre.comedy', affinity: -60, status: 'directional' },
        'genre.horror': { metricId: 'genre.horror', affinity: 90, status: 'excluded' },
        'mood.dark': { metricId: 'mood.dark', affinity: 40, status: 'directional' },
      },
    },
    { mood: 'Karanlık' }
  );
  assert.ok(signal);
  assert.equal(signal.genreAffinity['genre.drama'], 0.8);
  assert.equal(signal.genreAffinity['genre.comedy'], -0.6);
  assert.equal(signal.genreAffinity['genre.horror'], undefined);
  assert.ok(signal.confidence >= 0.35);
  assert.equal(genreMetricIdFor('movie', 18), 'genre.drama');
  assert.equal(genreMetricIdFor('tv', 10765), 'genre.scifi');
});
