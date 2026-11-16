import { type DataDocument } from '../core/cinetrack-core.ts';
import type {
  IProfileContext,
  PrimaryDataRepository,
  ProfileRef,
  WriteProfileRef,
} from '../contracts/index.ts';
import { get, set, del, createStore } from 'idb-keyval';

const OFFLINE_QUEUE_STORAGE_KEY = 'cinetrack_offline_sync_queue_v1';
const IDB_STORE_NAME = 'cinetrack_offline_queue_store';
let idbStoreRef: ReturnType<typeof createStore> | undefined;
let pendingIdbWrite: Promise<void> | null = null;

function getIdbStore() {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!idbStoreRef) {
    idbStoreRef = createStore('cinetrack-offline-queue-db', IDB_STORE_NAME);
  }
  return idbStoreRef;
}

export interface QueuedSyncSnapshot {
  queuedAt: string;
  baseRevision: number | null;
  payload: DataDocument;
  /** Profil izolasyonu referansı (MIA Faz 1B Adım 11). */
  profileRef?: ProfileRef;
  /** Kaç kez gönderilmeye çalışıldı (SEC-04: üstel geri çekilme için). */
  attempts?: number;
  lastAttemptAt?: string | null;
}

export type OfflineQueueStorage = 'indexeddb' | 'localstorage' | 'memory';

export interface EnqueueOfflineResult extends QueuedSyncSnapshot {
  persisted: boolean;
  storage: OfflineQueueStorage;
}

export const OFFLINE_QUEUE_MAX_ATTEMPTS = 5;
export const OFFLINE_QUEUE_FAILED_EVENT = 'cinetrack:queue-failed';
const OFFLINE_BACKOFF_BASE_MS = 2_000;
const OFFLINE_BACKOFF_MAX_MS = 5 * 60_000;

/** Deneme sayısına göre bekleme: 2 sn → 4 → 8 → 16 → 32 … en fazla 5 dk. */
export function offlineQueueBackoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(OFFLINE_BACKOFF_MAX_MS, OFFLINE_BACKOFF_BASE_MS * 2 ** (attempts - 1));
}

let memoryFallbackSnapshot: QueuedSyncSnapshot | null = null;
let lastPersistFailed = false;

/**
 * P0-03: Aynı anda gelen iki enqueue ve bir clear birbirinin üzerine yazmasın.
 * Tüm kuyruk yazmaları tek bir sıraya (serializer) bağlanır.
 */
let queueWriteChain: Promise<unknown> = Promise.resolve();

function serializeQueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = queueWriteChain.then(task, task);
  queueWriteChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function hasUnpersistedOfflineFallback(): boolean {
  return lastPersistFailed && memoryFallbackSnapshot !== null;
}

export async function flushOfflineQueuePersistence(): Promise<void> {
  if (pendingIdbWrite) {
    await pendingIdbWrite;
  }
}

export function loadOfflineSyncSnapshot(): QueuedSyncSnapshot | null {
  const store = getIdbStore();
  if (store && memoryFallbackSnapshot) {
    return memoryFallbackSnapshot;
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.payload) {
          const baseRev = typeof parsed.baseRevision === 'number' ? parsed.baseRevision : null;
          const rawRef =
            parsed.profileRef &&
            typeof parsed.profileRef === 'object' &&
            typeof parsed.profileRef.profileId === 'string' &&
            parsed.profileRef.profileId.trim()
              ? {
                  profileId: parsed.profileRef.profileId.trim(),
                  ...(typeof parsed.profileRef.revision === 'number'
                    ? { revision: parsed.profileRef.revision }
                    : {}),
                }
              : undefined;
          const resolvedRef = resolveSnapshotProfileRef(
            parsed.payload as DataDocument,
            baseRev,
            rawRef
          );
          const snapshot: QueuedSyncSnapshot = {
            queuedAt: String(parsed.queuedAt || new Date().toISOString()),
            baseRevision: baseRev,
            payload: parsed.payload as DataDocument,
            ...(resolvedRef ? { profileRef: resolvedRef } : {}),
            // SEC-04: deneme sayacı yeniden yüklemede kaybolmamalı.
            attempts: Number.isFinite(Number(parsed.attempts)) ? Number(parsed.attempts) : 0,
            lastAttemptAt:
              typeof parsed.lastAttemptAt === 'string' ? parsed.lastAttemptAt : null,
          };
          if (store) {
            memoryFallbackSnapshot = snapshot;
            void migrateSnapshotToIndexedDB(snapshot);
          }
          return snapshot;
        }
      }
    }
  } catch {
    // Fall back to in-memory snapshot if localStorage is inaccessible or corrupt
  }
  return memoryFallbackSnapshot;
}

export async function loadOfflineSyncSnapshotAsync(): Promise<QueuedSyncSnapshot | null> {
  const store = getIdbStore();
  if (store) {
    try {
      await flushOfflineQueuePersistence();
      const idbData = await get<QueuedSyncSnapshot>('latest_offline_snapshot', store);
      if (idbData && idbData.payload) {
        memoryFallbackSnapshot = idbData;
        lastPersistFailed = false;
        return idbData;
      }
    } catch (e) {
      console.warn('[OfflineQueue] IDB read failed:', e);
    }
  }

  const syncSnap = loadOfflineSyncSnapshot();
  if (syncSnap) return syncSnap;

  return memoryFallbackSnapshot;
}

async function migrateSnapshotToIndexedDB(snapshot: QueuedSyncSnapshot): Promise<void> {
  const store = getIdbStore();
  if (store) {
    try {
      await set('latest_offline_snapshot', snapshot, store);
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
      }
    } catch (e) {
      console.warn('[OfflineQueue] Taşıma başarısız, localStorage yedeği korunuyor:', e);
    }
  }
}

/**
 * DATA-01: kuyruk kaydını gerçekten kalıcı hâle getirir ve yazmayı doğrular.
 * Sıra: IndexedDB → localStorage (okuma ile doğrulanır) → bellek (persisted: false).
 */
async function persistSnapshotDurably(entry: QueuedSyncSnapshot): Promise<OfflineQueueStorage> {
  const store = getIdbStore();
  if (store) {
    try {
      await set('latest_offline_snapshot', entry, store);
      memoryFallbackSnapshot = entry;
      lastPersistFailed = false;
      try {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
        }
      } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
      return 'indexeddb';
    } catch (e) {
      console.warn('[OfflineQueue] IndexedDB yazımı başarısız, localStorage yedeğine geçiliyor:', e);
    }
  }

  try {
    if (typeof localStorage !== 'undefined') {
      const raw = JSON.stringify(entry);
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, raw);
      // Kota/yarıda kesilme sessizce yutulmasın: geri okuyup doğrula.
      if (localStorage.getItem(OFFLINE_QUEUE_STORAGE_KEY) === raw) {
        memoryFallbackSnapshot = null;
        lastPersistFailed = false;
        return 'localstorage';
      }
    }
  } catch (e) {
    console.warn('[OfflineQueue] localStorage yedeği de yazılamadı:', e);
  }

  memoryFallbackSnapshot = entry;
  lastPersistFailed = true;
  return 'memory';
}

function resolveSnapshotProfileRef(
  payload: DataDocument,
  baseRevision: number | null,
  explicitRef?: ProfileRef
): ProfileRef | undefined {
  if (explicitRef?.profileId) {
    return explicitRef.revision !== undefined
      ? { profileId: explicitRef.profileId, revision: explicitRef.revision }
      : {
          profileId: explicitRef.profileId,
          ...(typeof baseRevision === 'number' ? { revision: baseRevision } : {}),
        };
  }
  const activeId =
    typeof payload?.activeProfileId === 'string' ? payload.activeProfileId.trim() : '';
  if (!activeId) return undefined;
  return typeof baseRevision === 'number'
    ? { profileId: activeId, revision: baseRevision }
    : { profileId: activeId };
}

/**
 * DATA-01: kalıcılığı doğrulayan ve serileştirilmiş kuyruk yazımı. Kalıcılık
 * doğrulaması olmayan eski senkron sürüm P0-03 ile kaldırıldı.
 */
export async function enqueueOfflineSyncSnapshotDurable(
  payload: DataDocument,
  baseRevision: number | null,
  profileRef?: ProfileRef
): Promise<EnqueueOfflineResult> {
  return serializeQueueWrite(async () => {
    const existing = loadOfflineSyncSnapshot();
    const resolvedBase =
      baseRevision !== null ? baseRevision : existing ? existing.baseRevision : null;
    const resolvedRef = resolveSnapshotProfileRef(payload, resolvedBase, profileRef);
    const entry: QueuedSyncSnapshot = {
      queuedAt: new Date().toISOString(),
      baseRevision: resolvedBase,
      payload,
      ...(resolvedRef ? { profileRef: resolvedRef } : {}),
      attempts: existing?.attempts ?? 0,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
    };
    const storage = await persistSnapshotDurably(entry);
    return { ...entry, persisted: storage !== 'memory', storage };
  });
}

/**
 * MIA Faz 1B Adım 11: ZORUNLU `WriteProfileRef` damgalı kuyruğa alma yardımcısı.
 */
export async function enqueueOfflineSyncForProfile(
  payload: DataDocument,
  ref: WriteProfileRef
): Promise<EnqueueOfflineResult> {
  if (!ref?.profileId?.trim()) {
    throw new Error('Çevrimdışı kuyruğa almak için geçerli profileId zorunludur.');
  }
  if (!Number.isSafeInteger(ref.revision) || ref.revision < 0) {
    throw new Error('Çevrimdışı kuyruğa almak için geçerli kaynak revision zorunludur.');
  }
  return enqueueOfflineSyncSnapshotDurable(payload, ref.revision, {
    profileId: ref.profileId,
    revision: ref.revision,
  });
}

export interface FlushOfflineQueueResult {
  status: 'empty' | 'synced' | 'conflict' | 'profile-conflict' | 'retry';
  revision?: number;
  error?: string;
  nextDelayMs?: number;
  exhausted?: boolean;
}

/**
 * MIA Faz 1B Adım 11: Kuyruktaki anlık görüntüyü `PrimaryDataRepository` sözleşmesi
 * ve isteğe bağlı `IProfileContext` izolasyon denetimiyle boşaltır.
 */
export async function flushOfflineQueueWithRepository(
  repository: PrimaryDataRepository<DataDocument>,
  options: { profileContext?: IProfileContext } = {}
): Promise<FlushOfflineQueueResult> {
  const queued = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
  if (!queued) {
    return { status: 'empty' };
  }

  if (options.profileContext && queued.profileRef?.profileId) {
    try {
      options.profileContext.assertCurrent({ profileId: queued.profileRef.profileId });
    } catch (err) {
      return {
        status: 'profile-conflict',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const res = await repository.save(queued.payload, {
    expectedRevision: queued.baseRevision ?? undefined,
    requirePrecondition: queued.baseRevision !== null,
    reason: 'offline-queue-flush',
  });

  if (res.ok) {
    await clearOfflineSyncSnapshot();
    return { status: 'synced', revision: res.revision };
  }

  if (res.conflict) {
    return {
      status: 'conflict',
      revision: res.revision,
      error: res.error,
    };
  }

  const attemptInfo = await recordOfflineQueueAttempt();
  return {
    status: 'retry',
    error: res.error,
    nextDelayMs: attemptInfo.nextDelayMs,
    exhausted: attemptInfo.exhausted,
  };
}

/** Başarısız gönderimde deneme sayacını artırır ve bir sonraki bekleme süresini döner. */
export async function recordOfflineQueueAttempt(): Promise<{
  attempts: number;
  nextDelayMs: number;
  exhausted: boolean;
  persisted: boolean;
}> {
  return serializeQueueWrite(async () => {
    const existing = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
    if (!existing) {
      return { attempts: 0, nextDelayMs: 0, exhausted: false, persisted: false };
    }
    const attempts = (existing.attempts ?? 0) + 1;
    const entry: QueuedSyncSnapshot = {
      ...existing,
      attempts,
      lastAttemptAt: new Date().toISOString(),
    };
    const storage = await persistSnapshotDurably(entry);
    const exhausted = attempts >= OFFLINE_QUEUE_MAX_ATTEMPTS;
    const nextDelayMs = exhausted ? 0 : offlineQueueBackoffMs(attempts);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent(OFFLINE_QUEUE_FAILED_EVENT, {
          detail: { attempts, nextDelayMs, exhausted, persisted: storage !== 'memory' },
        })
      );
    }
    return { attempts, nextDelayMs, exhausted, persisted: storage !== 'memory' };
  });
}

export async function clearOfflineSyncSnapshot(): Promise<void> {
  // P0-03: silme de aynı yazma sırasına girer; eşzamanlı enqueue onu geçemez.
  return serializeQueueWrite(async () => {
    memoryFallbackSnapshot = null;
    lastPersistFailed = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
      }
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }

    const store = getIdbStore();
    if (store) {
      const task = del('latest_offline_snapshot', store).catch((e) => {
        console.warn('[OfflineQueue] Kuyruk silinemedi:', e);
      });
      pendingIdbWrite = task.finally(() => {
        pendingIdbWrite = null;
      });
      await pendingIdbWrite;
    }
  });
}

export function hasPendingOfflineSync(): boolean {
  return loadOfflineSyncSnapshot() !== null;
}

export function resetOfflineQueueForTests(): void {
  idbStoreRef = undefined;
  pendingIdbWrite = null;
  memoryFallbackSnapshot = null;
  lastPersistFailed = false;
}
