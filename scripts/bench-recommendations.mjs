#!/usr/bin/env node
/**
 * Aşama 3 — B-03 öneri benzerlik benchmark'ı (deterministik, gerçek veriye dokunmaz).
 *
 * Aynı fixture üzerinde:
 *  - yeni motor (ters indeks + önceden hesaplanmış özellikler),
 *  - eski motor (aday × geçmiş tam tarama; `--reference`),
 * çalıştırılır; süre, karşılaştırma sayısı, özellik üretimi, bellek ve ilk-20
 * sıralama örtüşmesi raporlanır.
 *
 * Kullanım:
 *   node --import tsx scripts/bench-recommendations.mjs                 # yeni motor, tüm matris
 *   node --import tsx scripts/bench-recommendations.mjs --reference     # eski motor (yavaş)
 *   node --import tsx scripts/bench-recommendations.mjs --only=5000x5000 --repeat=3
 *   node --import tsx scripts/bench-recommendations.mjs --json
 *
 * Notlar:
 * - Veri üretimi sabit tohumludur (mulberry32), bu yüzden koşumlar tekrarlanabilir.
 * - `data/` dizinine yazmaz; yalnızca bellekte çalışır.
 * - Referans uygulama, Aşama 3 öncesi algoritmanın birebir kopyasıdır; yeni motorun
 *   sonuç eşitliğini kanıtlamak için kullanılır.
 */

import {
  buildTasteProfileV3,
  computeLovedSimilarityScore,
  calculateGenreSim,
  calculateStorySim,
  calculateCastSim,
  calculateAtmosphereSim,
  calculateEraSim,
  getLovedSimilarityStats,
  resetLovedSimilarityStats,
} from '../src/core/cinetrack-core.ts';

const GENRES = [28, 12, 16, 35, 80, 99, 18, 10751, 14, 36, 27, 10402, 9648, 10749, 878, 10770, 53, 10752, 37, 10765, 10759];
const WORDS = Array.from({ length: 600 }, (_, i) => `kelime${i}`);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function pickType(rand, profileShape, index) {
  if (profileShape === 'movie') return index % 11 === 0 ? 'tv' : 'movie';
  if (profileShape === 'tv') return index % 11 === 0 ? 'movie' : 'tv';
  return index % 2 === 0 ? 'movie' : 'tv';
}

function makeHistory(count, { seed = 7, shape = 'mixed' } = {}) {
  const rand = mulberry32(seed);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      id: 900000 + i,
      media_type: pickType(rand, shape, i),
      title: `Sevilen ${i}`,
      overview: Array.from({ length: 20 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '),
      genre_ids: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => GENRES[Math.floor(rand() * GENRES.length)]),
      personal_rating: 8 + Math.floor(rand() * 3),
      status: 'completed',
      release_date: `${1980 + Math.floor(rand() * 45)}-01-01`,
      cast: Array.from({ length: 8 }, () => ({ id: 1000 + Math.floor(rand() * 1500), name: 'Oyuncu' })),
      crew: [{ id: 5000 + Math.floor(rand() * 300), name: 'Yönetmen', job: 'Director' }],
    });
  }
  return items;
}

function makeCandidates(count, { seed = 11, shape = 'mixed' } = {}) {
  const rand = mulberry32(seed);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push({
      id: 100000 + i,
      media_type: pickType(rand, shape, i),
      title: `Aday ${i}`,
      overview: Array.from({ length: 24 }, () => WORDS[Math.floor(rand() * WORDS.length)]).join(' '),
      genre_ids: Array.from({ length: 1 + Math.floor(rand() * 3) }, () => GENRES[Math.floor(rand() * GENRES.length)]),
      vote_average: 6 + rand() * 3,
      vote_count: 100 + Math.floor(rand() * 4000),
      popularity: 10 + rand() * 500,
      release_date: `${1980 + Math.floor(rand() * 45)}-01-01`,
      cast: Array.from({ length: 8 }, () => ({ id: 1000 + Math.floor(rand() * 1500), name: 'Oyuncu' })),
      crew: [{ id: 5000 + Math.floor(rand() * 300), name: 'Yönetmen', job: 'Director' }],
    });
  }
  return items;
}

/** Aşama 3 öncesi algoritmanın birebir kopyası (referans). */
function baselineLovedSimilarity(candidate, lovedItems, precomputedTokens) {
  if (!lovedItems || lovedItems.length === 0) return { score: 0.5, breakdown: null };
  const rawGenres = Array.isArray(candidate.genre_ids)
    ? candidate.genre_ids.map(Number).filter((n) => Number.isFinite(n) && n > 0)
    : Array.isArray(candidate.genres)
    ? candidate.genres.map((g) => Number(typeof g === 'object' ? g?.id : g)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const rawCast = Array.isArray(candidate.cast) ? candidate.cast : [];
  const castIds = rawCast.slice(0, 10).map((c) => Number(c?.id)).filter((id) => Number.isFinite(id) && id > 0);
  const rawCrew = Array.isArray(candidate.crew) ? candidate.crew : [];
  const directorIds = rawCrew
    .filter((m) => m && (m.job === 'Director' || m.job === 'Creator'))
    .map((m) => Number(m.id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (candidate.director?.id && !directorIds.includes(Number(candidate.director.id))) {
    const id = Number(candidate.director.id);
    if (Number.isFinite(id) && id > 0) directorIds.push(id);
  }
  const dateStr = candidate.release_date || candidate.first_air_date;
  const year = typeof dateStr === 'string' && /^\d{4}/.test(dateStr) ? parseInt(dateStr.slice(0, 4), 10) : undefined;
  const collectionId = candidate.belongs_to_collection?.id ? Number(candidate.belongs_to_collection.id) : undefined;
  const tokens = Array.isArray(precomputedTokens)
    ? precomputedTokens
    : Array.isArray(candidate._extractedTokens)
    ? candidate._extractedTokens
    : typeof candidate.overview === 'string'
    ? candidate.overview.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
    : [];
  const candMeta = { genre_ids: rawGenres, tokens, castIds, directorIds, collectionId, year };

  const scored = [];
  for (const loved of lovedItems) {
    const genreSim = calculateGenreSim(candMeta.genre_ids, loved.genre_ids || []);
    const storySim = calculateStorySim(candMeta.tokens, loved.overviewTokens);
    const castSim = calculateCastSim(candMeta.castIds, loved.castIds || []);
    const atmosphereSim = calculateAtmosphereSim(
      candMeta.directorIds,
      loved.directorIds || [],
      candMeta.collectionId,
      loved.collectionId
    );
    const eraSim = calculateEraSim(candMeta.year, loved.year);
    const similarity = Math.round(
      clamp01(0.35 * genreSim + 0.25 * storySim + 0.15 * castSim + 0.15 * atmosphereSim + 0.1 * eraSim) * 1000
    ) / 1000;
    const rawWeight = Number(loved.weight);
    const weight = Number.isFinite(rawWeight) && rawWeight > 0 ? Math.min(1, rawWeight) : 1;
    scored.push({ similarity, weight, breakdown: { matchedKey: loved.key, similarity } });
  }

  let bestEntry = scored[0];
  for (const entry of scored) {
    const contribution = entry.similarity * entry.weight;
    const bestContribution = bestEntry.similarity * bestEntry.weight;
    if (contribution > bestContribution || (contribution === bestContribution && entry.similarity > bestEntry.similarity)) {
      bestEntry = entry;
    }
  }
  const top3 = [...scored].sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const top3Weight = top3.reduce((sum, entry) => sum + entry.weight, 0);
  const top3Avg =
    top3Weight > 0
      ? top3.reduce((sum, entry) => sum + entry.similarity * entry.weight, 0) / top3Weight
      : top3.reduce((sum, entry) => sum + entry.similarity, 0) / top3.length;
  const finalScore =
    lovedItems.length >= 2 ? clamp01(0.8 * bestEntry.similarity + 0.2 * top3Avg) : bestEntry.similarity;
  return { score: clamp01(finalScore), breakdown: bestEntry.breakdown };
}

const SCENARIOS = [
  { label: '1000x500', candidates: 1000, history: 500 },
  { label: '5000x2000', candidates: 5000, history: 2000 },
  { label: '5000x5000', candidates: 5000, history: 5000 },
  { label: '10000x5000', candidates: 10000, history: 5000 },
  { label: '5000x10000', candidates: 5000, history: 10000 },
];
const SHAPES = ['movie', 'tv', 'mixed'];

function parseArgs(argv) {
  const args = { reference: false, json: false, only: null, shape: null, repeat: 1 };
  for (const arg of argv) {
    if (arg === '--reference') args.reference = true;
    else if (arg === '--json') args.json = true;
    else if (arg.startsWith('--only=')) args.only = arg.slice('--only='.length);
    else if (arg.startsWith('--shape=')) args.shape = arg.slice('--shape='.length);
    else if (arg.startsWith('--repeat=')) args.repeat = Math.max(1, Number(arg.slice('--repeat='.length)) || 1);
  }
  return args;
}

function rankOf(scores, limit) {
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}

const args = parseArgs(process.argv.slice(2));
const rows = [];
let parityMismatches = 0;

for (const scenario of SCENARIOS) {
  if (args.only && scenario.label !== args.only) continue;
  for (const shape of SHAPES) {
    if (args.shape && shape !== args.shape) continue;
    const history = makeHistory(scenario.history, { shape });
    const candidates = makeCandidates(scenario.candidates, { shape });

    const heapBefore = process.memoryUsage().heapUsed;
    const profileStart = performance.now();
    const profile = buildTasteProfileV3(history, { lambda: 1 });
    const profileMs = performance.now() - profileStart;

    const runNew = () => {
      resetLovedSimilarityStats();
      const start = performance.now();
      const scores = new Map();
      for (const candidate of candidates) {
        scores.set(candidate.id, computeLovedSimilarityScore(candidate, profile.lovedItemFeatures).score);
      }
      return { scores, ms: performance.now() - start, stats: getLovedSimilarityStats() };
    };

    let bestCold = Infinity;
    let warm = null;
    let stats = null;
    let newScores = null;
    for (let run = 0; run < args.repeat; run += 1) {
      const result = runNew();
      if (run === 0) {
        bestCold = result.ms;
        newScores = result.scores;
        stats = result.stats;
      } else {
        bestCold = Math.min(bestCold, result.ms);
        warm = result.ms;
      }
    }

    let reference = null;
    let overlap = null;
    if (args.reference) {
      const start = performance.now();
      const refScores = new Map();
      for (const candidate of candidates) {
        refScores.set(candidate.id, baselineLovedSimilarity(candidate, profile.lovedItemFeatures).score);
      }
      const ms = performance.now() - start;
      let mismatches = 0;
      for (const [id, score] of newScores) {
        if (Math.abs(score - refScores.get(id)) > 1e-9) mismatches += 1;
      }
      parityMismatches += mismatches;
      const newTop = rankOf(newScores, 20);
      const refTop = rankOf(refScores, 20);
      const shared = newTop.filter((id) => refTop.includes(id)).length;
      overlap = { shared, of: newTop.length };
      reference = { ms, mismatches };
    }

    const heapAfter = process.memoryUsage().heapUsed;
    rows.push({
      scenario: scenario.label,
      shape,
      candidates: scenario.candidates,
      history: scenario.history,
      lovedItems: profile.lovedItemFeatures.length,
      profileMs: Math.round(profileMs),
      coldMs: Math.round(bestCold),
      warmMs: warm === null ? null : Math.round(warm),
      comparisons: stats.comparisons,
      indexedComparisons: stats.indexedComparisons,
      analyticComparisons: stats.analyticComparisons,
      fallbackCandidates: stats.fallbackCandidates,
      indexBuilds: stats.indexBuilds,
      heapDeltaMb: Math.round(((heapAfter - heapBefore) / (1024 * 1024)) * 10) / 10,
      referenceMs: reference ? Math.round(reference.ms) : null,
      speedup: reference ? Math.round((reference.ms / bestCold) * 10) / 10 : null,
      referenceMismatches: reference ? reference.mismatches : null,
      top20Overlap: overlap,
    });
  }
}

if (args.json) {
  console.log(JSON.stringify({ node: process.version, mode: args.reference ? 'reference' : 'engine', rows, parityMismatches }, null, 2));
} else {
  console.log(`Node ${process.version} — mod: ${args.reference ? 'yeni + referans' : 'yeni motor'}`);
  const header = ['senaryo', 'profil', 'profilMs', 'soğukMs', 'sıcakMs', 'karşılaştırma', 'analitik', 'fallback', 'refMs', 'hız', 'ilk20'];
  console.log(header.join('\t'));
  for (const row of rows) {
    console.log(
      [
        row.scenario,
        row.shape,
        row.profileMs,
        row.coldMs,
        row.warmMs ?? '-',
        row.comparisons,
        row.analyticComparisons,
        row.fallbackCandidates,
        row.referenceMs ?? '-',
        row.speedup ?? '-',
        row.top20Overlap ? `${row.top20Overlap.shared}/${row.top20Overlap.of}` : '-',
      ].join('\t')
    );
  }
  if (args.reference) console.log(`Referans ile skor uyuşmazlığı: ${parityMismatches}`);
}
