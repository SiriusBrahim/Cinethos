import { type DataDocument } from '../core/cinetrack-core.ts';
import {
  ProfileConflictError,
  type IProfileContext,
  type PrimaryDataRepository,
  type ProfileRef,
  type WriteProfileRef,
} from '../contracts/index.ts';
import { get, set, del, createStore } from 'idb-keyval';
import type { PushServerDataResult, ServerConflictDetail } from './api.ts';
import type { HttpSaveDataOptions } from './client-primary-repository.ts';

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

function normalizeQueuedSnapshot(raw: any): QueuedSyncSnapshot | null {
  if (!raw || typeof raw !== 'object' || !raw.payload) return null;
  const baseRev =
    typeof raw.baseRevision === 'number' && Number.isSafeInteger(raw.baseRevision) && raw.baseRevision >= 0
      ? raw.baseRevision
      : null;
  const rawRef =
    raw.profileRef &&
    typeof raw.profileRef === 'object' &&
    typeof raw.profileRef.profileId === 'string' &&
    raw.profileRef.profileId.trim()
      ? {
          profileId: raw.profileRef.profileId.trim(),
          ...(typeof raw.profileRef.revision === 'number' &&
          Number.isSafeInteger(raw.profileRef.revision) &&
          raw.profileRef.revision >= 0
            ? { revision: raw.profileRef.revision }
            : {}),
        }
      : undefined;
  const resolvedRef = tryDeriveSnapshotProfileRef(
    raw.payload as DataDocument,
    baseRev,
    rawRef
  );
  return {
    queuedAt: String(raw.queuedAt || new Date().toISOString()),
    baseRevision: baseRev,
    payload: raw.payload as DataDocument,
    ...(resolvedRef ? { profileRef: resolvedRef } : {}),
    // SEC-04: deneme sayacı yeniden yüklemede kaybolmamalı.
    attempts: Number.isFinite(Number(raw.attempts)) ? Number(raw.attempts) : 0,
    lastAttemptAt: typeof raw.lastAttemptAt === 'string' ? raw.lastAttemptAt : null,
  };
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
        const snapshot = normalizeQueuedSnapshot(JSON.parse(raw));
        if (snapshot) {
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
      const normalized = normalizeQueuedSnapshot(idbData);
      if (normalized) {
        memoryFallbackSnapshot = normalized;
        lastPersistFailed = false;
        return normalized;
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

function tryDeriveSnapshotProfileRef(
  payload: DataDocument,
  baseRevision: number | null,
  explicitRef?: ProfileRef
): ProfileRef | undefined {
  if (explicitRef?.profileId) {
    const pid = explicitRef.profileId.trim();
    if (!pid) return undefined;
    return explicitRef.revision !== undefined
      ? { profileId: pid, revision: explicitRef.revision }
      : {
          profileId: pid,
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

function assertValidWriteProfileRefForPayload(
  payload: DataDocument,
  baseRevision: number | null,
  explicitRef?: ProfileRef
): WriteProfileRef {
  const derived = tryDeriveSnapshotProfileRef(payload, baseRevision, explicitRef);
  const profileId = typeof derived?.profileId === 'string' ? derived.profileId.trim() : '';
  if (!profileId) {
    throw new Error('Çevrimdışı kuyruğa almak için geçerli WriteProfileRef (profileId) zorunludur.');
  }
  const rev = derived?.revision;
  if (typeof rev !== 'number' || !Number.isSafeInteger(rev) || rev < 0) {
    throw new Error('Çevrimdışı kuyruğa almak için geçerli WriteProfileRef (revision) zorunludur.');
  }
  const docProfileId =
    typeof payload?.activeProfileId === 'string' ? payload.activeProfileId.trim() : '';
  if (docProfileId && docProfileId !== profileId) {
    throw new ProfileConflictError('profile-switched', {
      expectedRevision: rev,
      message: `Çevrimdışı kuyruk profil uyuşmazlığı: beklenen '${profileId}', yük '${docProfileId}'.`,
    });
  }
  return Object.freeze({ profileId, revision: rev });
}

/**
 * MIA Faz 1B Adım 11: ZORUNLU `WriteProfileRef` damgalı ana kuyruk yazma giriş noktası.
 */
export async function enqueueOfflineSyncForProfile(
  payload: DataDocument,
  ref: WriteProfileRef
): Promise<EnqueueOfflineResult> {
  const validatedRef = assertValidWriteProfileRefForPayload(payload, ref?.revision ?? null, ref);
  return serializeQueueWrite(async () => {
    const existing = loadOfflineSyncSnapshot();
    const entry: QueuedSyncSnapshot = {
      queuedAt: new Date().toISOString(),
      baseRevision: validatedRef.revision,
      payload,
      profileRef: validatedRef,
      attempts: existing?.attempts ?? 0,
      lastAttemptAt: existing?.lastAttemptAt ?? null,
    };
    const storage = await persistSnapshotDurably(entry);
    return { ...entry, persisted: storage !== 'memory', storage };
  });
}

/**
 * DATA-01: Kalıcılığı doğrulayan ve serileştirilmiş kuyruk yazımı.
 * Güvenlik sınırı: geçerli bir `WriteProfileRef` (profileId + >=0 revision)
 * doğrulanmadan kuyruğa yazılamaz.
 * @deprecated Yeni çağrılar doğrudan `enqueueOfflineSyncForProfile` kullanmalıdır.
 */
export async function enqueueOfflineSyncSnapshotDurable(
  payload: DataDocument,
  baseRevision: number | null,
  profileRef?: ProfileRef
): Promise<EnqueueOfflineResult> {
  const existing = loadOfflineSyncSnapshot();
  const resolvedBase =
    baseRevision !== null ? baseRevision : existing ? existing.baseRevision : null;
  const validatedRef = assertValidWriteProfileRefForPayload(
    payload,
    resolvedBase,
    profileRef
  );
  return enqueueOfflineSyncForProfile(payload, validatedRef);
}

/**
 * GERİYE DÖNÜK UYUMLULUK: 17a12e8 öncesi senkron enqueue imzası.
 * Eski çağıranlar (phases-all, phases-1-to-4-architecture, audit-spec-fixes) ve
 * harici entegrasyonlar bu imzayı kullanmaya devam edebilir. Yeni çağrılar
 * `enqueueOfflineSyncForProfile` kullanmalıdır.
 */
export function enqueueOfflineSyncSnapshot(
  payload: DataDocument,
  baseRevision: number | null
): EnqueueOfflineResult {
  const existing = loadOfflineSyncSnapshot();
  const effectiveBaseRevision =
    baseRevision !== null ? baseRevision : existing ? existing.baseRevision : null;
  const profileRef = tryDeriveSnapshotProfileRef(payload, effectiveBaseRevision);
  const entry: QueuedSyncSnapshot = {
    queuedAt: new Date().toISOString(),
    baseRevision: effectiveBaseRevision,
    payload,
    ...(profileRef ? { profileRef } : {}),
    attempts: existing?.attempts ?? 0,
    lastAttemptAt: existing?.lastAttemptAt ?? null,
  };

  // Birincil kalıcı depo: IndexedDB (BUG-02 — localStorage şişmesi yaşanmaz).
  const store = getIdbStore();
  if (store) {
    memoryFallbackSnapshot = entry;
    lastPersistFailed = false;
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
      }
    } catch { /* opsiyonel adım */ }
    pendingIdbWrite = set('latest_offline_snapshot', entry, store)
      .catch((e) => {
        console.warn('[OfflineQueue] IndexedDB persist failed:', e);
        lastPersistFailed = true;
      })
      .finally(() => {
        pendingIdbWrite = null;
      });
    return { ...entry, persisted: true, storage: 'indexeddb' };
  }

  // Node.js test ortamları için localStorage yedeği.
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(OFFLINE_QUEUE_STORAGE_KEY, JSON.stringify(entry));
      memoryFallbackSnapshot = null;
      lastPersistFailed = false;
      return { ...entry, persisted: true, storage: 'localstorage' };
    }
  } catch (err) {
    console.warn('Cinethos: çevrimdışı kuyruk localStorage kotasına takıldı; bellek yedeği kullanılıyor.', err);
  }

  memoryFallbackSnapshot = entry;
  lastPersistFailed = true;
  return { ...entry, persisted: false, storage: 'memory' };
}

export interface FlushOfflineQueueResult {
  status: 'empty' | 'synced' | 'conflict' | 'profile-conflict' | 'retry';
  revision?: number;
  error?: string;
  nextDelayMs?: number;
  exhausted?: boolean;
  merged?: boolean;
  document?: DataDocument;
  conflict?: ServerConflictDetail;
}

interface DetailedSaveCapableRepository extends PrimaryDataRepository<DataDocument> {
  saveDetailed: (
    document: DataDocument,
    options?: HttpSaveDataOptions
  ) => Promise<PushServerDataResult>;
}

function hasDetailedSave(
  repo: PrimaryDataRepository<DataDocument>
): repo is DetailedSaveCapableRepository {
  return typeof (repo as Partial<DetailedSaveCapableRepository>).saveDetailed === 'function';
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

  const targetProfileId =
    queued.profileRef?.profileId ||
    (typeof queued.payload?.activeProfileId === 'string'
      ? queued.payload.activeProfileId.trim()
      : '');

  if (options.profileContext && targetProfileId) {
    try {
      options.profileContext.assertCurrent({ profileId: targetProfileId });
    } catch (err) {
      return {
        status: 'profile-conflict',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  if (hasDetailedSave(repository)) {
    const detailed = await repository.saveDetailed(queued.payload, {
      expectedRevision: queued.baseRevision ?? undefined,
      expectedProfileId: targetProfileId || undefined,
      requirePrecondition: queued.baseRevision !== null,
      mergeStrategy: 'lossless',
      reason: 'offline-queue-flush',
    });

    if (detailed.ok) {
      await clearOfflineSyncSnapshot();
      const nextRev = detailed.revision ?? detailed.document?.revision;
      if (
        options.profileContext &&
        typeof nextRev === 'number' &&
        nextRev >= 0 &&
        'commitRevision' in options.profileContext &&
        typeof (options.profileContext as { commitRevision?: unknown }).commitRevision === 'function'
      ) {
        try {
          (
            options.profileContext as {
              commitRevision: (rev: number, expectedProfileId?: string) => unknown;
            }
          ).commitRevision(nextRev, targetProfileId || undefined);
        } catch {
          // Profil uçuş sırasında değişmişse commitRevision sessizce yeni profili ezmez
        }
      }
      return {
        status: 'synced',
        revision: nextRev,
        merged: Boolean(detailed.merged),
        document: detailed.document,
      };
    }

    if (
      (detailed.status === 409 || detailed.status === 412 || detailed.status === 428) &&
      detailed.conflict
    ) {
      return {
        status: detailed.conflict.code === 'profile_conflict' ? 'profile-conflict' : 'conflict',
        revision: detailed.conflict.currentRevision,
        error: detailed.conflict.message,
        conflict: { ...detailed.conflict, localPayload: queued.payload },
      };
    }

    const attemptInfo = await recordOfflineQueueAttempt();
    return {
      status: 'retry',
      error: detailed.errorMessage,
      nextDelayMs: attemptInfo.nextDelayMs,
      exhausted: attemptInfo.exhausted,
    };
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

export function clearOfflineSyncSnapshot(): Promise<void> {
  // Senkron yüzey: bellek ve localStorage anında temizlenir (17a12e8 öncesi davranış;
  // çağıranlar await etmese bile kuyruk boş görünür).
  memoryFallbackSnapshot = null;
  lastPersistFailed = false;
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(OFFLINE_QUEUE_STORAGE_KEY);
    }
  } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }

  // P0-03: IDB silme işlemi yazma sırasına girer; eşzamanlı enqueue onu geçemez.
  const store = getIdbStore();
  if (!store) return Promise.resolve();
  const task = serializeQueueWrite(async () => {
    await del('latest_offline_snapshot', store).catch((e) => {
      console.warn('[OfflineQueue] Kuyruk silinemedi:', e);
    });
  });
  pendingIdbWrite = task.finally(() => {
    pendingIdbWrite = null;
  });
  return task;
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
