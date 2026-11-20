/**
 * MIA Faz 6 — Öneri Motoru (bağımsız yönetici).
 *
 * Taşınan kaynak: `src/core/recommendation-orchestrator.ts`. Algoritma
 * DEĞİŞTİRİLMEDİ; aynı girdi aynı puanı üretir (kanıt:
 * `tests/phase6-recommendation-manager.test.mjs` önce/sonra karşılaştırması).
 *
 * SINIRLAR (kullanıcı planı §1 Yönetici 6, §4):
 * - Kullanıcı hafızasına (kanıt defteri, kütüphane kayıtları) YAZMAZ.
 * - Yalnızca Zevk Haritası/profil özetini ve katalog adaylarını okur; ürettiği
 *   türetilmiş profil paketini çağıran katman kalıcılaştırır.
 * - Saf hesaplama `src/core/` içinde kalır; bu yönetici orkestrasyon ve
 *   gösterim/açıklama sınırlarını sahiplenir.
 */

import {
  ALGORITHM_VERSION,
  buildTasteProfileV3,
  calculateTastePillars,
  inferLifecycleRing,
  isCandidateEligibleInPool,
  isItemSaved,
  RECOMMENDATION_WEIGHTS_V3,
  scoreCandidatesV3,
  type PersistentTasteMapData,
  type Preferences,
  type SavedItem,
  type TasteMapEntry,
  type TasteRing,
} from '../../core/cinetrack-core.ts';
import { canonicalizeMediaKey, makeMediaKey, parseMediaKey } from '../../core/keys.ts';
import {
  computeSourceCatalogSignature,
  DERIVED_PROFILE_SCHEMA_VERSION,
  validateDerivedProfileCache,
  type DerivedCacheInvalidReason,
  type DerivedProfileCacheDocument,
} from '../../core/derived-profile-cache.ts';
import { enforceStrictMediaTypePool } from './CandidatePoolManager.ts';
import { resolveDisplayedLifecycleRing } from './ExplanationManager.ts';
import { genreMetricIdFor, type ServerTasteSignal } from './taste-signal.ts';

/**
 * Keşfet sekmelerindeki (Gündemdekiler, Gizli Cevherler, Popüler vb.) içerikleri
 * kullanıcının Zevk Haritası ve puanlarıyla zenginleştirir (`ring1` ezilmeden).
 */
export function enrichCatalogItemsWithTaste(params: {
  items: any[];
  savedItems: SavedItem[];
  preferences: Preferences;
  genresMap: Record<number, string>;
  tasteMap?: PersistentTasteMapData | null;
  /**
   * Sunucu zevk profili sinyali (Faz 1/2 metrik motoru). Verildiğinde tür/ruh
   * hâli puanına sınırlı ağırlıkla katılır; verilmezse davranış birebir eskidir.
   */
  serverTaste?: ServerTasteSignal | null;
  /**
   * Faz 6: Referans zamanı. Öneri puanlaması zaman duyarlıdır (tazelik/bağlam);
   * önce/sonra karşılaştırma testinin deterministik olması için dışarıdan
   * verilebilir. Verilmezse mevcut davranış (güncel zaman) korunur.
   */
  now?: Date | number | string;
  /** Faz 6: Gölge modda taste adapter (TP-037). Sıralama değişmez, sadece loglanır. */
  tasteAdapter?: {
    logFit?: (contentId: string, fit: number, confidence: string) => void;
  };
}): any[] {
  const { items, savedItems, preferences, genresMap, tasteMap, now, serverTaste } = params;
  if (!Array.isArray(items) || items.length === 0) return items;

  const tasteProfile = buildTasteProfileV3(savedItems, {
    lambda: 1,
    dislikedKeys: preferences.disliked,
    ...(now !== undefined ? { now: new Date(now).getTime() } : {}),
  });
  const scored = scoreCandidatesV3(items, tasteProfile, {
    weights: RECOMMENDATION_WEIGHTS_V3,
    genreNames: genresMap,
    mood: preferences.mood,
    tasteMap: tasteMap || undefined,
    ...(serverTaste
      ? {
          serverTaste: {
            confidence: serverTaste.confidence,
            genreAffinity: serverTaste.genreAffinity,
            moodAffinity: serverTaste.moodAffinity,
            metricIdFor: genreMetricIdFor,
          },
        }
      : {}),
    ...(now !== undefined ? { now } : {}),
  });

  return scored.map((s) => {
    const cand = s.candidate || s;
    const key = canonicalizeMediaKey(makeMediaKey(cand));
    const mapEntry = tasteMap?.entries?.[key] || tasteMap?.archivedEntries?.[key];
    const tasteScore =
      mapEntry?.tasteScore ??
      mapEntry?.matchScore ??
      Math.max(1, Math.min(100, Math.round(Number(s.tasteScore || s.score || s.rawScore || cand.tasteScore) || 75)));
    const resolvedRing: TasteRing = resolveDisplayedLifecycleRing(s, tasteMap);

    return {
      ...cand,
      tasteScore,
      matchScore: tasteScore,
      priorityScore: mapEntry?.priorityScore ?? s.priorityScore ?? tasteScore,
      tags: s.tags || cand.tags || [],
      ring: resolvedRing,
      lifecycleRing: resolvedRing,
      tasteMapEntry: mapEntry,
    };
  });
}

/**
 * Sunucudan okunan türetilmiş profil önbelleğini (`DerivedProfileDocument`) doğrular ve
 * geçerliyse yerel `PersistentTasteMapData` içine kaynak doğruluğunu (kullanıcı listeleri/tercihleri)
 * bozmadan aktarır. `forceRefresh === true` olduğunda veya sürüm/imza uyuşmadığında önbelleği reddeder.
 */
export function hydrateTasteMapWithDerivedCache(params: {
  tasteMap: PersistentTasteMapData;
  derivedDoc: any;
  profileId: string;
  profileFingerprint: string;
  algorithmVersion?: string;
  sourceCatalogHash?: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  catalogLookup?: Record<string, any>;
  forceRefresh?: boolean;
}): {
  cacheHit: boolean;
  reason?: DerivedCacheInvalidReason | 'force_refresh';
  tasteMap: PersistentTasteMapData;
  validatedDocument?: DerivedProfileCacheDocument;
  hydratedCount: number;
} {
  const {
    tasteMap,
    derivedDoc,
    profileId,
    profileFingerprint,
    algorithmVersion = ALGORITHM_VERSION,
    sourceCatalogHash,
    savedItems,
    preferences,
    catalogLookup = {},
    forceRefresh = false,
  } = params;

  if (forceRefresh) {
    return {
      cacheHit: false,
      reason: 'force_refresh',
      tasteMap,
      hydratedCount: 0,
    };
  }

  const validation = validateDerivedProfileCache(derivedDoc, {
    profileId,
    profileFingerprint,
    algorithmVersion,
    sourceCatalogHash,
    expectedSchemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
  });

  if (!validation.valid) {
    return {
      cacheHit: false,
      reason: validation.reason,
      tasteMap,
      hydratedCount: 0,
    };
  }

  const validDoc = validation.document;
  const nextEntries: Record<string, TasteMapEntry> = { ...(tasteMap.entries || {}) };
  const lastKeys = Array.isArray(tasteMap.lastRecommendedKeys) ? tasteMap.lastRecommendedKeys : [];
  let hydratedCount = 0;

  for (const [rawKey, cachedItem] of Object.entries(validDoc.items)) {
    const key = canonicalizeMediaKey(cachedItem.mediaKey || rawKey);
    const parsed = parseMediaKey(key);
    if (!parsed) continue;

    const existing = nextEntries[key];
    const catalogMeta = catalogLookup[key];
    const mediaType = parsed.type;
    const numericId = Number(parsed.id);
    if (!Number.isSafeInteger(numericId) || numericId <= 0) continue;

    // Önbellek asla kullanıcı listelerinin/tercihlerinin doğruluk kaynağı olamaz; güncel durumu hesapla
    const saved = isItemSaved(savedItems, { id: numericId, media_type: mediaType }, mediaType);
    const disliked = Boolean(preferences.disliked?.some((k) => canonicalizeMediaKey(k) === key));
    const hidden = Boolean(preferences.hidden?.some((k) => canonicalizeMediaKey(k) === key));
    const liveStatus: 'active' | 'saved' | 'disliked' | 'hidden' = saved
      ? 'saved'
      : disliked
      ? 'disliked'
      : hidden
      ? 'hidden'
      : 'active';

    const shownCount = existing?.shownCount ?? cachedItem.shownCount ?? 0;
    const skippedCount = existing?.skippedCount ?? cachedItem.skippedCount ?? 0;
    const demotionPenalty = existing?.demotionPenalty ?? cachedItem.demotionPenalty ?? 0;
    const tasteScore = cachedItem.tasteScore ?? cachedItem.matchScore;
    const priorityScore =
      cachedItem.priorityScore ?? Math.max(1, Math.min(100, Math.round(tasteScore - demotionPenalty)));

    const inferredRing = inferLifecycleRing(
      key,
      {
        shownCount,
        skippedCount,
        lastShownAt: existing?.lastShownAt ?? null,
      },
      lastKeys
    );
    const resolvedRing =
      inferredRing !== 'ring0'
        ? inferredRing
        : isValidLifecycleRing(cachedItem.lifecycleRing)
        ? cachedItem.lifecycleRing
        : 'ring0';

    nextEntries[key] = {
      mediaKey: key,
      mediaType,
      id: numericId,
      title: existing?.title || catalogMeta?.title || catalogMeta?.name || '',
      poster_path: existing?.poster_path ?? catalogMeta?.poster_path ?? null,
      backdrop_path: existing?.backdrop_path ?? catalogMeta?.backdrop_path ?? null,
      vote_average: Number(existing?.vote_average ?? catalogMeta?.vote_average ?? 0),
      popularity: Number(existing?.popularity ?? catalogMeta?.popularity ?? 0),
      genre_ids: Array.isArray(existing?.genre_ids)
        ? existing.genre_ids
        : Array.isArray(catalogMeta?.genre_ids)
        ? catalogMeta.genre_ids
        : [],
      release_date: existing?.release_date || catalogMeta?.release_date,
      first_air_date: existing?.first_air_date || catalogMeta?.first_air_date,
      overview: existing?.overview || catalogMeta?.overview || '',
      matchScore: cachedItem.matchScore,
      tasteScore,
      priorityScore,
      rawScore: existing?.rawScore ?? tasteScore,
      ring: resolvedRing,
      initialRing: 'ring0',
      pillars:
        cachedItem.pillars ||
        existing?.pillars ||
        calculateTastePillars(cachedItem.signals || existing?.parts || {}),
      parts: cachedItem.signals || existing?.parts || {},
      tags: cachedItem.reasons || existing?.tags || [],
      shownCount,
      skippedCount,
      ringDemotions: existing?.ringDemotions ?? 0,
      demotionPenalty,
      firstShownAt: existing?.firstShownAt ?? null,
      lastShownAt: existing?.lastShownAt ?? null,
      lastScoredAt: cachedItem.calculatedAt || existing?.lastScoredAt || new Date().toISOString(),
      archivedImpressionCount: existing?.archivedImpressionCount ?? 0,
      impressionHistory: existing?.impressionHistory ?? [],
      status: liveStatus,
      isArchived: false,
      archivedAt: null,
      scoreCoverage: cachedItem.scoreCoverage || existing?.scoreCoverage || 'basic',
      confidenceLevel:
        (cachedItem.scoreCoverage || existing?.scoreCoverage) === 'enriched' ? 'high' : 'standard',
    };
    hydratedCount++;
  }

  // Kaynak doğrulama: Hâlihazırda listede veya gizli olan öğeler vitrin önbelleğinde kalamaz
  const sanitizedBalanced = Array.isArray(tasteMap.cachedBalancedItems)
    ? tasteMap.cachedBalancedItems.filter((item: any) =>
        isCandidateEligibleInPool(item?.candidate || item, savedItems, preferences)
      )
    : undefined;

  return {
    cacheHit: true,
    tasteMap: {
      ...tasteMap,
      profileId,
      profileSignature: profileFingerprint,
      algorithmVersion,
      entries: nextEntries,
      ...(sanitizedBalanced !== undefined ? { cachedBalancedItems: sanitizedBalanced } : {}),
    },
    validatedDocument: validDoc,
    hydratedCount,
  };
}

function isValidLifecycleRing(val: unknown): val is 'ring0' | 'ring1' | 'ring2' {
  return val === 'ring0' || val === 'ring1' || val === 'ring2';
}

/**
 * Kalıcı `PersistentTasteMapData` üzerinden sunucudaki `data/profiles/<profileId>.json`
 * dosyasına yazılacak şema-2 uyumlu türetilmiş veri paketini oluşturur.
 */
export function buildDerivedProfilePayloadFromTasteMap(params: {
  profileId: string;
  tasteMap: PersistentTasteMapData;
  profileFingerprint: string;
  algorithmVersion?: string;
  sourceCatalogHash?: string;
  catalogItems?: Array<Record<string, any>>;
}) {
  const {
    profileId,
    tasteMap,
    profileFingerprint,
    algorithmVersion = ALGORITHM_VERSION,
    sourceCatalogHash,
    catalogItems,
  } = params;

  const resolvedCatalogHash =
    sourceCatalogHash !== undefined
      ? sourceCatalogHash
      : catalogItems
      ? computeSourceCatalogSignature(catalogItems)
      : '';

  const derivedItemsPayload: Record<string, any> = {};
  for (const [rawKey, entryVal] of Object.entries(tasteMap.entries || {})) {
    if (!entryVal) continue;
    const key = canonicalizeMediaKey(entryVal.mediaKey || rawKey);
    if (!parseMediaKey(key)) continue;

    derivedItemsPayload[key] = {
      mediaKey: key,
      matchScore: entryVal.matchScore,
      tasteScore: entryVal.tasteScore,
      priorityScore: entryVal.priorityScore,
      lifecycleRing: entryVal.ring || 'ring0',
      ...(entryVal.parts && Object.keys(entryVal.parts).length > 0 ? { signals: entryVal.parts } : {}),
      ...(Array.isArray(entryVal.tags) && entryVal.tags.length > 0 ? { reasons: entryVal.tags } : {}),
      shownCount: entryVal.shownCount ?? 0,
      skippedCount: entryVal.skippedCount ?? 0,
      demotionPenalty: entryVal.demotionPenalty ?? 0,
      status: entryVal.status || 'active',
      scoreCoverage: entryVal.scoreCoverage || 'basic',
      ...(entryVal.pillars ? { pillars: entryVal.pillars } : {}),
      calculatedAt: entryVal.lastScoredAt || new Date().toISOString(),
    };
  }

  return {
    schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
    profileId,
    algorithmVersion,
    profileFingerprint,
    sourceCatalogHash: resolvedCatalogHash,
    items: derivedItemsPayload,
  };
}

export interface RecommendationEngine {
  readonly enrichCatalogItemsWithTaste: typeof enrichCatalogItemsWithTaste;
  readonly hydrateTasteMapWithDerivedCache: typeof hydrateTasteMapWithDerivedCache;
  readonly buildDerivedProfilePayloadFromTasteMap: typeof buildDerivedProfilePayloadFromTasteMap;
  readonly enforceStrictMediaTypePool: typeof enforceStrictMediaTypePool;
}

/**
 * Öneri motoru yöneticisi. Durum tutmaz; tüm işlemler girdi → çıktı saftır.
 * Hafızaya yazmaz — kalıcılaştırma çağıran katmanın sorumluluğundadır.
 */
export function createRecommendationEngine(): RecommendationEngine {
  return {
    enrichCatalogItemsWithTaste,
    hydrateTasteMapWithDerivedCache,
    buildDerivedProfilePayloadFromTasteMap,
    enforceStrictMediaTypePool,
  };
}
