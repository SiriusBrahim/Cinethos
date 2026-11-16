/**
 * MIA Faz 2 — Content Intelligence & Ortak İçerik Veritabanı Modül Tipleri.
 *
 * KURAL:
 * - Tamamen kullanıcıdan/profilden bağımsızdır (profileId, personal_rating, status YOKTUR).
 * - Poster, backdrop, görsel dosyaları/ikili veriler BU MODÜLDE TUTULMAZ.
 * - Browser-safe saf TypeScript tanımları (node:* importu içermez).
 */

import type { ContentFeatureSignal, MediaKind } from '../../contracts/index.ts';

export const CONTENT_INTELLIGENCE_VERSION = '2.0.0';

export type ContentProcessingStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'skipped';

export const CANONICAL_MOOD_IDS = [
  'dark',
  'thoughtful',
  'feel-good',
  'mind-bending',
  'cheerful',
  'deep',
  'thrilling',
  'romantic',
] as const;

export type CanonicalMoodId = (typeof CANONICAL_MOOD_IDS)[number];

/** Ham/karma içerik girdisi (TMDB, katalog veya istemci öğesinden gelebilir). */
export type RawContentInput = Record<string, unknown>;

export interface ContentKeywordEntry {
  readonly id: number;
  readonly name?: string;
}

export interface ContentCreditPerson {
  readonly id: number;
  readonly name: string;
  readonly character?: string;
  readonly job?: string;
  readonly department?: string;
}

export interface ContentCollectionRef {
  readonly id: number;
  readonly name?: string;
}

/** Görsellerden ve kişisel verilerden tamamen arındırılmış kanonik içerik metaverisi. */
export interface NormalizedContentMetadata {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly tmdbId: number;
  readonly imdbId: string | null;
  readonly title: string;
  readonly originalTitle: string;
  readonly overview: string;
  readonly genres: readonly string[];
  readonly genreIds: readonly number[];
  readonly keywords: readonly ContentKeywordEntry[];
  readonly cast: readonly ContentCreditPerson[];
  readonly crew: readonly ContentCreditPerson[];
  readonly collection: ContentCollectionRef | null;
  readonly releaseDate: string | null;
  /** Yalnızca TV: ilk yayın tarihi (movie için undefined). */
  readonly firstAirDate?: string | null;
  readonly runtimeMinutes: number | null;
  readonly episodeRunTime: readonly number[];
  readonly numberOfSeasons: number | null;
  readonly numberOfEpisodes: number | null;
  readonly originalLanguage: string | null;
  readonly originCountries: readonly string[];
  readonly productionCountries: readonly string[];
  /** TMDB oylama ortalaması (kişisel puan değildir). */
  readonly externalRating: number | null;
  readonly voteCount: number | null;
  readonly popularity: number | null;
  readonly source: string;
  readonly sourceRevision: string;
  readonly acquiredAt: string;
}

export interface MetadataValidationIssue {
  readonly field: string;
  readonly kind: 'missing' | 'invalid';
  readonly message: string;
}

export interface MetadataValidationResult {
  readonly valid: boolean;
  readonly mediaKey: string | null;
  readonly mediaType: MediaKind | null;
  readonly tmdbId: number | null;
  readonly imdbId: string | null;
  readonly errors: readonly string[];
  readonly issues: readonly MetadataValidationIssue[];
  readonly missingFields: readonly string[];
  readonly invalidFields: readonly string[];
  readonly strippedVisualFields: readonly string[];
  readonly strippedPersonalFields: readonly string[];
  /** Allowlist dışında kalan ve default-deny ile atılan bilinmeyen alanlar. */
  readonly strippedUnknownFields: readonly string[];
  readonly fieldCompleteness: number;
  readonly sanitizedRawMetadata: Record<string, unknown>;
  readonly normalized: NormalizedContentMetadata | null;
  readonly dataHash: string;
  readonly sourceRevision: string;
}

export type ContentPacingKind = 'fast' | 'balanced' | 'slow-burn' | 'episodic' | 'unknown';

export interface ContentDimensionConfidence {
  readonly genres: number;
  readonly themes: number;
  readonly atmosphere: number;
  readonly narrativeStyle: number;
  readonly pacing: number;
  readonly era: number;
  readonly setting: number;
  readonly characterDynamics: number;
  readonly concepts: number;
  readonly structure: number;
  readonly overallConfidence: number;
  readonly missingSignals: readonly string[];
}

export interface ContentDomainDimensions {
  readonly genres: readonly string[];
  readonly genreIds: readonly number[];
  readonly themes: readonly string[];
  readonly atmosphere: readonly string[];
  readonly narrativeStyle: readonly string[];
  readonly pacing: ContentPacingKind;
  readonly era: {
    readonly year: number | null;
    readonly decade: string | null;
    readonly bucket: number | null;
    readonly confidence: number;
  };
  readonly setting: {
    readonly countries: readonly string[];
    readonly language: string | null;
    readonly scopes: readonly string[];
  };
  readonly characterDynamics: readonly string[];
  readonly scientificPhilosophicalConcepts: readonly string[];
  readonly structureFormat: {
    readonly mediaType: MediaKind;
    readonly formatTag: string;
    readonly runtimeMinutes: number | null;
    readonly numberOfSeasons: number | null;
    readonly episodeRunTime: readonly number[];
  };
}

export interface ContentFeatureBundle {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly layoutVersion: number;
  readonly extractorVersion: string;
  readonly signature: string;
  readonly denseVector: readonly number[];
  readonly toneVector: readonly number[];
  readonly completeness: number;
  readonly toneTags: readonly string[];
  readonly features: Readonly<Record<string, ContentFeatureSignal>>;
  readonly dimensions: ContentDomainDimensions;
  readonly confidence: ContentDimensionConfidence;
}

export interface MoodAffinityDetail {
  readonly moodId: CanonicalMoodId;
  readonly label: string;
  readonly score: number;
  readonly confidence: number;
  readonly matchedSignals: readonly string[];
  readonly opposingSignals: readonly string[];
}

export interface ContentMoodVector {
  readonly version: string;
  readonly moods: Readonly<Record<CanonicalMoodId, number>>;
  readonly dominantMoods: readonly MoodAffinityDetail[];
  readonly overallConfidence: number;
  readonly isNeutralFallback: boolean;
}

export interface SemanticConceptDetail {
  readonly id: string;
  readonly label: string;
  readonly matchedTerms: readonly string[];
  readonly confidence: number;
}

export interface ContentSemanticProfile {
  readonly version: string;
  readonly concepts: readonly SemanticConceptDetail[];
  readonly keywords: {
    readonly ids: readonly number[];
    readonly displayKeywords: readonly string[];
  };
  readonly atmosphereClusters: readonly string[];
  readonly crewSummary: {
    readonly directorIds: readonly number[];
    readonly writerIds: readonly number[];
    readonly actorIds: readonly number[];
    readonly collectionId: number | null;
  };
  readonly contrastPoles: readonly string[];
  readonly confidence: number;
}

export interface ContentRelationshipLink {
  readonly sourceKey: string;
  readonly targetKey: string;
  readonly cosineSimilarity: number;
  readonly moodSimilarity: number;
  readonly atmosphereSimilarity: number;
  readonly conceptSimilarity: number;
  readonly contrastScore: number;
  readonly relationKind: 'similar' | 'atmospheric' | 'conceptual' | 'contrast' | 'mixed';
  readonly sharedConcepts: readonly string[];
  readonly contrastSignals: readonly string[];
  readonly confidence: number;
}

export interface ContentPipelineResult {
  readonly ok: boolean;
  readonly mediaKey: string | null;
  readonly mediaType: MediaKind | null;
  readonly tmdbId: number | null;
  readonly imdbId: string | null;
  readonly sourceRevision: string;
  readonly processingVersion: string;
  readonly processingStatus: ContentProcessingStatus;
  readonly processingError: string | null;
  readonly dataHash: string;
  readonly processedAt: string;
  readonly validation: MetadataValidationResult;
  readonly featureBundle: ContentFeatureBundle | null;
  readonly moodVector: ContentMoodVector | null;
  readonly semanticProfile: ContentSemanticProfile | null;
}

/** SQLite `content_intelligence` tablosu satır modeli (17+ zorunlu alan). */
export interface ContentIntelligenceRecord {
  readonly media_key: string;
  readonly media_type: MediaKind;
  readonly tmdb_id: number;
  readonly imdb_id: string | null;
  readonly source_revision: string;
  readonly metadata_json: string;
  readonly normalized_metadata_json: string;
  readonly feature_vector_json: string;
  readonly mood_vector_json: string;
  readonly semantic_data_json: string;
  readonly data_hash: string;
  readonly processed_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly processing_version: string;
  readonly processing_status: ContentProcessingStatus;
  readonly processing_error: string | null;
}

/** İleride çok kullanıcılı anonimleştirilmiş agregasyon için genişletme noktası. */
export interface AnonymizedAggregateStats {
  readonly generatedAt: string;
  readonly processingVersion: string;
  readonly totalRecords: number;
  readonly completedRecords: number;
  readonly failedRecords: number;
  readonly pendingOrProcessingRecords: number;
  readonly byMediaType: Readonly<Record<MediaKind, number>>;
  readonly averageCompleteness: number;
  readonly topGenres: ReadonlyArray<{ readonly genre: string; readonly count: number }>;
  readonly topConcepts: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly count: number;
  }>;
  readonly moodAverages: Readonly<Record<CanonicalMoodId, number>>;
}
