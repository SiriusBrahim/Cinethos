/**
 * MIA Faz 2 — Content Processing Queue
 *
 * Sorumluluklar:
 * - SQLite destekli kalıcı kuyruk (`content_processing_queue`): yeniden başlatmada
 *   yarım kalan (`processing`) veya bekleyen (`pending`) işleri devam ettirir.
 * - Aynı `media_key` için eşzamanlı çalışmayı engeller (`inFlightByKey` kilidi + koalesans).
 * - `data_hash` + `processing_version` değişmemişse gereksiz yeniden işlemeyi atlar.
 * - Geçici API/ağ hatalarında kontrollü backoff ile yeniden dener; kalıcı veya
 *   bozuk metaveride hatayı `processing_status = 'failed'` olarak kaydeder, çökmez.
 * - Büyük listeler için sayfalama / parça bazlı (chunked) arka plan kuyruklama sağlar.
 */

import type { MediaKind } from '../contracts/index.ts';
import { parseMediaKey } from '../core/keys.ts';
import { ContentIntelligenceService } from '../modules/content/content-intelligence-service.ts';
import { sanitizeRawContentInput } from '../modules/content/content-metadata-processor.ts';
import {
  CONTENT_INTELLIGENCE_VERSION,
  type ContentIntelligenceRecord,
} from '../modules/content/types.ts';
import {
  ContentIntelligenceRepository,
  type ContentQueueJobRow,
} from './content-intelligence-repository.ts';
import {
  ContentMetadataSource,
  TransientMetadataFetchError,
  hasSufficientDetail,
} from './content-metadata-source.ts';

export interface EnqueueContentJobInput {
  readonly mediaKey?: string;
  readonly mediaType?: MediaKind;
  readonly tmdbId?: number;
  readonly payload?: Record<string, unknown> | null;
  readonly sourceRevision?: string | null;
  readonly triggerEventId?: string | null;
  readonly maxAttempts?: number;
}

export interface ProcessJobOutcome {
  readonly mediaKey: string;
  readonly status: 'completed' | 'skipped' | 'retrying' | 'failed';
  readonly record?: ContentIntelligenceRecord | null;
  readonly error?: string;
}

export interface ContentProcessingQueueOptions {
  readonly repository: ContentIntelligenceRepository;
  readonly metadataSource: ContentMetadataSource;
  readonly intelligenceService?: ContentIntelligenceService;
  readonly concurrency?: number;
  readonly baseRetryDelayMs?: number;
  readonly maxAttempts?: number;
  readonly pollIntervalMs?: number;
  readonly logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof TransientMetadataFetchError) return true;
  if (err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === true) {
    return true;
  }
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\b(ECONNRESET|ETIMEDOUT|EAI_AGAIN|429|502|503|504|transient)\b/i.test(msg);
}

function resolveJobIdentity(
  input: EnqueueContentJobInput
): { mediaKey: string; mediaType: MediaKind; tmdbId: number } | null {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : null;
  const keyCandidate =
    input.mediaKey ||
    (payload && typeof payload.mediaKey === 'string' ? payload.mediaKey : undefined) ||
    (payload && typeof payload.media_key === 'string' ? payload.media_key : undefined);

  const parsed = keyCandidate ? parseMediaKey(keyCandidate) : null;
  const mediaType: MediaKind | null =
    input.mediaType ??
    (parsed?.type === 'tv' || parsed?.type === 'movie'
      ? parsed.type
      : payload?.media_type === 'tv' || payload?.mediaType === 'tv'
        ? 'tv'
        : payload?.media_type === 'movie' || payload?.mediaType === 'movie'
          ? 'movie'
          : payload?.name && !payload?.title
            ? 'tv'
            : payload?.title
              ? 'movie'
              : null);

  const rawId = input.tmdbId ?? parsed?.id ?? payload?.tmdbId ?? payload?.tmdb_id ?? payload?.id;
  const numId = Number(rawId);
  if (!mediaType || !Number.isInteger(numId) || numId <= 0) {
    return null;
  }

  return {
    mediaKey: `${mediaType}:${numId}`,
    mediaType,
    tmdbId: numId,
  };
}

export class ContentProcessingQueue {
  private readonly repository: ContentIntelligenceRepository;
  private readonly metadataSource: ContentMetadataSource;
  private readonly intelligenceService: ContentIntelligenceService;
  private readonly concurrency: number;
  private readonly baseRetryDelayMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly pollIntervalMs: number;
  private readonly logger?: ContentProcessingQueueOptions['logger'];

  private readonly inFlightByKey = new Map<string, Promise<ProcessJobOutcome>>();
  private running = false;
  private pumpScheduled = false;
  private activeWorkers = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pumpPromise: Promise<void> | null = null;

  constructor(options: ContentProcessingQueueOptions) {
    this.repository = options.repository;
    this.metadataSource = options.metadataSource;
    this.intelligenceService =
      options.intelligenceService ?? new ContentIntelligenceService();
    this.concurrency = Math.max(1, Math.min(8, Math.floor(options.concurrency ?? 3)));
    this.baseRetryDelayMs = Math.max(10, Math.floor(options.baseRetryDelayMs ?? 150));
    this.defaultMaxAttempts = Math.max(1, Math.min(10, Math.floor(options.maxAttempts ?? 3)));
    this.pollIntervalMs = Math.max(20, Math.floor(options.pollIntervalMs ?? 250));
    this.logger = options.logger;
  }

  start(): { recovered: number } {
    this.repository.ensureInitialized();
    const recovered = this.repository.recoverInterruptedJobs();
    this.running = true;
    this.schedulePump();
    if (recovered > 0) {
      this.logger?.info?.(
        `Yeniden başlatma sonrası ${recovered} yarım kalmış iş kuyruğa geri alındı.`
      );
    }
    return { recovered };
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pumpPromise) {
      await this.pumpPromise.catch(() => undefined);
    }
    if (this.inFlightByKey.size > 0) {
      await Promise.allSettled([...this.inFlightByKey.values()]);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  enqueue(input: EnqueueContentJobInput): {
    accepted: boolean;
    mediaKey: string | null;
    reason?: string;
  } {
    const identity = resolveJobIdentity(input);
    if (!identity) {
      return {
        accepted: false,
        mediaKey: input.mediaKey ?? null,
        reason: 'Geçerli mediaKey / tmdbId / mediaType belirlenemedi.',
      };
    }

    this.repository.ensureInitialized();
    const sanitizedPayload = input.payload
      ? sanitizeRawContentInput(input.payload).sanitized
      : null;

    this.repository.upsertPendingStub({
      mediaKey: identity.mediaKey,
      mediaType: identity.mediaType,
      tmdbId: identity.tmdbId,
      ...(input.sourceRevision ? { sourceRevision: input.sourceRevision } : {}),
      ...(sanitizedPayload ? { sanitizedMetadata: sanitizedPayload } : {}),
    });

    this.repository.enqueueJob({
      mediaKey: identity.mediaKey,
      mediaType: identity.mediaType,
      tmdbId: identity.tmdbId,
      sourceRevision: input.sourceRevision ?? null,
      payload: sanitizedPayload,
      triggerEventId: input.triggerEventId ?? null,
      maxAttempts: input.maxAttempts ?? this.defaultMaxAttempts,
    });

    if (this.running) {
      this.schedulePump();
    }

    return { accepted: true, mediaKey: identity.mediaKey };
  }

  /**
   * Büyük listeleri olay döngüsünü kilitlemeden sayfalayarak kuyruğa alır.
   */
  async enqueueBatch(
    items: readonly EnqueueContentJobInput[],
    options: { pageSize?: number; yieldBetweenPages?: boolean } = {}
  ): Promise<{ total: number; accepted: number; rejected: number }> {
    const pageSize = Math.max(1, Math.min(100, Math.floor(options.pageSize ?? 25)));
    const yieldBetweenPages = options.yieldBetweenPages ?? true;
    let accepted = 0;
    let rejected = 0;

    for (let i = 0; i < items.length; i += pageSize) {
      const slice = items.slice(i, i + pageSize);
      for (const item of slice) {
        const res = this.enqueue(item);
        if (res.accepted) accepted += 1;
        else rejected += 1;
      }
      if (yieldBetweenPages && i + pageSize < items.length) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    return { total: items.length, accepted, rejected };
  }

  /**
   * Aynı `media_key` için eşzamanlı çağrıları tek bir uçuş içi promise'ta birleştirir.
   */
  async processImmediate(input: EnqueueContentJobInput): Promise<ProcessJobOutcome> {
    const identity = resolveJobIdentity(input);
    if (!identity) {
      const rawKey = input.mediaKey || 'unknown';
      return {
        mediaKey: rawKey,
        status: 'failed',
        error: 'Geçerli mediaKey / tmdbId / mediaType belirlenemedi.',
      };
    }

    const existingInFlight = this.inFlightByKey.get(identity.mediaKey);
    if (existingInFlight) {
      return existingInFlight;
    }

    const sanitizedPayload = input.payload
      ? sanitizeRawContentInput(input.payload).sanitized
      : null;

    const syntheticRow: ContentQueueJobRow = {
      media_key: identity.mediaKey,
      media_type: identity.mediaType,
      tmdb_id: identity.tmdbId,
      source_revision: input.sourceRevision ?? null,
      payload_json: sanitizedPayload ? JSON.stringify(sanitizedPayload) : null,
      trigger_event_id: input.triggerEventId ?? null,
      status: 'processing',
      attempts: 1,
      max_attempts: input.maxAttempts ?? this.defaultMaxAttempts,
      next_retry_at: null,
      last_error: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    return this.executeLockedJob(syntheticRow, false);
  }

  /**
   * Bekleyen (ve istenirse retry bekleyen) tüm işler bitene kadar kuyruğu boşaltır.
   */
  async drain(options: { waitForRetries?: boolean; timeoutMs?: number } = {}): Promise<void> {
    const waitForRetries = options.waitForRetries ?? true;
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);

    while (Date.now() < deadline) {
      await this.pumpOnce();
      if (this.inFlightByKey.size > 0) {
        await Promise.allSettled([...this.inFlightByKey.values()]);
      }
      const stats = this.repository.getQueueStats();
      if (stats.pending === 0 && stats.processing === 0) {
        return;
      }
      if (!waitForRetries) {
        if (!this.repository.hasReadyJobs(new Date().toISOString())) return;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, this.baseRetryDelayMs)));
    }
  }

  private schedulePump(): void {
    if (!this.running || this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      if (!this.running) return;
      this.pumpPromise = this.pumpOnce()
        .catch((err) => {
          this.logger?.error?.(
            `Kuyruk pompası hatası: ${err instanceof Error ? err.message : String(err)}`
          );
        })
        .finally(() => {
          this.pumpPromise = null;
        });
    }, 0);
  }

  private scheduleNextRetryCheck(): void {
    if (!this.running || this.retryTimer) return;
    const stats = this.repository.getQueueStats();
    if (stats.pending === 0) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.running) {
        this.schedulePump();
      }
    }, Math.min(this.pollIntervalMs, this.baseRetryDelayMs));
    this.retryTimer.unref?.();
  }

  async pumpOnce(): Promise<void> {
    this.repository.ensureInitialized();
    const availableSlots = Math.max(0, this.concurrency - this.activeWorkers);
    if (availableSlots === 0) return;

    const claimed = this.repository.claimNextJobs(availableSlots, new Date().toISOString());
    if (claimed.length === 0) {
      this.scheduleNextRetryCheck();
      return;
    }

    await Promise.all(claimed.map((job) => this.executeLockedJob(job, true)));

    const stats = this.repository.getQueueStats();
    if (stats.pending > 0 && this.running) {
      if (!this.repository.hasReadyJobs(new Date().toISOString())) {
        this.scheduleNextRetryCheck();
      } else {
        this.schedulePump();
      }
    }
  }

  private executeLockedJob(
    job: ContentQueueJobRow,
    updateQueueTable: boolean
  ): Promise<ProcessJobOutcome> {
    const existing = this.inFlightByKey.get(job.media_key);
    if (existing) {
      if (updateQueueTable) {
        this.repository.markJobCompleted(job.media_key);
      }
      return existing;
    }

    const promise = this.runSingleJob(job, updateQueueTable).finally(() => {
      this.inFlightByKey.delete(job.media_key);
      this.activeWorkers = Math.max(0, this.activeWorkers - 1);
    });

    this.activeWorkers += 1;
    this.inFlightByKey.set(job.media_key, promise);
    return promise;
  }

  private async runSingleJob(
    job: ContentQueueJobRow,
    updateQueueTable: boolean
  ): Promise<ProcessJobOutcome> {
    let parsedPayload: Record<string, unknown> | null = null;
    if (job.payload_json) {
      try {
        parsedPayload = JSON.parse(job.payload_json) as Record<string, unknown>;
      } catch {
        parsedPayload = null;
      }
    }

    try {
      // Senaryo 7/13 koruması: Yük yeterli metaveri taşımıyorsa ve bu media_key için
      // zaten tamamlanmış bir ortak kayıt varsa, kaydı 'failed' ile EZME; mevcut kaydı koru.
      // (Başka bir kullanıcının aynı içeriği listeye eklemesi ortak kaydı bozmamalı.)
      const existingCompleted = this.repository.getByMediaKey(job.media_key);
      if (
        existingCompleted &&
        existingCompleted.processing_status === 'completed' &&
        !hasSufficientDetail(parsedPayload)
      ) {
        if (updateQueueTable) {
          this.repository.markJobCompleted(job.media_key);
        }
        return {
          mediaKey: job.media_key,
          status: 'skipped',
          record: existingCompleted,
        };
      }

      const acquired = await this.metadataSource.acquireMetadata({
        mediaKey: job.media_key,
        mediaType: job.media_type,
        tmdbId: job.tmdb_id,
        providedPayload: parsedPayload,
        sourceRevision: job.source_revision,
      });

      const pipelineResult = this.intelligenceService.runPipeline(acquired.payload, {
        source: acquired.source,
        sourceRevision: acquired.sourceRevision,
        acquiredAt: acquired.acquiredAt,
        processingVersion: CONTENT_INTELLIGENCE_VERSION,
      });

      if (!pipelineResult.ok) {
        const errMsg =
          pipelineResult.processingError || 'İçerik metaverisi doğrulama hatası.';
        const failedRecord = this.repository.upsertFailedResult({
          mediaKey: job.media_key,
          mediaType: job.media_type,
          tmdbId: job.tmdb_id,
          imdbId: pipelineResult.imdbId,
          sourceRevision: pipelineResult.sourceRevision,
          sanitizedMetadata: pipelineResult.validation.sanitizedRawMetadata,
          dataHash: pipelineResult.dataHash,
          processingVersion: pipelineResult.processingVersion,
          error: errMsg,
        });
        if (updateQueueTable) {
          this.repository.markJobFailed(job.media_key, errMsg);
        }
        return {
          mediaKey: job.media_key,
          status: 'failed',
          record: failedRecord,
          error: errMsg,
        };
      }

      // Hash & version değişmediyse gereksiz yeniden yazmayı/hesaplamayı atla
      const existing = this.repository.getByMediaKey(job.media_key);
      if (
        existing &&
        existing.processing_status === 'completed' &&
        existing.processing_version === pipelineResult.processingVersion &&
        existing.data_hash === pipelineResult.dataHash
      ) {
        if (updateQueueTable) {
          this.repository.markJobCompleted(job.media_key);
        }
        return {
          mediaKey: job.media_key,
          status: 'skipped',
          record: existing,
        };
      }

      const saved = this.repository.upsertCompletedResult(pipelineResult);
      if (updateQueueTable) {
        this.repository.markJobCompleted(job.media_key);
      }

      return {
        mediaKey: job.media_key,
        status: 'completed',
        record: saved,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const retryable = isRetryableError(error);

      if (retryable && updateQueueTable && job.attempts < job.max_attempts) {
        const delayMs = this.baseRetryDelayMs * Math.pow(2, Math.max(0, job.attempts - 1));
        const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
        this.repository.scheduleJobRetry(job.media_key, nextRetryAt, errMsg);
        this.logger?.warn?.(
          `${job.media_key} için geçici hata; yeniden deneme planlandı (${job.attempts}/${job.max_attempts}): ${errMsg}`
        );
        this.scheduleNextRetryCheck();
        return {
          mediaKey: job.media_key,
          status: 'retrying',
          error: errMsg,
        };
      }

      const failedRecord = this.repository.upsertFailedResult({
        mediaKey: job.media_key,
        mediaType: job.media_type,
        tmdbId: job.tmdb_id,
        sourceRevision: job.source_revision || 'error',
        sanitizedMetadata: parsedPayload ?? {},
        error: errMsg,
      });
      if (updateQueueTable) {
        this.repository.markJobFailed(job.media_key, errMsg);
      }
      this.logger?.error?.(`${job.media_key} işlenemedi: ${errMsg}`);
      return {
        mediaKey: job.media_key,
        status: 'failed',
        record: failedRecord,
        error: errMsg,
      };
    }
  }
}

export function createContentProcessingQueue(
  options: ContentProcessingQueueOptions
): ContentProcessingQueue {
  return new ContentProcessingQueue(options);
}
