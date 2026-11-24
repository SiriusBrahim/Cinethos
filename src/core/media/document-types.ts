/**
 * Ortak medya/veri belgesi tipleri ve sabitleri (F5-05).
 *
 * Aşama 5.1 (F5.1-05) — Bu dosya artık KANONİK tanımları içermez.
 * SavedItem/NextEpisode/FavoriteActorInfo/Preferences/Profile/DataDocument
 * tanımları ve belge sabitleri tek kaynağa (`./types.ts`, yaprak dosya)
 * taşındı; bu dosya onları birebir yeniden dışa aktarır. Böylece eski
 * import yolları ve public API korunur, kopya tip modeli ortadan kalkar.
 * `cinetrack-core` her iki dosyayı da yeniden dışa aktarmaya devam eder.
 */

export {
  REMINDER_WINDOW_DAYS,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  TOMBSTONE_RETENTION_DAYS,
  TARGET_RECOMMENDATION_COUNT,
  SERVER_TASTE_WEIGHT,
  SERVER_TASTE_EXPLANATION_PART_THRESHOLD,
  LATEST_BACKUP_VERSION,
  SUPPORTED_BACKUP_VERSIONS,
} from './types.ts';

export type {
  NextEpisode,
  SavedItem,
  FavoriteActorInfo,
  Preferences,
  Profile,
  DataDocument,
} from './types.ts';

import type { CinemaKunyeDocument } from '../cinema-kunye.ts';

export interface ParsedBackupProfile {
  id: string;
  name: string;
  createdAt?: string;
  preferences: unknown;
  items: SavedItem[];
  favoriteActors: FavoriteActorInfo[];
  deleted_keys?: Record<string, string>;
  isDemo: boolean;
}

export interface ParsedBackupDocument {
  version: number;
  schemaVersion: number;
  /** Yedek `profiles[]` taşıyor mu (tam belge) yoksa tek profil mi? */
  containsFullDocument: boolean;
  activeProfileId: string;
  profiles: ParsedBackupProfile[];
  /** Aktif profilin (zenginleştirilmiş) kayıtları — geriye dönük alan. */
  items: SavedItem[];
  profileName: string;
  preferences: unknown;
  favoriteActors: FavoriteActorInfo[];
  cinemaKunye: CinemaKunyeDocument;
  isDemo: boolean;
  revision?: number;
  deletedKeys: Record<string, string>;
}

import type {
  SavedItem,
  FavoriteActorInfo,
} from './types.ts';
