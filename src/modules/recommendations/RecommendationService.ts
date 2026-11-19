import { normalizeProfileId } from '../../core/profile-id.ts';
/**
 * MIA Faz 6 — Profile-aware recommendation service adapter.
 *
 * Keeps async data loading, revision fencing and per-profile cache lifecycle
 * outside the pure scoring engine. It never mutates library or Taste evidence.
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
import { makeMediaKey } from '../../core/keys.ts';
import { enrichCatalogItemsWithTaste } from './RecommendationEngine.ts';

export interface RecommendationSnapshot {
  readonly items: readonly any[];
  readonly savedItems: readonly SavedItem[];
  readonly preferences: Preferences;
  readonly genresMap: Readonly<Record<number, string>>;
  readonly tasteMap?: PersistentTasteMapData | null;
}

export interface RecommendationServiceOptions {
  readonly loadSnapshot: (ref: ProfileRef) => Promise<RecommendationSnapshot>;
  /** Returns false when the captured profile/revision is no longer current. */
  readonly isCurrent?: (ref: ProfileRef) => boolean;
  readonly defaultLimit?: number;
}

export class RecommendationService implements IRecommendationService {
  private readonly loadSnapshot: RecommendationServiceOptions['loadSnapshot'];
  private readonly isCurrent: (ref: ProfileRef) => boolean;
  private readonly defaultLimit: number;
  private readonly cache = new Map<string, readonly RecommendationView[]>();

  constructor(options: RecommendationServiceOptions) {
    this.loadSnapshot = options.loadSnapshot;
    this.isCurrent = options.isCurrent ?? (() => true);
    this.defaultLimit = Math.max(1, Math.min(100, Math.floor(options.defaultLimit ?? 20)));
  }

  async getRecommendations(
    ref: ProfileRef,
    limit = this.defaultLimit
  ): Promise<readonly RecommendationView[]> {
    const canonicalRef = this.canonicalizeRef(ref);
    this.assertCurrent(canonicalRef);
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const cacheKey = `${canonicalRef.profileId}:${canonicalRef.revision}:${safeLimit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const snapshot = await this.loadSnapshot(canonicalRef);
    this.assertCurrent(canonicalRef);
    const enriched = enrichCatalogItemsWithTaste({
      items: [...snapshot.items],
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

    this.cache.set(cacheKey, result);
    return result;
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
    const prefix = `${canonicalId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) this.cache.delete(key);
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
