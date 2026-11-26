/**
 * F5.2-02 / B-21 — App state ↔ yerel kalıcılık koordinasyonu.
 *
 * Autosave effect'i, kirli işaret kararı ve profil bazlı en-iyi-çaba yazımı
 * tek bir hook'ta toplanır. Plan saf `persistence-plan.ts` içinde üretilir;
 * B-21 ile yazımlar `local-write-scheduler.ts` üzerinden birleştirilir ve
 * sekme gizlenirken/kapanırken bekleyen yazım flush edilir.
 *
 * Veri güvenliği: kota dolduğunda hiçbir alan kırpılmaz, eski değer korunur
 * ve başarısız yazım kullanıcıya bildirilir (`onWriteFailure`).
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Profile } from '../../core/cinetrack-core.ts';
import { saveUserListsIdb } from '../../services/storage-idb.ts';
import { DIRTY_KEY, listStorageKey } from '../profile-storage.ts';
import {
  applyStorageWrites,
  buildProfileWritePlans,
  decideDirtyAfterSync,
  type ApplyStorageResult,
  type PersistenceSnapshot,
} from './persistence-plan.ts';
import { StorageWriteScheduler } from './local-write-scheduler.ts';

export interface AppPersistenceRefs {
  hydratedRef: MutableRefObject<boolean>;
  applyingRemoteSnapshotRef: MutableRefObject<boolean>;
  isDirtyRef: MutableRefObject<boolean>;
  localEditedDuringStartupRef: MutableRefObject<boolean>;
}

export interface UseAppPersistenceParams extends PersistenceSnapshot {
  serverSyncReady: boolean;
  refs: AppPersistenceRefs;
  /** Kota/yazma hatası olduğunda çağrılır; kullanıcıya bildirim için. */
  onWriteFailure?: (failedKeys: string[]) => void;
  /** Yeniden başarılı yazımda çağrılır (uyarıyı temizlemek için). */
  onWriteSuccess?: () => void;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export interface AppPersistenceController {
  persistProfilesBestEffort: (profilesList: Profile[]) => void;
  /** Bekleyen yazımı hemen uygular. */
  flushPending: () => ApplyStorageResult | null;
}

export function useAppPersistence({
  serverSyncReady,
  refs,
  onWriteFailure,
  onWriteSuccess,
  ...snapshot
}: UseAppPersistenceParams): AppPersistenceController {
  const { hydratedRef, applyingRemoteSnapshotRef, isDirtyRef, localEditedDuringStartupRef } = refs;
  const onWriteFailureRef = useRef(onWriteFailure);
  onWriteFailureRef.current = onWriteFailure;
  const onWriteSuccessRef = useRef(onWriteSuccess);
  onWriteSuccessRef.current = onWriteSuccess;

  const schedulerRef = useRef<StorageWriteScheduler | null>(null);
  if (schedulerRef.current === null && browserStorage()) {
    schedulerRef.current = new StorageWriteScheduler({
      storage: browserStorage() as Storage,
      delayMs: 250,
      onResult: (result) => {
        if (result.failed.length > 0) {
          onWriteFailureRef.current?.(result.failed.map((failure) => failure.key));
        } else {
          onWriteSuccessRef.current?.();
        }
      },
    });
  }
  const snapshotRef = useRef<PersistenceSnapshot>(snapshot);
  snapshotRef.current = snapshot;

  const flushPending = useCallback((): ApplyStorageResult | null => {
    return schedulerRef.current?.flush() ?? null;
  }, []);

  useEffect(() => {
    const storage = browserStorage();
    const scheduler = schedulerRef.current;
    if (!storage || !scheduler) return;

    scheduler.request({
      profiles: snapshot.profiles,
      activeProfileId: snapshot.activeProfileId,
      profileName: snapshot.profileName,
      preferences: snapshot.preferences,
      favoriteActors: snapshot.favoriteActors,
      deletedKeys: snapshot.deletedKeys,
      savedItems: snapshot.savedItems,
    });

    const decision = decideDirtyAfterSync({
      hydrated: hydratedRef.current,
      applyingRemoteSnapshot: applyingRemoteSnapshotRef.current,
      serverSyncReady,
    });

    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    if (applyingRemoteSnapshotRef.current) {
      applyingRemoteSnapshotRef.current = false;
      return;
    }
    if (decision.markDirty) {
      isDirtyRef.current = true;
      if (decision.editedDuringStartup) {
        localEditedDuringStartupRef.current = true;
      } else {
        try {
          storage.setItem(DIRTY_KEY, '1');
        } catch {
          // Kota doluysa kirli işareti bellekte tutulur.
        }
      }
    }
  }, [
    snapshot.profiles,
    snapshot.activeProfileId,
    snapshot.profileName,
    snapshot.savedItems,
    snapshot.preferences,
    snapshot.favoriteActors,
    snapshot.deletedKeys,
    serverSyncReady,
    hydratedRef,
    applyingRemoteSnapshotRef,
    isDirtyRef,
    localEditedDuringStartupRef,
  ]);

  // B-21: sekme gizlenirken veya kapanırken bekleyen yazım kaybolmaz.
  useEffect(() => {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    const flush = () => {
      flushPending();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flushPending]);

  const persistProfilesBestEffort = useCallback((profilesList: Profile[]) => {
    const storage = browserStorage();
    const failures: string[] = [];
    for (const plan of buildProfileWritePlans(profilesList)) {
      if (storage) {
        const result = applyStorageWrites(storage, plan.writes);
        failures.push(...result.failed.map((failure) => failure.key));
        // B-21: kota hatasında liste kırpılarak yazılmaz; hata raporlanır ve
        // tam veri React state'inde + IndexedDB'de korunur.
        try {
          storage.setItem(listStorageKey(plan.profileId), JSON.stringify(plan.items));
        } catch (error) {
          failures.push(listStorageKey(plan.profileId));
          console.warn('LocalStorage save warning:', error);
        }
      }
      void saveUserListsIdb(plan.profileId, plan.items);
    }
    if (failures.length > 0) onWriteFailureRef.current?.(failures);
  }, []);

  return { persistProfilesBestEffort, flushPending };
}
