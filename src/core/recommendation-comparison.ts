/**
 * Faz 3 — Öneri algoritması karşılaştırma raporu.
 *
 * PR #60 tek öneri hattını kurdu; puanlama formülleri burada **yeniden
 * yazılmaz**. Aynı sabit veri kümesi ve aynı profil üzerinde iki yapılandırma
 * yan yana koşulur:
 *
 * - `baseline`: yalnızca yerel zevk profili (sunucu zevk sinyali ve İçerik
 *   Zekâsı semantik katkısı kapalı) — #60 sonrası eklenen sinyallerin
 *   karşılaştırma tabanı.
 * - `current`: sunucu zevk sinyali + semantik afinite ile üretim hattı.
 *
 * Rapor yalnızca toplam puana bakmaz: ilk 20 kesişimi, sıra değişimleri,
 * favori oyuncu etkisi, tür/ruh hâli uyumu, kullanıcı puanları, film/dizi
 * dengesi, benzer içerik yoğunluğu ve elenen içerikleri ayrı ayrı verir.
 * Deterministik: aynı girdi + aynı `now` aynı raporu üretir.
 */

import {
  RECOMMENDATION_WEIGHTS_V3,
  buildTasteProfileV3,
  canonicalizeMediaKey,
  makeMediaKey,
  scoreCandidatesV3,
  selectBalancedRecommendations,
  type PersistentTasteMapData,
  type Profile,
} from './cinetrack-core.ts';
import { genreMetricIdFor } from './taste/genre-metric.ts';

/** Sunucu zevk sinyalinin yapısal sözleşmesi (modül katmanına bağımlılık yok). */
export interface ServerTasteSignal {
  readonly confidence: number;
  readonly genreAffinity: Readonly<Record<string, number>>;
  readonly moodAffinity: number | null;
}
import { semanticBoostFor } from './semantic-ranking.ts';
import {
  filterRecommendableItems,
  isItemExcludedFromRecommendations,
  resolveEffectiveItemState,
} from './item-effective-state.ts';

export interface RecommendationComparisonInput {
  readonly profile: Profile;
  readonly candidatePool: readonly any[];
  readonly limit?: number;
  readonly tasteMap?: PersistentTasteMapData | null;
  readonly serverTaste?: ServerTasteSignal | null;
  readonly semanticHints?: ReadonlyMap<string, number> | null;
  readonly genreNames?: Record<number | string, string> | null;
  readonly now?: Date | number | string;
}

export interface StrategyMetrics {
  readonly strategy: 'baseline' | 'current';
  readonly topN: readonly string[];
  readonly top20Keys: readonly string[];
  readonly averageScore: number;
  readonly averageUserRating: number | null;
  readonly favoriteActorHits: number;
  readonly genreFitRate: number;
  readonly moodFit: number | null;
  readonly movieCount: number;
  readonly tvCount: number;
  readonly typeBalanceAccuracy: number;
  readonly lovedSimilarityDensity: number;
  readonly semanticBoostTotal: number;
  readonly excludedItemsRemoved: number;
}

export interface RecommendationComparisonReport {
  readonly limit: number;
  readonly candidateCount: number;
  readonly eligibleCount: number;
  readonly removedAsDislikedOrHidden: number;
  readonly topNOverlap: number;
  readonly topNOverlapRate: number;
  readonly rankChanges: ReadonlyArray<{ key: string; baselineRank: number | null; currentRank: number | null }>;
  readonly baseline: StrategyMetrics;
  readonly current: StrategyMetrics;
  readonly deterministic: boolean;
}

function clampLimit(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 20;
  return Math.max(1, Math.min(50, Math.floor(num)));
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, v) => sum + v, 0) / values.length) * 1000) / 1000;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function favoriteActorIds(profile: Profile): Set<string> {
  const ids = new Set<string>();
  for (const actor of profile.favoriteActors || []) {
    if (actor && actor.id != null) ids.add(String(actor.id));
  }
  return ids;
}

function computeMetrics(
  strategy: 'baseline' | 'current',
  picked: readonly any[],
  options: {
    profile: Profile;
    semanticHints?: ReadonlyMap<string, number> | null;
    excludedRemoved: number;
    favoriteIds: Set<string>;
    positiveGenres: ReadonlySet<string>;
  }
): StrategyMetrics {
  const top20Keys = picked.slice(0, 20).map((cand) => canonicalizeMediaKey(makeMediaKey(cand)));
  const scores = picked.map((cand) => Number(cand.score) || 0);
  const userRatings = picked
    .map((cand) => Number(cand.vote_average))
    .filter((v) => Number.isFinite(v) && v > 0);
  let movieCount = 0;
  let tvCount = 0;
  let genreHits = 0;
  let moodHits = 0;
  let moodTotal = 0;
  let actorHits = 0;
  let lovedDensitySum = 0;
  let semanticBoostTotal = 0;

  for (const cand of picked) {
    const mediaType = cand.media_type === 'tv' ? 'tv' : 'movie';
    if (mediaType === 'tv') tvCount += 1;
    else movieCount += 1;

    const genreIds = (Array.isArray(cand.genre_ids) ? cand.genre_ids : []).map(String);
    if (genreIds.some((gid: string) => options.positiveGenres.has(gid))) genreHits += 1;

    const parts: Record<string, number> = (cand.signalBreakdown && typeof cand.signalBreakdown === 'object'
      ? cand.signalBreakdown
      : cand.parts && typeof cand.parts === 'object'
      ? cand.parts
      : {}) as Record<string, number>;
    const moodValue = Number.isFinite(parts.mood)
      ? Number(parts.mood)
      : Number.isFinite(parts.atmosphere)
      ? Number(parts.atmosphere)
      : null;
    if (moodValue !== null) {
      moodHits += moodValue;
      moodTotal += 1;
    }
    const lovedValue = Number.isFinite(parts.lovedSim) ? Number(parts.lovedSim) : 0;
    lovedDensitySum += Math.max(0, Math.min(1, lovedValue));

    const cast = Array.isArray(cand.cast) ? cand.cast : [];
    if (
      cast.some((person: any) => person && options.favoriteIds.has(String(person.id))) ||
      (parts.actor !== undefined && Number(parts.actor) >= 0.7)
    ) {
      actorHits += 1;
    }

    if (options.semanticHints && options.semanticHints.size > 0) {
      semanticBoostTotal += semanticBoostFor(
        options.semanticHints,
        canonicalizeMediaKey(makeMediaKey(cand))
      );
    }
  }

  const total = picked.length;
  const expectedMovieRatio = 0.5;
  const movieRatio = total > 0 ? movieCount / total : 0;

  return {
    strategy,
    topN: top20Keys,
    top20Keys,
    averageScore: total > 0 ? round3(scores.reduce((sum, v) => sum + v, 0) / total) : 0,
    averageUserRating: average(userRatings),
    favoriteActorHits: actorHits,
    genreFitRate: total > 0 ? round3(genreHits / total) : 0,
    moodFit: moodTotal > 0 ? round3(moodHits / moodTotal) : null,
    movieCount,
    tvCount,
    typeBalanceAccuracy: total > 0 ? round3(1 - Math.abs(movieRatio - expectedMovieRatio) * 2) : 0,
    lovedSimilarityDensity: total > 0 ? round3(lovedDensitySum / total) : 0,
    semanticBoostTotal,
    excludedItemsRemoved: options.excludedRemoved,
  };
}

function runStrategy(
  strategy: 'baseline' | 'current',
  input: RecommendationComparisonInput,
  eligible: any[],
  limit: number,
  excludedRemoved: number
): { metrics: StrategyMetrics; picked: any[] } {
  const { profile } = input;
  const now = input.now ?? new Date();
  const tasteProfile = buildTasteProfileV3(profile.items || [], {
    lambda: 1,
    dislikedKeys: profile.preferences?.disliked || [],
    ...(input.now !== undefined ? { now: new Date(now).getTime() } : {}),
  });

  const useCurrent = strategy === 'current';
  const scored = scoreCandidatesV3(eligible, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    genreNames: input.genreNames ?? null,
    mood: profile.preferences?.mood || '',
    tasteMap: input.tasteMap ?? null,
    ...(useCurrent && input.serverTaste
      ? {
          serverTaste: {
            confidence: input.serverTaste.confidence,
            genreAffinity: input.serverTaste.genreAffinity,
            moodAffinity: input.serverTaste.moodAffinity,
            metricIdFor: genreMetricIdFor,
          },
        }
      : {}),
    ...(input.now !== undefined ? { now } : {}),
  });

  // Semantik katkı yalnızca "current" yapılandırmasında ve tek bir yerde eklenir.
  const decorated = scored.map((entry: any) => {
    if (!useCurrent || !input.semanticHints || input.semanticHints.size === 0) return entry;
    const cand = entry.candidate || entry;
    const boost = semanticBoostFor(input.semanticHints, canonicalizeMediaKey(makeMediaKey(cand)));
    if (boost === 0) return entry;
    const score = Number(entry.score) || 0;
    const denominator = 100;
    return { ...entry, score: Math.min(1, score + boost / denominator) };
  });

  const sorted = decorated.sort((a: any, z: any) => (Number(z.score) || 0) - (Number(a.score) || 0));
  const movies = sorted.filter((e: any) => (e.candidate || e).media_type !== 'tv');
  const tvs = sorted.filter((e: any) => (e.candidate || e).media_type === 'tv');
  const balanced = selectBalancedRecommendations({
    targetType: 'all',
    scoredMovies: movies.filter((e: any) => e.ring !== 'ring1'),
    scoredTv: tvs.filter((e: any) => e.ring !== 'ring1'),
    remainingMovies: movies.filter((e: any) => e.ring === 'ring1'),
    remainingTv: tvs.filter((e: any) => e.ring === 'ring1'),
    targetTotal: limit,
    minPerTypeInAll: Math.floor(limit / 2),
    tasteMap: input.tasteMap ?? null,
  });

  const picked = (balanced.items || []).map((entry: any) => entry.candidate || entry);
  const positiveGenres = new Set<string>(tasteProfile.positiveGenres || []);
  const metrics = computeMetrics(strategy, picked, {
    profile,
    semanticHints: useCurrent ? input.semanticHints : null,
    excludedRemoved,
    favoriteIds: favoriteActorIds(profile),
    positiveGenres,
  });
  return { metrics, picked };
}

/**
 * İki stratejiyi aynı veri kümesi üzerinde karşılaştırarak rapor üretir.
 * Girdi mutasyonu yoktur; çağrı iki kez aynı sonucu verir (`deterministic`).
 */
export function compareRecommendationStrategies(
  input: RecommendationComparisonInput
): RecommendationComparisonReport {
  const limit = clampLimit(input.limit ?? 20);
  const pool = Array.isArray(input.candidatePool) ? [...input.candidatePool] : [];

  const eligible = filterRecommendableItems(
    { savedItems: input.profile.items || [], preferences: input.profile.preferences },
    pool
  );
  const removedAsDislikedOrHidden = pool.length - eligible.length;

  const baseline = runStrategy('baseline', input, eligible, limit, removedAsDislikedOrHidden);
  const current = runStrategy('current', input, eligible, limit, removedAsDislikedOrHidden);

  const baselineKeys = baseline.metrics.top20Keys;
  const currentKeys = current.metrics.top20Keys;
  const currentSet = new Set(currentKeys);
  const baselineSet = new Set(baselineKeys);
  const overlap = baselineKeys.filter((key) => currentSet.has(key)).length;
  const union = new Set([...baselineKeys, ...currentKeys]);
  const allKeys = union.size > 0 ? Array.from(union) : [];

  const rankChanges = allKeys.map((key) => {
    const bIndex = baselineKeys.indexOf(key);
    const cIndex = currentKeys.indexOf(key);
    return {
      key,
      baselineRank: bIndex >= 0 ? bIndex + 1 : null,
      currentRank: cIndex >= 0 ? cIndex + 1 : null,
    };
  });

  return {
    limit,
    candidateCount: pool.length,
    eligibleCount: eligible.length,
    removedAsDislikedOrHidden,
    topNOverlap: overlap,
    topNOverlapRate:
      union.size > 0 ? round3(overlap / Math.max(1, Math.min(baselineKeys.length, currentKeys.length))) : 0,
    rankChanges,
    baseline: baseline.metrics,
    current: current.metrics,
    deterministic:
      baselineSet.size === baselineKeys.length &&
      currentSet.size === currentKeys.length &&
      baselineKeys.join('|') ===
        runStrategy('baseline', input, eligible, limit, removedAsDislikedOrHidden).metrics.top20Keys.join('|'),
  };
}

/** Raporu insan-okur metne çevirir (İşlem Merkezi / test çıktısı için). */
export function formatRecommendationComparisonReport(
  report: RecommendationComparisonReport
): string {
  const lines = [
    `Öneri karşılaştırması (ilk ${report.limit}, ${report.eligibleCount}/${report.candidateCount} uygun aday)`,
    `Kesişim: ${report.topNOverlap} (${Math.round(report.topNOverlapRate * 100)}%)`,
    `Elenen (ilgilenmiyorum/gizli): ${report.removedAsDislikedOrHidden}`,
    `Favori oyuncu isabeti: taban ${report.baseline.favoriteActorHits} → güncel ${report.current.favoriteActorHits}`,
    `Tür uyumu: taban ${report.baseline.genreFitRate} → güncel ${report.current.genreFitRate}`,
    `Ruh hâli uyumu: taban ${report.baseline.moodFit ?? 'yok'} → güncel ${report.current.moodFit ?? 'yok'}`,
    `Film/dizi dengesi: taban ${report.baseline.movieCount}/${report.baseline.tvCount} → güncel ${report.current.movieCount}/${report.current.tvCount}`,
    `Benzer içerik yoğunluğu: taban ${report.baseline.lovedSimilarityDensity} → güncel ${report.current.lovedSimilarityDensity}`,
    `Ortalama kullanıcı puanı: taban ${report.baseline.averageUserRating ?? 'yok'} → güncel ${report.current.averageUserRating ?? 'yok'}`,
    `Semantik katkı toplamı (güncel): ${report.current.semanticBoostTotal}`,
    `Deterministik: ${report.deterministic ? 'evet' : 'hayır'}`,
  ];
  return lines.join('\n');
}

export { isItemExcludedFromRecommendations, resolveEffectiveItemState };
