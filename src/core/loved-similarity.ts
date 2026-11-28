/**
 * Sevilen Yapımlara Benzerlik (Loved Similarity) Motoru
 *
 * Adayın başlangıç kaynağı (seedSourceType) yerine; kullanıcının gerçekten sevdiği
 * (yüksek puanlı / tamamlanmış) yapımların özellik vektörleri ile adayın özellikleri
 * arasındaki çok boyutlu anlamsal benzerliği hesaplar:
 * 1. Tür benzerliği (Genre similarity - Dice katsayısı)
 * 2. Hikâye benzerliği (Story / Overview token örtüşmesi)
 * 3. Oyuncu kadrosu benzerliği (Cast overlap)
 * 4. Atmosfer / Yönetmen / Evren benzerliği (Director & Franchise affinity)
 * 5. Dönem / Zaman benzerliği (Release era proximity)
 *
 * AŞAMA 3 — B-03 performans notu:
 * Önceden her aday için TÜM sevilen yapımlar dolaşılıyor ve her karşılaştırmada
 * tür kimlikleri yeniden kanonikleştiriliyordu (O(aday × geçmiş)). Artık:
 * - Sevilen yapım özellikleri profilde bir kez hazırlanır,
 * - Tür/oyuncu/yönetmen/koleksiyon/anahtar kelime için ters indeks kurulur,
 * - Yalnızca gerçekten ortak özellik taşıyan yapımlar tam olarak karşılaştırılır,
 * - Ortak özellik taşımayan yapımların benzerliği analitik taban değerinden
 *   hesaplanır ve üst-N sonucu etkileyemeyecekleri kanıtlanırsa atlanır.
 *
 * Hızlı yol YALNIZCA sonucu değiştirmediği kanıtlandığında kullanılır: en iyi
 * eşleşme ve ilk üç benzerlik, ortak özellik taşımayan bir yapımın ulaşabileceği
 * üst sınırın üzerindeyse sonuç birebir aynıdır. Aksi halde tam (yavaş) yol
 * çalışır; yani çıktı eski algoritmayla her durumda aynıdır.
 */

import { canonicalGenreKeys } from './genre-matching.ts';

export interface LovedItemFeatures {
  key: string;
  id: number | string;
  media_type: string;
  title: string;
  genre_ids: number[];
  overviewTokens: Set<string>;
  castIds: number[];
  directorIds: number[];
  collectionId?: number;
  year?: number;
  weight: number;
  /**
   * Kanonik tür anahtarları (film/dizi taksonomisi birleşik). Profil kurulurken
   * bir kez hesaplanır; karşılaştırma sırasında yeniden üretilmez.
   */
  genreKeys?: string[];
}

export interface LovedSimBreakdown {
  matchedTitle: string;
  matchedKey: string;
  similarity: number;       // 0..1 birleşik benzerlik
  genreSim: number;         // 0..1 tür benzerliği
  storySim: number;         // 0..1 hikâye benzerliği
  castSim: number;          // 0..1 oyuncu benzerliği
  atmosphereSim: number;    // 0..1 atmosfer / yönetmen / evren benzerliği
  eraSim: number;           // 0..1 dönem benzerliği
}

export interface LovedSimMatchResult {
  score: number;            // 0..1 genel öneri sinyali
  breakdown: LovedSimBreakdown | null;
}

/** Bileşik benzerlik ağırlıkları (tek kaynak). */
const LOVED_SIM_WEIGHTS = Object.freeze({
  genre: 0.35,
  story: 0.25,
  cast: 0.15,
  atmosphere: 0.15,
  era: 0.10,
});

/** Ters indeksin altına inildiğinde indeks kurulumu maliyeti kazancı aşar. */
const FAST_PATH_MIN_ITEMS = 8;

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * 1. Tür Benzerliği (0..1)
 * İki yapımın tür kümesi arasındaki Dice katsayısı.
 */
export function calculateGenreSim(candGenres: number[], lovedGenres: number[]): number {
  if (!candGenres?.length || !lovedGenres?.length) return 0.5;
  // Film ve dizi tür kimlikleri ortak taksonomiye indirgenir: 878 (film) ile
  // 10765 (dizi) aynı "scifi" ailesinde eşleşir.
  const candKeys = canonicalGenreKeys(candGenres);
  const lovedKeys = canonicalGenreKeys(lovedGenres);
  if (candKeys.size === 0 || lovedKeys.size === 0) return 0.5;

  let shared = 0;
  for (const key of candKeys) {
    if (lovedKeys.has(key)) shared++;
  }
  if (shared === 0) return 0.05;
  return clamp01((2 * shared) / (candKeys.size + lovedKeys.size));
}

/**
 * 2. Hikâye Benzerliği (0..1)
 * Özet metinlerindeki anlamlı sözcük token örtüşmesi.
 */
export function calculateStorySim(
  candTokens: string[] | Set<string>,
  lovedTokens: Set<string>
): number {
  if (!lovedTokens || lovedTokens.size === 0) return 0.5;
  const tokenArr = Array.isArray(candTokens) ? candTokens : Array.from(candTokens || []);
  if (tokenArr.length === 0) return 0.5;

  let shared = 0;
  for (const t of tokenArr) {
    if (lovedTokens.has(t)) shared++;
  }
  if (shared === 0) return 0.15;
  const denominator = Math.max(1, Math.min(tokenArr.length, lovedTokens.size, 8));
  const ratio = shared / denominator;
  return clamp01(0.25 + 0.75 * Math.min(1, ratio));
}

/**
 * 3. Oyuncu Kadrosu Benzerliği (0..1)
 * Öne çıkan oyuncuların ortaklığı.
 */
export function calculateCastSim(candCastIds: number[], lovedCastIds: number[]): number {
  if (!candCastIds?.length || !lovedCastIds?.length) return 0.5;
  const lovedSet = new Set(lovedCastIds);
  let shared = 0;
  for (const id of candCastIds) {
    if (lovedSet.has(id)) shared++;
  }
  if (shared >= 2) return 0.95;
  if (shared === 1) return 0.80;
  return 0.15;
}

/**
 * 4. Atmosfer & Yönetmen / Evren Benzerliği (0..1)
 */
export function calculateAtmosphereSim(
  candDirectorIds: number[],
  lovedDirectorIds: number[],
  candCollectionId?: number,
  lovedCollectionId?: number
): number {
  if (candCollectionId && lovedCollectionId && candCollectionId === lovedCollectionId) {
    return 1.0;
  }
  if (candDirectorIds?.length && lovedDirectorIds?.length) {
    const lovedSet = new Set(lovedDirectorIds);
    if (candDirectorIds.some((id) => lovedSet.has(id))) {
      return 0.95;
    }
    return 0.35;
  }
  return 0.5;
}

/**
 * 5. Dönem Benzerliği (0..1)
 * Yapım yılları arasındaki yakınlık (25 yıllık pencere).
 */
export function calculateEraSim(candYear?: number, lovedYear?: number): number {
  if (!candYear || !lovedYear) return 0.5;
  const delta = Math.abs(candYear - lovedYear);
  return clamp01(Math.max(0, 1 - delta / 25));
}

// ---------------------------------------------------------------------------
// Önceden hazırlanmış özellikler + ters indeks (B-03)
// ---------------------------------------------------------------------------

interface PreparedLovedItem {
  readonly feature: LovedItemFeatures;
  readonly genreKeys: Set<string>;
  readonly castSet: Set<number>;
  readonly castIds: number[];
  readonly directorSet: Set<number>;
  readonly directorIds: number[];
  readonly tokenSet: Set<string>;
  readonly collectionId?: number;
  readonly year?: number;
  readonly weight: number;
}

interface CandidateFeatures {
  readonly genreKeys: Set<string>;
  readonly castIds: number[];
  readonly directorIds: number[];
  readonly tokenArr: string[];
  readonly tokenSet: Set<string>;
  readonly collectionId?: number;
  readonly year?: number;
}

interface NoMatchBucket {
  readonly hasGenres: boolean;
  readonly hasTokens: boolean;
  readonly hasCast: boolean;
  readonly hasDirectors: boolean;
  readonly indices: number[];
}

interface LovedSimilarityIndex {
  readonly source: readonly LovedItemFeatures[];
  readonly prepared: PreparedLovedItem[];
  readonly genrePostings: Map<string, number[]>;
  readonly castPostings: Map<number, number[]>;
  readonly directorPostings: Map<number, number[]>;
  readonly collectionPostings: Map<number, number[]>;
  readonly tokenPostings: Map<string, number[]>;
  readonly noMatchBuckets: NoMatchBucket[];
  readonly maxWeight: number;
  /** Aday başına paylaşılan özellik sayaçları; yalnızca dokunulan yuvalar sıfırlanır. */
  readonly genreCounts: Int32Array;
  readonly castCounts: Int32Array;
  readonly directorCounts: Int32Array;
  readonly tokenCounts: Int32Array;
  readonly collectionFlags: Uint8Array;
}

export interface LovedSimilarityStatsSnapshot {
  /** Tam olarak karşılaştırılan (aday, sevilen yapım) çifti sayısı. */
  comparisons: number;
  /** Ters indekslerin ürettiği, ön elemeden geçen çift sayısı. */
  indexedComparisons: number;
  /** Ortak özellik taşımadığı için analitik taban değerle hesaplanan çift sayısı. */
  analyticComparisons: number;
  /** Tam (yavaş) yola düşülen aday sayısı. */
  fallbackCandidates: number;
  indexBuilds: number;
  candidateFeatureBuilds: number;
}

const stats: LovedSimilarityStatsSnapshot = {
  comparisons: 0,
  indexedComparisons: 0,
  analyticComparisons: 0,
  fallbackCandidates: 0,
  indexBuilds: 0,
  candidateFeatureBuilds: 0,
};

export function resetLovedSimilarityStats(): void {
  stats.comparisons = 0;
  stats.indexedComparisons = 0;
  stats.analyticComparisons = 0;
  stats.fallbackCandidates = 0;
  stats.indexBuilds = 0;
  stats.candidateFeatureBuilds = 0;
}

export function getLovedSimilarityStats(): LovedSimilarityStatsSnapshot {
  return { ...stats };
}

let indexCache = new WeakMap<readonly LovedItemFeatures[], LovedSimilarityIndex>();

/** Testler ve profil değişimleri için: kimlik önbelleğini bırakır. */
export function clearLovedSimilarityIndexCache(): void {
  indexCache = new WeakMap();
}

function prepareLovedItem(feature: LovedItemFeatures): PreparedLovedItem {
  const genreKeys = new Set(
    Array.isArray(feature.genreKeys)
      ? feature.genreKeys
      : Array.from(canonicalGenreKeys(feature.genre_ids || []))
  );
  const castIds = Array.isArray(feature.castIds) ? feature.castIds : [];
  const directorIds = Array.isArray(feature.directorIds) ? feature.directorIds : [];
  const rawWeight = Number(feature.weight);
  return {
    feature,
    genreKeys,
    castIds,
    castSet: new Set(castIds),
    directorIds,
    directorSet: new Set(directorIds),
    tokenSet: feature.overviewTokens instanceof Set ? feature.overviewTokens : new Set(feature.overviewTokens || []),
    collectionId: feature.collectionId,
    year: feature.year,
    weight: Number.isFinite(rawWeight) && rawWeight > 0 ? Math.min(1, rawWeight) : 1,
  };
}

function byKey<T>(list: T[], visit: (value: T) => void): void {
  if (!Array.isArray(list) || list.length === 0) return;
  if (list.length === 1) {
    visit(list[0]);
    return;
  }
  for (const value of new Set(list)) visit(value);
}

function addPosting<T>(map: Map<T, number[]>, key: T, index: number): void {
  const list = map.get(key);
  if (list) list.push(index);
  else map.set(key, [index]);
}

function buildLovedIndex(source: readonly LovedItemFeatures[]): LovedSimilarityIndex {
  const prepared = source.map(prepareLovedItem);
  const genrePostings = new Map<string, number[]>();
  const castPostings = new Map<number, number[]>();
  const directorPostings = new Map<number, number[]>();
  const collectionPostings = new Map<number, number[]>();
  const tokenPostings = new Map<string, number[]>();
  const buckets = new Map<number, NoMatchBucket>();
  let maxWeight = 0;

  prepared.forEach((item, index) => {
    for (const key of item.genreKeys) addPosting(genrePostings, key, index);
    for (const id of item.castSet) addPosting(castPostings, id, index);
    for (const id of item.directorSet) addPosting(directorPostings, id, index);
    if (item.collectionId) addPosting(collectionPostings, item.collectionId, index);
    for (const token of item.tokenSet) addPosting(tokenPostings, token, index);
    if (item.weight > maxWeight) maxWeight = item.weight;

    const flags =
      (item.genreKeys.size > 0 ? 1 : 0) |
      (item.tokenSet.size > 0 ? 2 : 0) |
      (item.castSet.size > 0 ? 4 : 0) |
      (item.directorSet.size > 0 ? 8 : 0);
    let bucket = buckets.get(flags);
    if (!bucket) {
      bucket = {
        hasGenres: (flags & 1) !== 0,
        hasTokens: (flags & 2) !== 0,
        hasCast: (flags & 4) !== 0,
        hasDirectors: (flags & 8) !== 0,
        indices: [],
      };
      buckets.set(flags, bucket);
    }
    bucket.indices.push(index);
  });

  stats.indexBuilds += 1;

  return {
    source,
    prepared,
    genrePostings,
    castPostings,
    directorPostings,
    collectionPostings,
    tokenPostings,
    noMatchBuckets: Array.from(buckets.values()),
    maxWeight,
    genreCounts: new Int32Array(prepared.length),
    castCounts: new Int32Array(prepared.length),
    directorCounts: new Int32Array(prepared.length),
    tokenCounts: new Int32Array(prepared.length),
    collectionFlags: new Uint8Array(prepared.length),
  };
}

function getLovedIndex(source: readonly LovedItemFeatures[]): LovedSimilarityIndex {
  const cached = indexCache.get(source);
  if (cached && cached.source === source && cached.prepared.length === source.length) {
    return cached;
  }
  const built = buildLovedIndex(source);
  indexCache.set(source, built);
  return built;
}

function prepareCandidate(candidate: any, tokens?: string[]): CandidateFeatures {
  stats.candidateFeatureBuilds += 1;
  const rawGenres: number[] = Array.isArray(candidate?.genre_ids)
    ? candidate.genre_ids.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
    : Array.isArray(candidate?.genres)
    ? candidate.genres.map((g: any) => Number(typeof g === 'object' ? g?.id : g)).filter((n: number) => Number.isFinite(n) && n > 0)
    : [];

  const rawCast: any[] = Array.isArray(candidate?.cast) ? candidate.cast : [];
  const castIds: number[] = rawCast
    .slice(0, 10)
    .map((c: any) => Number(c?.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);

  const rawCrew: any[] = Array.isArray(candidate?.crew) ? candidate.crew : [];
  const directorIds: number[] = rawCrew
    .filter((m: any) => m && (m.job === 'Director' || m.job === 'Creator'))
    .map((m: any) => Number(m.id))
    .filter((id: number) => Number.isFinite(id) && id > 0);
  if (candidate?.director?.id && !directorIds.includes(Number(candidate.director.id))) {
    const dId = Number(candidate.director.id);
    if (Number.isFinite(dId) && dId > 0) directorIds.push(dId);
  }

  const dateStr = candidate?.release_date || candidate?.first_air_date;
  const year = typeof dateStr === 'string' && /^\d{4}/.test(dateStr)
    ? parseInt(dateStr.slice(0, 4), 10)
    : undefined;

  const collectionId = candidate?.belongs_to_collection?.id
    ? Number(candidate.belongs_to_collection.id)
    : undefined;

  const tokenArr = Array.isArray(tokens)
    ? tokens
    : Array.isArray(candidate?._extractedTokens)
    ? candidate._extractedTokens
    : typeof candidate?.overview === 'string'
    ? candidate.overview.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []
    : [];

  return {
    genreKeys: canonicalGenreKeys(rawGenres),
    castIds,
    directorIds,
    tokenArr,
    tokenSet: new Set(tokenArr),
    collectionId,
    year,
  };
}

/** Hazır özellikler üzerinden birebir aynı formülleri uygular (eski yol). */
function scorePreparedPair(
  cand: CandidateFeatures,
  loved: PreparedLovedItem,
  tokens: string[]
): { similarity: number; genreSim: number; storySim: number; castSim: number; atmosphereSim: number; eraSim: number } {
  const genreSim =
    cand.genreKeys.size === 0 || loved.genreKeys.size === 0
      ? 0.5
      : (() => {
          let shared = 0;
          for (const key of cand.genreKeys) {
            if (loved.genreKeys.has(key)) shared++;
          }
          if (shared === 0) return 0.05;
          return clamp01((2 * shared) / (cand.genreKeys.size + loved.genreKeys.size));
        })();

  const storySim = calculateStorySim(tokens, loved.tokenSet);
  const castSim = calculateCastSim(cand.castIds, loved.castIds);
  const atmosphereSim = calculateAtmosphereSim(
    cand.directorIds,
    loved.directorIds,
    cand.collectionId,
    loved.collectionId
  );
  const eraSim = calculateEraSim(cand.year, loved.year);

  const similarity = clamp01(
    LOVED_SIM_WEIGHTS.genre * genreSim +
      LOVED_SIM_WEIGHTS.story * storySim +
      LOVED_SIM_WEIGHTS.cast * castSim +
      LOVED_SIM_WEIGHTS.atmosphere * atmosphereSim +
      LOVED_SIM_WEIGHTS.era * eraSim
  );

  return {
    similarity: Math.round(similarity * 1000) / 1000,
    genreSim: Math.round(genreSim * 1000) / 1000,
    storySim: Math.round(storySim * 1000) / 1000,
    castSim: Math.round(castSim * 1000) / 1000,
    atmosphereSim: Math.round(atmosphereSim * 1000) / 1000,
    eraSim: Math.round(eraSim * 1000) / 1000,
  };
}

function breakdownFor(item: PreparedLovedItem, values: ReturnType<typeof scorePreparedPair>): LovedSimBreakdown {
  return {
    matchedTitle: item.feature.title,
    matchedKey: item.feature.key,
    similarity: values.similarity,
    genreSim: values.genreSim,
    storySim: values.storySim,
    castSim: values.castSim,
    atmosphereSim: values.atmosphereSim,
    eraSim: values.eraSim,
  };
}

/**
 * Aday ile belirli bir sevilen yapım arasındaki birleşik benzerliği hesaplar.
 */
export function computeItemToItemLovedSim(
  cand: {
    genre_ids?: number[];
    tokens?: string[] | Set<string>;
    castIds?: number[];
    directorIds?: number[];
    collectionId?: number;
    year?: number;
  },
  loved: LovedItemFeatures
): LovedSimBreakdown {
  const rawGenres = Array.isArray(cand.genre_ids) ? cand.genre_ids : [];
  const tokenArr = Array.isArray(cand.tokens)
    ? cand.tokens
    : Array.from(cand.tokens instanceof Set ? cand.tokens : []);
  const preparedCand: CandidateFeatures = {
    genreKeys: canonicalGenreKeys(rawGenres),
    castIds: Array.isArray(cand.castIds) ? cand.castIds : [],
    directorIds: Array.isArray(cand.directorIds) ? cand.directorIds : [],
    tokenArr,
    tokenSet: new Set(tokenArr),
    collectionId: cand.collectionId,
    year: cand.year,
  };
  const preparedLoved = prepareLovedItem(loved);
  return breakdownFor(preparedLoved, scorePreparedPair(preparedCand, preparedLoved, tokenArr));
}

function pushTopSimilarity(
  list: Array<{ similarity: number; weight: number }>,
  similarity: number,
  weight: number
): void {
  if (list.length === 3 && similarity <= list[2].similarity) return;
  let insertAt = list.length;
  while (insertAt > 0 && list[insertAt - 1].similarity < similarity) insertAt -= 1;
  list.splice(insertAt, 0, { similarity, weight });
  if (list.length > 3) list.length = 3;
}

/**
 * Bir adayı kullanıcının tüm sevilen yapımlarıyla karşılaştırıp en yüksek uyumlu yapımı
 * ve genel sevilen benzerlik puanını (lovedSimScore) hesaplar.
 */
export function computeLovedSimilarityScore(
  candidate: any,
  lovedItems: LovedItemFeatures[],
  precomputedTokens?: string[]
): LovedSimMatchResult {
  if (!lovedItems || lovedItems.length === 0) {
    return { score: 0.5, breakdown: null };
  }

  const cand = prepareCandidate(candidate, precomputedTokens);
  const tokens = cand.tokenArr;

  if (lovedItems.length < FAST_PATH_MIN_ITEMS) {
    return bruteForceLovedSimilarity(cand, lovedItems, tokens);
  }

  const index = getLovedIndex(lovedItems);
  const touched: number[] = [];
  const seenIdx = new Uint8Array(index.prepared.length);

  const markTouched = (idx: number) => {
    if (seenIdx[idx] === 0) {
      seenIdx[idx] = 1;
      touched.push(idx);
    }
  };

  for (const key of cand.genreKeys) {
    const posting = index.genrePostings.get(key);
    if (!posting) continue;
    for (const idx of posting) {
      index.genreCounts[idx] += 1;
      markTouched(idx);
    }
  }
  const castMultiplicity = new Map<number, number>();
  for (const id of cand.castIds) castMultiplicity.set(id, (castMultiplicity.get(id) || 0) + 1);
  for (const [id, occurrences] of castMultiplicity) {
    const posting = index.castPostings.get(id);
    if (!posting) continue;
    for (const idx of posting) {
      index.castCounts[idx] += occurrences;
      markTouched(idx);
    }
  }
  byKey(cand.directorIds, (id) => {
    const posting = index.directorPostings.get(id);
    if (!posting) return;
    for (const idx of posting) {
      index.directorCounts[idx] += 1;
      markTouched(idx);
    }
  });
  if (cand.collectionId) {
    const posting = index.collectionPostings.get(cand.collectionId);
    if (posting) {
      for (const idx of posting) {
        index.collectionFlags[idx] = 1;
        markTouched(idx);
      }
    }
  }
  const tokenMultiplicity = new Map<string, number>();
  for (const token of cand.tokenArr) {
    tokenMultiplicity.set(token, (tokenMultiplicity.get(token) || 0) + 1);
  }
  for (const [token, occurrences] of tokenMultiplicity) {
    const posting = index.tokenPostings.get(token);
    if (!posting) continue;
    for (const idx of posting) {
      index.tokenCounts[idx] += occurrences;
      markTouched(idx);
    }
  }

  let bestContribution = -1;
  let bestSimilarity = -1;
  let bestIndex = -1;
  const topSimilarities: Array<{ similarity: number; weight: number }> = [];

  // Eşit katkı/benzerlikte eski algoritma dizideki İLK yapımı seçiyordu; aynı
  // sonucu korumak için indeks sırasına göre geziyoruz.
  touched.sort((a, b) => a - b);

  const candGenreSize = cand.genreKeys.size;
  const candTokenLength = cand.tokenArr.length;
  const candCastLength = cand.castIds.length;
  const candDirectorLength = cand.directorIds.length;

  for (const idx of touched) {
    const item = index.prepared[idx];
    const sharedGenres = index.genreCounts[idx];
    const genreSim =
      candGenreSize === 0 || item.genreKeys.size === 0
        ? 0.5
        : sharedGenres === 0
        ? 0.05
        : clamp01((2 * sharedGenres) / (candGenreSize + item.genreKeys.size));

    const sharedTokens = index.tokenCounts[idx];
    const storySim =
      item.tokenSet.size === 0 || candTokenLength === 0
        ? 0.5
        : sharedTokens === 0
        ? 0.15
        : clamp01(
            0.25 +
              0.75 *
                Math.min(1, sharedTokens / Math.max(1, Math.min(candTokenLength, item.tokenSet.size, 8)))
          );

    const sharedCast = index.castCounts[idx];
    const castSim =
      candCastLength === 0 || item.castIds.length === 0
        ? 0.5
        : sharedCast >= 2
        ? 0.95
        : sharedCast === 1
        ? 0.80
        : 0.15;

    let atmosphereSim: number;
    if (index.collectionFlags[idx] === 1) {
      atmosphereSim = 1.0;
    } else if (candDirectorLength > 0 && item.directorIds.length > 0) {
      atmosphereSim = index.directorCounts[idx] > 0 ? 0.95 : 0.35;
    } else {
      atmosphereSim = 0.5;
    }

    const eraSim = calculateEraSim(cand.year, item.year);
    const similarity =
      Math.round(
        clamp01(
          LOVED_SIM_WEIGHTS.genre * genreSim +
            LOVED_SIM_WEIGHTS.story * storySim +
            LOVED_SIM_WEIGHTS.cast * castSim +
            LOVED_SIM_WEIGHTS.atmosphere * atmosphereSim +
            LOVED_SIM_WEIGHTS.era * eraSim
        ) * 1000
      ) / 1000;

    stats.comparisons += 1;
    stats.indexedComparisons += 1;
    const contribution = similarity * item.weight;
    if (
      contribution > bestContribution ||
      (contribution === bestContribution && similarity > bestSimilarity) ||
      (contribution === bestContribution && similarity === bestSimilarity && idx < bestIndex)
    ) {
      bestContribution = contribution;
      bestSimilarity = similarity;
      bestIndex = idx;
    }
    pushTopSimilarity(topSimilarities, similarity, item.weight);
  }

  // Ortak özellik taşımayan yapımların ulaşabileceği en yüksek benzerlik:
  // her boyutun taban değeri + dönem benzerliğinin en yüksek değeri (1.0).
  const noMatchBase = (bucket: NoMatchBucket): number => {
    const fg = cand.genreKeys.size > 0 && bucket.hasGenres ? 0.05 : 0.5;
    const fs = cand.tokenArr.length > 0 && bucket.hasTokens ? 0.15 : 0.5;
    const fc = cand.castIds.length > 0 && bucket.hasCast ? 0.15 : 0.5;
    const fa = cand.directorIds.length > 0 && bucket.hasDirectors ? 0.35 : 0.5;
    return (
      LOVED_SIM_WEIGHTS.genre * fg +
      LOVED_SIM_WEIGHTS.story * fs +
      LOVED_SIM_WEIGHTS.cast * fc +
      LOVED_SIM_WEIGHTS.atmosphere * fa
    );
  };

  let nonMatchBound = 0;
  for (const bucket of index.noMatchBuckets) {
    const bound = noMatchBase(bucket) + LOVED_SIM_WEIGHTS.era;
    if (bound > nonMatchBound) nonMatchBound = bound;
  }
  nonMatchBound = clamp01(nonMatchBound);

  // Hızlı yol yalnızca sonucu değiştiremeyeceği KANITLANDIĞINDA kullanılır:
  // en iyi eşleşme ve ilk üç benzerliğin tümü, ortak özellik taşımayan bir
  // yapımın ulaşabileceği üst sınırın kesinlikle üzerinde olmalı.
  const fastPathSafe =
    lovedItems.length >= 4 &&
    touched.length >= 3 &&
    bestSimilarity > nonMatchBound &&
    topSimilarities[2].similarity > nonMatchBound;

  if (!fastPathSafe) {
    stats.fallbackCandidates += 1;
    for (const bucket of index.noMatchBuckets) {
      const base = noMatchBase(bucket);
      for (const idx of bucket.indices) {
        if (seenIdx[idx] === 1) continue;
        const item = index.prepared[idx];
        const eraSim = calculateEraSim(cand.year, item.year);
        const similarity = Math.round(clamp01(base + LOVED_SIM_WEIGHTS.era * eraSim) * 1000) / 1000;
        stats.comparisons += 1;
        stats.analyticComparisons += 1;
        const contribution = similarity * item.weight;
        if (
          contribution > bestContribution ||
          (contribution === bestContribution && similarity > bestSimilarity) ||
          (contribution === bestContribution && similarity === bestSimilarity && idx < bestIndex)
        ) {
          bestContribution = contribution;
          bestSimilarity = similarity;
          bestIndex = idx;
        }
        pushTopSimilarity(topSimilarities, similarity, item.weight);
      }
    }
  } else {
    stats.analyticComparisons += Math.max(0, index.prepared.length - touched.length);
  }

  // Sonraki aday için sayaçları temizle (yalnızca dokunulan yuvalar).
  for (const idx of touched) {
    index.genreCounts[idx] = 0;
    index.castCounts[idx] = 0;
    index.directorCounts[idx] = 0;
    index.tokenCounts[idx] = 0;
    index.collectionFlags[idx] = 0;
  }

  if (bestIndex < 0) {
    return { score: 0.5, breakdown: null };
  }

  let breakdown: LovedSimBreakdown;
  if (seenIdx[bestIndex] === 1) {
    breakdown = breakdownFor(index.prepared[bestIndex], scorePreparedPair(cand, index.prepared[bestIndex], tokens));
  } else {
    const item = index.prepared[bestIndex];
    const bucket: NoMatchBucket = {
      hasGenres: item.genreKeys.size > 0,
      hasTokens: item.tokenSet.size > 0,
      hasCast: item.castIds.length > 0,
      hasDirectors: item.directorIds.length > 0,
      indices: [],
    };
    const base = noMatchBase(bucket);
    const eraSim = calculateEraSim(cand.year, item.year);
    const similarity = Math.round(clamp01(base + LOVED_SIM_WEIGHTS.era * eraSim) * 1000) / 1000;
    breakdown = {
      matchedTitle: item.feature.title,
      matchedKey: item.feature.key,
      similarity,
      genreSim: Math.round((item.genreKeys.size > 0 && cand.genreKeys.size > 0 ? 0.05 : 0.5) * 1000) / 1000,
      storySim: Math.round((item.tokenSet.size > 0 && cand.tokenArr.length > 0 ? 0.15 : 0.5) * 1000) / 1000,
      castSim: Math.round((item.castIds.length > 0 && cand.castIds.length > 0 ? 0.15 : 0.5) * 1000) / 1000,
      atmosphereSim: Math.round((item.directorIds.length > 0 && cand.directorIds.length > 0 ? 0.35 : 0.5) * 1000) / 1000,
      eraSim: Math.round(eraSim * 1000) / 1000,
    };
  }

  // Çoklu sevilen yapım varsa, tepe benzerliği (%80) ile en iyi ilk 3'ün
  // ağırlıklı ortalamasını (%20) harmanla.
  const top3Weight = topSimilarities.reduce((s, e) => s + e.weight, 0);
  const top3Avg =
    top3Weight > 0
      ? topSimilarities.reduce((s, e) => s + e.similarity * e.weight, 0) / top3Weight
      : topSimilarities.length > 0
      ? topSimilarities.reduce((s, e) => s + e.similarity, 0) / topSimilarities.length
      : 0;
  const finalScore =
    lovedItems.length >= 2
      ? clamp01(0.80 * breakdown.similarity + 0.20 * top3Avg)
      : breakdown.similarity;

  return {
    score: clamp01(finalScore),
    breakdown,
  };
}

/** Tam karşılaştırma (indeks yok / küçük liste / güvenli değil). */
function bruteForceLovedSimilarity(
  cand: CandidateFeatures,
  lovedItems: LovedItemFeatures[],
  tokens: string[]
): LovedSimMatchResult {
  const scored: Array<{ similarity: number; weight: number; breakdown: LovedSimBreakdown }> = [];
  for (const feature of lovedItems) {
    const prepared = prepareLovedItem(feature);
    const values = scorePreparedPair(cand, prepared, tokens);
    stats.comparisons += 1;
    scored.push({
      similarity: values.similarity,
      weight: prepared.weight,
      breakdown: breakdownFor(prepared, values),
    });
  }
  return finalizeScoredList(scored, lovedItems.length);
}

function finalizeScoredList(
  scored: Array<{ similarity: number; weight: number; breakdown: LovedSimBreakdown }>,
  totalLoved: number
): LovedSimMatchResult {
  if (scored.length === 0) return { score: 0.5, breakdown: null };

  let bestEntry = scored[0];
  for (const entry of scored) {
    const candidateContribution = entry.similarity * entry.weight;
    const bestContribution = bestEntry.similarity * bestEntry.weight;
    if (
      candidateContribution > bestContribution ||
      (candidateContribution === bestContribution && entry.similarity > bestEntry.similarity)
    ) {
      bestEntry = entry;
    }
  }
  const bestMatch = bestEntry.breakdown;

  const top3 = [...scored].sort((a, b) => b.similarity - a.similarity).slice(0, 3);
  const top3Weight = top3.reduce((s, e) => s + e.weight, 0);
  const top3Avg =
    top3Weight > 0
      ? top3.reduce((s, e) => s + e.similarity * e.weight, 0) / top3Weight
      : top3.reduce((s, e) => s + e.similarity, 0) / top3.length;
  const finalScore = totalLoved >= 2
    ? clamp01(0.80 * bestMatch.similarity + 0.20 * top3Avg)
    : bestMatch.similarity;

  return { score: clamp01(finalScore), breakdown: bestMatch };
}
