import { useCallback, useEffect, useRef, useState } from 'react';
import type { IProfileContext, WriteProfileRef } from '../contracts/index.ts';
import { type DataDocument } from '../core/cinetrack-core.ts';
import {
  getLastKnownServerRevision,
  type ServerConflictDetail,
} from '../services/api.ts';
import { createHttpPrimaryDataRepository } from '../services/client-primary-repository.ts';
import {
  OFFLINE_QUEUE_MAX_ATTEMPTS,
  clearOfflineSyncSnapshot,
  enqueueOfflineSyncForProfile,
  flushOfflineQueueWithRepository,
  hasPendingOfflineSync,
  hasUnpersistedOfflineFallback,
  loadOfflineSyncSnapshot,
  loadOfflineSyncSnapshotAsync,
  offlineQueueBackoffMs,
} from '../services/offline-queue.ts';
import {
  hasUnpersistedIdbFallback,
  subscribeIdbQuotaWarning,
} from '../services/storage-idb.ts';
import { useOnlineStatus } from './useOnlineStatus.ts';

export interface OfflineQueueFailure {
  attempts: number;
  exhausted: boolean;
}

export function useOfflineSync(
  onConflict?: (conflict: ServerConflictDetail, localDoc: DataDocument) => void,
  onMergedServerDocument?: (serverDoc: DataDocument, sentPayload: DataDocument) => void,
  profileContext?: IProfileContext
) {
  const isOnline = useOnlineStatus();
  const [pendingSync, setPendingSync] = useState<boolean>(() => hasPendingOfflineSync());
  const [unpersistedWarning, setUnpersistedWarning] = useState<boolean>(
    () => hasUnpersistedOfflineFallback() || hasUnpersistedIdbFallback()
  );
  const [queueFailure, setQueueFailure] = useState<OfflineQueueFailure | null>(null);
  const conflictPausedRef = useRef<boolean>(false);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repositoryRef = useRef<ReturnType<typeof createHttpPrimaryDataRepository> | null>(null);
  if (repositoryRef.current === null) {
    repositoryRef.current = createHttpPrimaryDataRepository();
  }

  const resolveWriteProfileRef = useCallback(
    (payload: DataDocument, explicitRevision?: number | null): WriteProfileRef => {
      const ctxRef = profileContext?.getCurrent();
      const profileId =
        ctxRef?.profileId ||
        (typeof payload?.activeProfileId === 'string' && payload.activeProfileId.trim()
          ? payload.activeProfileId.trim()
          : 'default');
      const revCandidate =
        explicitRevision !== undefined && explicitRevision !== null
          ? explicitRevision
          : ctxRef?.revision ??
            getLastKnownServerRevision() ??
            (typeof payload?.revision === 'number' ? payload.revision : 0);
      const revision =
        typeof revCandidate === 'number' && Number.isSafeInteger(revCandidate) && revCandidate >= 0
          ? revCandidate
          : 0;
      return Object.freeze({ profileId, revision });
    },
    [profileContext]
  );

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearRetryTimer, [clearRetryTimer]);

  useEffect(() => {
    return subscribeIdbQuotaWarning(() => {
      if (hasUnpersistedIdbFallback()) {
        setUnpersistedWarning(true);
      }
    });
  }, []);

  useEffect(() => {
    let active = true;
    void loadOfflineSyncSnapshotAsync().then((snap) => {
      if (active && snap) {
        setPendingSync(true);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  const resolveQueuedConflict = useCallback(() => {
    conflictPausedRef.current = false;
    clearRetryTimer();
    setQueueFailure(null);
    void clearOfflineSyncSnapshot();
    setPendingSync(false);
    setUnpersistedWarning(hasUnpersistedIdbFallback());
  }, [clearRetryTimer]);

  const flushQueue = useCallback(async () => {
    if (conflictPausedRef.current) {
      return;
    }
    clearRetryTimer();
    const queued = (await loadOfflineSyncSnapshotAsync()) || loadOfflineSyncSnapshot();
    if (!queued) {
      setPendingSync(false);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      return;
    }

    const result = await flushOfflineQueueWithRepository(repositoryRef.current!, {
      profileContext,
    });

    if (result.status === 'empty') {
      setPendingSync(false);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      return;
    }

    if (result.status === 'synced') {
      conflictPausedRef.current = false;
      setPendingSync(false);
      setQueueFailure(null);
      setUnpersistedWarning(hasUnpersistedIdbFallback());
      if (result.document && result.merged) {
        onMergedServerDocument?.(result.document, queued.payload);
      }
      return;
    }

    if (result.status === 'profile-conflict') {
      // Başka bir profile geçildiyse eski profilin bekleyen değişikliği yeni profili ezemez;
      // kuyruk korunur ve otomatik deneme duraklatılır.
      setPendingSync(true);
      return;
    }

    if (result.status === 'conflict' && result.conflict) {
      // BUG-07: Çakışma çözülene kadar çevrimdışı kuyruk kaydını silme!
      conflictPausedRef.current = true;
      setPendingSync(true);
      onConflict?.({ ...result.conflict, localPayload: queued.payload }, queued.payload);
      return;
    }

    // SEC-04: ağ/5xx hatasında üstel geri çekilmeyle yeniden dene; sayaç kalıcıdır.
    setPendingSync(true);
    const snapAfter = loadOfflineSyncSnapshot();
    const attempts = snapAfter?.attempts ?? 1;
    const nextDelayMs = result.nextDelayMs ?? offlineQueueBackoffMs(attempts);
    const exhausted = result.exhausted ?? attempts >= OFFLINE_QUEUE_MAX_ATTEMPTS;
    setQueueFailure({ attempts, exhausted });
    if (!exhausted && nextDelayMs > 0) {
      clearRetryTimer();
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        void flushQueue();
      }, nextDelayMs);
    }
  }, [clearRetryTimer, onConflict, onMergedServerDocument, profileContext]);

  useEffect(() => {
    if (!profileContext) return;
    const sub = profileContext.onProfileChange(() => {
      if (!conflictPausedRef.current && navigator.onLine) {
        void flushQueue();
      }
    });
    return () => {
      sub.unsubscribe();
    };
  }, [profileContext, flushQueue]);

  useEffect(() => {
    if (isOnline && pendingSync && !conflictPausedRef.current) {
      void flushQueue();
    }
  }, [isOnline, pendingSync, flushQueue]);

  const syncDocument = useCallback(
    async (
      payload: DataDocument,
      options: {
        confirmBulkDelete?: boolean;
        forceOverwrite?: boolean;
        foldUnhydratedDefaultProfile?: boolean;
      } = {}
    ) => {
      if (options.forceOverwrite) {
        conflictPausedRef.current = false;
        clearRetryTimer();
        setQueueFailure(null);
      }

      if (profileContext && !options.forceOverwrite) {
        try {
          profileContext.assertCurrent({ profileId: payload.activeProfileId });
        } catch (err) {
          return {
            ok: false,
            queued: false,
            conflict: {
              code: 'profile_conflict',
              message: err instanceof Error ? err.message : String(err),
              currentRevision: getLastKnownServerRevision() ?? undefined,
              localPayload: payload,
            } satisfies ServerConflictDetail,
          };
        }
      }

      if (!navigator.onLine) {
        // DATA-01 & Adım 11: yazma tamamlanmadan "kaydedildi" denmez; WriteProfileRef zorunludur.
        const writeRef = resolveWriteProfileRef(payload, getLastKnownServerRevision());
        const enq = await enqueueOfflineSyncForProfile(payload, writeRef);
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted, storage: enq.storage };
      }

      const useLossless = !options.forceOverwrite && !options.confirmBulkDelete;
      const baseRevision = options.forceOverwrite
        ? null
        : profileContext?.getCurrent().revision ?? getLastKnownServerRevision();
      const res = await repositoryRef.current!.saveDetailed(payload, {
        expectedRevision: baseRevision ?? undefined,
        expectedProfileId: options.forceOverwrite
          ? undefined
          : profileContext?.getCurrent().profileId ?? payload.activeProfileId,
        confirmBulkDelete: options.confirmBulkDelete,
        forceOverwrite: options.forceOverwrite,
        mergeStrategy: useLossless ? 'lossless' : undefined,
        foldUnhydratedDefaultProfile: options.foldUnhydratedDefaultProfile,
      });

      if (res.ok) {
        conflictPausedRef.current = false;
        await clearOfflineSyncSnapshot();
        setPendingSync(false);
        setQueueFailure(null);
        setUnpersistedWarning(hasUnpersistedIdbFallback());
        if (res.document && res.merged) {
          onMergedServerDocument?.(res.document, payload);
        }
        return { ok: true, queued: false, merged: res.merged, document: res.document };
      }

      if (res.status === 0) {
        const writeRef = resolveWriteProfileRef(payload, getLastKnownServerRevision());
        const enq = await enqueueOfflineSyncForProfile(payload, writeRef);
        setPendingSync(true);
        setUnpersistedWarning(!enq.persisted || hasUnpersistedIdbFallback());
        return { ok: false, queued: true, persisted: enq.persisted, storage: enq.storage };
      }

      if ((res.status === 409 || res.status === 412 || res.status === 428) && res.conflict) {
        onConflict?.({ ...res.conflict, localPayload: payload }, payload);
      }

      return { ok: false, queued: false, conflict: res.conflict };
    },
    [
      clearRetryTimer,
      onConflict,
      onMergedServerDocument,
      profileContext,
      resolveWriteProfileRef,
    ]
  );

  return {
    isOnline,
    pendingSync,
    unpersistedWarning,
    queueFailure,
    maxQueueAttempts: OFFLINE_QUEUE_MAX_ATTEMPTS,
    syncDocument,
    flushQueue,
    resolveQueuedConflict,
  };
}
