/**
 * Aşama 3 — B-13: `serverTaste` sinyalinin GERÇEK katkısı.
 *
 * Karar: Seçenek A — sinyal korunur ve kendi açık ağırlığıyla skora katılır.
 * Önceden tür puanına gizlice karışıyor, `parts.serverTaste` ise ağırlıksız
 * olduğu için açıklamada "katkı varmış gibi" görünüyordu. Artık:
 * - katkı `SERVER_TASTE_WEIGHT` ile tek yerde,
 * - açıklama etiketi yalnızca gerçek katkı eşiği aşıldığında üretilir,
 * - sinyal yokken puanlar birebir değişmez.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTasteProfileV3,
  calculateTastePillars,
  RECOMMENDATION_WEIGHTS_V3,
  scoreCandidatesV3,
  SERVER_TASTE_EXPLANATION_PART_THRESHOLD,
  SERVER_TASTE_WEIGHT,
} from '../src/core/cinetrack-core.ts';
import { genreMetricIdFor } from '../src/modules/recommendations/index.ts';

const SAVED = [
  {
    id: 1,
    media_type: 'movie',
    title: 'Sevilen Drama',
    genre_ids: [18],
    personal_rating: 10,
    status: 'completed',
    release_date: '2020-01-01',
  },
];
const profile = buildTasteProfileV3(SAVED, { lambda: 1 });
const NOW = '2026-11-22T00:00:00.000Z';

const candidates = [
  { id: 10, media_type: 'movie', title: 'Drama A', genre_ids: [18], overview: 'dram hikaye', vote_average: 7, vote_count: 1000, popularity: 100 },
  { id: 11, media_type: 'movie', title: 'Komedi B', genre_ids: [35], overview: 'komedi eglence', vote_average: 7, vote_count: 1000, popularity: 100 },
  { id: 12, media_type: 'movie', title: 'Drama C', genre_ids: [18], overview: 'dram aile', vote_average: 6, vote_count: 500, popularity: 60 },
];

function signal(overrides = {}) {
  return {
    confidence: 1,
    genreAffinity: { 'genre.drama': 1 },
    moodAffinity: null,
    metricIdFor: genreMetricIdFor,
    ...overrides,
  };
}

function scoreAll(serverTaste) {
  return scoreCandidatesV3(
    candidates.map((c) => ({ ...c })),
    profile,
    { weights: RECOMMENDATION_WEIGHTS_V3, serverTaste, now: NOW }
  );
}

test('B-13: sinyal yokken puanlar ve kırılım birebir eskisi gibi kalır', () => {
  const baseline = scoreAll(null);
  for (const row of baseline) {
    assert.equal(row.parts.serverTaste, undefined, 'sinyal yokken kırılımda serverTaste olmamalı');
  }
  const totalWeight = Object.values(RECOMMENDATION_WEIGHTS_V3).reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(totalWeight - 1) < 1e-9);
});

test('B-13: sinyal varken skorda ölçülebilir ve açık ağırlıklı katkı sağlar', () => {
  const baseline = scoreAll(null);
  const biased = scoreAll(signal());
  const target = biased.find((row) => row.candidate.id === 10);
  const before = baseline.find((row) => row.candidate.id === 10);

  assert.equal(typeof target.parts.serverTaste, 'number');
  assert.ok(target.parts.serverTaste > 0.5, 'olumlu afinite 0.5 üzerinde bir bileşen üretmeli');
  assert.ok(target.score > before.score, 'olumlu serverTaste puanı artırmalı');

  // Normalize edilmiş ağırlıklarda yeni bileşen hem payı hem toplam ağırlığı
  // büyütür: delta = 100 · w · (part − eski_ham/100) / (1 + w)
  const expectedDelta =
    (100 * SERVER_TASTE_WEIGHT * (target.parts.serverTaste - before.rawScore / 100)) /
    (1 + SERVER_TASTE_WEIGHT);
  assert.ok(
    Math.abs(target.rawScore - before.rawScore - expectedDelta) < 1e-6,
    `katkı açık ağırlıkla eşleşmeli (beklenen ~${expectedDelta.toFixed(3)})`
  );
});

test('B-13: olumsuz afinite puanı düşürür ve açıklama etiketi üretilmez', () => {
  const baseline = scoreAll(null);
  const biased = scoreAll(signal({ genreAffinity: { 'genre.drama': -1 } }));
  const target = biased.find((row) => row.candidate.id === 10);
  const before = baseline.find((row) => row.candidate.id === 10);
  assert.ok(target.score < before.score);
  assert.equal(target.candidate.tags.includes('Sunucu zevk profilinle uyumlu'), false);
});

test('B-13: açıklama etiketi gerçek katkı eşiğiyle uyumludur', () => {
  const strong = scoreAll(signal({ genreAffinity: { 'genre.drama': 1 } })).find((row) => row.candidate.id === 10);
  assert.ok(strong.parts.serverTaste >= SERVER_TASTE_EXPLANATION_PART_THRESHOLD);
  assert.ok(strong.candidate.tags.includes('Sunucu zevk profilinle uyumlu'));

  const weak = scoreAll(signal({ confidence: 0.4, genreAffinity: { 'genre.drama': 0.2 } })).find(
    (row) => row.candidate.id === 10
  );
  assert.ok(weak.parts.serverTaste < SERVER_TASTE_EXPLANATION_PART_THRESHOLD);
  assert.equal(weak.candidate.tags.includes('Sunucu zevk profilinle uyumlu'), false);
});

test('B-13: sinyal değiştiğinde sıralama gerçekten etkilenir', () => {
  const baseline = new Map(scoreAll(null).map((row) => [row.candidate.id, row.score]));
  const biased = new Map(
    scoreAll(signal({ confidence: 1, genreAffinity: { 'genre.drama': 1, 'genre.comedy': -1 } })).map((row) => [
      row.candidate.id,
      row.score,
    ])
  );

  const baselineGap = baseline.get(10) - baseline.get(11);
  const biasedGap = biased.get(10) - biased.get(11);
  assert.ok(biasedGap > baselineGap, 'drama lehine fark büyümeli');
  assert.ok(biased.get(10) > baseline.get(10));
  assert.ok(biased.get(11) < baseline.get(11), 'olumsuz komedi afinitesi komedi adayını düşürmeli');
  assert.ok(
    [...biased.entries()].sort((a, b) => b[1] - a[1])[0][0] === 10,
    'güçlü drama afinitesi drama adayını tepeye taşımalı'
  );
});

test('B-13: düşük güvenli sinyal ne skoru ne açıklamayı etkiler', () => {
  const baseline = scoreAll(null);
  const low = scoreAll(signal({ confidence: 0.1 }));
  for (const [index, row] of low.entries()) {
    assert.equal(row.score, baseline[index].score);
    assert.equal(row.parts.serverTaste, undefined);
    assert.equal(row.candidate.tags.includes('Sunucu zevk profilinle uyumlu'), false);
  }
});

test('B-13: tür ve hikâye sütunları serverTaste ile çifte sayılmaz', () => {
  const baseline = scoreAll(null).find((row) => row.candidate.id === 10);
  const biased = scoreAll(signal()).find((row) => row.candidate.id === 10);
  // Tür puanı yerel profilden gelir; sinyal yalnızca kendi bileşeninde yaşar.
  assert.equal(biased.parts.genre, baseline.parts.genre);
  assert.deepEqual(
    calculateTastePillars(biased.parts),
    calculateTastePillars(baseline.parts),
    'sunucu sinyali tür/hikâye sütunlarına sızmamalı'
  );
});
