/**
 * MIA Faz 1 — Content Intelligence Manager sözleşmeleri.
 *
 * Sınır: bu modül **içerik** hakkındaki gerçekleri yönetir; kullanıcıya ait hiçbir
 * alan (profil, puan, izleme durumu, beğenmeme) burada tutulmaz. Böylece aynı
 * içerik tüm profillerde tek kez saklanır ve tekrar indirilmez (mimari ilke 5).
 *
 * `SourceMetadata` = sağlayıcıdan gelen veri; `DerivedFeatures` = Cinethos'un
 * kendi ürettiği özellikler. İkisi ayrı alanlarda tutulur, karıştırılmaz.
 */

import type { Repository } from '../kernel/repository-contracts.ts';

export type MediaType = 'movie' | 'tv';

export interface ContentIdentity {
  readonly mediaType: MediaType;
  readonly tmdbId: number;
  /** Kanonik anahtar: `movie:157336` / `tv:1396`. */
  readonly key: string;
}

/** Sağlayıcıdan gelen ham veri. TMDB puanı burada kalır — kullanıcı puanına asla yazılmaz. */
export interface SourceMetadata {
  readonly mediaType: MediaType;
  readonly tmdbId: number;
  readonly title: string;
  readonly originalTitle?: string;
  readonly overview?: string;
  readonly genreIds: readonly number[];
  readonly genres: readonly string[];
  readonly releaseYear?: number;
  readonly runtimeMinutes?: number;
  readonly voteAverage?: number;
  readonly voteCount?: number;
  readonly popularity?: number;
  readonly originCountry?: readonly string[];
  readonly keywords?: readonly string[];
  readonly cast?: readonly { readonly id: number; readonly name: string }[];
  readonly directors?: readonly { readonly id: number; readonly name: string }[];
  readonly provider: 'tmdb' | 'manual' | 'import';
  readonly fetchedAt: string;
}

/** Cinethos'un içerikten türettiği özellikler (öneri motorunun girdisi). */
export interface DerivedFeatures {
  readonly key: string;
  readonly featureVersion: number;
  readonly genreSet: readonly string[];
  readonly primaryGenre: string | null;
  readonly decade: number | null;
  readonly runtimeBucket: 'short' | 'standard' | 'long' | 'unknown';
  readonly popularityTier: 'low' | 'medium' | 'high';
  readonly qualityTier: 'low' | 'medium' | 'high';
  readonly keywordTokens: readonly string[];
  readonly castIds: readonly number[];
  readonly directorIds: readonly number[];
  readonly computedAt: string;
}

export type ContentProcessingState = 'pending' | 'features_ready' | 'failed';

export interface ContentProcessingStatus {
  readonly state: ContentProcessingState;
  readonly attempts: number;
  readonly updatedAt: string;
  readonly lastError?: string;
}

export interface ContentRecord {
  readonly identity: ContentIdentity;
  readonly source: SourceMetadata;
  readonly derived?: DerivedFeatures;
  readonly processing: ContentProcessingStatus;
}

export interface ContentIntelligenceStats {
  readonly total: number;
  readonly ready: number;
  readonly failed: number;
  readonly pending: number;
  readonly featureVersion: number;
}

export type ContentErrorCode =
  | 'invalid_input'
  | 'conflict'
  | 'storage_unavailable'
  | 'processing_failed';

export interface ContentError {
  readonly code: ContentErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type ContentResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ContentError };

export interface IngestResult {
  readonly action: 'inserted' | 'updated' | 'skipped';
  readonly reason: string;
  readonly record: ContentRecord;
}

/**
 * Öneri motorunun bu modülden gördüğü tek yüzey. Profil parametresi yoktur:
 * içerik bilgisi profilden bağımsızdır.
 */
export interface ContentIntelligenceApi {
  ingest(source: SourceMetadata): Promise<ContentResult<IngestResult>>;
  getRecord(key: string): Promise<ContentResult<ContentRecord | null>>;
  getFeatures(key: string): Promise<ContentResult<DerivedFeatures | null>>;
  getFeaturesBatch(keys: readonly string[]): Promise<ContentResult<readonly DerivedFeatures[]>>;
  getStatus(key: string): Promise<ContentResult<ContentProcessingStatus | null>>;
  reprocess(key: string): Promise<ContentResult<ContentRecord>>;
  stats(): Promise<ContentResult<ContentIntelligenceStats>>;
}

export type ContentRecordRepository = Repository<ContentRecord, string>;

/** Dışa açılan servis adı — registry `getService` çağrısında kullanılır. */
export const CONTENT_INTELLIGENCE_SERVICE = 'content-intelligence';
export const CONTENT_FEATURE_VERSION = 1;
