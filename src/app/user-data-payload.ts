/**
 * Sunucuya gönderilecek kullanıcı veri belgesini üretir.
 *
 * App.tsx'te iki neredeyse aynı fonksiyon vardı (ref tabanlı ve state tabanlı).
 * Tek üretici burada tutulur: aktif profil için canlı state, diğer profiller
 * için kalıcı depodaki izole veriler kullanılır. Profil kimlikleri ve p2-hex
 * yerleşimi değiştirilmez; yalnızca belge birleştirilir.
 */

import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  normalizeDeletedKeys,
  normalizePreferences,
  type DataDocument,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import {
  loadDeletedKeys,
  loadFavoriteActors,
  loadProfileItems,
  loadProfilePreferences,
} from './profile-storage.ts';
import { MOOD_GENRES } from '../utils/helpers.ts';

export interface UserDataSnapshot {
  readonly profiles: readonly Profile[];
  readonly activeProfileId: string;
  readonly profileName: string;
  readonly preferences: Preferences;
  readonly savedItems: readonly SavedItem[];
  readonly favoriteActors: readonly FavoriteActorInfo[];
  readonly deletedKeys: Record<string, string>;
  /** Aktif profilin demo olup olmadığı; verilmezse profil kaydı kullanılır. */
  readonly isDemo?: boolean;
}

function hasStoredPreferences(preferences: Preferences | undefined): boolean {
  return Boolean(
    preferences &&
      ((preferences.disliked?.length || 0) > 0 ||
        (preferences.hidden?.length || 0) > 0 ||
        (preferences.providers?.length || 0) > 0 ||
        Boolean(preferences.mood) ||
        Boolean(preferences.reminders))
  );
}

/** Aktif profili canlı state'ten, diğer profilleri izole kalıcı depodan birleştirir. */
export function buildUserDataDocument(snapshot: UserDataSnapshot): DataDocument {
  const {
    profiles,
    activeProfileId,
    profileName,
    preferences,
    savedItems,
    favoriteActors,
    deletedKeys,
  } = snapshot;
  const activeProfile = profiles.find((p) => p.id === activeProfileId) || profiles[0];

  return {
    version: 3,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    activeProfileId,
    profiles: profiles.map((p) => {
      const isCurrent = p.id === activeProfileId;
      const profileDeletedKeys = normalizeDeletedKeys(
        isCurrent
          ? deletedKeys
          : p.deleted_keys && Object.keys(p.deleted_keys).length > 0
            ? p.deleted_keys
            : loadDeletedKeys(p.id)
      );
      const profileItems = isCurrent
        ? [...savedItems]
        : Array.isArray(p.items) && p.items.length > 0
          ? p.items
          : loadProfileItems(p.id);
      const profilePreferences = isCurrent
        ? preferences
        : hasStoredPreferences(p.preferences)
          ? normalizePreferences(p.preferences, { knownMoods: Object.keys(MOOD_GENRES) })
          : loadProfilePreferences(p.id);
      const profileFavoriteActors = isCurrent
        ? [...favoriteActors]
        : Array.isArray(p.favoriteActors) && p.favoriteActors.length > 0
          ? p.favoriteActors
          : loadFavoriteActors(p.id);

      return {
        id: p.id,
        name: isCurrent ? profileName : p.name,
        createdAt: p.createdAt || '',
        preferences: profilePreferences,
        items: profileItems,
        favoriteActors: profileFavoriteActors,
        isDemo: isCurrent
          ? Boolean(snapshot.isDemo ?? activeProfile?.isDemo)
          : Boolean(p.isDemo),
        ...(Object.keys(profileDeletedKeys).length > 0
          ? { deleted_keys: profileDeletedKeys }
          : {}),
      };
    }),
  };
}
