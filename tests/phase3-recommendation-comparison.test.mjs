import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compareRecommendationStrategies,
  formatRecommendationComparisonReport,
} from '../src/core/recommendation-comparison.ts';

const NOW = new Date('2026-06-01T00:00:00.000Z');

function libraryItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Sevilen ${id}`,
    vote_average: 8,
    vote_count: 4000,
    popularity: 60,
    genre_ids: [18, 53],
    overview: 'Karanlık bir hikâye, gergin atmosfer',
    status: 'completed',
    personal_rating: 9,
    completedAt: '2025-01-01T00:00:00.000Z',
    cast: [{ id: 500, name: 'Sevilen Oyuncu' }],
    ...overrides,
  };
}

function poolItem(id, overrides = {}) {
  return {
    id,
    media_type: 'movie',
    title: `Aday ${id}`,
    vote_average: 7 + (id % 3) * 0.3,
    vote_count: 2000,
    popularity: 45 + id,
    genre_ids: id % 2 === 0 ? [18] : [53],
    overview: 'Gergin ve karanlık bir hikâye',
    cast: id % 4 === 0 ? [{ id: 500, name: 'Sevilen Oyuncu' }] : [{ id: 900 + id, name: 'Başka' }],
    ...overrides,
  };
}

function makeProfile(overrides = {}) {
  return {
    id: 'PROFILE-DEFAULT',
    name: 'Profilim',
    createdAt: '2024-01-01T00:00:00.000Z',
    preferences: {
      disliked: [],
      hidden: [],
      providers: [],
      mood: 'gergin',
      reminders: false,
      notified: [],
    },
    items: [libraryItem(1), libraryItem(2, { id: 2 })],
    favoriteActors: [{ id: 500, name: 'Sevilen Oyuncu' }],
    ...overrides,
  };
}

test('Faz 3 · 12 — Karşılaştırma raporu tüm metrikleri üretir', () => {
  const pool = Array.from({ length: 16 }, (_, index) => poolItem(index + 10));
  const report = compareRecommendationStrategies({
    profile: makeProfile(),
    candidatePool: pool,
    limit: 10,
    semanticHints: new Map(
      Array.from({ length: 17 }, (_, index) => [`movie:${index + 10}`, 0.8])
    ),
    now: NOW,
  });

  assert.equal(report.candidateCount, 16);
  assert.equal(report.eligibleCount, 16);
  assert.equal(report.removedAsDislikedOrHidden, 0);
  assert.ok(report.baseline.top20Keys.length > 0);
  assert.ok(report.current.top20Keys.length > 0);
  assert.ok(report.topNOverlap >= 0);
  assert.equal(typeof report.baseline.genreFitRate, 'number');
  assert.equal(typeof report.current.genreFitRate, 'number');
  assert.equal(typeof report.baseline.typeBalanceAccuracy, 'number');
  assert.equal(typeof report.baseline.lovedSimilarityDensity, 'number');
  assert.ok(Array.isArray(report.rankChanges));
  assert.equal(report.deterministic, true);
  assert.ok(report.current.semanticBoostTotal > 0, 'semantik katkı rapora yansımalı');
});

test('Faz 3 · 12 — Aynı veri ve profil aynı sonucu üretir (deterministik)', () => {
  const pool = Array.from({ length: 12 }, (_, index) => poolItem(index + 1));
  const input = { profile: makeProfile(), candidatePool: pool, limit: 8, now: NOW };
  const first = compareRecommendationStrategies(input);
  const second = compareRecommendationStrategies(input);
  assert.deepEqual(first.baseline.top20Keys, second.baseline.top20Keys);
  assert.deepEqual(first.current.top20Keys, second.current.top20Keys);
  assert.equal(first.topNOverlap, second.topNOverlap);
});

test('Faz 3 · 12 — İlgilenmiyorum ve gizli içerikler rapor öncesi elenir', () => {
  const pool = Array.from({ length: 10 }, (_, index) => poolItem(index + 1));
  const report = compareRecommendationStrategies({
    profile: makeProfile({
      preferences: {
        disliked: ['movie:1'],
        hidden: ['movie:2'],
        providers: [],
        mood: '',
        reminders: false,
        notified: [],
      },
    }),
    candidatePool: pool,
    limit: 10,
    now: NOW,
  });
  assert.equal(report.removedAsDislikedOrHidden, 2);
  assert.equal(report.eligibleCount, pool.length - 2);
  const allKeys = [...report.baseline.top20Keys, ...report.current.top20Keys];
  assert.ok(!allKeys.includes('movie:1'));
  assert.ok(!allKeys.includes('movie:2'));
});

test('Faz 3 · 12 — Rapor insan-okur metne çevrilebilir', () => {
  const pool = Array.from({ length: 8 }, (_, index) => poolItem(index + 1));
  const report = compareRecommendationStrategies({
    profile: makeProfile(),
    candidatePool: pool,
    limit: 6,
    now: NOW,
  });
  const text = formatRecommendationComparisonReport(report);
  for (const label of ['Kesişim', 'Favori oyuncu isabeti', 'Tür uyumu', 'Film/dizi dengesi', 'Deterministik']) {
    assert.ok(text.includes(label), `rapor "${label}" içermeli`);
  }
});
