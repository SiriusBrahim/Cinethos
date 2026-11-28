/**
 * F5.2-02 — Profil yaşam döngüsü koordinasyonu (React'ten bağımsız).
 *
 * Profil oluşturma ve profil değiştirme akışlarının veri hazırlığı burada
 * toplanır: giden profilin anlık görüntüsü, yeni profil kaydı ve hedef profilin
 * çözümlenmesi. `App` yalnızca bu sonuçları React state'ine uygular; böylece
 * aynı mantık iki yerde kopyalanmaz ve doğrudan test edilebilir.
 */

import {
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
  normalizeDeletedKeys,
} from '../../core/cinetrack-core.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';

export interface OutgoingProfileSnapshotInput {
  activeProfileId: string;
  profileName: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  deletedKeys: Record<string, string>;
}

/** Giden profilin güncel liste/tercih/silme durumunu profil kaydına işler. */
export function snapshotOutgoingProfile(
  profiles: Profile[],
  input: OutgoingProfileSnapshotInput
): Profile[] {
  const outgoingDeleted = normalizeDeletedKeys(input.deletedKeys);
  const hasDeletedKeys = Object.keys(outgoingDeleted).length > 0;

  return profiles.map((profile) =>
    profile.id === input.activeProfileId
      ? {
          ...profile,
          name: input.profileName,
          items: input.savedItems,
          preferences: input.preferences,
          favoriteActors: input.favoriteActors || [],
          ...(hasDeletedKeys ? { deleted_keys: outgoingDeleted } : {}),
        }
      : profile
  );
}

export interface CreateProfileRecordInput {
  name: string;
  id?: string;
  createdAt?: string;
  isDemo?: boolean;
}

/** Yeni profil kimliği: mevcut `profile-<zaman>-<rastgele>` biçimi korunur. */
export function createProfileId(now: number = Date.now(), random: number = Math.random()): string {
  const normalized = normalizeProfileId(
    `profile-${now}-${random.toString(36).slice(2, 8)}`
  );
  if (!normalized) {
    throw new Error('Profil kimliği üretilemedi.');
  }
  return normalized;
}

export function createProfileRecord(input: CreateProfileRecordInput): Profile {
  return {
    id: input.id ?? createProfileId(),
    name: input.name,
    createdAt: input.createdAt ?? new Date().toISOString(),
    preferences: { disliked: [], providers: [], mood: '', reminders: false, notified: [] },
    items: [],
    favoriteActors: [],
    isDemo: input.isDemo ?? false,
  };
}

export interface ProfileSwitchResolvers {
  loadItems: (profileId: string) => SavedItem[];
  loadPreferences: (profileId: string) => Preferences;
  loadFavoriteActors: (profileId: string) => FavoriteActorInfo[];
  loadDeletedKeys: (profileId: string) => Record<string, string>;
}

export interface ProfileSwitchState {
  name: string;
  items: SavedItem[];
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  deletedKeys: Record<string, string>;
}

function hasMeaningfulPreferences(preferences: Preferences | undefined): boolean {
  if (!preferences) return false;
  return (
    (preferences.disliked?.length || 0) > 0 ||
    (preferences.hidden?.length || 0) > 0 ||
    (preferences.providers?.length || 0) > 0 ||
    Boolean(preferences.mood) ||
    Boolean(preferences.reminders)
  );
}

/**
 * Hedef profilin görünüm durumunu çözer. Profilde kayıtlı veri yoksa
 * profil kapsamlı localStorage anahtarlarına düşer; çıktı her zaman yeni
 * profilin kendi verisidir (giden profilden sızma olmaz).
 */
export function resolveProfileSwitchState(
  target: Profile | undefined,
  profileId: string,
  resolvers: ProfileSwitchResolvers
): ProfileSwitchState {
  return {
    name: target?.name || 'Profilim',
    items: target?.items?.length ? target.items : resolvers.loadItems(profileId),
    preferences: hasMeaningfulPreferences(target?.preferences)
      ? (target?.preferences as Preferences)
      : resolvers.loadPreferences(profileId),
    favoriteActors: target?.favoriteActors?.length
      ? target.favoriteActors
      : resolvers.loadFavoriteActors(profileId),
    deletedKeys: normalizeDeletedKeys(target?.deleted_keys || resolvers.loadDeletedKeys(profileId)),
  };
}
