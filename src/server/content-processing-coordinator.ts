/**
 * MIA Faz 2 — Content Processing Coordinator (`IApplicationModule`)
 *
 * Sorumluluk:
 * - Repository, Metadata Source, Pure Intelligence Service, Persistent Queue ve
 *   Event Subscriber modüllerini çalışma zamanında birleştirir.
 * - `ModuleRegistry` üzerinden initialize -> start -> stop -> healthCheck
 *   yaşam döngüsünü uygular; açılışta yarım kalan işleri kaldığı yerden sürdürür.
 * - Mevcut Content Manager, Taste Engine ve Recommendation Engine yetkilerine müdahale etmez.
 */

import path from 'node:path';
import type {
  EventSubscription,
  IApplicationModule,
  MediaKind,
  ModuleContext,
  ModuleHealth,
} from '../contracts/index.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import { parseMediaKey } from '../core/keys.ts';
import {
  collectInitialIndexItems,
  createInitialIndexStats,
  type InitialIndexStats,
} from './initial-indexer.ts';
import {
  ContentIntelligenceService,
  createContentIntelligenceService,
} from '../modules/content/content-intelligence-service.ts';
import { createContentSemanticAnalyzer } from '../modules/content/content-semantic-analyzer.ts';
import {
  CONTENT_INTELLIGENCE_VERSION,
  type AnonymizedAggregateStats,
  type ContentFeatureBundle,
  ContentIntelligenceRecord,
  ContentMoodVector,
  ContentProcessingStatus,
  ContentRelationshipLink,
  ContentSemanticProfile,
  NormalizedContentMetadata,
} from '../modules/content/types.ts';
import {
  ContentEventSubscriber,
  createContentEventSubscriber,
} from './content-event-subscriber.ts';
import {
  ContentIntelligenceRepository,
  createContentIntelligenceRepository,
  type ContentRepositoryStatus,
} from './content-intelligence-repository.ts';
import {
  ContentMetadataSource,
  createContentMetadataSource,
  type CustomMetadataFetcher,
} from './content-metadata-source.ts';
import {
  ContentProcessingQueue,
  createContentProcessingQueue,
  type EnqueueContentJobInput,
  type ProcessJobOutcome,
} from './content-processing-queue.ts';

export interface ContentProcessingCoordinatorOptions {
  readonly dataDir?: string;
  readonly dbPath?: string;
  readonly tmdbApiKey?: string;
  readonly concurrency?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly customFetcher?: CustomMetadataFetcher;
  readonly resolveMetadata?: (mediaKey: string) => Record<string, unknown> | undefined;
}

export interface ContentCoordinatorStatus {
  readonly started: boolean;
  readonly repository: ContentRepositoryStatus;
  readonly counts: ReturnType<ContentIntelligenceRepository['countRecords']>;
  readonly queue: ReturnType<ContentIntelligenceRepository['getQueueStats']>;
}

export class ContentProcessingCoordinator implements IApplicationModule {
  readonly id = 'content-intelligence';
  readonly version = '2.0.0';
  readonly layer = 'background' as const;

  readonly repository: ContentIntelligenceRepository;
  readonly metadataSource: ContentMetadataSource;
  readonly intelligenceService: ContentIntelligenceService;
  readonly queue: ContentProcessingQueue;
  readonly eventSubscriber: ContentEventSubscriber;

  private readonly semanticAnalyzer = createContentSemanticAnalyzer();
  private moduleContext: ModuleContext | null = null;
  private eventSub: EventSubscription | null = null;
  private initialized = false;
  private started = false;
  private initialIndexStats: InitialIndexStats = createInitialIndexStats();

  constructor(options: ContentProcessingCoordinatorOptions = {}) {
    const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
    this.repository = createContentIntelligenceRepository({
      dataDir: resolvedDataDir,
      dbPath: options.dbPath,
    });
    this.metadataSource = createContentMetadataSource({
      dataDir: resolvedDataDir,
      tmdbApiKey: options.tmdbApiKey,
      customFetcher: options.customFetcher,
    });
    this.intelligenceService = createContentIntelligenceService();
    this.queue = createContentProcessingQueue({
      repository: this.repository,
      metadataSource: this.metadataSource,
      intelligenceService: this.intelligenceService,
      concurrency: options.concurrency,
      baseRetryDelayMs: options.baseRetryDelayMs,
      maxAttempts: options.maxAttempts,
    });
    this.eventSubscriber = createContentEventSubscriber({
      repository: this.repository,
      queue: this.queue,
      resolveMetadata: options.resolveMetadata,
    });
  }

  async initialize(ctx?: ModuleContext): Promise<void> {
    if (ctx) {
      this.moduleContext = ctx;
    }
    if (this.initialized) return;
    this.repository.ensureInitialized();
    this.initialized = true;
  }

  async start(ctx?: ModuleContext): Promise<void> {
    if (ctx) {
      this.moduleContext = ctx;
    }
    if (!this.initialized) {
      await this.initialize(this.moduleContext ?? undefined);
    }
    const activeCtx = this.moduleContext;
    if (!this.eventSub && activeCtx?.subscribe) {
      this.eventSub = this.eventSubscriber.subscribeToEventBus(activeCtx.subscribe);
    }
    const { recovered } = this.queue.start();
    this.started = true;
    if (recovered > 0) {
      activeCtx?.logger.info(
        this.id,
        `Açılış kurtarması: ${recovered} bekleyen/yarım kalmış iş kuyruğa alındı.`
      );
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.eventSub?.unsubscribe();
    this.eventSub = null;
    await this.queue.stop();
    this.repository.close();
    this.initialized = false;
  }

  async healthCheck(): Promise<ModuleHealth> {
    try {
      const available = this.repository.isAvailable();
      if (!available) {
        return {
          moduleId: this.id,
          status: 'unhealthy',
          detail: this.repository.getStatus().lastError || 'sqlite_unavailable',
        };
      }
      const counts = this.repository.countRecords();
      const q = this.repository.getQueueStats();
      return {
        moduleId: this.id,
        status: this.started && this.eventSub ? 'healthy' : 'degraded',
        detail: `records=${counts.completed}/${counts.total} queuePending=${q.pending} failed=${counts.failed}`,
      };
    } catch (error) {
      return {
        moduleId: this.id,
        status: 'unhealthy',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  enqueueRawItem(
    rawItem: Record<string, unknown>,
    options: { sourceRevision?: string; triggerEventId?: string } = {}
  ): { accepted: boolean; mediaKey: string | null; reason?: string } {
    this.repository.ensureInitialized();
    return this.queue.enqueue({
      payload: rawItem,
      sourceRevision: options.sourceRevision ?? null,
      triggerEventId: options.triggerEventId ?? null,
    });
  }

  enqueueHiddenOrDislikedItem(
    mediaKey: string,
    rawItem?: Record<string, unknown>
  ): { accepted: boolean; mediaKey: string | null; reason?: string } {
    this.repository.ensureInitialized();
    const parsed = parseMediaKey(mediaKey);
    return this.queue.enqueue({
      mediaKey,
      mediaType: parsed?.type,
      tmdbId: parsed && /^\d+$/.test(parsed.id) ? Number(parsed.id) : undefined,
      payload: rawItem ?? (parsed ? { id: Number(parsed.id), media_type: parsed.type } : null),
    });
  }

  async enqueueLibraryItemsBatch(
    items: readonly Record<string, unknown>[],
    options: { pageSize?: number } = {}
  ): Promise<{ total: number; accepted: number; rejected: number }> {
    this.repository.ensureInitialized();
    const jobs: EnqueueContentJobInput[] = items.map((item) => ({ payload: item }));
    return this.queue.enqueueBatch(jobs, {
      pageSize: options.pageSize ?? 25,
      yieldBetweenPages: true,
    });
  }

  /**
   * MIA Faz 2 — Adım 2.7 (Dilim G): Başlangıç indekslemesi.
   *
   * Belgedeki beş liste kapsamını (izledim/izleyeceğim/izliyorum/ilgilenmiyorum/
   * gizlenen) sayfalı olarak kuyruğa alır; normal kullanıcı olaylarıyla
   * idempotent biçimde birleşir (aynı media_key için tek iş).
   */
  async runInitialIndexing(
    doc: DataDocument | null | undefined,
    options: { pageSize?: number } = {}
  ): Promise<InitialIndexStats> {
    this.repository.ensureInitialized();
    this.initialIndexStats = {
      ...createInitialIndexStats(),
      status: 'running',
      lastRunAt: new Date().toISOString(),
    };
    try {
      const items = collectInitialIndexItems(doc);
      const jobs: EnqueueContentJobInput[] = items.map((it) => ({
        mediaKey: it.mediaKey,
        mediaType: it.mediaType,
        tmdbId: it.tmdbId,
        payload: it.payload,
      }));
      const result = await this.queue.enqueueBatch(jobs, {
        pageSize: options.pageSize ?? 25,
        yieldBetweenPages: true,
      });
      this.initialIndexStats = {
        ...this.initialIndexStats,
        status: result.rejected > 0 ? 'partial' : 'completed',
        totalUnique: result.total,
        queued: result.accepted,
        rejected: result.rejected,
        failed: result.rejected,
        lastError:
          result.rejected > 0
            ? `${result.rejected} kayıt kuyruğa alınamadı; indeksleme kısmi tamamlandı.`
            : null,
      };
    } catch (err) {
      this.initialIndexStats = {
        ...this.initialIndexStats,
        status: 'failed',
        failed: this.initialIndexStats.totalUnique,
        lastError: err instanceof Error ? err.message : String(err),
      };
    }
    return this.initialIndexStats;
  }

  getInitialIndexStats(): InitialIndexStats {
    return { ...this.initialIndexStats };
  }

  processImmediate(rawItem: Record<string, unknown>): Promise<ProcessJobOutcome> {
    this.repository.ensureInitialized();
    return this.queue.processImmediate({ payload: rawItem });
  }

  async drain(options?: { waitForRetries?: boolean; timeoutMs?: number }): Promise<void> {
    this.repository.ensureInitialized();
    await this.queue.drain(options);
  }

  getByMediaKey(mediaKey: string): ContentIntelligenceRecord | null {
    this.repository.ensureInitialized();
    return this.repository.getByMediaKey(mediaKey);
  }

  listRecords(options?: {
    limit?: number;
    offset?: number;
    mediaType?: MediaKind;
    status?: ContentProcessingStatus;
  }): ReturnType<ContentIntelligenceRepository['listRecords']> {
    this.repository.ensureInitialized();
    return this.repository.listRecords(options);
  }

  countStaleRecords(): number {
    this.repository.ensureInitialized();
    return this.repository.countStaleRecords(CONTENT_INTELLIGENCE_VERSION);
  }

  listStaleRecords(limit = 100): Array<{ mediaKey: string; mediaType: MediaKind; tmdbId: number }> {
    this.repository.ensureInitialized();
    return this.repository
      .listStaleMediaKeys(CONTENT_INTELLIGENCE_VERSION, limit)
      .map((row) => ({ mediaKey: row.media_key, mediaType: row.media_type, tmdbId: row.tmdb_id }));
  }

  /**
   * Eksik/başarısız/eski sürümlü analizleri kuyruğa geri verir.
   * Aynı `media_key` için tek iş üretilir (kuyruk koalesansı).
   */
  async reprocessStale(options: { limit?: number; pageSize?: number } = {}) {
    this.repository.ensureInitialized();
    const stale = this.listStaleRecords(options.limit ?? 100);
    if (stale.length === 0) {
      return { total: 0, accepted: 0, rejected: 0 };
    }
    return this.queue.enqueueBatch(
      stale.map((row) => ({
        mediaKey: row.mediaKey,
        mediaType: row.mediaType,
        tmdbId: row.tmdbId,
      })),
      { pageSize: options.pageSize ?? 25, yieldBetweenPages: true }
    );
  }

  getRelated(mediaKey: string, limit = 10): ContentRelationshipLink[] {
    this.repository.ensureInitialized();
    return this.repository.findRelated(mediaKey, limit);
  }

  compareStored(sourceKey: string, targetKey: string): ContentRelationshipLink | null {
    this.repository.ensureInitialized();
    const src = this.repository.getByMediaKey(sourceKey);
    const tgt = this.repository.getByMediaKey(targetKey);
    if (
      !src ||
      !tgt ||
      src.processing_status !== 'completed' ||
      tgt.processing_status !== 'completed'
    ) {
      return null;
    }
    try {
      const srcNorm = JSON.parse(src.normalized_metadata_json) as NormalizedContentMetadata;
      const srcFeat = JSON.parse(src.feature_vector_json) as ContentFeatureBundle;
      const srcMood = JSON.parse(src.mood_vector_json) as ContentMoodVector;
      const srcSem = JSON.parse(src.semantic_data_json) as ContentSemanticProfile;
      const tgtNorm = JSON.parse(tgt.normalized_metadata_json) as NormalizedContentMetadata;
      const tgtFeat = JSON.parse(tgt.feature_vector_json) as ContentFeatureBundle;
      const tgtMood = JSON.parse(tgt.mood_vector_json) as ContentMoodVector;
      const tgtSem = JSON.parse(tgt.semantic_data_json) as ContentSemanticProfile;
      return this.semanticAnalyzer.compareAnalyzed(
        srcNorm,
        srcFeat,
        srcMood,
        srcSem,
        tgtNorm,
        tgtFeat,
        tgtMood,
        tgtSem
      );
    } catch {
      return null;
    }
  }

  getAnonymizedAggregateStats(): AnonymizedAggregateStats {
    this.repository.ensureInitialized();
    return this.repository.getAnonymizedAggregateStats();
  }

  getStatus(): ContentCoordinatorStatus {
    this.repository.ensureInitialized();
    return {
      started: this.started,
      repository: this.repository.getStatus(),
      counts: this.repository.countRecords(),
      queue: this.repository.getQueueStats(),
    };
  }
}

export function createContentProcessingCoordinator(
  options: ContentProcessingCoordinatorOptions = {}
): ContentProcessingCoordinator {
  return new ContentProcessingCoordinator(options);
}
