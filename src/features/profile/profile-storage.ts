import type {
  FavoriteActorInfo,
  Preferences,
  Profile,
  SavedItem,
} from '../../core/cinetrack-core.ts';
import {
  normalizeDeletedKeys,
  normalizeFavoriteActors,
  normalizePreferences,
  normalizeSavedItem,
} from '../../core/cinetrack-core.ts';
import { MOOD_GENRES } from '../../utils/helpers.ts';

export const PROFILES_STORAGE = 'cinetrack.profiles.v1';
export const ACTIVE_PROFILE_STORAGE = 'cinetrack.activeProfile.v1';
export const PROFILE_STORAGE = 'cinetrack.profile.v1';
export const DIRTY_KEY = 'cinetrack.dirty.v2';
export const HIDE_LISTED_STORAGE_KEY = 'cinetrack_hide_listed_items';

export function listStorageKey(profileId: string) {
  return `cinetrack.profile.${profileId}.watchlist.v1`;
}

export function preferencesStorageKey(profileId: string) {
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
    return { disliked: [], providers: [], mood: '', reminders: false, notified: [] };
  }
}

export function loadProfileItems(profileId: string): SavedItem[] {
  try {
    const stored = localStorage.getItem(listStorageKey(profileId)) || '[]';
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? (parsed
          .filter((item) => item && (item.media_type === 'movie' || item.media_type === 'tv') && item.id != null)
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

export function loadInitialProfiles(): Profile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(PROFILES_STORAGE) || 'null');
    const profiles = Array.isArray(stored)
      ? stored
          .filter((p) => p && /^profile-[A-Za-z0-9_-]{1,60}$/.test(p.id) && typeof p.name === 'string')
          .map((p) => {
            const delKeys = loadDeletedKeys(p.id);
            return {
              id: p.id,
              name: p.name.slice(0, 40),
              createdAt: p.createdAt || '',
              isDemo: Boolean(p.isDemo),
              preferences: loadProfilePreferences(p.id),
              items: loadProfileItems(p.id),
              favoriteActors: loadFavoriteActors(p.id),
              ...(Object.keys(delKeys).length > 0 ? { deleted_keys: delKeys } : {}),
            };
          })
      : [];
    if (profiles.length) return profiles;
    const legacyName = localStorage.getItem(PROFILE_STORAGE) || '';
    const defaultProfile: Profile = {
      id: 'profile-default',
      name: legacyName || 'Profilim',
      createdAt: new Date().toISOString(),
      preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
      items: [],
    };
    return [defaultProfile];
  } catch {
    return [
      {
        id: 'profile-default',
        name: 'Profilim',
        createdAt: '',
        preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
        items: [],
      },
    ];
  }
}

export function loadActiveProfileId(profiles: Profile[]): string {
  try {
    const active = localStorage.getItem(ACTIVE_PROFILE_STORAGE);
    return profiles.some((p) => p.id === active) ? active! : profiles[0].id;
  } catch {
    return profiles[0].id;
  }
}
