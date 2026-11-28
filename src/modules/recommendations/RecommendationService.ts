import { normalizeProfileId } from '../../core/profile-id.ts';
/**
 * MIA Faz 6 — Profile-aware recommendation service adapter.
 *
 * Keeps async data loading, revision fencing and per-profile cache lifecycle
 * outside the pure scoring engine. It never mutates library or Taste evidence.
 *
 * AŞAMA 3 — B-22 önbellek sınırlandırması:
 * - Önbellek sabit üst sınırlıdır (LRU tahliyesi) ve TTL ile bayatlar.
 * - Anahtar; profil kimliği + profil revizyonu + katalog imzası + kapsam (film/
 *   dizi/tümü) + istek limitini birlikte taşır. Böylece izleme listesi, favori
 *   oyuncular veya katalog değiştiğinde eski sonuç dönmez; film-only ve TV-only
 *   sonuçları birbirine karışmaz.
 * - Profil geçersizleştirmesi bir nesil (generation) sayacını artırır: uçuştaki
 *   eski bir hesaplama tamamlandığında yeni neslin anahtarını ezemez.
 */

import type {
  IRecommendationService,
  RecommendationView,
} from '../../contracts/services.ts';
import type {
  OperationOutcome,
  ProfileRef,
  WriteProfileRef,
} from '../../contracts/common.ts';
import type {
  PersistentTasteMapData,
  Preferences,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import { isCandidateEligibleInPool } from '../../core/cinetrack-core.ts';
import { makeMediaKey } from '../../core/keys.ts';
import { enrichCatalogItemsWithTaste } from './RecommendationEngine.ts';
import { enforceStrictMediaTypePool } from './CandidatePoolManager.ts';

export type RecommendationScope = 'all' | 'movie' | 'tv';

export interface RecommendationSnapshot {
  readonly items: readonly any[];
  readonly savedItems: readonly SavedItem[];
  readonly preferences: Preferences;
  readonly genresMap: Readonly<Record<number, string>>;
  readonly tasteMap?: PersistentTasteMapData | null;
  /** Katalog revizyonu: değiştiğinde önceki önbellek girdileri kullanılmaz. */
  readonly catalogSignature?: string;
}

export interface RecommendationRequestOptions {
  readonly scope?: RecommendationScope;
  /** Çağıran katman taze bir katalog imzası biliyorsa snapshot'ınkini geçersiz kılar. */
  readonly catalogSignature?: string;
}

export interface RecommendationServiceOptions {
  readonly loadSnapshot: (ref: ProfileRef) => Promise<RecommendationSnapshot>;
  /** Returns false when the captured profile/revision is no longer current. */
  readonly isCurrent?: (ref: ProfileRef) => boolean;
  readonly defaultLimit?: number;
  /** LRU üst sınırı. Varsayılan 64; en az 1. */
  readonly maxEntries?: number;
  /** Girdi ömrü (ms). Varsayılan 5 dakika; 0 TTL'i kapatır. */
  readonly ttlMs?: number;
  /** Testler için enjekte edilebilir saat. */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly views: readonly RecommendationView[];
  readonly storedAt: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

export class RecommendationService implements IRecommendationService {
  private readonly loadSnapshot: RecommendationServiceOptions['loadSnapshot'];
  private readonly isCurrent: (ref: ProfileRef) => boolean;
  private readonly defaultLimit: number;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<readonly RecommendationView[]>>();
  private readonly generations = new Map<string, number>();

  constructor(options: RecommendationServiceOptions) {
    this.loadSnapshot = options.loadSnapshot;
    this.isCurrent = options.isCurrent ?? (() => true);
    this.defaultLimit = Math.max(1, Math.min(100, Math.floor(options.defaultLimit ?? 20)));
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.ttlMs = Math.max(0, Number(options.ttlMs ?? DEFAULT_TTL_MS) || 0);
    this.now = options.now ?? (() => Date.now());
  }

  async getRecommendations(
    ref: ProfileRef,
    limit = this.defaultLimit,
    options: RecommendationRequestOptions = {}
  ): Promise<readonly RecommendationView[]> {
    const canonicalRef = this.canonicalizeRef(ref);
    this.assertCurrent(canonicalRef);
    const revision = Number(canonicalRef.revision);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const scope: RecommendationScope =
      options.scope === 'movie' || options.scope === 'tv' ? options.scope : 'all';
    const generation = this.generations.get(canonicalRef.profileId) ?? 0;
    // Katalog imzası snapshot'tan da gelebilir; anahtarı iki aşamada kurmamak için
    // imza bilinmiyorsa "unknown" kullanılır ve yükleme sonrası doğrulanır.
    const requestedSignature = options.catalogSignature ?? '';

    const cachedEntryFor = (catalogSignature: string): CacheEntry | undefined => {
      const key = this.cacheKey(canonicalRef.profileId, revision, catalogSignature, scope, safeLimit, generation);
      const entry = this.cache.get(key);
      if (!entry) return undefined;
      if (this.ttlMs > 0 && this.now() - entry.storedAt >= this.ttlMs) {
        this.cache.delete(key);
        return undefined;
      }
      // LRU: erişilen girdi sona taşınır.
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry;
    };

    // İstenen katalog imzası yoksa önceki koşumun "unknown" anahtarı da geçerlidir;
    // böylece imza sağlamayan çağıranlar gereksiz yükleme yapmaz.
    for (const signature of requestedSignature ? [requestedSignature] : ['unknown']) {
      const cached = cachedEntryFor(signature);
      if (cached) return cached.views;
    }

    const provisionalKey = this.cacheKey(
      canonicalRef.profileId,
      revision,
      requestedSignature || 'unknown',
      scope,
      safeLimit,
      generation
    );
    const pending = this.inFlight.get(provisionalKey);
    if (pending) return pending;

    const request = (async () => {
      const snapshot = await this.loadSnapshot(canonicalRef);
      this.assertCurrent(canonicalRef);

      const catalogSignature = requestedSignature || snapshot.catalogSignature || 'unknown';
      const key = this.cacheKey(
        canonicalRef.profileId,
        revision,
        catalogSignature,
        scope,
        safeLimit,
        generation
      );
      const fresh = this.readValid(key);
      if (fresh) return fresh;

      const scopedItems = enforceStrictMediaTypePool([...snapshot.items], scope);
      const eligibleItems = scopedItems.filter((item) =>
        isCandidateEligibleInPool(item, [...snapshot.savedItems], snapshot.preferences)
      );

      const enriched = enrichCatalogItemsWithTaste({
        items: eligibleItems,
        savedItems: [...snapshot.savedItems],
        preferences: snapshot.preferences,
        genresMap: { ...snapshot.genresMap },
        tasteMap: snapshot.tasteMap ?? null,
      });

      this.assertCurrent(canonicalRef);
      const result = enriched.slice(0, safeLimit).map((item: any): RecommendationView => {
        const mediaKey = makeMediaKey(item);
        const rawScore = item.priorityScore ?? item.matchScore ?? item.tasteScore ?? 0;
        const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : 0;
        const reason = Array.isArray(item.tags) && item.tags.length
          ? item.tags.map(String).join(' · ')
          : 'Zevk profilinle eşleşiyor';
        return { mediaKey, score, reason };
      });

      // Nesil değiştiyse (profil geçersizleştirildi) eski sonuç yazılmaz.
      if ((this.generations.get(canonicalRef.profileId) ?? 0) === generation) {
        this.writeCache(key, result);
      }
      return result;
    })();

    this.inFlight.set(provisionalKey, request);
    try {
      return await request;
    } finally {
      this.inFlight.delete(provisionalKey);
    }
  }

  async refresh(ref: WriteProfileRef): Promise<OperationOutcome> {
    try {
      const canonicalRef = this.canonicalizeRef(ref);
      this.assertCurrent(canonicalRef);
      this.invalidateProfile(canonicalRef.profileId);
      await this.getRecommendations(canonicalRef, this.defaultLimit);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  invalidateProfile(profileId: string): void {
    const canonicalId = normalizeProfileId(profileId);
    if (!canonicalId) return;
    // Nesli artır: uçuştaki eski hesaplamalar yeni neslin anahtarını yazamaz.
    this.generations.set(canonicalId, (this.generations.get(canonicalId) ?? 0) + 1);
    const prefix = `${canonicalId}:`;
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(prefix)) this.cache.delete(key);
    }
  }

  /** Tüm profillerin önbelleğini bırakır (ör. katalog sürümü değiştiğinde). */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.generations.clear();
  }

  /** Tanılama/testler için: mevcut önbellek girdi sayısı. */
  get cacheSize(): number {
    return this.cache.size;
  }

  private cacheKey(
    profileId: string,
    revision: number,
    catalogSignature: string,
    scope: RecommendationScope,
    limit: number,
    generation: number
  ): string {
    return `${profileId}:${revision}:${catalogSignature}:${scope}:${limit}:g${generation}`;
  }

  private readValid(key: string): readonly RecommendationView[] | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (this.ttlMs > 0 && this.now() - entry.storedAt >= this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.views;
  }

  private writeCache(key: string, views: readonly RecommendationView[]): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, { views, storedAt: this.now() });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private canonicalizeRef<T extends ProfileRef>(ref: T): T {
    const profileId = normalizeProfileId(ref?.profileId);
    if (!profileId) {
      throw new Error('RecommendationService için geçerli profileId zorunludur.');
    }
    if (typeof ref.revision !== 'number' || !Number.isSafeInteger(ref.revision) || ref.revision < 0) {
      throw new Error('RecommendationService için geçerli profile revision zorunludur.');
    }
    return { ...ref, profileId } as T;
  }

  private assertCurrent(ref: ProfileRef): void {
    if (!this.isCurrent(ref)) {
      throw new Error(`Öneri isteği eski profile/revision ait: ${ref.profileId}@${ref.revision}`);
    }
  }
}

export function createRecommendationService(
  options: RecommendationServiceOptions
): RecommendationService {
  return new RecommendationService(options);
}
