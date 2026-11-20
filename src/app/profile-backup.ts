/**
 * Faz 3 — Profil yedekleme/geri yükleme saf yardımcıları.
 *
 * App.tsx'teki dışa aktarma ve içe aktarma bloklarının hesaplama kısmı burada
 * toplanır. Dosya indirme (`Blob`, `URL.createObjectURL`), modal ve bildirim
 * yönetimi App'te kalır.
 */

import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  normalizeFavoriteActors,
  type FavoriteActorInfo,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import type { CinemaKunyeDocument } from '../core/cinema-kunye.ts';

export interface LocalBackupDocument {
  version: 3;
  schemaVersion: number;
  engineVersion: string;
  profileId: string;
  profileName: string;
  items: SavedItem[];
  cinemaKunye: CinemaKunyeDocument;
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  isDemo: boolean;
  exportedAt: string;
}

export interface BuildLocalBackupInput {
  readonly profileId: string;
  readonly profileName: string;
  readonly items: SavedItem[];
  readonly cinemaKunye: CinemaKunyeDocument;
  readonly preferences: Preferences;
  readonly favoriteActors: FavoriteActorInfo[];
  readonly isDemo: boolean;
  readonly nowIso?: string;
}

/** Yerel yedek belgesini üretir (tek kaynak; iki kopya payload yok). */
export function buildLocalBackupDocument(input: BuildLocalBackupInput): LocalBackupDocument {
  return {
    version: 3,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    engineVersion: ENGINE_VERSION,
    profileId: input.profileId,
    profileName: input.profileName,
    items: input.items,
    cinemaKunye: input.cinemaKunye,
    preferences: input.preferences,
    favoriteActors: input.favoriteActors,
    isDemo: input.isDemo,
    exportedAt: input.nowIso ?? new Date().toISOString(),
  };
}

export function buildBackupFileName(nowIso: string = new Date().toISOString()): string {
  return `cinethos-local-backup-${nowIso.slice(0, 10)}.json`;
}

export type BackupImportMode = 'overwrite' | 'merge';

function unionKeys(current: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] {
  return Array.from(new Set([...(current || []), ...(incoming || [])]));
}

/**
 * İçe aktarılan tercihleri geçerli tercihlerle birleştirir.
 * - `overwrite`: içe aktarılan değerler geçerlidir.
 * - `merge`: küme alanları birleşim, ölçek alanları içe aktarılandan.
 * `reminders`/`notified` içe aktarmada sıfırlanır (mevcut davranış korunur).
 */
export function resolveImportedPreferences(
  current: Preferences,
  incoming: Partial<Preferences> | null | undefined,
  mode: BackupImportMode
): Preferences | null {
  if (!incoming) return null;
  const pickKeys = (field: 'disliked' | 'hidden' | 'providers') => {
    const next = incoming[field];
    if (!Array.isArray(next)) return mode === 'merge' ? current[field] || [] : [];
    return mode === 'merge' ? unionKeys(current[field], next) : next.map(String);
  };
  return {
    ...current,
    ...incoming,
    disliked: pickKeys('disliked'),
    hidden: pickKeys('hidden'),
    providers: pickKeys('providers'),
    reminders: false,
    notified: [],
  };
}

/** İçe aktarılan favori oyuncuları geçerli listeyle birleştirir. */
export function resolveImportedFavoriteActors(
  current: readonly FavoriteActorInfo[],
  incoming: readonly FavoriteActorInfo[] | null | undefined,
  mode: BackupImportMode
): FavoriteActorInfo[] {
  return mode === 'merge'
    ? normalizeFavoriteActors([...(current || []), ...(incoming || [])])
    : normalizeFavoriteActors(incoming || []);
}
