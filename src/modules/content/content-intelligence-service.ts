/**
 * MIA Faz 1B — Adım 2 & Adım 4: Content Intelligence Servis Uygulaması.
 *
 * SINIR GÜVENCESİ:
 * - Bu modül `IContentIntelligenceService` sözleşmesini uygular.
 * - Girdi olarak yalnızca normalize edilmiş `ContentMetadata` alır.
 * - TMDB API proxy'sine veya `apiFetch`'e DOĞRUDAN erişmez (o yetki
 *   Content Manager / `IContentService` tarafındadır).
 * - Kullanıcı kütüphanesine, kişisel puanlarına veya `TasteStore`'a yazmaz.
 */

import type {
  ContentFeatureProfileView,
  ContentFeatureSignal,
  ContentMetadata,
  ContentMoodEvaluation,
  ContentSemanticComparison,
  IContentIntelligenceService,
} from '../../contracts/index.ts';
import {
  ENCODING_LAYOUT_VERSION,
  cosineSimilarity,
  type EncodableMediaInput,
} from '../../core/encoding.ts';
import { parseMediaKey } from '../../core/keys.ts';
import { calculateMoodAffinity } from '../../core/mood-affinity.ts';
import { EXTRACTOR_VERSION } from '../../core/taste/constants.ts';
import { extractContentTasteItem } from '../../core/taste/feature-extractor.ts';
import type { TasteMetadataInput } from '../../core/taste/types.ts';
import { batchGetEncodings, getItemEncoding } from '../../services/encoding-service.ts';

function parseNumericId(mediaKey: string): number {
  const parsed = parseMediaKey(mediaKey);
  if (parsed && /^\d+$/.test(parsed.id)) {
    return Number(parsed.id);
  }
  const digits = String(mediaKey).replace(/\D+/g, '');
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function toEncodableInput(metadata: ContentMetadata): EncodableMediaInput {
  return {
    id: parseNumericId(metadata.mediaKey),
    media_type: metadata.mediaType,
    title: metadata.title,
    name: metadata.mediaType === 'tv' ? metadata.title : undefined,
    overview: metadata.overview ?? '',
    genre_ids: metadata.genreIds ? [...metadata.genreIds] : [],
    release_date: metadata.mediaType === 'movie' ? metadata.releaseDate : undefined,
    first_air_date: metadata.mediaType === 'tv' ? metadata.releaseDate : undefined,
    vote_average: metadata.externalRating ?? undefined,
    vote_count: metadata.voteCount ?? undefined,
    popularity: metadata.popularity ?? undefined,
    keywords: metadata.keywords?.map((kw) => ({ id: kw.id })),
  };
}

function toTasteMetadataInput(metadata: ContentMetadata): TasteMetadataInput {
  return {
    contentId: metadata.mediaKey,
    mediaType: metadata.mediaType,
    tmdbId: parseNumericId(metadata.mediaKey),
    ...(metadata.genreIds?.length ? { genreIds: [...metadata.genreIds] } : {}),
    ...(metadata.keywords?.length
      ? { keywords: metadata.keywords.map((k) => ({ id: k.id, name: k.name })) }
      : {}),
    ...(metadata.originalLanguage ? { originalLanguage: metadata.originalLanguage } : {}),
    ...(metadata.originCountries?.length ? { originCountry: [...metadata.originCountries] } : {}),
    ...(metadata.runtimeMinutes != null ? { runtime: metadata.runtimeMinutes } : {}),
    ...(metadata.releaseDate
      ? metadata.mediaType === 'tv'
        ? { firstAirDate: metadata.releaseDate }
        : { releaseDate: metadata.releaseDate }
      : {}),
  };
}

export class ContentIntelligenceService implements IContentIntelligenceService {
  private readonly invalidatedSignatures = new Set<string>();

  async analyzeContent(metadata: ContentMetadata): Promise<ContentFeatureProfileView> {
    this.invalidatedSignatures.delete(metadata.mediaKey);
    const enc = await getItemEncoding(toEncodableInput(metadata));
    const extracted = extractContentTasteItem(toTasteMetadataInput(metadata));

    const signals: Record<string, ContentFeatureSignal> = {};
    for (const [metricId, feat] of Object.entries(extracted.features)) {
      signals[metricId] = {
        metricId,
        strength: feat.strength,
        confidence: feat.confidence,
        source: feat.source,
        ...(feat.evidence ? { evidence: [...feat.evidence] } : {}),
      };
    }

    return {
      mediaKey: metadata.mediaKey,
      mediaType: metadata.mediaType,
      layoutVersion: ENCODING_LAYOUT_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      signature: enc.signature,
      denseVector: [...enc.denseVector],
      completeness: extracted.completeness,
      toneTags: [...enc.tokens],
      features: signals,
      computedAt: enc.encodedAt,
    };
  }

  async analyzeBatch(
    items: readonly ContentMetadata[]
  ): Promise<readonly ContentFeatureProfileView[]> {
    if (items.length === 0) return [];
    const encodings = await batchGetEncodings(items.map(toEncodableInput));
    return items.map((metadata, index) => {
      const enc = encodings[index];
      const extracted = extractContentTasteItem(toTasteMetadataInput(metadata));
      const signals: Record<string, ContentFeatureSignal> = {};
      for (const [metricId, feat] of Object.entries(extracted.features)) {
        signals[metricId] = {
          metricId,
          strength: feat.strength,
          confidence: feat.confidence,
          source: feat.source,
          ...(feat.evidence ? { evidence: [...feat.evidence] } : {}),
        };
      }
      return {
        mediaKey: metadata.mediaKey,
        mediaType: metadata.mediaType,
        layoutVersion: ENCODING_LAYOUT_VERSION,
        extractorVersion: EXTRACTOR_VERSION,
        signature: enc.signature,
        denseVector: [...enc.denseVector],
        completeness: extracted.completeness,
        toneTags: [...enc.tokens],
        features: signals,
        computedAt: enc.encodedAt,
      };
    });
  }

  async evaluateMood(
    metadata: ContentMetadata,
    moodId: string
  ): Promise<ContentMoodEvaluation> {
    const result = calculateMoodAffinity(
      {
        id: parseNumericId(metadata.mediaKey),
        media_type: metadata.mediaType,
        title: metadata.title,
        overview: metadata.overview,
        genre_ids: metadata.genreIds ? [...metadata.genreIds] : [],
        keywords: metadata.keywords?.map((k) => ({ id: k.id, name: k.name })),
      },
      moodId
    );

    const matchedSignals = [...result.matchedFeatures];
    return {
      mediaKey: metadata.mediaKey,
      moodId: result.normalizedMood || moodId,
      affinity: result.atmosphereScore,
      confidence: result.isNeutralFallback ? 0.25 : 0.85,
      matchedSignals,
    };
  }

  async compareContents(
    source: ContentMetadata,
    target: ContentMetadata
  ): Promise<ContentSemanticComparison> {
    const [srcEnc, tgtEnc] = await Promise.all([
      getItemEncoding(toEncodableInput(source)),
      getItemEncoding(toEncodableInput(target)),
    ]);

    const vecSim = cosineSimilarity(srcEnc.denseVector, tgtEnc.denseVector);
    const srcTokens = new Set(srcEnc.tokens);
    const sharedConcepts = tgtEnc.tokens.filter((t) => srcTokens.has(t));

    // Atmosferik benzerlik: toneVector kosinüs benzerliği + ortak ton kelimeleri
    const toneSim = cosineSimilarity(srcEnc.toneVector, tgtEnc.toneVector);
    const atmosphereSimilarity =
      sharedConcepts.length > 0
        ? Math.min(1, toneSim * 0.7 + Math.min(0.3, sharedConcepts.length * 0.08))
        : toneSim;

    const confidence =
      srcEnc.denseVector.length > 0 && tgtEnc.denseVector.length > 0
        ? Math.min(1, 0.5 + (sharedConcepts.length > 0 ? 0.3 : 0) + (vecSim > 0 ? 0.2 : 0))
        : 0.2;

    return {
      sourceKey: source.mediaKey,
      targetKey: target.mediaKey,
      cosineSimilarity: Math.round(vecSim * 1000) / 1000,
      atmosphereSimilarity: Math.round(atmosphereSimilarity * 1000) / 1000,
      sharedConcepts,
      confidence: Math.round(confidence * 100) / 100,
    };
  }

  async invalidateSignature(mediaKey: string): Promise<void> {
    this.invalidatedSignatures.add(mediaKey);
  }

  isInvalidated(mediaKey: string): boolean {
    return this.invalidatedSignatures.has(mediaKey);
  }
}

export function createContentIntelligenceService(): ContentIntelligenceService {
  return new ContentIntelligenceService();
}
