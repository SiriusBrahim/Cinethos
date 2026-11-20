/**
 * Profil kalıcılığı — localStorage okuma/yazma anahtarları ve başlangıç yüklemesi.
 *
 * React'ten bağımsızdır; `App` yalnızca bu modülün ürettiği normalize edilmiş
 * profil anlık görüntüsünü başlangıç durumu olarak kullanır. Eski ham profil
 * kimlikleriyle yazılmış anahtarlar okunmaya devam eder (`normalizeProfileId`),
 * böylece geçiş sırasında kullanıcı listeleri kaybolmaz.
 */

import {
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
  dedupeItems,
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizePreferences,
  normalizeSavedItem,
} from '../core/cinetrack-core.ts';
import { normalizeProfileId } from '../core/profile-id.ts';
import { MOOD_GENRES } from '../utils/helpers.ts';

export const PROFILES_STORAGE = 'cinetrack.profiles.v1';
export const ACTIVE_PROFILE_STORAGE = 'cinetrack.activeProfile.v1';
export const PROFILE_STORAGE = 'cinetrack.profile.v1';
export const DIRTY_KEY = 'cinetrack.dirty.v2';
export const HIDE_LISTED_STORAGE_KEY = 'cinetrack_hide_listed_items';
export const DISLIKED_CACHE_STORAGE = 'cinetrack_disliked_cache';

export const EMPTY_PREFERENCES: Preferences = {
  disliked: [],
  providers: [],
  mood: '',
  reminders: false,
  notified: [],
};

export function listStorageKey(profileId: string): string {
  return `cinetrack.profile.${profileId}.watchlist.v1`;
}

export function preferencesStorageKey(profileId: string): string {
  return `cinetrack.profile.${profileId}.preferences.v1`;
}

export function favActorsStorageKey(profileId: string): string {
  return `cinetrack_fav_actors_${profileId}`;
}

export function deletedKeysStorageKey(profileId: string): string {
  return `cinetrack_deleted_keys_${profileId}`;
}

export function hasPersistedProfilesInStorage(): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    return Array.isArray(stored) && stored.length > 0;
  } catch {
    return false;
  }
}

export function loadProfilePreferences(profileId: string): Preferences {
  try {
    return normalizePreferences(
      JSON.parse(localStorage.getItem(preferencesStorageKey(profileId)) || '{}'),
      { knownMoods: Object.keys(MOOD_GENRES) }
    );
  } catch {
    return { ...EMPTY_PREFERENCES };
  }
}

export function loadProfileItems(profileId: string): SavedItem[] {
  try {
    const stored = localStorage.getItem(listStorageKey(profileId)) || '[]';
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? (parsed
          .filter(
            (item) =>
              item && (item.media_type === 'movie' || item.media_type === 'tv') && item.id != null
          )
          .map(normalizeSavedItem)
          .filter(Boolean) as SavedItem[])
      : [];
  } catch {
    return [];
  }
}

export function loadFavoriteActors(profileId: string): FavoriteActorInfo[] {
  try {
    const stored = localStorage.getItem(favActorsStorageKey(profileId));
    return stored ? normalizeFavoriteActors(JSON.parse(stored)) : [];
  } catch {
    return [];
  }
}

export function loadDeletedKeys(profileId: string): Record<string, string> {
  try {
    const stored = localStorage.getItem(deletedKeysStorageKey(profileId));
    return stored ? normalizeDeletedKeys(JSON.parse(stored)) : {};
  } catch {
    return {};
  }
}

function createDefaultProfile(name: string): Profile {
  return {
    id: 'PROFILE-DEFAULT',
    name,
    createdAt: new Date().toISOString(),
    preferences: { ...EMPTY_PREFERENCES },
    items: [],
  };
}

/**
 * localStorage'daki profil tanımlarını, izole liste/tercih anahtarlarıyla
 * birleştirerek yükler. Aynı kanonik kimliğe düşen kayıtlar kayıpsız birleştirilir.
 */
export function loadInitialProfiles(): Profile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    const profiles: Profile[] = [];
    if (Array.isArray(stored)) {
      for (const p of stored) {
        const canonicalId = normalizeProfileId(p?.id);
        if (!p || !canonicalId || typeof p.name !== 'string') continue;
        // Eski localStorage anahtarları ham profileId ile yazılmış olabilir;
        // ilk açılışta veriyi eski anahtardan oku, sonraki kayıt kanonik anahtarı yazar.
        const storageId = p.id as string;
        const delKeys = loadDeletedKeys(storageId);
        const loaded: Profile = {
          id: canonicalId,
          name: p.name.slice(0, 40),
          createdAt: p.createdAt || '',
          isDemo: Boolean(p.isDemo),
          preferences: loadProfilePreferences(storageId),
          items: loadProfileItems(storageId),
          favoriteActors: loadFavoriteActors(storageId),
          ...(Object.keys(delKeys).length > 0 ? { deleted_keys: delKeys } : {}),
        };
        const existing = profiles.find((profile) => profile.id === canonicalId);
        if (existing) {
          existing.items = dedupeItems([...existing.items, ...loaded.items]);
          existing.favoriteActors = normalizeFavoriteActors([
            ...(existing.favoriteActors || []),
            ...(loaded.favoriteActors || []),
          ]);
          existing.preferences = normalizePreferences({
            ...existing.preferences,
            disliked: [...(existing.preferences.disliked || []), ...(loaded.preferences.disliked || [])],
            hidden: [...(existing.preferences.hidden || []), ...(loaded.preferences.hidden || [])],
            providers: [...(existing.preferences.providers || []), ...(loaded.preferences.providers || [])],
            mood: existing.preferences.mood || loaded.preferences.mood,
            reminders: existing.preferences.reminders || loaded.preferences.reminders,
            notified: [...(existing.preferences.notified || []), ...(loaded.preferences.notified || [])],
          });
          const mergedDeleted = normalizeDeletedKeys({
            ...(existing.deleted_keys || {}),
            ...(loaded.deleted_keys || {}),
          });
          if (Object.keys(mergedDeleted).length) existing.deleted_keys = mergedDeleted;
          existing.isDemo = Boolean(existing.isDemo && loaded.isDemo);
        } else {
          profiles.push(loaded);
        }
      }
    }
    if (profiles.length) return profiles;
    const legacyName = localStorage.getItem(PROFILE_STORAGE) || '';
    return [createDefaultProfile(legacyName || 'Profilim')];
  } catch {
    return [createDefaultProfile('Profilim')];
  }
}

export function loadActiveProfileId(profiles: Profile[]): string {
  try {
    const active = normalizeProfileId(localStorage.getItem(ACTIVE_PROFILE_STORAGE));
    return active && profiles.some((p) => p.id === active) ? active : profiles[0].id;
  } catch {
    return profiles[0].id;
  }
}

export function loadDislikedCache(): unknown[] {
  try {
    const cache = JSON.parse(localStorage.getItem(DISLIKED_CACHE_STORAGE) || '{}');
    return Object.values(cache);
  } catch {
    return [];
  }
}
