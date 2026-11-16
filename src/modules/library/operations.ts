/**
 * MIA Faz 3 — Kütüphane işlem kuralları (tek kaynak).
 *
 * Bu modül kullanıcı kütüphanesine ait SAF kuralları barındırır:
 * - liste kimliği ↔ izleme durumu eşlemesi,
 * - puan/durum geçişlerinde `ratedAt` / `completedAt` / `addedAt` / `updatedAt`
 *   zaman damgaları,
 * - normalize `SavedItem` üretimi,
 * - içerik metaverisinden yalnızca içerik alanlarının alınması (kullanıcı
 *   alanlarının kütüphane kaydına karışmaması için allowlist).
 *
 * Aynı kurallar hem istemci eylem katmanı (`src/hooks/useItemActions.ts`) hem
 * de sunucu Library Manager (`src/modules/library/service.ts`) tarafından
 * kullanılır; böylece ikinci bir iş kuralı seti oluşmaz.
 *
 * SINIR: Burada EventBus, repository veya ağ erişimi YOKTUR; modül saftır.
 */

import type { LibraryListId } from '../../contracts/index.ts';
import { normalizeSavedItem, type SavedItem } from '../../core/cinetrack-core.ts';

export type ItemWatchStatus = 'watching' | 'watchlist' | 'completed';

export interface ResolvedItemTimestamps {
  effectiveStatus: ItemWatchStatus;
  ratedAt?: string;
  completedAt?: string;
  addedAt: string;
  updatedAt: string;
  personalRatingCleared: boolean;
}

export interface ResolveTimestampOptions {
  /** rateItem doğrudan çağrıldığında mevcut puan aynı olsa bile ratedAt yenilenir */
  forceRatedAt?: boolean;
  /** Test edilebilirlik için opsiyonel ISO zaman damgası (varsayılan: new Date().toISOString()) */
  nowIso?: string;
}

/**
 * `SavedItem.status` → sözleşmedeki liste kimliği.
 */
export function mapWatchStatusToLibraryList(
  status?: ItemWatchStatus | string | null
): LibraryListId {
  switch (status) {
    case 'completed':
      return 'watched';
    case 'watching':
      return 'watching';
    default:
      return 'watchlist';
  }
}

/**
 * Liste kimliği → `SavedItem.status`.
 * `not-interested` bir kütüphane durumu değildir (gizleme/ilgilenmiyorum ayrı
 * akıştır); bu yüzden `null` döner.
 */
export function libraryListToWatchStatus(list: LibraryListId): ItemWatchStatus | null {
  switch (list) {
    case 'watched':
      return 'completed';
    case 'watching':
      return 'watching';
    case 'watchlist':
      return 'watchlist';
    default:
      return null;
  }
}

/**
 * Puanlama ve durum geçişleri için V1.5 zaman damgalarını belirler.
 * - Yeni bir puan verildiğinde veya puan değiştiğinde `ratedAt` güncellenir.
 * - `status` 'completed' durumuna geçtiğinde `completedAt` güncellenir.
 * - Eski (imported) kayıtlarda ilgili alan değişmediyse `undefined` korunur.
 */
export function resolveItemActionTimestamps(
  existing: SavedItem | undefined,
  requestedStatus: ItemWatchStatus,
  personalRating: number | '',
  options: ResolveTimestampOptions = {}
): ResolvedItemTimestamps {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const hasValidRating =
    typeof personalRating === 'number' &&
    Number.isFinite(personalRating) &&
    personalRating >= 1 &&
    personalRating <= 10;

  const effectiveStatus: ItemWatchStatus =
    hasValidRating && (requestedStatus === 'watchlist' || !requestedStatus)
      ? 'completed'
      : requestedStatus;

  const existingHasValidRating = Boolean(
    existing &&
      existing.personal_rating !== '' &&
      Number.isFinite(Number(existing.personal_rating)) &&
      Number(existing.personal_rating) >= 1 &&
      Number(existing.personal_rating) <= 10
  );

  const personalRatingCleared = Boolean(existingHasValidRating && !hasValidRating);

  let ratedAt: string | undefined;
  if (hasValidRating) {
    const ratingChanged =
      !existingHasValidRating || Number(existing?.personal_rating) !== personalRating;
    ratedAt = options.forceRatedAt || ratingChanged ? nowIso : existing?.ratedAt;
  } else {
    ratedAt = undefined;
  }

  let completedAt: string | undefined;
  if (effectiveStatus === 'completed') {
    const transitionedToCompleted = !existing || existing.status !== 'completed';
    completedAt = transitionedToCompleted ? nowIso : existing.completedAt;
  } else {
    completedAt = undefined;
  }

  return {
    effectiveStatus,
    ratedAt,
    completedAt,
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    personalRatingCleared,
  };
}

/**
 * Kütüphane kaydına Content Manager'dan alınabilecek içerik alanları.
 * Kişisel alanlar (status, personal_rating, notes, ilerleme, profil kimliği)
 * bu listede YOKTUR; metadata'dan gelse bile kayda geçmez.
 */
const CONTENT_FIELD_ALLOWLIST = [
  'title',
  'name',
  'original_title',
  'original_name',
  'overview',
  'poster_path',
  'poster_url',
  'backdrop_path',
  'genres',
  'genre_ids',
  'release_date',
  'first_air_date',
  'last_air_date',
  'vote_average',
  'vote_count',
  'popularity',
  'runtime',
  'episode_run_time',
  'number_of_seasons',
  'number_of_episodes',
  'cast',
  'crew',
  'belongs_to_collection',
  'imdb_id',
  'original_language',
] as const;

/**
 * Ham içerik metaverisinden yalnızca allowlist'teki içerik alanlarını seçer.
 * Kullanıcı verisinin kütüphane kaydına içerik kanalından sızmasını engeller.
 */
export function pickContentFields(
  metadata: Readonly<Record<string, unknown>> | null | undefined
): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const field of CONTENT_FIELD_ALLOWLIST) {
    const value = metadata[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

export interface BuildLibraryItemInput {
  readonly existing?: SavedItem;
  readonly incoming?: Readonly<Record<string, unknown>> | null;
  readonly status: ItemWatchStatus;
  readonly rating: number | '';
  readonly tracking?: Record<string, unknown>;
  readonly nowIso?: string;
  readonly forceRatedAt?: boolean;
}

/**
 * Kütüphane kaydını mevcut kurallarla üretir: içerik alanları metadata'dan,
 * kullanıcı alanları yalnızca açık parametrelerden gelir.
 */
export function buildLibraryItem(input: BuildLibraryItemInput): SavedItem | null {
  const existing = input.existing;
  const nowIso = input.nowIso ?? new Date().toISOString();
  const timestamps = resolveItemActionTimestamps(existing, input.status, input.rating, {
    forceRatedAt: input.forceRatedAt,
    nowIso,
  });

  const incoming = input.incoming ?? {};
  const mediaType =
    (existing?.media_type ?? (incoming.media_type as string | undefined)) === 'tv' ? 'tv' : 'movie';

  const normalized = normalizeSavedItem({
    ...existing,
    ...incoming,
    media_type: mediaType,
    ...(input.tracking ?? {}),
    status: timestamps.effectiveStatus,
    personal_rating: input.rating || '',
    personal_rating_cleared: timestamps.personalRatingCleared,
    ratedAt: timestamps.ratedAt,
    completedAt: timestamps.completedAt,
    addedAt: timestamps.addedAt,
    updatedAt: timestamps.updatedAt,
    isDemo: false,
  });

  return normalized;
}
