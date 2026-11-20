import { apiFetch, readApiErrorMessage } from './api-client.ts';

/**
 * İşlem Merkezi istemcisi.
 *
 * Sunucunun görev uçları yalnızca aktif profile ait, sırlardan arındırılmış
 * görev özetlerini döner. Bu modül yanıtı doğrular, tanınmayan alanları atar
 * ve eşzamanlı aynı istekleri tekilleştirir (uçuş hâlinde tekilleştirme).
 */

export type OperationsTaskStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'retry_wait'
  | 'failed'
  | 'cancelled';

export const OPERATIONS_STATUSES: readonly OperationsTaskStatus[] = [
  'pending',
  'processing',
  'retry_wait',
  'failed',
  'completed',
  'cancelled',
];

export interface OperationsTask {
  readonly taskId: string;
  readonly eventId: string;
  readonly handlerId: string;
  readonly profileId: string;
  readonly status: OperationsTaskStatus;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly nextRetryAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly lastError: string | null;
}

export type OperationsTaskCounts = Readonly<Record<OperationsTaskStatus, number>>;

export interface OperationsSnapshot {
  readonly checkedAt: string;
  readonly activeProfileId: string;
  readonly storeAvailable: boolean;
  readonly totalEvents: number;
  readonly totalTasks: number;
  readonly dueRetries: number;
  readonly counts: OperationsTaskCounts;
  readonly tasks: readonly OperationsTask[];
}

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface PipelineHealth {
  readonly modules: ReadonlyArray<{ id: string; status: HealthStatus }>;
  readonly queue: { pending: number; processing: number; completed: number; failed: number } | null;
}

function emptyCounts(): OperationsTaskCounts {
  return {
    pending: 0,
    processing: 0,
    completed: 0,
    retry_wait: 0,
    failed: 0,
    cancelled: 0,
  };
}

function asStatus(value: unknown): OperationsTaskStatus | null {
  return typeof value === 'string' && (OPERATIONS_STATUSES as readonly string[]).includes(value)
    ? (value as OperationsTaskStatus)
    : null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asCount(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.floor(num) : 0;
}

export function normalizeOperationsTask(raw: unknown): OperationsTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const status = asStatus(record.status);
  const taskId = asString(record.taskId);
  if (!status || !taskId) return null;
  return {
    taskId,
    eventId: asString(record.eventId),
    handlerId: asString(record.handlerId),
    profileId: asString(record.profileId),
    status,
    attempts: asCount(record.attempts),
    maxAttempts: Math.max(1, asCount(record.maxAttempts) || 1),
    nextRetryAt: asNullableString(record.nextRetryAt),
    createdAt: asString(record.createdAt),
    updatedAt: asString(record.updatedAt),
    completedAt: asNullableString(record.completedAt),
    lastError: asNullableString(record.lastError),
  };
}

/** Sunucu yanıtını doğrular; eksik sayaçlar görev listesinden türetilir. */
export function normalizeOperationsSnapshot(raw: unknown): OperationsSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.ok !== true) return null;
  const stats =
    record.stats && typeof record.stats === 'object'
      ? (record.stats as Record<string, unknown>)
      : {};
  const rawByStatus =
    stats.byStatus && typeof stats.byStatus === 'object'
      ? (stats.byStatus as Record<string, unknown>)
      : {};

  const tasks = Array.isArray(record.tasks)
    ? record.tasks.map(normalizeOperationsTask).filter((task): task is OperationsTask => Boolean(task))
    : [];

  const counts = { ...emptyCounts() };
  for (const status of OPERATIONS_STATUSES) {
    counts[status] = asCount(rawByStatus[status]);
  }
  // Sayaçlar eksikse (ör. farklı sunucu sürümü) görev listesinden türet.
  if (OPERATIONS_STATUSES.every((status) => counts[status] === 0) && tasks.length > 0) {
    for (const task of tasks) counts[task.status] += 1;
  }

  const store = record.store && typeof record.store === 'object' ? (record.store as Record<string, unknown>) : {};

  return {
    checkedAt: asString(record.checkedAt) || new Date().toISOString(),
    activeProfileId: asString(record.activeProfileId),
    storeAvailable: store.available !== false,
    totalEvents: asCount(stats.events),
    totalTasks: asCount(stats.tasks),
    dueRetries: asCount(stats.dueRetries),
    counts,
    tasks,
  };
}

/** Pipeline sağlığı — yalnızca kimlik ve durum; iç yollar/sırlar taşınmaz. */
export function normalizePipelineHealth(raw: unknown): PipelineHealth | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const modules = Array.isArray(record.modules)
    ? record.modules
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const mod = entry as Record<string, unknown>;
          const id = asString(mod.moduleId);
          if (!id) return null;
          const status =
            mod.status === 'healthy' || mod.status === 'degraded' || mod.status === 'unhealthy'
              ? (mod.status as HealthStatus)
              : 'unknown';
          return { id, status };
        })
        .filter((entry): entry is { id: string; status: HealthStatus } => Boolean(entry))
    : [];

  const ci =
    record.contentIntelligence && typeof record.contentIntelligence === 'object'
      ? (record.contentIntelligence as Record<string, unknown>)
      : null;
  const queue =
    ci?.queue && typeof ci.queue === 'object' ? (ci.queue as Record<string, unknown>) : null;

  return {
    modules,
    queue: queue
      ? {
          pending: asCount(queue.pending),
          processing: asCount(queue.processing),
          completed: asCount(queue.completed),
          failed: asCount(queue.failed),
        }
      : null,
  };
}

const inFlight = new Map<string, Promise<Response>>();

async function requestDeduped(url: string, init: RequestInit): Promise<Response> {
  // Abort sinyali paylaşılırsa bir çağıranın iptali diğerini de durdurur;
  // sinyalli istekler tekilleştirmeye katılmaz.
  if (init.signal) return apiFetch(url, init);
  const key = `${init.method || 'GET'} ${url}`;
  const existing = inFlight.get(key);
  if (existing) return (await existing).clone();
  const promise = apiFetch(url, init);
  inFlight.set(key, promise);
  try {
    return (await promise).clone();
  } finally {
    inFlight.delete(key);
  }
}

export async function fetchOperationsSnapshot(options: {
  status?: OperationsTaskStatus | 'all';
  limit?: number;
  signal?: AbortSignal;
} = {}): Promise<OperationsSnapshot> {
  const params = new URLSearchParams();
  if (options.status && options.status !== 'all') params.set('status', options.status);
  params.set('limit', String(Math.max(1, Math.min(200, options.limit ?? 100))));
  const response = await requestDeduped(`/api/background/tasks?${params.toString()}`, {
    method: 'GET',
    signal: options.signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const { message, code } = await readApiErrorMessage(response, 'Görev kuyruğu okunamadı.');
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  const snapshot = normalizeOperationsSnapshot(await response.json());
  if (!snapshot) throw new Error('Görev kuyruğu yanıtı doğrulanamadı.');
  return snapshot;
}

export async function fetchPipelineHealth(signal?: AbortSignal): Promise<PipelineHealth | null> {
  const response = await requestDeduped('/api/health', {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) return null;
  return normalizePipelineHealth(await response.json());
}

async function mutateTask(taskId: string, action: 'retry' | 'cancel'): Promise<OperationsTask> {
  const response = await apiFetch(
    `/api/background/tasks/${encodeURIComponent(taskId)}/${action}`,
    { method: 'POST', headers: { Accept: 'application/json' } }
  );
  if (!response.ok) {
    const { message, code } = await readApiErrorMessage(
      response,
      action === 'retry' ? 'Görev yeniden denenemedi.' : 'Görev iptal edilemedi.'
    );
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  const body = await response.json();
  const task = normalizeOperationsTask(body?.task);
  if (!task) throw new Error('Güncellenen görev yanıtı doğrulanamadı.');
  return task;
}

export function retryOperationsTask(taskId: string): Promise<OperationsTask> {
  return mutateTask(taskId, 'retry');
}

export function cancelOperationsTask(taskId: string): Promise<OperationsTask> {
  return mutateTask(taskId, 'cancel');
}

/** İçerik zekâsı katalog durumu — İşlem Merkezi bu özeti gösterir. */
export interface ContentIntelligenceSummary {
  readonly started: boolean;
  readonly stale: number;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly pending: number;
  readonly processing: number;
  readonly skipped: number;
  readonly queue: {
    readonly pending: number;
    readonly processing: number;
    readonly completed: number;
    readonly failed: number;
  };
}

export function normalizeContentIntelligenceSummary(
  raw: unknown
): ContentIntelligenceSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (record.ok !== true) return null;
  const counts =
    record.counts && typeof record.counts === 'object'
      ? (record.counts as Record<string, unknown>)
      : {};
  const queue =
    record.queue && typeof record.queue === 'object'
      ? (record.queue as Record<string, unknown>)
      : {};
  return {
    started: record.started === true,
    stale: asCount(record.stale),
    total: asCount(counts.total),
    completed: asCount(counts.completed),
    failed: asCount(counts.failed),
    pending: asCount(counts.pending),
    processing: asCount(counts.processing),
    skipped: asCount(counts.skipped),
    queue: {
      pending: asCount(queue.pending),
      processing: asCount(queue.processing),
      completed: asCount(queue.completed),
      failed: asCount(queue.failed),
    },
  };
}

export async function fetchContentIntelligenceSummary(
  signal?: AbortSignal
): Promise<ContentIntelligenceSummary> {
  const response = await requestDeduped('/api/content-intelligence/status', {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    const { message, code } = await readApiErrorMessage(response, 'İçerik zekâsı durumu okunamadı.');
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  const summary = normalizeContentIntelligenceSummary(await response.json());
  if (!summary) throw new Error('İçerik zekâsı durum yanıtı doğrulanamadı.');
  return summary;
}

export interface ReprocessResult {
  readonly total: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly stale: number;
}

/** Eski/başarısız analizleri kuyruğa verir; aynı içerik için kopya iş üretilmez. */
export async function reprocessStaleContent(limit = 100): Promise<ReprocessResult> {
  const response = await apiFetch('/api/content-intelligence/reprocess', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ limit }),
  });
  if (!response.ok) {
    const { message, code } = await readApiErrorMessage(
      response,
      'Yeniden işleme başlatılamadı.'
    );
    throw Object.assign(new Error(message), { code, status: response.status });
  }
  const body = (await response.json()) as Record<string, unknown>;
  return {
    total: asCount(body.total),
    accepted: asCount(body.accepted),
    rejected: asCount(body.rejected),
    stale: asCount(body.stale),
  };
}
