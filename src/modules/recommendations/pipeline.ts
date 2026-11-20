/**
 * Tek öneri hattı — havuz puanlama, kısa liste ve nihai seçim.
 *
 * `App.tsx` içinde dağınık duran "500 film + 500 dizi" puanlama, zenginleştirme
 * kısa listesi ve dengeli seçim mantığı buraya taşındı. React'e bağımlılık yok;
 * ağ erişimi (kadro zenginleştirme) çağıranda kalır, karar mantığı burada.
 *
 * Tek kaynak ilkesi: puanlama her zaman `scoreCandidatesV3` + sunucu zevk
 * sinyali üzerinden yapılır. Paralel/ikinci bir sıralama yolu yoktur.
 */

import {
  type PersistentTasteMapData,
  type Preferences,
  type SavedItem,
  type TasteProfileV3,
  RECOMMENDATION_WEIGHTS_V3,
  TARGET_RECOMMENDATION_COUNT,
  filterOutLastRecommendedCandidates,
  isCandidateEligibleInPool,
  makeMediaKey,
  scoreCandidatesV3,
  selectBalancedRecommendations,
} from '../../core/cinetrack-core.ts';
import type { ServerTasteInput } from '../../core/cinetrack-core.ts';
import { mapRecommendationBatchToDisplayItems } from './ExplanationManager.ts';
import { genreMetricIdFor } from './taste-signal.ts';
import type { ServerTasteSignal } from './taste-signal.ts';

export type TargetMediaType = 'all' | 'movie' | 'tv';

/** Sunucu sinyalini çekirdek puanlayıcının dar sözleşmesine çevirir. */
export function toServerTasteInput(
  signal: ServerTasteSignal | null | undefined
): ServerTasteInput | null {
  if (!signal) return null;
  return {
    confidence: signal.confidence,
    genreAffinity: signal.genreAffinity,
    moodAffinity: signal.moodAffinity,
    metricIdFor: genreMetricIdFor,
  };
}

export interface PoolScoreInput {
  /** Havuzun tamamı (filtre uygulanmadan); tüm adaylar puanlanır. */
  readonly candidates: readonly any[];
  /** Seçili filtreye uyan adaylar; daraltılmış görünümde sonuç bunlarla sınırlanır. */
  readonly activeCandidates?: readonly any[];
  readonly profile: TasteProfileV3;
  readonly savedItems: readonly SavedItem[];
  readonly preferences: Preferences;
  readonly genresMap: Record<number | string, string>;
  readonly tasteMap: PersistentTasteMapData | null;
  readonly targetType: TargetMediaType;
  readonly isFilteredView: boolean;
  readonly serverTaste?: ServerTasteSignal | null;
  /**
   * İçerik Zekâsı anlamsal komşuluk sinyali: mediaKey → 0..1 benzerlik.
   * Sunucu kayıtlarından gelir; sıralamada küçük ama gerçek bir ağırlığı vardır.
   */
  readonly semanticHints?: ReadonlyMap<string, number> | null;
  readonly now?: Date | number | string;
  /** Kısa liste boyutu (zenginleştirme için). */
  readonly shortlistSize: number;
}

export interface ScoredCandidateEntry {
  readonly candidate: any;
  readonly score: number;
  readonly ring?: string;
  readonly [key: string]: unknown;
}

export interface PoolScoreResult {
  readonly scored: ScoredCandidateEntry[];
  readonly shortlist: ScoredCandidateEntry[];
}

export const SEMANTIC_HINT_WEIGHT = 4;

/**
 * Anlamsal komşuluk bonusunu uygular. Bonus, ham puanı 100'ü aşmayacak şekilde
 * kaydırır ve gerekçe etiketi üretir; sinyal yoksa giriş birebir korunur.
 */
function applySemanticHints(
  scored: ScoredCandidateEntry[],
  hints: ReadonlyMap<string, number> | null | undefined
): ScoredCandidateEntry[] {
  if (!hints || hints.size === 0) return scored;
  return scored.map((entry) => {
    const key = makeMediaKey(entry.candidate ?? entry);
    const hint = hints.get(key);
    if (!hint || hint <= 0) return entry;
    const candidate = entry.candidate ?? entry;
    const tags = Array.isArray((candidate as any).tags) ? [...(candidate as any).tags] : [];
    if (hint >= 0.5 && !tags.includes('Sunucu anlamsal analiziyle ilişkili')) {
      tags.push('Sunucu anlamsal analiziyle ilişkili');
    }
    return {
      ...entry,
      candidate: { ...candidate, tags },
      semanticAffinity: hint,
      score: Math.min(100, Number(entry.score) + hint * SEMANTIC_HINT_WEIGHT),
    };
  });
}

function scoreList(input: PoolScoreInput, candidates: readonly any[]): ScoredCandidateEntry[] {
  return scoreCandidatesV3(
    [...candidates],
    input.profile,
    {
      weights: RECOMMENDATION_WEIGHTS_V3,
      genreNames: input.genresMap,
      mood: input.preferences.mood,
      tasteMap: input.tasteMap,
      serverTaste: toServerTasteInput(input.serverTaste),
      ...(input.now !== undefined ? { now: input.now } : {}),
    }
  ).sort((a: any, b: any) => b.score - a.score) as ScoredCandidateEntry[];
}

/**
 * Havuzu puanlar ve zenginleştirme kısa listesini üretir.
 * Halka 1 (son önerilenler) hiçbir zaman kısa listeye girmez.
 */
export function scoreRecommendationPool(input: PoolScoreInput): PoolScoreResult {
  const fullScored = applySemanticHints(
    scoreList(input, input.candidates),
    input.semanticHints
  ).sort((a: any, b: any) => b.score - a.score);

  const activeKeys = new Set(
    (input.activeCandidates ?? []).map((item) => makeMediaKey(item))
  );
  const scored =
    input.isFilteredView && activeKeys.size > 0
      ? fullScored.filter((entry) => activeKeys.has(makeMediaKey(entry.candidate)))
      : fullScored;

  const shortlist = filterOutLastRecommendedCandidates(
    scored,
    input.tasteMap?.lastRecommendedKeys ?? []
  )
    .filter((entry: any) => entry.ring === 'ring0' || entry.ring === 'ring2')
    .slice(0, input.shortlistSize) as ScoredCandidateEntry[];

  return { scored, shortlist };
}

export interface FinalSelectionInput {
  readonly targetType: TargetMediaType;
  readonly isFilteredView: boolean;
  readonly tasteMap: PersistentTasteMapData;
  readonly lastRecommendedKeys: readonly string[];
  readonly savedItems: readonly SavedItem[];
  readonly preferences: Preferences;
  /** Zenginleştirilmiş (kadro/hikâye sinyali eklenmiş) kısa liste puanları. */
  readonly enrichedMovies?: readonly any[];
  readonly enrichedTv?: readonly any[];
  /** Zenginleştirilmemiş kalan puanlar. */
  readonly remainingMovies?: readonly any[];
  readonly remainingTv?: readonly any[];
  readonly targetTotal?: number;
}

export interface FinalSelectionResult {
  readonly picked: any[];
  readonly explanation: string;
  readonly displayItems: any[];
  readonly reasonsMap: Map<string, string>;
}

/**
 * Dengeli (film/dizi/tür çeşitliliği korunan) nihai seçimi yapar.
 * Dar filtrede 20 öneri dolmazsa kalan havuzdan tamamlar; yinelenen anahtar
 * eklemez.
 */
export function selectRecommendationBatch(input: FinalSelectionInput): FinalSelectionResult {
  const targetTotal = Math.max(
    1,
    Math.min(100, Math.floor(input.targetTotal ?? TARGET_RECOMMENDATION_COUNT))
  );

  const balanced = selectBalancedRecommendations({
    targetType: input.targetType,
    scoredMovies: [...(input.enrichedMovies ?? [])],
    scoredTv: [...(input.enrichedTv ?? [])],
    remainingMovies: [...(input.remainingMovies ?? [])].filter((entry: any) =>
      isCandidateEligibleInPool(entry?.candidate ?? entry, [...input.savedItems], input.preferences)
    ),
    remainingTv: [...(input.remainingTv ?? [])].filter((entry: any) =>
      isCandidateEligibleInPool(entry?.candidate ?? entry, [...input.savedItems], input.preferences)
    ),
    lastRecommendedKeys: [...input.lastRecommendedKeys],
    tasteMap: input.tasteMap,
    targetTotal,
    minPerTypeInAll: 10,
    maxPerGenre: input.isFilteredView ? targetTotal : undefined,
  });

  const picked = [...balanced.items];

  if (input.isFilteredView && input.targetType === 'all' && picked.length < targetTotal) {
    const pickedKeys = new Set(picked.map((entry: any) => makeMediaKey(entry.candidate ?? entry)));
    const overflowPool = [
      ...(input.enrichedMovies ?? []),
      ...(input.enrichedTv ?? []),
      ...(input.remainingMovies ?? []),
      ...(input.remainingTv ?? []),
    ].sort((a: any, b: any) => Number(b.score) - Number(a.score));
    for (const entry of overflowPool) {
      if (picked.length >= targetTotal) break;
      const key = makeMediaKey(entry.candidate ?? entry);
      if (pickedKeys.has(key)) continue;
      pickedKeys.add(key);
      picked.push(entry);
    }
  }

  const { displayItems, reasonsMap } = mapRecommendationBatchToDisplayItems(
    picked,
    input.tasteMap,
    input.targetType
  );

  return {
    picked,
    explanation: balanced.explanation,
    displayItems,
    reasonsMap,
  };
}

/** Kısa listeyi yeniden puanlar; son önerilenler ve uygun olmayanlar elenir. */
export function rescoreShortlist(input: {
  readonly shortlist: readonly any[];
  readonly profile: TasteProfileV3;
  readonly savedItems: readonly SavedItem[];
  readonly preferences: Preferences;
  readonly genresMap: Record<number | string, string>;
  readonly tasteMap: PersistentTasteMapData | null;
  readonly serverTaste?: ServerTasteSignal | null;
  readonly semanticHints?: ReadonlyMap<string, number> | null;
  readonly now?: Date | number | string;
}): ScoredCandidateEntry[] {
  if (input.shortlist.length === 0) return [];
  const scored = scoreCandidatesV3(
    input.shortlist.map((entry: any) => entry.candidate ?? entry),
    input.profile,
    {
      weights: RECOMMENDATION_WEIGHTS_V3,
      genreNames: input.genresMap,
      mood: input.preferences.mood,
      tasteMap: input.tasteMap,
      serverTaste: toServerTasteInput(input.serverTaste),
      ...(input.now !== undefined ? { now: input.now } : {}),
    }
  );
  return applySemanticHints(
    filterOutLastRecommendedCandidates(scored, input.tasteMap?.lastRecommendedKeys ?? []).filter(
      (entry: any) =>
        isCandidateEligibleInPool(entry.candidate, [...input.savedItems], input.preferences)
    ),
    input.semanticHints
  ).sort((a: any, b: any) => b.score - a.score) as ScoredCandidateEntry[];
}
