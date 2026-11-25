/**
 * F5.2-02 — Yerel kalıcılık planı (React'ten bağımsız).
 *
 * Hangi anahtarların hangi değerle yazılacağını saf olarak üretir; yazma
 * sırası, kota düşüşü (özet kırpma) ve hata toleransı burada tanımlıdır.
 * Testler planı sahte bir depoya uygulayarak gerçek davranışı doğrular.
 */

import type {
  FavoriteActorInfo,
  Preferences,
  Profile,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import { normalizeDeletedKeys } from '../../core/cinetrack-core.ts';
import {
  ACTIVE_PROFILE_STORAGE,
  DIRTY_KEY,
  PROFILES_STORAGE,
  PROFILE_STORAGE,
  deletedKeysStorageKey,
  favActorsStorageKey,
  listStorageKey,
  preferencesStorageKey,
} from '../profile-storage.ts';

export interface PersistenceSnapshot {
  profiles: Profile[];
  activeProfileId: string;
  profileName: string;
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  deletedKeys: Record<string, string>;
  savedItems: SavedItem[];
}

export interface StorageWrite {
  key: string;
  value: string;
}

export interface LocalStoragePlan {
  metadata: StorageWrite[];
  list: { key: string; primary: string; compactFallback: string };
}

export function compactSavedItems(items: SavedItem[]): SavedItem[] {
  return items.map((item) => ({
    ...item,
    overview: typeof item.overview === 'string' ? item.overview.slice(0, 120) : '',
  }));
}

export function buildLocalStoragePlan(snapshot: PersistenceSnapshot): LocalStoragePlan {
  // >2 MB kütüphanelerde PROFILES_STORAGE yalnızca üst veriyi taşır; tam liste
  // profil kapsamlı anahtarda tutulur (mevcut kota güvenliği davranışı).
  const lightweightProfiles = snapshot.profiles.map((profile) => ({
    id: profile.id,
    name: profile.id === snapshot.activeProfileId ? snapshot.profileName : profile.name,
    createdAt: profile.createdAt || '',
    isDemo: Boolean(profile.isDemo),
    favoriteActors:
      profile.id === snapshot.activeProfileId
        ? snapshot.favoriteActors
        : profile.favoriteActors || [],
    items: [],
  }));

  return {
    metadata: [
      { key: PROFILES_STORAGE, value: JSON.stringify(lightweightProfiles) },
      { key: ACTIVE_PROFILE_STORAGE, value: snapshot.activeProfileId },
      { key: PROFILE_STORAGE, value: snapshot.profileName },
      {
        key: preferencesStorageKey(snapshot.activeProfileId),
        value: JSON.stringify(snapshot.preferences),
      },
      {
        key: favActorsStorageKey(snapshot.activeProfileId),
        value: JSON.stringify(snapshot.favoriteActors),
      },
      {
        key: deletedKeysStorageKey(snapshot.activeProfileId),
        value: JSON.stringify(snapshot.deletedKeys),
      },
    ],
    list: {
      key: listStorageKey(snapshot.activeProfileId),
      primary: JSON.stringify(snapshot.savedItems),
      compactFallback: JSON.stringify(compactSavedItems(snapshot.savedItems)),
    },
  };
}

export interface ProfileWritePlan {
  profileId: string;
  items: SavedItem[];
  writes: StorageWrite[];
}

export function buildProfileWritePlans(profiles: Profile[]): ProfileWritePlan[] {
  const plans: ProfileWritePlan[] = [];
  for (const profile of profiles) {
    if (!profile || !profile.id) continue;
    const items = profile.items || [];
    plans.push({
      profileId: profile.id,
      items,
      writes: [
        { key: preferencesStorageKey(profile.id), value: JSON.stringify(profile.preferences || {}) },
        { key: favActorsStorageKey(profile.id), value: JSON.stringify(profile.favoriteActors || []) },
        {
          key: deletedKeysStorageKey(profile.id),
          value: JSON.stringify(normalizeDeletedKeys(profile.deleted_keys)),
        },
      ],
      // Liste yazımı kota nedeniyle ayrı ele alınır.
    });
  }
  return plans;
}

export interface StorageLike {
  setItem: (key: string, value: string) => void;
}

export interface ApplyStorageResult {
  written: string[];
  skipped: string[];
  failed: Array<{ key: string; error: unknown }>;
  compacted: string[];
}

/** Aynı içeriğin tekrar yazılmasını engeller (autosave gürültüsü). */
export class StorageWriteMemo {
  private readonly last = new Map<string, string>();

  shouldWrite(key: string, value: string): boolean {
    return this.last.get(key) !== value;
  }

  record(key: string, value: string): void {
    this.last.set(key, value);
  }

  forget(key: string): void {
    this.last.delete(key);
  }
}

function tryWrite(
  storage: StorageLike,
  write: StorageWrite,
  memo: StorageWriteMemo | undefined,
  result: ApplyStorageResult
): boolean {
  if (memo && !memo.shouldWrite(write.key, write.value)) {
    result.skipped.push(write.key);
    return true;
  }
  try {
    storage.setItem(write.key, write.value);
    memo?.record(write.key, write.value);
    result.written.push(write.key);
    return true;
  } catch (error) {
    // Yazma başarısızsa önceki değer korunur (setItem atomik değildir ama
    // hata sonrası eski içerik silinmez).
    memo?.forget(write.key);
    result.failed.push({ key: write.key, error });
    return false;
  }
}

export function applyStorageWrites(
  storage: StorageLike,
  writes: StorageWrite[],
  memo?: StorageWriteMemo
): ApplyStorageResult {
  const result: ApplyStorageResult = { written: [], skipped: [], failed: [], compacted: [] };
  for (const write of writes) tryWrite(storage, write, memo, result);
  return result;
}

export function applyLocalStoragePlan(
  storage: StorageLike,
  plan: LocalStoragePlan,
  memo?: StorageWriteMemo
): ApplyStorageResult {
  const result = applyStorageWrites(storage, plan.metadata, memo);

  const primary: StorageWrite = { key: plan.list.key, value: plan.list.primary };
  const written = tryWrite(storage, primary, memo, result);
  if (!written) {
    const fallback: StorageWrite = { key: plan.list.key, value: plan.list.compactFallback };
    if (tryWrite(storage, fallback, memo, result)) {
      result.compacted.push(plan.list.key);
      // Birincil deneme başarısızdı ama kırpılmış yedek yazıldı; hata sayılmaz.
      result.failed = result.failed.filter((entry) => entry.key !== plan.list.key);
    }
  }

  return result;
}

export interface DirtyDecision {
  markDirty: boolean;
  editedDuringStartup: boolean;
}

/**
 * Autosave sonrası kirli işaret kararı. İlk hidrasyon ve uzak anlık görüntü
 * uygulaması yazma sayılmaz; sunucu hazır değilken düzenleme başlangıç
 * çakışması için işaretlenir.
 */
export function decideDirtyAfterSync(input: {
  hydrated: boolean;
  applyingRemoteSnapshot: boolean;
  serverSyncReady: boolean;
}): DirtyDecision {
  if (!input.hydrated) return { markDirty: false, editedDuringStartup: false };
  if (input.applyingRemoteSnapshot) return { markDirty: false, editedDuringStartup: false };
  return { markDirty: true, editedDuringStartup: !input.serverSyncReady };
}

export { DIRTY_KEY };
