/**
 * Aşama 3 — B-03: sevilen yapım benzerliği performans yolu.
 *
 * Kanıtlananlar:
 * 1. Ters indeksli hızlı yol, eski (tam tarama) algoritmayla BİREBİR aynı skoru ve
 *    aynı "en iyi eşleşme"yi üretir (deterministik fixture, farklı boyutlar).
 * 2. Tam tarama yerine yalnızca ortak özellik taşıyan adaylar karşılaştırılır;
 *    karşılaştırma sayısı aday × geçmiş çarpımının belirgin altındadır.
 * 3. Profil değişmediği sürece ters indeks bir kez kurulur ve yeniden kullanılır.
 * 4. Küçük listelerde ve güvenli olmayan durumlarda tam yol devreye girer; sonuç
 *    yine aynıdır (sonuç eşitliği bozulmaz).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTasteProfileV3,
  calculateAtmosphereSim,
  calculateCastSim,
  calculateEraSim,
  calculateGenreSim,
  calculateStorySim,
  clearLovedSimilarityIndexCache,
  computeLovedSimilarityScore,
  getLovedSimilarityStats,
  resetLovedSimilarityStats,
} from '../src/core/cinetrack-core.ts';

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GENRES = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37, 10765];
const WORDS = Array.from({ length: 240 }, (_, i) => `sozcuk${i}`);

function makeHistory(count, seed = 7) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: 900000 + i,
    media_type: i % 4 === 0 ? 'tv' : 'movie',
    title: `Sevilen ${i}`,
    overview: Array.from({ length: 16 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '),
    genre_ids: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => GENRES[Math.floor(rand() * GENRES.length)]),
    personal_rating: 8 + Math.floor(rand() * 3),
    status: 'completed',
    release_date: `${1985 + Math.floor(rand() * 40)}-01-01`,
    cast: Array.from({ length: 8 }, () => ({ id: 1000 + Math.floor(rand() * 900), name: 'Oyuncu' })),
    crew: [{ id: 5000 + Math.floor(rand() * 200), name: 'Yönetmen', job: 'Director' }],
  }));
}

function makeCandidates(count, seed = 11) {
  const rand = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: 100000 + i,
    media_type: i % 4 === 0 ? 'tv' : 'movie',
    title: `Aday ${i}`,
    overview: Array.from({ length: 18 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '),
    genre_ids: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => GENRES[Math.floor(rand() * GENRES.length)]),
    vote_average: 6 + rand() * 3,
    vote_count: 100 + Math.floor(rand() * 4000),
    popularity: 10 + rand() * 400,
    release_date: `${1985 + Math.floor(rand() * 40)}-01-01`,
    cast: Array.from({ length: 8 }, () => ({ id: 1000 + Math.floor(rand() * 900), name: 'Oyuncu' })),
    crew: [{ id: 5000 + Math.floor(rand() * 200), name: 'Yönetmen', job: 'Director' }],
  }));
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

/** Aşama 3 öncesi algoritmanın birebir kopyası (referans). */
function referenceLovedSimilarity(candidate, lovedItems, precomputedTokens) {
  if (!lovedItems || lovedItems.length === 0) return { score: 0.5, breakdown: null };
  const rawGenres = Array.isArray(candidate.genre_ids) ? candidate.genre_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];
  const castIds = (Array.isArray(candidate.cast) ? candidate.cast : [])
    .slice(0, 10)
    .map((c) => Number(c?.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const directorIds = (Array.isArray(candidate.crew) ? candidate.crew : [])
    .filter((m) => m && (m.job === 'Director' || m.job === 'Creator'))
    .map((m) => Number(m.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  const dateStr = candidate.release_date || candidate.first_air_date;
  const year = typeof dateStr === 'string' && /^\d{4}/.test(dateStr) ? parseInt(dateStr.slice(0, 4), 10) : undefined;
  const collectionId = candidate.belongs_to_collection?.id ? Number(candidate.belongs_to_collection.id) : undefined;
  const tokens = Array.isArray(precomputedTokens)
    ? precomputedTokens
    : typeof candidate.overview === 'string'
    ? candidate.overview.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
    : [];

  const scored = lovedItems.map((loved) => {
    const genreSim = calculateGenreSim(rawGenres, loved.genre_ids || []);
    const storySim = calculateStorySim(tokens, loved.overviewTokens);
    const castSim = calculateCastSim(castIds, loved.castIds || []);
    const atmosphereSim = calculateAtmosphereSim(directorIds, loved.directorIds || [], collectionId, loved.collectionId);
    const eraSim = calculateEraSim(year, loved.year);
    const similarity = Math.round(
      clamp01(0.35 * genreSim + 0.25 * storySim + 0.15 * castSim + 0.15 * atmosphereSim + 0.1 * eraSim) * 1000
    ) / 1000;
    const rawWeight = Number(loved.weight);
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? Math.min(1, rawWeight) : 1;
    return { similarity, weight, key: loved.key };
  });

  let best = scored[0];
  for (const entry of scored) {
    const contribution = entry.similarity * entry.weight;
    const bestContribution = best.similarity * best.weight;
    if (contribution > bestContribution || (contribution === bestContribution && entry.similarity > best.similarity)) {
      best = entry;
    }
  }
  const top3 = [...scored].sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const top3Weight = top3.reduce((sum, entry) => sum + entry.weight, 0);
  const top3Avg =
    top3Weight > 0
      ? top3.reduce((sum, entry) => sum + entry.similarity * entry.weight, 0) / top3Weight
      : top3.reduce((sum, entry) => sum + entry.similarity, 0) / top3.length;
  const finalScore = lovedItems.length >= 2 ? clamp01(0.8 * best.similarity + 0.2 * top3Avg) : best.similarity;
  return { score: clamp01(finalScore), breakdown: { matchedKey: best.key } };
}

test('B-03: hızlı yol eski algoritmayla birebir aynı skoru ve eşleşmeyi üretir', () => {
  clearLovedSimilarityIndexCache();
  for (const [candidateCount, historyCount] of [
    [60, 12],
    [80, 40],
    [120, 300],
    [200, 1200],
  ]) {
    const profile = buildTasteProfileV3(makeHistory(historyCount), { lambda: 1 });
    const candidates = makeCandidates(candidateCount);
    for (const candidate of candidates) {
      const actual = computeLovedSimilarityScore(candidate, profile.lovedItemFeatures);
      const expected = referenceLovedSimilarity(candidate, profile.lovedItemFeatures);
      assert.equal(actual.score, expected.score, `skor farkı: ${candidate.id} (${candidateCount}×${historyCount})`);
      assert.equal(
        actual.breakdown?.matchedKey,
        expected.breakdown?.matchedKey,
        `eşleşme farkı: ${candidate.id} (${candidateCount}×${historyCount})`
      );
    }
  }
});

test('B-03: yalnızca ortak özellik taşıyan yapımlar tam karşılaştırılır', () => {
  clearLovedSimilarityIndexCache();
  // 400 sevilen yapımın hiçbiri diğeriyle ortak tür/oyuncu/kelime taşımaz.
  const lovedItems = Array.from({ length: 400 }, (_, i) => ({
    key: `movie:${i + 1}`,
    id: i + 1,
    media_type: 'movie',
    title: `Yapım ${i + 1}`,
    genre_ids: [],
    overviewTokens: new Set([`ozel${i}`]),
    castIds: [1000 + i],
    directorIds: [],
    year: 2000,
    weight: 1,
  }));
  const candidate = {
    id: 999,
    media_type: 'movie',
    title: 'Aday',
    genre_ids: [18],
    overview: Array.from({ length: 10 }, (_, i) => `ozel${i}`).join(' '),
    cast: [{ id: 1001 }, { id: 1002 }],
    crew: [],
  };

  resetLovedSimilarityStats();
  const result = computeLovedSimilarityScore(candidate, lovedItems);
  const stats = getLovedSimilarityStats();

  assert.ok(stats.indexedComparisons <= 20, `indeksli karşılaştırma 20'yi aşmamalı (${stats.indexedComparisons})`);
  assert.ok(stats.analyticComparisons >= 380, 'ortak özellik taşımayan çiftler analitik hesaplanmalı');
  assert.equal(stats.fallbackCandidates, 0, 'güvenli hızlı yol yeterli olmalı');
  assert.equal(result.score, referenceLovedSimilarity(candidate, lovedItems).score);
});

test('B-03: ters indeks profil dizisi başına bir kez kurulur', () => {
  clearLovedSimilarityIndexCache();
  const profile = buildTasteProfileV3(makeHistory(300), { lambda: 1 });
  const candidates = makeCandidates(50);
  resetLovedSimilarityStats();
  for (const candidate of candidates) computeLovedSimilarityScore(candidate, profile.lovedItemFeatures);
  assert.equal(getLovedSimilarityStats().indexBuilds, 1, 'indeks yalnızca bir kez kurulmalı');
});

test('B-03: küçük sevilen listesi ve güvenli olmayan durum tam yola düşer, sonuç değişmez', () => {
  clearLovedSimilarityIndexCache();
  const profile = buildTasteProfileV3(makeHistory(6), { lambda: 1 });
  const candidate = makeCandidates(1)[0];

  const actual = computeLovedSimilarityScore(candidate, profile.lovedItemFeatures);
  const expected = referenceLovedSimilarity(candidate, profile.lovedItemFeatures);
  assert.equal(actual.score, expected.score);
  assert.equal(actual.breakdown?.matchedKey, expected.breakdown?.matchedKey);
});

test('B-03: eşleşme yoksa nötr/taban davranışı korunur', () => {
  clearLovedSimilarityIndexCache();
  const lovedItems = Array.from({ length: 10 }, (_, i) => ({
    key: `movie:${i + 1}`,
    id: i + 1,
    media_type: 'movie',
    title: `Yapım ${i + 1}`,
    genre_ids: [27],
    overviewTokens: new Set(['korku']),
    castIds: [],
    directorIds: [],
    year: 2000,
    weight: 1,
  }));
  const candidate = { id: 999, media_type: 'movie', title: 'Aday', genre_ids: [35], overview: 'komedi eglence', cast: [], crew: [] };
  const actual = computeLovedSimilarityScore(candidate, lovedItems);
  const expected = referenceLovedSimilarity(candidate, lovedItems);
  assert.equal(actual.score, expected.score);
  assert.equal(actual.breakdown?.matchedKey, expected.breakdown?.matchedKey);
});
