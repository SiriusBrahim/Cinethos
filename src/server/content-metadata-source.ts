/**
 * MIA Faz 2 — Content Metadata Source (Content Manager Sınır Adaptörü)
 *
 * Sorumluluk:
 * - İçerik zekâsı boru hattına yalnızca görsellerden ve kişisel verilerden
 *   arındırılmış ham/normalize metaveri temin eder.
 * - Sıra: gelen payload -> yerel catalog/{movies,tv}.json -> taste metadata cache -> TMDB API.
 * - TMDB anahtarı yoksa yerel/gönderilen metaveri ile çalışır (sahte veri uydurmaz).
 * - Geçici ağ / 429 / 5xx hatalarını `TransientMetadataFetchError` olarak işaretler
 *   ki kuyruk kontrollü retry + backoff uygulayabilsin.
 */

import path from 'node:path';
import type { MediaKind } from '../contracts/index.ts';
import { sanitizeRawContentInput } from '../modules/content/content-metadata-processor.ts';
import { readJsonFileWithRecoveryAsync } from './atomic-json.ts';
import { readTasteMetadataCache } from './taste-metadata-hydrator.ts';

export class TransientMetadataFetchError extends Error {
  readonly retryable = true;
  readonly statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'TransientMetadataFetchError';
    this.statusCode = statusCode;
  }
}

export interface AcquiredMetadataEnvelope {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly tmdbId: number;
  readonly payload: Record<string, unknown>;
  readonly source: string;
  readonly sourceRevision?: string;
  readonly acquiredAt: string;
}

export type CustomMetadataFetcher = (params: {
  mediaKey: string;
  mediaType: MediaKind;
  tmdbId: number;
  existingPayload?: Record<string, unknown> | null;
}) => Promise<Record<string, unknown> | null>;

/** Yerel katalogdan okunan tekil içerik anlık görüntüsü (Content Manager okuma). */
export interface CatalogEntrySnapshot {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly payload: Record<string, unknown>;
}

export interface ContentMetadataSourceOptions {
  dataDir?: string;
  tmdbApiKey?: string;
  fetchTimeoutMs?: number;
  customFetcher?: CustomMetadataFetcher;
}

const DEFAULT_FETCH_TIMEOUT_MS = 8000;

export function hasSufficientDetail(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  const hasTitle =
    (typeof payload.title === 'string' && payload.title.trim().length > 0) ||
    (typeof payload.name === 'string' && payload.name.trim().length > 0);
  const hasGenres =
    (Array.isArray(payload.genre_ids) && payload.genre_ids.length > 0) ||
    (Array.isArray(payload.genreIds) && payload.genreIds.length > 0) ||
    (Array.isArray(payload.genres) && payload.genres.length > 0);
  const hasOverview = typeof payload.overview === 'string' && payload.overview.trim().length > 0;
  const hasKeywords =
    (Array.isArray(payload.keywords) && payload.keywords.length > 0) ||
    Boolean(
      payload.keywords &&
        typeof payload.keywords === 'object' &&
        (Array.isArray((payload.keywords as Record<string, unknown>).keywords) ||
          Array.isArray((payload.keywords as Record<string, unknown>).results))
    );
  return hasTitle && hasGenres && hasOverview && hasKeywords;
}

export class ContentMetadataSource {
  private readonly dataDir: string;
  private readonly tmdbApiKey: string;
  private readonly fetchTimeoutMs: number;
  private customFetcher?: CustomMetadataFetcher;

  constructor(options: ContentMetadataSourceOptions = {}) {
    this.dataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.tmdbApiKey = (options.tmdbApiKey || '').trim();
    this.fetchTimeoutMs = Math.max(500, options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS);
    this.customFetcher = options.customFetcher;
  }

  setCustomFetcher(fetcher?: CustomMetadataFetcher): void {
    this.customFetcher = fetcher;
  }

  private async readCatalogEntry(
    mediaType: MediaKind,
    mediaKey: string,
    tmdbId: number
  ): Promise<Record<string, unknown> | null> {
    const filePath = path.join(
      this.dataDir,
      'catalog',
      mediaType === 'tv' ? 'tv.json' : 'movies.json'
    );
    try {
      const res = await readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(
        filePath
      );
      if ((res.status === 'ok' || res.status === 'recovered') && res.data) {
        const entry = res.data[mediaKey] ?? res.data[String(tmdbId)];
        if (entry && typeof entry === 'object') {
          return sanitizeRawContentInput(entry).sanitized;
        }
      }
    } catch {
      /* yerel katalog okunamazsa kaynak zinciri devam eder */
    }
    return null;
  }

  private async readTasteCacheEntry(mediaKey: string): Promise<Record<string, unknown> | null> {
    try {
      const cache = await readTasteMetadataCache(this.dataDir);
      const entry = cache.items?.[mediaKey];
      if (entry && typeof entry === 'object') {
        return sanitizeRawContentInput(entry).sanitized;
      }
    } catch {
      /* önbellek yoksa veya okunamazsa akış devam eder */
    }
    return null;
  }

  private async fetchFromTmdb(
    mediaType: MediaKind,
    tmdbId: number
  ): Promise<Record<string, unknown> | null> {
    if (!this.tmdbApiKey) return null;

    const url = new URL(`https://api.themoviedb.org/3/${mediaType}/${tmdbId}`);
    url.searchParams.set('append_to_response', 'keywords,credits,external_ids');
    url.searchParams.set('language', 'tr-TR');

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.tmdbApiKey.startsWith('eyJ')) {
      headers.Authorization = `Bearer ${this.tmdbApiKey}`;
    } else {
      url.searchParams.set('api_key', this.tmdbApiKey);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
    try {
      const res = await fetch(url.toString(), { headers, signal: controller.signal });
      if (res.status === 429 || res.status >= 500) {
        throw new TransientMetadataFetchError(
          `TMDB geçici hata döndürdü: HTTP ${res.status}`,
          res.status
        );
      }
      if (!res.ok) {
        return null;
      }
      const raw = (await res.json()) as Record<string, unknown>;
      return sanitizeRawContentInput({
        ...raw,
        media_type: mediaType,
        tmdbId,
      }).sanitized;
    } catch (error) {
      if (error instanceof TransientMetadataFetchError) {
        throw error;
      }
      throw new TransientMetadataFetchError(
        `TMDB ağ isteği başarısız oldu: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Yerel katalog stokunun tamamını allowlist temizliğinden geçmiş olarak döner.
   * Content Manager'ın katalog aramasını ikinci bir dosya okuyucusu olmadan
   * yapmasını sağlar.
   */
  async listCatalogEntries(): Promise<CatalogEntrySnapshot[]> {
    const entries: CatalogEntrySnapshot[] = [];
    for (const mediaType of ['movie', 'tv'] as const) {
      const filePath = path.join(
        this.dataDir,
        'catalog',
        mediaType === 'tv' ? 'tv.json' : 'movies.json'
      );
      try {
        const res = await readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(
          filePath
        );
        if ((res.status !== 'ok' && res.status !== 'recovered') || !res.data) continue;
        for (const [rawKey, rawEntry] of Object.entries(res.data)) {
          if (!rawEntry || typeof rawEntry !== 'object') continue;
          const sanitized = sanitizeRawContentInput(rawEntry).sanitized;
          const numericId = Number(rawEntry.id ?? sanitized.id);
          if (!Number.isSafeInteger(numericId) || numericId <= 0) continue;
          const mediaKey = `${mediaType}:${numericId}`;
          if (!rawKey || rawKey === 'updatedAt') continue;
          entries.push({ mediaKey, mediaType, payload: sanitized });
        }
      } catch {
        /* katalog dosyası yoksa/okunamazsa arama diğer türle devam eder */
      }
    }
    return entries;
  }

  async acquireMetadata(params: {
    mediaKey: string;
    mediaType: MediaKind;
    tmdbId: number;
    providedPayload?: Record<string, unknown> | null;
    sourceRevision?: string | null;
  }): Promise<AcquiredMetadataEnvelope> {
    const acquiredAt = new Date().toISOString();
    const sanitizedProvided = params.providedPayload
      ? sanitizeRawContentInput(params.providedPayload).sanitized
      : {};

    // Bozuk olarak işaretlenmiş veya doğrulama hatası taşıyan yükü dış ağla ezmeden doğrudan aktar
    if (sanitizedProvided.corrupt === true) {
      return {
        mediaKey: params.mediaKey,
        mediaType: params.mediaType,
        tmdbId: params.tmdbId,
        payload: sanitizedProvided,
        source: 'provided',
        ...(params.sourceRevision ? { sourceRevision: params.sourceRevision } : {}),
        acquiredAt,
      };
    }

    // 1. Custom fetcher enjekte edilmişse (testler veya harici adaptör) öncelik ver
    if (this.customFetcher) {
      const fetched = await this.customFetcher({
        mediaKey: params.mediaKey,
        mediaType: params.mediaType,
        tmdbId: params.tmdbId,
        existingPayload: sanitizedProvided,
      });
      if (fetched) {
        const cleanFetched = sanitizeRawContentInput(fetched).sanitized;
        return {
          mediaKey: params.mediaKey,
          mediaType: params.mediaType,
          tmdbId: params.tmdbId,
          payload: {
            ...sanitizedProvided,
            ...cleanFetched,
            id: params.tmdbId,
            mediaType: params.mediaType,
            mediaKey: params.mediaKey,
          },
          source: typeof cleanFetched.source === 'string' ? cleanFetched.source : 'tmdb',
          ...(params.sourceRevision ? { sourceRevision: params.sourceRevision } : {}),
          acquiredAt,
        };
      }
    }

    // 2. Yerel katalog & taste metadata önbelleği ile birleştir
    let merged: Record<string, unknown> = { ...sanitizedProvided };
    let source = Object.keys(sanitizedProvided).length > 0 ? 'library-catalog' : 'tmdb';

    if (!hasSufficientDetail(merged)) {
      const [catalogEntry, cacheEntry] = await Promise.all([
        this.readCatalogEntry(params.mediaType, params.mediaKey, params.tmdbId),
        this.readTasteCacheEntry(params.mediaKey),
      ]);
      if (cacheEntry) {
        merged = { ...cacheEntry, ...merged };
      }
      if (catalogEntry) {
        merged = { ...catalogEntry, ...merged };
        source = 'local-catalog';
      }
    }

    // 3. Hâlâ özet/anahtar kelime/credits eksikse ve TMDB anahtarı tanımlıysa uzaktan zenginleştir
    const needsRemote =
      this.tmdbApiKey.length > 0 &&
      (!hasSufficientDetail(merged) ||
        (!merged.imdb_id && !merged.imdbId) ||
        (!merged.cast && !merged.credits));
    if (needsRemote) {
      const remote = await this.fetchFromTmdb(params.mediaType, params.tmdbId);
      if (remote) {
        merged = { ...merged, ...remote };
        source = 'tmdb';
      }
    }

    return {
      mediaKey: params.mediaKey,
      mediaType: params.mediaType,
      tmdbId: params.tmdbId,
      payload: {
        ...merged,
        id: merged.id ?? params.tmdbId,
        mediaType: merged.mediaType ?? merged.media_type ?? params.mediaType,
        mediaKey: params.mediaKey,
      },
      source,
      ...(params.sourceRevision ? { sourceRevision: params.sourceRevision } : {}),
      acquiredAt,
    };
  }
}

export function createContentMetadataSource(
  options: ContentMetadataSourceOptions = {}
): ContentMetadataSource {
  return new ContentMetadataSource(options);
}
