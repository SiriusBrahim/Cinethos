/**
 * MIA Faz 4 — Background Manager.
 *
 * Sorumluluk:
 * - `AppEventBus.persistEvent` kancası üzerinden gelen olayları kalıcı deftere
 *   yazar (tüm olaylar) ve yalnızca kayıtlı işleyicisi olan olaylar için görev
 *   üretir (pilot: LibraryItemAdded + LibraryRatingChanged).
 * - Görevleri sırayla kiralar, işleyiciye yönlendirir, sonucu durum olarak yazar.
 * - Geçici hatalarda deterministik backoff ile `retry_wait`, kalıcı hatalarda
 *   `failed`, profil değişiminde yeniden planlama uygular.
 * - Açılışta lease'i dolmuş `processing` görevleri kurtarır.
 *
 * KURALLAR:
 * - İkinci bir EventBus/kuyruk/persistent katman YOKTUR; mevcut AppEventBus,
 *   ProfileContext ve SQLite (`background_events`/`background_tasks`) kullanılır.
 * - Bir işleyici hatası diğer görevleri durdurmaz (her görev kendi try/catch'inde).
 * - Aynı `(eventId, handlerId)` ikinci kez işlenmez (UNIQUE + terminal kontrolü).
 * - Kullanıcı verisi yalnızca allowlist'li payload ile taşınır.
 */

import {
  ProfileConflictError,
  type AppEventMap,
  type BackgroundEventRecord,
  type BackgroundTaskHandler,
  type BackgroundTaskHandlerContext,
  type BackgroundTaskListOptions,
  type BackgroundTaskRecord,
  type BackgroundTaskStats,
  type BackgroundTaskStore,
  type IProfileContext,
  type ModuleContext,
  type ModuleHealth,
  type TypedAppEvent,
} from '../../contracts/index.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import { sanitizeEventPayload } from './event-payload.ts';
import { isRetryableBackgroundError, resolveRetryDelayMs } from './errors.ts';

export interface BackgroundManagerOptions {
  readonly repository: BackgroundTaskStore;
  readonly handlers?: readonly BackgroundTaskHandler[];
  /** Test/bağımsız kullanım için; uygulamada `initialize(context)` ile gelir. */
  readonly profileContext?: IProfileContext | null;
  readonly baseRetryDelayMs?: number;
  readonly leaseMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => string;
  readonly logger?: {
    info?(message: string, data?: Record<string, unknown>): void;
    warn?(message: string, data?: Record<string, unknown>): void;
    error?(message: string, data?: Record<string, unknown>): void;
  };
}

export interface BackgroundManagerStatus {
  readonly started: boolean;
  readonly running: boolean;
  readonly stats: BackgroundTaskStats;
  readonly handlerIds: readonly string[];
}

export class BackgroundManager {
  readonly id = 'background-manager';
  readonly version = '1.0.0';
  readonly layer = 'background' as const;

  private readonly repository: BackgroundTaskStore;
  private readonly handlersById = new Map<string, BackgroundTaskHandler>();
  private readonly handlersByEvent = new Map<string, BackgroundTaskHandler[]>();
  private readonly baseRetryDelayMs: number;
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly now: () => string;
  private readonly logger?: BackgroundManagerOptions['logger'];

  private profileContext: IProfileContext | null;
  private profileUnsub: { unsubscribe(): void } | null = null;
  private running = false;
  private pumpScheduled = false;
  private pumpPromise: Promise<void> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private recoveredOnStart = { requeued: 0, failed: 0 };

  constructor(options: BackgroundManagerOptions) {
    this.repository = options.repository;
    this.profileContext = options.profileContext ?? null;
    this.baseRetryDelayMs = Math.max(10, Math.floor(options.baseRetryDelayMs ?? 250));
    this.leaseMs = Math.max(1_000, Math.floor(options.leaseMs ?? 60_000));
    this.pollIntervalMs = Math.max(25, Math.floor(options.pollIntervalMs ?? 500));
    this.now = options.now ?? (() => new Date().toISOString());
    this.logger = options.logger;

    this.registerHandlers(options.handlers ?? []);
  }

  /**
   * İşleyici kaydı. Uygulamada Taste telafi işleyicisi, adapter oluşturulduktan
   * sonra (başlatmadan önce) bu yöntemle eklenir; mevcut kimlikler korunur.
   */
  registerHandlers(handlers: readonly BackgroundTaskHandler[]): void {
    if (this.running) {
      throw new Error('Background işleyicileri yönetici çalışırken kaydedilemez.');
    }
    for (const handler of handlers) {
      if (this.handlersById.has(handler.id)) {
        throw new Error(`Background handler kimliği tekrar ediyor: ${handler.id}`);
      }
      this.handlersById.set(handler.id, handler);
      for (const eventType of handler.eventTypes) {
        const list = this.handlersByEvent.get(eventType) ?? [];
        list.push(handler);
        this.handlersByEvent.set(eventType, list);
      }
    }
  }

  /** `ModuleContext` uyumlu başlatma; profil bağlamı buradan alınır. */
  async initialize(context?: Pick<ModuleContext, 'profile' | 'logger'>): Promise<void> {
    if (context?.profile) {
      this.profileContext = context.profile;
    }
    this.repository.ensureInitialized();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.repository.ensureInitialized();
    this.recoveredOnStart = this.repository.recoverInterrupted(this.now());
    // R2-A4: profil değişiminde bekleyen (hedef profili artık aktif olan)
    // görevler için pompa uyandırılır. Dinleyici yoksa (test stub) sessiz geçilir.
    if (!this.profileUnsub && typeof this.profileContext?.onProfileChange === 'function') {
      this.profileUnsub = this.profileContext.onProfileChange(() => this.notify());
    }
    this.running = true;
    if (this.recoveredOnStart.requeued > 0 || this.recoveredOnStart.failed > 0) {
      this.logger?.warn?.('Yarım kalan görevler kurtarıldı.', this.recoveredOnStart);
    }
    this.schedulePump();
    this.pollTimer = setInterval(() => this.schedulePump(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.profileUnsub?.unsubscribe();
    this.profileUnsub = null;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pumpPromise) {
      await this.pumpPromise.catch(() => undefined);
    }
    this.repository.close();
  }

  async healthCheck(): Promise<ModuleHealth> {
    try {
      const status = this.repository.getStatus();
      if (!status.available) {
        return {
          moduleId: this.id,
          status: 'unhealthy',
          detail: status.lastError || 'sqlite_unavailable',
        };
      }
      const stats = this.repository.getStats(this.now());
      return {
        moduleId: this.id,
        status: this.running ? 'healthy' : 'degraded',
        detail: `tasks=${stats.tasks} pending=${stats.byStatus.pending} retry=${stats.byStatus.retry_wait} failed=${stats.byStatus.failed}`,
      };
    } catch (error) {
      return {
        moduleId: this.id,
        status: 'unhealthy',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * `AppEventBus.persistEvent` kancası. Olay kalıcı yazılamazsa hata fırlatır;
   * `publish()` bu hatayı çağırana iletir (sessiz yutma yok).
   */
  async acceptEvent(event: TypedAppEvent): Promise<{
    eventInserted: boolean;
    tasksCreated: number;
    deduplicated: boolean;
  }> {
    const profileId = normalizeProfileId(event.profileId);
    if (!profileId) throw new Error('Background event için geçerli profileId zorunludur.');
    const allHandlers = this.handlersByEvent.get(event.eventType) ?? [];
    // R2-A4: profil kapsamlı işleyiciler yalnızca HEDEF PROFİL AKTİF DEĞİLKEN
    // görev üretir. Aktif profilin olayı canlı abonelikte zaten işlenir; ayrıca
    // görev üretmek gereksiz çift iş olurdu. Aktif olmayan profilin olayı ise
    // kalıcı kuyrukta bekler ve o profil aktif olunca telafi edilir.
    const activeProfileId = normalizeProfileId(this.profileContext?.getCurrent().profileId);
    const handlers = allHandlers.filter(
      (handler) => !handler.profileScoped || activeProfileId !== profileId
    );
    const result = this.repository.acceptEvent(
      {
        eventId: event.eventId,
        eventType: event.eventType,
        profileId,
        entityId: event.entityId ?? null,
        schemaVersion: event.schemaVersion,
        sourceRevision: event.sourceRevision,
        occurredAt: event.occurredAt,
        payload: sanitizeEventPayload(event.eventType, event.payload),
        handlerIds: handlers.map((handler) => handler.id),
      },
      this.now()
    );

    if (result.tasksCreated > 0) {
      this.notify();
    }
    if (result.deduplicated) {
      this.logger?.warn?.('Aynı eventId ikinci kez geldi; yeni görev üretilmedi.', {
        eventId: event.eventId,
        eventType: event.eventType,
      });
    }
    return result;
  }


  /**
   * A live subscriber can discover a profile switch after persistEvent already
   * accepted the event. Add only the profile-scoped fallback tasks at that point.
   */
  ensureProfileScopedTasks(event: TypedAppEvent): number {
    const profileId = normalizeProfileId(event.profileId);
    if (!profileId) throw new Error('Background event için geçerli profileId zorunludur.');
    const handlers = (this.handlersByEvent.get(event.eventType) ?? []).filter(
      (handler) => handler.profileScoped
    );
    let created = 0;
    for (const handler of handlers) {
      if (
        this.repository.ensureTaskForEvent(
          event.eventId,
          handler.id,
          profileId,
          this.now()
        )
      ) {
        created += 1;
      }
    }
    if (created > 0) this.notify();
    return created;
  }

  /** Yeni görev bildirimi (pompa zamanlar). */
  notify(): void {
    this.schedulePump();
  }

  getTask(taskId: string): BackgroundTaskRecord | null {
    return this.repository.getTask(taskId);
  }

  listTasks(options: BackgroundTaskListOptions = {}): BackgroundTaskRecord[] {
    return this.repository.listTasks(options);
  }

  getEvent(eventId: string): BackgroundEventRecord | null {
    return this.repository.getEvent(eventId);
  }

  getStats(): BackgroundTaskStats {
    return this.repository.getStats(this.now());
  }

  cancelTask(taskId: string, reason = 'cancelled-by-operator'): boolean {
    return this.repository.cancelTask(taskId, reason, this.now());
  }

  /**
   * Operatör yeniden denemesi. Terminal hatalı bir görev `pending` durumuna
   * döner, deneme sayacı sıfırlanır ve pompa uyandırılır. Depo bu işlemi
   * desteklemiyorsa `false` döner (sessiz yutma yok).
   */
  retryTask(taskId: string): boolean {
    if (typeof this.repository.requeueTask !== 'function') return false;
    const requeued = this.repository.requeueTask(taskId, this.now());
    if (requeued) this.notify();
    return requeued;
  }

  getStatus(): BackgroundManagerStatus {
    return {
      started: this.running,
      running: this.running,
      stats: this.getStats(),
      handlerIds: [...this.handlersById.keys()],
    };
  }

  /** Test/teşhis için tek pompa turu; üretimde zamanlayıcı çağırır. */
  async pumpOnce(): Promise<void> {
    if (!this.running) return;
    // R2-A4: yalnızca aktif profile ait görev kiralanır. Diğer profillerin
    // görevleri pending kalır; profil değişiminde pompa yeniden çalışır.
    const activeProfileId = this.profileContext?.getCurrent().profileId;
    const task = this.repository.claimNextTask(this.leaseMs, this.now(), activeProfileId);
    if (!task) return;
    await this.executeTask(task);
  }

  private schedulePump(): void {
    if (!this.running || this.pumpScheduled) return;
    this.pumpScheduled = true;
    setTimeout(() => {
      this.pumpScheduled = false;
      if (!this.running) return;
      this.pumpPromise = this.pumpOnce()
        .catch((error) => {
          this.logger?.error?.('Background pompa hatası.', {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.pumpPromise = null;
        });
    }, 0);
  }

  private async executeTask(task: BackgroundTaskRecord): Promise<void> {
    const handler = this.handlersById.get(task.handlerId);
    if (!handler) {
      this.repository.markFailed(task.taskId, `handler-missing:${task.handlerId}`, this.now());
      return;
    }
    const record = this.repository.getEvent(task.eventId);
    if (!record) {
      this.repository.markFailed(task.taskId, 'event-missing', this.now());
      return;
    }
    const profileContext = this.profileContext;
    if (!profileContext) {
      this.repository.markFailed(task.taskId, 'profile-context-missing', this.now());
      return;
    }

    // R2-A4 savunma katmanı: kiralama ile işleyici başlangıcı arasında profil
    // değişmişse hedef profile YAZILMAZ; görev deneme hakkı tüketmeden bekler ve
    // hedef profil yeniden aktif olduğunda çalışır.
    if (handler.profileScoped && normalizeProfileId(profileContext.getCurrent().profileId) !== normalizeProfileId(task.profileId)) {
      this.repository.deferTask(task.taskId, 'profile-inactive', this.now());
      return;
    }

    const event = this.toTypedEvent(record);
    const context: BackgroundTaskHandlerContext = {
      profileContext,
      now: this.now,
      ...(this.logger ? { logger: this.logger } : {}),
    };

    try {
      await handler.handle(event, context);
      this.repository.markCompleted(task.taskId, this.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (error instanceof ProfileConflictError) {
        // Profil değişti: yeni profile YAZILMAZ; görev yeniden planlanır.
        if (task.attempts < task.maxAttempts) {
          const nextRetryAt = new Date(
            Date.parse(this.now()) + resolveRetryDelayMs(task.attempts, this.baseRetryDelayMs)
          ).toISOString();
          this.repository.scheduleRetry(task.taskId, nextRetryAt, message, this.now());
        } else {
          this.repository.markFailed(task.taskId, `profile-not-active: ${message}`, this.now());
        }
        return;
      }

      if (isRetryableBackgroundError(error) && task.attempts < task.maxAttempts) {
        const nextRetryAt = new Date(
          Date.parse(this.now()) + resolveRetryDelayMs(task.attempts, this.baseRetryDelayMs)
        ).toISOString();
        this.repository.scheduleRetry(task.taskId, nextRetryAt, message, this.now());
        this.logger?.warn?.('Görev yeniden planlandı.', {
          taskId: task.taskId,
          handlerId: task.handlerId,
          attempts: task.attempts,
          nextRetryAt,
        });
        return;
      }

      this.repository.markFailed(task.taskId, message, this.now());
      this.logger?.error?.('Görev kalıcı olarak başarısız.', {
        taskId: task.taskId,
        handlerId: task.handlerId,
        error: message,
      });
    }
  }

  private toTypedEvent(record: BackgroundEventRecord): TypedAppEvent {
    const eventType = record.eventType as keyof AppEventMap;
    const profileId = normalizeProfileId(record.profileId);
    if (!profileId) throw new Error('Kalıcı background event geçersiz profileId içeriyor.');
    return {
      eventId: record.eventId,
      eventType,
      profileId,
      ...(record.entityId ? { entityId: record.entityId } : {}),
      occurredAt: record.occurredAt,
      schemaVersion: record.schemaVersion,
      payload: record.payload as AppEventMap[keyof AppEventMap],
      sourceRevision: record.sourceRevision,
      ref: { profileId, revision: record.sourceRevision },
    };
  }
}

export function createBackgroundManager(options: BackgroundManagerOptions): BackgroundManager {
  return new BackgroundManager(options);
}
