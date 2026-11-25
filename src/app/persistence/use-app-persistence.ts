/**
 * F5.2-02 — App state ↔ yerel kalıcılık koordinasyonu.
 *
 * Autosave effect'i, kirli işaret kararı ve profil bazlı en-iyi-çaba yazımı
 * tek bir hook'ta toplanır. Plan saf `persistence-plan.ts` içinde üretilir;
 * bu hook yalnızca React yaşam döngüsüne bağlar.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import type { Profile } from '../../core/cinetrack-core.ts';
import { saveUserListsIdb } from '../../services/storage-idb.ts';
import { DIRTY_KEY, listStorageKey } from '../profile-storage.ts';
import {
  StorageWriteMemo,
  applyLocalStoragePlan,
  applyStorageWrites,
  buildLocalStoragePlan,
  buildProfileWritePlans,
  compactSavedItems,
  decideDirtyAfterSync,
  type ApplyStorageResult,
  type PersistenceSnapshot,
} from './persistence-plan.ts';

export interface AppPersistenceRefs {
  hydratedRef: MutableRefObject<boolean>;
  applyingRemoteSnapshotRef: MutableRefObject<boolean>;
  isDirtyRef: MutableRefObject<boolean>;
  localEditedDuringStartupRef: MutableRefObject<boolean>;
}

export interface UseAppPersistenceParams extends PersistenceSnapshot {
  serverSyncReady: boolean;
  refs: AppPersistenceRefs;
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
  /** Başarısız kalan yazımları son anlık görüntüyle yeniden dener. */
  flushPending: () => ApplyStorageResult | null;
}

export function useAppPersistence({
  serverSyncReady,
  refs,
  ...snapshot
}: UseAppPersistenceParams): AppPersistenceController {
  const { hydratedRef, applyingRemoteSnapshotRef, isDirtyRef, localEditedDuringStartupRef } = refs;
  const memoRef = useRef<StorageWriteMemo | null>(null);
  if (memoRef.current === null) memoRef.current = new StorageWriteMemo();
  const snapshotRef = useRef<PersistenceSnapshot>(snapshot);
  snapshotRef.current = snapshot;
  const pendingFlushRef = useRef(false);

  const flushPending = useCallback((): ApplyStorageResult | null => {
    const storage = browserStorage();
    if (!storage) return null;
    const result = applyLocalStoragePlan(
      storage,
      buildLocalStoragePlan(snapshotRef.current),
      memoRef.current ?? undefined
    );
    pendingFlushRef.current = result.failed.length > 0;
    return result;
  }, []);

  useEffect(() => {
    const storage = browserStorage();
    if (storage) {
      const result = applyLocalStoragePlan(
        storage,
        buildLocalStoragePlan({
          profiles: snapshot.profiles,
          activeProfileId: snapshot.activeProfileId,
          profileName: snapshot.profileName,
          preferences: snapshot.preferences,
          favoriteActors: snapshot.favoriteActors,
          deletedKeys: snapshot.deletedKeys,
          savedItems: snapshot.savedItems,
        }),
        memoRef.current ?? undefined
      );
      pendingFlushRef.current = result.failed.length > 0;
      for (const failure of result.failed) {
        console.warn('LocalStorage save warning:', failure.error);
      }
    }

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
      } else if (storage) {
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

  // Bileşen kalkarken yarım kalan (kota nedeniyle başarısız) yazım son
  // anlık görüntüyle bir kez daha denenir; başarılı yazımlar tekrarlanmaz.
  useEffect(
    () => () => {
      if (!pendingFlushRef.current) return;
      flushPending();
    },
    [flushPending]
  );

  const persistProfilesBestEffort = useCallback((profilesList: Profile[]) => {
    const storage = browserStorage();
    for (const plan of buildProfileWritePlans(profilesList)) {
      if (storage) {
        applyStorageWrites(storage, plan.writes);
        try {
          storage.setItem(listStorageKey(plan.profileId), JSON.stringify(plan.items));
        } catch {
          try {
            storage.setItem(
              listStorageKey(plan.profileId),
              JSON.stringify(compactSavedItems(plan.items))
            );
          } catch {
            // Tam veri React state'inde ve sunucu belgesinde korunur.
          }
        }
      }
      void saveUserListsIdb(plan.profileId, plan.items);
    }
  }, []);

  return { persistProfilesBestEffort, flushPending };
}

