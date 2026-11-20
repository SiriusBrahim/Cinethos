import { useCallback, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { DataDocument } from '../core/cinetrack-core.ts';
import { areUserDataDocumentsSemanticallyEqual } from '../core/user-data-merge.ts';
import { DIRTY_KEY } from '../app/profile-storage.ts';
import type { ServerConflictDetail } from '../services/api.ts';
import { hasPendingOfflineSync } from '../services/offline-queue.ts';

type SyncResult = {
  ok: boolean;
  queued?: boolean;
  conflict?: boolean | ServerConflictDetail;
  document?: DataDocument;
};

type SyncOptions = {
  confirmBulkDelete?: boolean;
  foldUnhydratedDefaultProfile?: boolean;
  forceOverwrite?: boolean;
};

export interface UseServerSyncCoordinatorOptions {
  buildCurrentLivePayloadFromRefs: () => DataDocument;
  buildCurrentPayload: () => DataDocument;
  syncDocument: (payload: DataDocument, options?: SyncOptions) => Promise<SyncResult>;
  serverConflict: ServerConflictDetail | null;
  mergeRemoteDocumentIntoState: (
    document: DataDocument,
    options?: {
      preferActiveFrom?: 'local' | 'remote';
      foldUnhydrated?: boolean;
      keepDirtyIfLocalAhead?: boolean;
    }
  ) => DataDocument | null;
  applyDataDocumentToState: (document: DataDocument) => void;
  resolveQueuedConflict: () => void;
  setServerConflict: (conflict: ServerConflictDetail | null) => void;
  setSyncStatus: (status: string) => void;
  showToast: (message: string) => void;
  isDirtyRef: MutableRefObject<boolean | null>;
  isPushingRef: MutableRefObject<boolean | null>;
  inFlightPushRef: MutableRefObject<Promise<void> | null>;
  confirmNextBulkSyncRef: MutableRefObject<boolean | null>;
  hadStoredProfilesOnBootRef: MutableRefObject<boolean | null>;
  serverSyncReady: boolean;
  favoriteActors: unknown[];
  deletedKeys: Record<string, string>;
}

/**
 * Owns the user-facing push and conflict-resolution actions. The App shell
 * supplies state/ref adapters; this hook serializes pushes and centralizes the
 * conflict decisions without owning profile data itself.
 */
export function useServerSyncCoordinator(options: UseServerSyncCoordinatorOptions) {
  const {
    buildCurrentLivePayloadFromRefs,
    buildCurrentPayload,
    syncDocument,
    serverConflict,
    mergeRemoteDocumentIntoState,
    applyDataDocumentToState,
    resolveQueuedConflict,
    setServerConflict,
    setSyncStatus,
    showToast,
    isDirtyRef,
    isPushingRef,
    inFlightPushRef,
    confirmNextBulkSyncRef,
    hadStoredProfilesOnBootRef,
    serverSyncReady,
    favoriteActors,
    deletedKeys,
  } = options;

  const executePushToServer = useCallback(async () => {
    const payload = buildCurrentLivePayloadFromRefs();
    const confirmBulkDelete = confirmNextBulkSyncRef.current;
    const foldUnhydrated = !hadStoredProfilesOnBootRef.current;
    isPushingRef.current = true;
    try {
      const result = await syncDocument(
        payload,
        confirmBulkDelete
          ? { confirmBulkDelete: true }
          : { foldUnhydratedDefaultProfile: foldUnhydrated }
      );
      if (result.ok) {
        confirmNextBulkSyncRef.current = false;
        hadStoredProfilesOnBootRef.current = true;
        const authoritativeServerDoc = result.document || payload;
        const liveNow = buildCurrentLivePayloadFromRefs();
        if (areUserDataDocumentsSemanticallyEqual(liveNow, authoritativeServerDoc)) {
          isDirtyRef.current = false;
          try {
            localStorage.removeItem(DIRTY_KEY);
          } catch {}
        }
        setServerConflict(null);
        setSyncStatus('Kayıt yeri: data/cinetrack-data.json (bu bilgisayarda, tüm profiller).');
      } else if (result.queued) {
        setSyncStatus('Çevrimdışı kuyrukta: bağlantı sağlandığında yerel sunucuya aktarılacak.');
      } else if (!result.conflict) {
        setSyncStatus('Değişiklikler yerel veri dosyasına yazılamadı; şimdilik yalnızca bu tarayıcıda.');
      }
    } finally {
      isPushingRef.current = false;
    }
  }, [
    buildCurrentLivePayloadFromRefs,
    syncDocument,
    confirmNextBulkSyncRef,
    hadStoredProfilesOnBootRef,
    isPushingRef,
    isDirtyRef,
    setServerConflict,
    setSyncStatus,
  ]);

  const pushToServer = useCallback(async () => {
    if (inFlightPushRef.current) {
      await inFlightPushRef.current;
      if (!isDirtyRef.current && !confirmNextBulkSyncRef.current && !hasPendingOfflineSync()) {
        return;
      }
    }
    const promise = executePushToServer().finally(() => {
      if (inFlightPushRef.current === promise) inFlightPushRef.current = null;
    });
    inFlightPushRef.current = promise;
    await promise;
  }, [executePushToServer, inFlightPushRef, isDirtyRef, confirmNextBulkSyncRef]);

  const handleKeepLocalOnConflict = useCallback(async () => {
    const payload = serverConflict?.localPayload || buildCurrentLivePayloadFromRefs();
    const result = await syncDocument(payload, { forceOverwrite: true, confirmBulkDelete: true });
    if (result.ok) {
      isDirtyRef.current = false;
      try {
        localStorage.removeItem(DIRTY_KEY);
      } catch {}
      resolveQueuedConflict();
      setServerConflict(null);
      setSyncStatus('Yerel değişiklikler sunucuya kaydedildi.');
      showToast('Yerel verileriniz sunucuya kaydedildi.');
    }
  }, [
    serverConflict,
    buildCurrentLivePayloadFromRefs,
    syncDocument,
    isDirtyRef,
    resolveQueuedConflict,
    setServerConflict,
    setSyncStatus,
    showToast,
  ]);

  const handleMergeBothOnConflict = useCallback(async () => {
    if (serverConflict?.serverDocument) {
      mergeRemoteDocumentIntoState(serverConflict.serverDocument, {
        preferActiveFrom: 'local',
        keepDirtyIfLocalAhead: true,
      });
    }
    await pushToServer();
    resolveQueuedConflict();
    setServerConflict(null);
    setSyncStatus('Yerel ve sunucu verileri kayıpsız birleştirildi.');
    showToast('Yerel ve sunucu listeleriniz kayıpsız birleştirildi.');
  }, [
    serverConflict,
    mergeRemoteDocumentIntoState,
    pushToServer,
    resolveQueuedConflict,
    setServerConflict,
    setSyncStatus,
    showToast,
  ]);

  const handleUseServerOnConflict = useCallback(() => {
    if (serverConflict?.serverDocument) {
      applyDataDocumentToState(serverConflict.serverDocument);
      showToast('Sunucudaki güncel veri yüklendi.');
    }
  }, [serverConflict, applyDataDocumentToState, showToast]);

  // Debounced auto-push stays beside the action coordinator so all push paths
  // share the same in-flight guard.
  useEffect(() => {
    if (!serverSyncReady) return;
    let localStorageDirty = false;
    try {
      localStorageDirty = localStorage.getItem(DIRTY_KEY) === '1';
    } catch {}
    if (
      !isDirtyRef.current &&
      !localStorageDirty &&
      !confirmNextBulkSyncRef.current &&
      !hasPendingOfflineSync()
    ) return;
    const timer = setTimeout(() => { void pushToServer(); }, 500);
    return () => clearTimeout(timer);
  }, [
    buildCurrentPayload,
    pushToServer,
    serverSyncReady,
    favoriteActors,
    deletedKeys,
    isDirtyRef,
    confirmNextBulkSyncRef,
  ]);

  return {
    pushToServer,
    handleKeepLocalOnConflict,
    handleMergeBothOnConflict,
    handleUseServerOnConflict,
  };
}
