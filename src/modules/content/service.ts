/**
 * MIA Faz 3 — Merkezi Content Manager (IContentService uygulaması).
 *
 * Ortak (kullanıcıya ait olmayan) içerik verisinin tek okuma hattıdır:
 * - TMDB/yerel kaynak erişimi mevcut `ContentMetadataSource` adaptörü üzerinden
 *   yapılır (ikinci bir TMDB istemcisi yoktur).
 * - Kalıcı içerik kayıtları mevcut `ContentIntelligenceRepository` üzerinden
 *   okunur; bu servis şemayı veya kuyruğu DEĞİŞTİRMEZ.
 * - Eksik metadata tamamlama mevcut içerik kuyruğuna devredilir (port).
 * - Kimlik `movie:<id>` / `tv:<id>` ayrımını korur (core `keys.ts`).
 *
 * SINIRLAR:
 * - Kullanıcı kütüphanesine, kişisel puanlara veya profil verisine YAZMAZ.
 * - `ContentMetadata.externalRating` TMDB puanıdır; kullanıcı puanıyla
 *   eşleştirilmez ve kullanıcı kaydına yazılmaz.
 * - Vektör/atmosfer/benzerlik hesaplaması Content Intelligence'ın işidir.
 */

import type {
  ContentMetadata,
  IContentService,
  MediaKind,
  OperationOutcome,
  ProfileRef,
} from '../../contracts/index.ts';
import type { DataDocument } from '../../core/cinetrack-core.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import { makeMediaKey, parseMediaKey } from '../../core/keys.ts';
import { hasSufficientDetail } from './metadata-detail.ts';
import type { ContentMetadataPort } from './ports.ts';
import type {
  ContentIntelligenceRecord,
  NormalizedContentMetadata,
} from './types.ts';

export interface ContentServiceOptions {
  readonly metadataSource: ContentMetadataPort;
  /** Merkezi içerik kaydı okuyucusu (ör. coordinator.getByMediaKey). */
  readonly getStoredRecord?: (mediaKey: string) => ContentIntelligenceRecord | null;
  /** Eksik metadata taraması için birincil kullanıcı belgesi okuyucusu. */
  readonly readDocument?: () => Promise<DataDocument | null>;
  /** Eksik içerikleri mevcut içerik kuyruğuna devreden port. */
  readonly enqueueRawItem?: (
    rawItem: Record<string, unknown>
  ) => { accepted: boolean; reason?: string };
}

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : [];
}

function asNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => Number.isSafeInteger(entry) && entry > 0)
    : [];
}

function extractGenres(payload: Record<string, unknown>): {
  genres: string[];
  genreIds: number[];
} {
  const genreIds = new Set<number>(asNumberArray(payload.genre_ids ?? payload.genreIds));
  const genreNames = new Set<string>();
  const rawGenres = payload.genres;
  if (Array.isArray(rawGenres)) {
    for (const entry of rawGenres) {
      if (typeof entry === 'string' && entry.trim()) {
        genreNames.add(entry.trim());
      } else if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>;
        if (typeof record.name === 'string' && record.name.trim()) {
          genreNames.add(record.name.trim());
        }
        if (Number.isSafeInteger(record.id) && Number(record.id) > 0) {
          genreIds.add(Number(record.id));
        }
      }
    }
  }
  return { genres: [...genreNames], genreIds: [...genreIds].sort((a, b) => a - b) };
}

function extractKeywords(payload: Record<string, unknown>): Array<{ id: number; name?: string }> {
  const raw = payload.keywords;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object'
      ? ((raw as Record<string, unknown>).keywords ?? (raw as Record<string, unknown>).results)
      : [];
  if (!Array.isArray(list)) return [];
  return list
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) return null;
      return {
        id: Number(record.id),
        ...(typeof record.name === 'string' && record.name.trim()
          ? { name: record.name.trim() }
          : {}),
      };
    })
    .filter((entry): entry is { id: number; name?: string } => entry !== null);
}

function firstRuntime(payload: Record<string, unknown>): number | null {
  if (typeof payload.runtime === 'number' && Number.isFinite(payload.runtime)) {
    return Math.max(0, Math.round(payload.runtime));
  }
  const episodeRuntime = payload.episode_run_time;
  if (Array.isArray(episodeRuntime)) {
    const first = episodeRuntime.find(
      (entry): entry is number => typeof entry === 'number' && Number.isFinite(entry) && entry > 0
    );
    if (first !== undefined) return Math.round(first);
  }
  return null;
}

function toContentMetadataFromPayload(
  mediaKey: string,
  mediaType: MediaKind,
  payload: Record<string, unknown>
): ContentMetadata {
  const { genres, genreIds } = extractGenres(payload);
  const title = String(payload.title ?? payload.name ?? '').trim();
  const releaseDateRaw = payload.release_date ?? payload.first_air_date;
  const originCountries = asStringArray(payload.origin_country);
  const externalRating =
    typeof payload.vote_average === 'number' && Number.isFinite(payload.vote_average)
      ? payload.vote_average
      : null;

  return {
    mediaKey,
    mediaType,
    title,
    genres,
    genreIds,
    ...(typeof payload.overview === 'string' && payload.overview.trim()
      ? { overview: payload.overview.trim() }
      : {}),
    posterPath:
      typeof payload.poster_path === 'string' && payload.poster_path.trim()
        ? payload.poster_path.trim()
        : null,
    ...(typeof releaseDateRaw === 'string' && releaseDateRaw.trim()
      ? { releaseDate: releaseDateRaw.trim() }
      : {}),
    keywords: extractKeywords(payload),
    ...(typeof payload.original_language === 'string' && payload.original_language.trim()
      ? { originalLanguage: payload.original_language.trim() }
      : {}),
    ...(originCountries.length > 0 ? { originCountries } : {}),
    runtimeMinutes: firstRuntime(payload),
    voteCount:
      typeof payload.vote_count === 'number' && Number.isFinite(payload.vote_count)
        ? payload.vote_count
        : null,
    popularity:
      typeof payload.popularity === 'number' && Number.isFinite(payload.popularity)
        ? payload.popularity
        : null,
    externalRating,
  };
}

function toContentMetadataFromStored(
  record: ContentIntelligenceRecord
): ContentMetadata | null {
  const normalized = parseJson<NormalizedContentMetadata>(record.normalized_metadata_json);
  if (!normalized) return null;
  return {
    mediaKey: record.media_key,
    mediaType: record.media_type,
    title: normalized.title,
    genres: [...normalized.genres],
    genreIds: [...normalized.genreIds],
    overview: normalized.overview,
    posterPath: null,
    releaseDate: normalized.releaseDate ?? normalized.firstAirDate ?? undefined,
    keywords: normalized.keywords.map((entry) => ({
      id: entry.id,
      ...(entry.name ? { name: entry.name } : {}),
    })),
    originalLanguage: normalized.originalLanguage ?? undefined,
    originCountries: [...normalized.originCountries],
    runtimeMinutes: normalized.runtimeMinutes,
    voteCount: normalized.voteCount,
    popularity: normalized.popularity,
    externalRating: normalized.externalRating,
  };
}

export class ContentService implements IContentService {
  private readonly metadataSource: ContentMetadataPort;
  private readonly getStoredRecord?: (mediaKey: string) => ContentIntelligenceRecord | null;
  private readonly readDocument?: () => Promise<DataDocument | null>;
  private readonly enqueueRawItem?: (
    rawItem: Record<string, unknown>
  ) => { accepted: boolean; reason?: string };

  constructor(options: ContentServiceOptions) {
    this.metadataSource = options.metadataSource;
    this.getStoredRecord = options.getStoredRecord;
    this.readDocument = options.readDocument;
    this.enqueueRawItem = options.enqueueRawItem;
  }

  /**
   * Kanonik metaveri: önce merkezi içerik kaydı (tamamlanmışsa), sonra mevcut
   * metadata kaynağı (yerel katalog → taste önbelleği → TMDB) kullanılır.
   */
  async getMetadata(mediaKey: string): Promise<ContentMetadata | null> {
    const parsed = parseMediaKey(mediaKey);
    if (!parsed) return null;
    const canonicalKey = makeMediaKey(parsed.type, parsed.id);

    const stored = this.getStoredRecord?.(canonicalKey);
    if (stored && stored.processing_status === 'completed') {
      const mapped = toContentMetadataFromStored(stored);
      if (mapped) return mapped;
    }

    if (!/^\d+$/.test(parsed.id)) return null;
    const acquired = await this.metadataSource.acquireMetadata({
      mediaKey: canonicalKey,
      mediaType: parsed.type,
      tmdbId: Number(parsed.id),
    });
    return toContentMetadataFromPayload(canonicalKey, parsed.type, acquired.payload);
  }

  /**
   * Profildeki eksik metadata'lı içerikleri mevcut içerik kuyruğuna devreder.
   * Kullanıcı verisi paylaşılan içerik deposuna yazılmaz; kuyruk zaten
   * allowlist temizliğini uygular.
   */
  async enrichMissing(ref: ProfileRef): Promise<OperationOutcome> {
    if (!this.readDocument || !this.enqueueRawItem) {
      return {
        ok: false,
        error: 'İçerik zenginleştirme portları bağlı değil.',
        retryable: false,
      };
    }
    try {
      const document = await this.readDocument();
      const expectedProfileId = normalizeProfileId(ref?.profileId);
      const profile = expectedProfileId
        ? document?.profiles?.find((entry) => normalizeProfileId(entry.id) === expectedProfileId)
        : undefined;
      if (!profile) {
        return {
          ok: false,
          error: `Profil bulunamadı: ${ref.profileId}`,
          retryable: false,
        };
      }

      const rejected: string[] = [];
      for (const item of profile.items ?? []) {
        if (hasSufficientDetail(item as unknown as Record<string, unknown>)) continue;
        const result = this.enqueueRawItem(item as unknown as Record<string, unknown>);
        if (!result.accepted) {
          rejected.push(makeMediaKey(item));
        }
      }

      if (rejected.length > 0) {
        return {
          ok: false,
          error: `${rejected.length} içerik kuyruğa alınamadı: ${rejected.slice(0, 5).join(', ')}`,
          retryable: true,
        };
      }
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'İçerik zenginleştirme başarısız.',
        retryable: true,
      };
    }
  }

  /** Yerel katalog stokunda arama (ağ çağrısı yapmaz). */
  async searchCatalog(query: string, limit = 20): Promise<readonly ContentMetadata[]> {
    const needle = String(query ?? '').trim().toLowerCase();
    if (!needle) return [];
    const entries = await this.metadataSource.listCatalogEntries();
    const results: ContentMetadata[] = [];
    for (const entry of entries) {
      const metadata = toContentMetadataFromPayload(
        entry.mediaKey,
        entry.mediaType,
        entry.payload
      );
      if (!metadata.title) continue;
      const haystack = `${metadata.title} ${
        typeof entry.payload.original_title === 'string' ? entry.payload.original_title : ''
      } ${metadata.overview ?? ''}`.toLowerCase();
      if (!haystack.includes(needle)) continue;
      results.push(metadata);
    }
    results.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0));
    return results.slice(0, Math.max(1, limit));
  }

  /** Ham tür + kimliği kanonik anahtara çevirir; `movie:<id>` ve `tv:<id>` ayrıdır. */
  canonicalizeKey(mediaType: MediaKind, rawId: string | number): string {
    if (mediaType !== 'movie' && mediaType !== 'tv') {
      throw new Error(`Geçersiz medya türü: ${String(mediaType)}`);
    }
    const id = String(rawId ?? '').trim();
    if (!/^\d+$/.test(id) || Number(id) <= 0) {
      throw new Error(`Geçersiz içerik kimliği: ${String(rawId)}`);
    }
    return makeMediaKey(mediaType, String(Number(id)));
  }
}

export function createContentService(options: ContentServiceOptions): ContentService {
  return new ContentService(options);
}
