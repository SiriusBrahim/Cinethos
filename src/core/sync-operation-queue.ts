/**
 * Aşama 2 (B-10 / B-38) — Senkronizasyon işlem kuyruğu.
 *
 * GitHub senkronizasyonu tek bir süreç içinde sıralı yürütülür. Bu modül
 * sıralamayı görünür ve denetlenebilir hale getirir:
 *
 * - Her işlem `queued` → `running` → sonuç (`succeeded` / `failed` /
 *   `cancelled`) durum geçişinden geçer; aynı anda iki işlem çalışmaz.
 * - `isBusy()` yalnızca çalışan işi değil **bekleyen** işi de sayar; böylece
 *   `rejectIfBusy` kuyruğu görebilir.
 * - Aynı `dedupeKey` ile gelen ikinci istek yeni bir işlem başlatmaz; aynı
 *   promise'i paylaşır (aynı işlem iki kez çalışıp veriyi iki kez yazmaz).
 * - Kuyruk kapasitesi ve bekleme süresi sınırlıdır; aşım açık hata koduyla
 *   reddedilir (sessiz yığılma yok).
 * - İptal sinyali kuyruktayken işlemi kuyruktan çıkarır; çalışırken işareti
 *   iletir (uçuş halindeki HTTP isteği kendi abort sinyaliyle durur).
 * - Görev hata fırlatsa da `finally` benzeri akış kuyruğu serbest bırakır;
 *   deadlock oluşmaz.
 *
 * SINIR: Bu kuyruk **süreç içidir**. Birden fazla Node süreci/instance için
 * garanti vermez; süreçler arası koruma `sync-file-lease.ts` ile sağlanır.
 */

export type SyncQueueState = 'idle' | 'queued' | 'running' | 'failed';
export type SyncQueueOutcomeStatus = 'succeeded' | 'failed' | 'cancelled';

export interface SyncQueueOutcome {
  readonly operation: string;
  readonly status: SyncQueueOutcomeStatus;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly error?: string;
}

export interface SyncQueueEntrySnapshot {
  readonly operation: string;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
}

export interface SyncQueueSnapshot {
  readonly state: SyncQueueState;
  /** Çalışan + bekleyen işlem sayısı. */
  readonly depth: number;
  readonly running: boolean;
  readonly runningOperation: string | null;
  readonly runningSince: string | null;
  readonly queuedOperations: readonly SyncQueueEntrySnapshot[];
  readonly lastOutcome: SyncQueueOutcome | null;
  readonly recoveredInterrupted: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly totalCancelled: number;
  readonly maxDepth: number;
}

export class SyncQueueError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'SyncQueueError';
    this.code = code;
  }
}

export class SyncQueueFullError extends SyncQueueError {
  constructor(maxDepth: number) {
    super(
      `Senkronizasyon kuyruğu dolu (${maxDepth} işlem). Devam eden işlem bitmeden yeni istek kabul edilmedi.`,
      'sync_queue_full'
    );
    this.name = 'SyncQueueFullError';
  }
}

export class SyncQueueTimeoutError extends SyncQueueError {
  constructor(operation: string, waitTimeoutMs: number) {
    super(
      `Senkronizasyon isteği kuyrukta ${waitTimeoutMs} ms bekledi ve başlatılamadı: ${operation}.`,
      'sync_queue_timeout'
    );
    this.name = 'SyncQueueTimeoutError';
  }
}

export class SyncAbortedError extends SyncQueueError {
  constructor(operation: string) {
    super(`Senkronizasyon isteği iptal edildi: ${operation}.`, 'sync_aborted');
    this.name = 'SyncAbortedError';
  }
}

export function isSyncQueueError(error: unknown): error is SyncQueueError {
  return error instanceof SyncQueueError;
}

export interface SyncQueueTaskContext {
  readonly signal: AbortSignal;
}

export interface SyncQueueEnqueueOptions {
  /** Aynı anahtarlı işlem çalışıyor/bekliyorsa yeni işlem açılmaz. */
  readonly dedupeKey?: string;
  /** Kuyrukta bekleme iptali. */
  readonly signal?: AbortSignal;
  /** Kuyrukta bekleme üst sınırı (varsayılan: kuyruk ayarı). */
  readonly waitTimeoutMs?: number;
}

export interface SyncOperationQueueOptions {
  readonly maxDepth?: number;
  readonly waitTimeoutMs?: number;
  readonly now?: () => string;
  readonly monotonicNow?: () => number;
  readonly setTimer?: (handler: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

interface PendingEntry {
  operation: string;
  dedupeKey?: string;
  task: (context: SyncQueueTaskContext) => Promise<unknown>;
  controller: AbortController;
  promise: Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  enqueuedAt: string;
  enqueuedAtMs: number;
  startedAt: string | null;
  timer: unknown;
  abortListener: (() => void) | null;
}

export class SyncOperationQueue {
  private readonly maxDepth: number;
  private readonly waitTimeoutMs: number;
  private readonly now: () => string;
  private readonly monotonicNow: () => number;
  private readonly setTimer: (handler: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private readonly pending: PendingEntry[] = [];
  private active: PendingEntry | null = null;
  private lastOutcome: SyncQueueOutcome | null = null;
  private recoveredInterrupted = 0;
  private totalSucceeded = 0;
  private totalFailed = 0;
  private totalCancelled = 0;
  private drainScheduled = false;

  constructor(options: SyncOperationQueueOptions = {}) {
    this.maxDepth = Math.max(1, Math.floor(options.maxDepth ?? 4));
    this.waitTimeoutMs = Math.max(1, Math.floor(options.waitTimeoutMs ?? 120_000));
    this.now = options.now ?? (() => new Date().toISOString());
    // Süre ölçümü için duvar saati yeterlidir; testler kontrollü saat enjekte eder.
    this.monotonicNow = options.monotonicNow ?? (() => Date.now());
    this.setTimer =
      options.setTimer ??
      ((handler, ms) => {
        const handle = setTimeout(handler, ms);
        (handle as { unref?: () => void }).unref?.();
        return handle;
      });
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  enqueue<T>(
    operation: string,
    task: (context: SyncQueueTaskContext) => Promise<T>,
    options: SyncQueueEnqueueOptions = {}
  ): Promise<T> {
    const dedupeKey = options.dedupeKey?.trim() || undefined;
    if (dedupeKey) {
      const existing = this.findByDedupeKey(dedupeKey);
      if (existing) return existing.promise as Promise<T>;
    }

    if (options.signal?.aborted) {
      return Promise.reject(new SyncAbortedError(operation));
    }
    if (this.getDepth() >= this.maxDepth) {
      return Promise.reject(new SyncQueueFullError(this.maxDepth));
    }

    let resolveEntry!: (value: unknown) => void;
    let rejectEntry!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveEntry = resolve;
      rejectEntry = reject;
    });

    const entry: PendingEntry = {
      operation,
      ...(dedupeKey ? { dedupeKey } : {}),
      task: task as (context: SyncQueueTaskContext) => Promise<unknown>,
      controller: new AbortController(),
      promise,
      resolve: resolveEntry,
      reject: rejectEntry,
      enqueuedAt: this.now(),
      enqueuedAtMs: this.monotonicNow(),
      startedAt: null,
      timer: null,
      abortListener: null,
    };

    this.pending.push(entry);
    this.armWaitTimer(entry, options.waitTimeoutMs ?? this.waitTimeoutMs);

    if (options.signal) {
      const listener = () => this.abortQueued(entry);
      entry.abortListener = listener;
      options.signal.addEventListener('abort', listener, { once: true });
    }

    this.scheduleDrain();
    return promise as Promise<T>;
  }

  isBusy(): boolean {
    return this.active !== null || this.pending.length > 0;
  }

  /** Çalışan + bekleyen işlem sayısı. */
  getDepth(): number {
    return this.pending.length + (this.active ? 1 : 0);
  }

  getSnapshot(): SyncQueueSnapshot {
    const pending = this.pending.slice();
    return {
      state: this.active
        ? 'running'
        : pending.length > 0
          ? 'queued'
          : this.lastOutcome?.status === 'failed'
            ? 'failed'
            : 'idle',
      depth: pending.length + (this.active ? 1 : 0),
      running: this.active !== null,
      runningOperation: this.active?.operation ?? null,
      runningSince: this.active?.startedAt ?? null,
      queuedOperations: pending.map((entry) => ({
        operation: entry.operation,
        enqueuedAt: entry.enqueuedAt,
        startedAt: entry.startedAt,
      })),
      lastOutcome: this.lastOutcome,
      recoveredInterrupted: this.recoveredInterrupted,
      totalSucceeded: this.totalSucceeded,
      totalFailed: this.totalFailed,
      totalCancelled: this.totalCancelled,
      maxDepth: this.maxDepth,
    };
  }

  /**
   * Önceki süreçte yarım kalan işlem sayısını bildirir. Kuyruk bellekte
   * olduğundan iş yeniden başlatılmaz; durum açıkça "kurtarıldı" olarak
   * raporlanır ve yeni işlemler normal çalışır.
   */
  markRecoveredInterrupted(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.recoveredInterrupted += Math.floor(count);
  }

  /** Test/teşhis için: bekleyen işlemleri iptal eder, çalışanı etkilemez. */
  cancelPending(reason = 'queue-drained'): number {
    const entries = this.pending.splice(0, this.pending.length);
    for (const entry of entries) {
      this.cleanupEntry(entry);
      this.recordOutcome(entry, 'cancelled', reason);
      entry.reject(new SyncAbortedError(entry.operation));
    }
    return entries.length;
  }

  private findByDedupeKey(dedupeKey: string): PendingEntry | null {
    if (this.active?.dedupeKey === dedupeKey) return this.active;
    return this.pending.find((entry) => entry.dedupeKey === dedupeKey) ?? null;
  }

  private armWaitTimer(entry: PendingEntry, waitTimeoutMs: number): void {
    if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) return;
    entry.timer = this.setTimer(() => {
      if (!this.pending.includes(entry)) return;
      const index = this.pending.indexOf(entry);
      if (index >= 0) this.pending.splice(index, 1);
      this.cleanupEntry(entry);
      this.recordOutcome(
        entry,
        'cancelled',
        new SyncQueueTimeoutError(entry.operation, waitTimeoutMs).message
      );
      entry.reject(new SyncQueueTimeoutError(entry.operation, waitTimeoutMs));
    }, waitTimeoutMs);
  }

  private abortQueued(entry: PendingEntry): void {
    const index = this.pending.indexOf(entry);
    if (index < 0) {
      // Çalışan işlem: sinyali ilet; sonucu görev belirler.
      if (this.active === entry) entry.controller.abort();
      return;
    }
    this.pending.splice(index, 1);
    this.cleanupEntry(entry);
    this.recordOutcome(entry, 'cancelled', new SyncAbortedError(entry.operation).message);
    entry.reject(new SyncAbortedError(entry.operation));
  }

  private cleanupEntry(entry: PendingEntry): void {
    if (entry.timer !== null) {
      this.clearTimer(entry.timer);
      entry.timer = null;
    }
    if (entry.abortListener) {
      entry.abortListener = null;
    }
  }

  private scheduleDrain(): void {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    void Promise.resolve().then(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;
    const next = this.pending.shift();
    if (!next) return;

    this.cleanupEntry(next);
    next.startedAt = this.now();
    this.active = next;

    void (async () => {
      let status: SyncQueueOutcomeStatus = 'succeeded';
      let failure: string | undefined;
      try {
        const value = await next.task({ signal: next.controller.signal });
        next.resolve(value);
      } catch (error) {
        status = next.controller.signal.aborted ? 'cancelled' : 'failed';
        failure = error instanceof Error ? error.message : String(error);
        next.reject(error);
      } finally {
        this.active = null;
        this.recordOutcome(next, status, failure);
        this.scheduleDrain();
      }
    })();
  }

  private recordOutcome(
    entry: PendingEntry,
    status: SyncQueueOutcomeStatus,
    error?: string
  ): void {
    const completedAt = this.now();
    const durationMs = Math.max(0, this.monotonicNow() - entry.enqueuedAtMs);
    this.lastOutcome = {
      operation: entry.operation,
      status,
      completedAt,
      durationMs,
      ...(error ? { error } : {}),
    };
    if (status === 'succeeded') this.totalSucceeded += 1;
    else if (status === 'failed') this.totalFailed += 1;
    else this.totalCancelled += 1;
  }
}
