import type { OperationsTask, OperationsTaskStatus } from '../../services/operations-api.ts';

/**
 * Aşama 4 (B-26) — İşlem Merkezi eylem politikası (tek kaynak).
 *
 * Retry/iptal düğmelerinin etkinliği sunucunun gerçek sözleşmesinden türetilir:
 * - `POST /api/background/tasks/:id/retry` yalnızca `failed`, `cancelled`,
 *   `retry_wait`, `completed` durumlarındaki görevleri `pending`e döndürür;
 *   `pending`/`processing` için 409 `task_not_retryable` döner.
 * - `POST /api/background/tasks/:id/cancel` `completed`/`cancelled` dışındaki
 *   durumları iptal eder; aksi hâlde 409 `task_not_cancellable`.
 *
 * Arayüz bu kuralı kendi başına yorumlamaz; hem düğme durumu hem açıklama
 * buradan gelir.
 */

export type TaskAction = 'retry' | 'cancel';

/** Sunucunun yeniden denemeye izin verdiği durumlar. */
const RETRYABLE_STATUSES: ReadonlySet<OperationsTaskStatus> = new Set([
  'failed',
  'cancelled',
  'retry_wait',
  'completed',
]);

/** Sunucunun iptale izin verdiği durumlar. */
const CANCELLABLE_STATUSES: ReadonlySet<OperationsTaskStatus> = new Set([
  'pending',
  'processing',
  'retry_wait',
  'failed',
]);

export const TASK_STATUS_HUMAN: Record<OperationsTaskStatus, string> = {
  pending: 'Bekliyor',
  processing: 'Çalışıyor',
  completed: 'Tamamlandı',
  retry_wait: 'Yeniden deneme bekliyor',
  failed: 'Başarısız',
  cancelled: 'İptal edildi',
};

export interface TaskActionAvailability {
  readonly retry: boolean;
  /** Retry devre dışıysa kullanıcıya gösterilecek neden. */
  readonly retryReason: string | null;
  readonly cancel: boolean;
  readonly cancelReason: string | null;
}

export interface TaskActionContext {
  /** Bu görev için istek uçuşta mı? */
  readonly busy?: boolean;
  /** Sunucudan kalıcı hata alındı mı? (409/403/404) */
  readonly blocked?: boolean;
}

export function getTaskActionAvailability(
  task: OperationsTask,
  context: TaskActionContext = {}
): TaskActionAvailability {
  let retryReason: string | null = null;
  if (context.blocked) {
    retryReason = 'Sunucu bu görev için eylemi reddetti. Liste yenilendiğinde yeniden değerlendirilir.';
  } else if (context.busy) {
    retryReason = 'Bu görev için bir istek sürüyor.';
  } else if (task.status === 'processing') {
    retryReason = 'Görev şu anda çalışıyor; bitmeden yeniden başlatılamaz.';
  } else if (task.status === 'pending') {
    retryReason = 'Görev zaten kuyrukta bekliyor.';
  } else if (!RETRYABLE_STATUSES.has(task.status)) {
    retryReason = 'Bu durumdaki görev yeniden denenemez.';
  }

  let cancelReason: string | null = null;
  if (context.busy) {
    cancelReason = 'Bu görev için bir istek sürüyor.';
  } else if (!CANCELLABLE_STATUSES.has(task.status)) {
    cancelReason =
      task.status === 'completed'
        ? 'Tamamlanmış görev iptal edilemez.'
        : 'İptal edilmiş görev yeniden iptal edilemez.';
  }

  return {
    retry: retryReason === null,
    retryReason,
    cancel: cancelReason === null,
    cancelReason,
  };
}

/**
 * Sunucu hatasını kullanıcı diline çevirir. Teknik kod ve HTTP durumu
 * gizlenmez; "Teknik ayrıntı" bölümünde gösterilmek üzere ayrı döner.
 */
export interface TaskErrorExplanation {
  readonly message: string;
  readonly technical: string;
  readonly permanent: boolean;
}

const CODE_MESSAGES: Record<string, string> = {
  task_not_retryable: 'Görev artık yeniden denenebilir durumda değil. Liste yenilendi.',
  task_not_cancellable: 'Görev artık iptal edilebilir durumda değil. Liste yenilendi.',
  task_not_found: 'Görev bulunamadı; kuyruk yenilenmeli.',
  profile_mismatch: 'Görev aktif profile ait değil.',
  background_unavailable: 'Görev deposuna şu anda ulaşılamıyor.',
};

export function explainTaskActionError(error: unknown): TaskErrorExplanation {
  const err = (error ?? {}) as { message?: unknown; code?: unknown; status?: unknown };
  const rawMessage = typeof err.message === 'string' ? err.message : '';
  const code = typeof err.code === 'string' ? err.code : '';
  const status = typeof err.status === 'number' ? err.status : 0;

  const message =
    CODE_MESSAGES[code] ||
    (status === 409
      ? 'Görev bu eylemi kabul etmiyor. Liste yenilendi.'
      : status === 403
        ? 'Bu görev üzerinde işlem yapma yetkiniz yok.'
        : rawMessage || 'Görev işlemi tamamlanamadı.');

  const technicalParts = [
    status ? `HTTP ${status}` : '',
    code ? `kod: ${code}` : '',
    rawMessage ? rawMessage : '',
  ].filter(Boolean);

  return {
    message,
    technical: technicalParts.join(' · '),
    // 4xx hataları tekrar denemekle düzelmez; 5xx/ağ hataları geçici olabilir.
    permanent: status >= 400 && status < 500,
  };
}

/** Görevin son hata metnini kullanıcıya okunur hâle getirir. */
export function describeTaskFailure(lastError: string | null): {
  summary: string;
  technical: string | null;
} {
  if (!lastError) return { summary: '', technical: null };
  const firstLine = lastError.split('\n')[0].trim();
  const withoutPrefix = firstLine.replace(/^(error|typeerror|error:)\s*:?\s*/i, '');
  const summary =
    withoutPrefix.length > 140 ? `${withoutPrefix.slice(0, 137)}…` : withoutPrefix || 'Bilinmeyen hata';
  return { summary, technical: lastError };
}
