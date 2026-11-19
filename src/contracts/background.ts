/**
 * MIA Faz 4 — Background Manager sözleşmeleri.
 *
 * Kalıcı görev kuyruğu, işleyici kaydı ve görev durumları burada tanımlıdır.
 * `AppEventBus`, `ProfileContext` ve SQLite repository mevcut altyapıdan
 * yeniden kullanılır; bu dosya yalnızca tipleri tanımlar.
 *
 * SINIR: Bu sözleşmeler UI'a bağımlı değildir ve içerik/öneri algoritmalarına
 * müdahale etmez. Kullanıcı verisi (puan, not, durum) yalnızca olayın kendi
 * payload'ında, allowlist ile küçültülmüş biçimde taşınır.
 */

import type { AppEventMap, TypedAppEvent } from './events.ts';
import type { IProfileContext } from './profile.ts';

/** Görev yaşam döngüsü — talimat §4.6. */
export type BackgroundTaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'retry_wait'
  | 'failed'
  | 'cancelled';

export const BACKGROUND_TASK_STATUSES: readonly BackgroundTaskStatus[] = [
  'pending',
  'processing',
  'completed',
  'retry_wait',
  'failed',
  'cancelled',
];

/** Terminal durumlar — yeniden denenmez. */
export const TERMINAL_BACKGROUND_STATUSES: readonly BackgroundTaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export interface BackgroundEventRecord {
  readonly eventId: string;
  readonly eventType: string;
  readonly profileId: string;
  readonly entityId: string | null;
  readonly schemaVersion: number;
  readonly sourceRevision: number;
  readonly occurredAt: string;
  readonly receivedAt: string;
  /** Allowlist ile küçültülmüş, JSON'a çevrilebilir payload. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface BackgroundTaskRecord {
  readonly taskId: string;
  readonly eventId: string;
  readonly handlerId: string;
  readonly profileId: string;
  readonly status: BackgroundTaskStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: string | null;
  readonly leaseUntil: string | null;
  readonly lastError: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface BackgroundTaskLogger {
  info?(message: string, data?: Record<string, unknown>): void;
  warn?(message: string, data?: Record<string, unknown>): void;
  error?(message: string, data?: Record<string, unknown>): void;
}

/**
 * İşleyiciye verilen bağlam. `profileContext` ZORUNLUDUR; işleyici her etkiden
 * önce görevin profilinin hâlâ aktif olduğunu doğrulamakla yükümlüdür.
 */
export interface BackgroundTaskHandlerContext {
  readonly profileContext: IProfileContext;
  readonly now: () => string;
  readonly logger?: BackgroundTaskLogger;
}

/**
 * Merkezi işleyici sözleşmesi. Her işleyici hangi olay türlerini karşıladığını
 * açıkça bildirir; eşleme `BackgroundManager` içinde tek yerde kurulur.
 */
export interface BackgroundTaskHandler {
  readonly id: string;
  readonly version: string;
  readonly eventTypes: readonly (keyof AppEventMap)[];
  /**
   * R2-A4: `true` ise görev yalnızca hedef profil AKTİFKEN çalıştırılır.
   * Hedef profili aktif olmayan görevler kiralanmaz (deneme hakkı tüketilmez) ve
   * aktif profil değişiminde pompa uyandırılarak telafi edilir. Canlı abonelik
   * zaten aktif profilin olaylarını işlediğinden bu tür görevler yalnızca
   * kaçırılmış (aktif olmayan profile ait) olaylar için üretilir.
   */
  readonly profileScoped?: boolean;
  /**
   * Etki burada yapılır. Hata fırlatırsa görev durumu hata sınıfına göre
   * `retry_wait` veya `failed` olur; diğer görevler etkilenmez.
   */
  handle(event: TypedAppEvent, context: BackgroundTaskHandlerContext): Promise<void>;
}

export interface BackgroundTaskStats {
  readonly events: number;
  readonly tasks: number;
  readonly byStatus: Readonly<Record<BackgroundTaskStatus, number>>;
  readonly dueRetries: number;
}

export interface BackgroundEventInput {
  readonly eventId: string;
  readonly eventType: string;
  readonly profileId: string;
  readonly entityId?: string | null;
  readonly schemaVersion: number;
  readonly sourceRevision: number;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
  /** Bu olay için görev üretilecek işleyici kimlikleri (pilot: iki olay). */
  readonly handlerIds: readonly string[];
}

export interface AcceptBackgroundEventResult {
  readonly eventInserted: boolean;
  readonly tasksCreated: number;
  readonly deduplicated: boolean;
}

export interface BackgroundTaskListOptions {
  readonly status?: BackgroundTaskStatus;
  readonly profileId?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface BackgroundTaskStoreStatus {
  readonly available: boolean;
  readonly filePath: string;
  readonly lastError: string | null;
}

/**
 * Kalıcı görev deposu portu.
 *
 * `BackgroundManager` somut SQLite sınıfına değil bu sözleşmeye bağlıdır;
 * sunucu katmanı `BackgroundTaskRepository` ile uygular (katman ters
 * bağımlılığı yoktur). Test/alternatif depolar aynı portu karşılayabilir.
 */
export interface BackgroundTaskStore {
  ensureInitialized(): void;
  close(): void;
  getStatus(): BackgroundTaskStoreStatus;
  acceptEvent(
    input: BackgroundEventInput,
    nowIso?: string
  ): AcceptBackgroundEventResult;
  getEvent(eventId: string): BackgroundEventRecord | null;
  getTask(taskId: string): BackgroundTaskRecord | null;
  listTasks(options?: BackgroundTaskListOptions): BackgroundTaskRecord[];
  claimNextTask(
    leaseMs?: number,
    nowIso?: string,
    profileId?: string
  ): BackgroundTaskRecord | null;
  /** R2-A4: hedef profili aktif olmayan görevi deneme hakkı tüketmeden bekletir. */
  deferTask(taskId: string, reason: string, nowIso?: string): void;
  markCompleted(taskId: string, nowIso?: string): void;
  scheduleRetry(taskId: string, nextRetryAt: string, error: string, nowIso?: string): void;
  markFailed(taskId: string, error: string, nowIso?: string): void;
  cancelTask(taskId: string, reason: string, nowIso?: string): boolean;
  recoverInterrupted(nowIso?: string): { requeued: number; failed: number };
  getStats(nowIso?: string): BackgroundTaskStats;
}
