/**
 * MIA Faz 1 & Faz 2 — Content Intelligence Servis Uygulaması.
 *
 * SINIR GÜVENCESİ:
 * - Bu modül `IContentIntelligenceService` sözleşmesini uygular.
 * - Girdi olarak yalnızca ham/normalize içerik metaverisi alır; görsel
 *   verileri ve kullanıcıya ait kişisel verileriProcessor katmanında ayıklar.
 * - TMDB API proxy'sine veya `apiFetch`'e DOĞRUDAN erişmez (o yetki
 *   Content Manager / `IContentService` tarafındadır).
 * - Kullanıcı kütüphanesine, kişisel puanlarına veya `TasteStore`'a yazmaz.
 */

import type {
  ContentFeatureProfileView,
  ContentMetadata,
  ContentMoodEvaluation,
  ContentSemanticComparison,
  IContentIntelligenceService,
} from '../../contracts/index.ts';
import {
  CONTENT_INTELLIGENCE_VERSION,
  type ContentPipelineResult,
  type RawContentInput,
} from './types.ts';
import {
  ContentMetadataProcessor,
  createContentMetadataProcessor,
} from './content-metadata-processor.ts';
import {
  ContentFeatureExtractor,
  createContentFeatureExtractor,
} from './content-feature-extractor.ts';
import {
  ContentSemanticAnalyzer,
  createContentSemanticAnalyzer,
} from './content-semantic-analyzer.ts';
import { normalizeMoodKey } from '../../core/mood-affinity.ts';

export class ContentIntelligenceService implements IContentIntelligenceService {
  private readonly invalidatedSignatures = new Set<string>();
  private readonly processor: ContentMetadataProcessor;
  private readonly featureExtractor: ContentFeatureExtractor;
  private readonly semanticAnalyzer: ContentSemanticAnalyzer;

  constructor(
    deps: {
      processor?: ContentMetadataProcessor;
      featureExtractor?: ContentFeatureExtractor;
      semanticAnalyzer?: ContentSemanticAnalyzer;
    } = {}
  ) {
    this.processor = deps.processor ?? createContentMetadataProcessor();
    this.featureExtractor = deps.featureExtractor ?? createContentFeatureExtractor();
    this.semanticAnalyzer = deps.semanticAnalyzer ?? createContentSemanticAnalyzer();
  }

  /**
   * 8 adımlı tam içerik zekâsı boru hattı:
   * 1) Doğrulama -> 2) Normalizasyon (görsel/kişisel temizliği) ->
   * 3) Eksik/geçersiz alan tespiti -> 4) 48-boyutlu öznitelik vektörü ->
   * 5) Ruh hâli / atmosfer vektörü -> 6) Anlamsal kavram çıkarımı ->
   * 7) Karşılaştırmaya hazır imzalı profil -> 8) Sürüm + hash damgalı çıktı.
   */
  runPipeline(
    rawInput: RawContentInput | ContentMetadata | unknown,
    options: {
      source?: string;
      sourceRevision?: string;
      acquiredAt?: string;
      processingVersion?: string;
      processedAt?: string;
    } = {}
  ): ContentPipelineResult {
    const processingVersion = options.processingVersion ?? CONTENT_INTELLIGENCE_VERSION;
    const processedAt = options.processedAt ?? new Date().toISOString();
    const validation = this.processor.validateAndNormalize(rawInput, {
      source: options.source,
      sourceRevision: options.sourceRevision,
      acquiredAt: options.acquiredAt,
      processingVersion,
    });

    if (!validation.valid || !validation.normalized) {
      return {
        ok: false,
        mediaKey: validation.mediaKey,
        mediaType: validation.mediaType,
        tmdbId: validation.tmdbId,
        imdbId: validation.imdbId,
        sourceRevision: validation.sourceRevision,
        processingVersion,
        processingStatus: 'failed',
        processingError:
          validation.errors.join(' | ') || 'Metaveri doğrulamasından geçemedi.',
        dataHash: validation.dataHash,
        processedAt,
        validation,
        featureBundle: null,
        moodVector: null,
        semanticProfile: null,
      };
    }

    const normalized = validation.normalized;
    this.invalidatedSignatures.delete(normalized.mediaKey);

    const featureBundle = this.featureExtractor.extract(normalized);
    const moodVector = this.semanticAnalyzer.buildMoodVector(normalized);
    const semanticProfile = this.semanticAnalyzer.buildSemanticProfile(normalized, moodVector);

    return {
      ok: true,
      mediaKey: normalized.mediaKey,
      mediaType: normalized.mediaType,
      tmdbId: normalized.tmdbId,
      imdbId: normalized.imdbId,
      sourceRevision: validation.sourceRevision,
      processingVersion,
      processingStatus: 'completed',
      processingError: null,
      dataHash: validation.dataHash,
      processedAt,
      validation,
      featureBundle,
      moodVector,
      semanticProfile,
    };
  }

  async analyzeContent(metadata: ContentMetadata): Promise<ContentFeatureProfileView> {
    const result = this.runPipeline(metadata);
    if (!result.ok || !result.featureBundle) {
      throw new Error(result.processingError || `İçerik analiz edilemedi: ${metadata.mediaKey}`);
    }
    const bundle = result.featureBundle;
    return {
      mediaKey: bundle.mediaKey,
      mediaType: bundle.mediaType,
      layoutVersion: bundle.layoutVersion,
      extractorVersion: bundle.extractorVersion,
      signature: bundle.signature,
      denseVector: [...bundle.denseVector],
      completeness: bundle.completeness,
      toneTags: [...bundle.toneTags],
      features: bundle.features,
      computedAt: result.processedAt,
    };
  }

  async analyzeBatch(
    items: readonly ContentMetadata[]
  ): Promise<readonly ContentFeatureProfileView[]> {
    if (items.length === 0) return [];
    const results: ContentFeatureProfileView[] = [];
    for (const item of items) {
      results.push(await this.analyzeContent(item));
    }
    return results;
  }

  async evaluateMood(
    metadata: ContentMetadata,
    moodId: string
  ): Promise<ContentMoodEvaluation> {
    const pipeline = this.runPipeline(metadata);
    if (!pipeline.ok || !pipeline.moodVector) {
      return {
        mediaKey: metadata.mediaKey,
        moodId: normalizeMoodKey(moodId) || moodId,
        affinity: 0.5,
        confidence: 0.2,
        matchedSignals: [],
      };
    }
    const normalizedMood = normalizeMoodKey(moodId) as keyof typeof pipeline.moodVector.moods;
    const matchedDetail = pipeline.moodVector.dominantMoods.find(
      (d) => d.moodId === normalizedMood
    );
    const affinity =
      normalizedMood && normalizedMood in pipeline.moodVector.moods
        ? pipeline.moodVector.moods[normalizedMood]
        : 0.5;
    return {
      mediaKey: pipeline.mediaKey || metadata.mediaKey,
      moodId: normalizedMood || moodId,
      affinity,
      confidence: matchedDetail?.confidence ?? pipeline.moodVector.overallConfidence,
      matchedSignals: matchedDetail ? [...matchedDetail.matchedSignals] : [],
    };
  }

  async compareContents(
    source: ContentMetadata,
    target: ContentMetadata
  ): Promise<ContentSemanticComparison> {
    const srcPipe = this.runPipeline(source);
    const tgtPipe = this.runPipeline(target);
    if (
      !srcPipe.ok ||
      !srcPipe.validation.normalized ||
      !srcPipe.featureBundle ||
      !srcPipe.moodVector ||
      !srcPipe.semanticProfile ||
      !tgtPipe.ok ||
      !tgtPipe.validation.normalized ||
      !tgtPipe.featureBundle ||
      !tgtPipe.moodVector ||
      !tgtPipe.semanticProfile
    ) {
      return {
        sourceKey: source.mediaKey,
        targetKey: target.mediaKey,
        cosineSimilarity: 0,
        atmosphereSimilarity: 0,
        sharedConcepts: [],
        confidence: 0.1,
      };
    }

    const link = this.semanticAnalyzer.compareAnalyzed(
      srcPipe.validation.normalized,
      srcPipe.featureBundle,
      srcPipe.moodVector,
      srcPipe.semanticProfile,
      tgtPipe.validation.normalized,
      tgtPipe.featureBundle,
      tgtPipe.moodVector,
      tgtPipe.semanticProfile
    );

    return {
      sourceKey: link.sourceKey,
      targetKey: link.targetKey,
      cosineSimilarity: link.cosineSimilarity,
      atmosphereSimilarity: link.atmosphereSimilarity,
      sharedConcepts: [...link.sharedConcepts],
      confidence: link.confidence,
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
