/**
 * Ortak medya/veri belgesi tipleri ve sabitleri (F5-05).
 *
 * `cinetrack-core.ts` içindeki SavedItem/Profile/DataDocument modeli ve ilgili
 * sabitler buraya taşındı. Davranış değişmedi; `cinetrack-core` yeniden dışa
 * aktarır (eski import yolları korunur).
 */

export const REMINDER_WINDOW_DAYS = 3;

export interface NextEpisode {
  air_date: string;
  episode_number: number;
  season_number: number;
}

export interface SavedItem {
  id: number | string;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  last_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  poster_url?: string;
  poster_path?: string;
  backdrop_path?: string;
  overview?: string;
  genre_ids: number[];
  genres?: string[] | { id: number; name: string }[];
  runtime?: number;
  episode_run_time?: number[];
  number_of_seasons?: number;
  number_of_episodes?: number;
  season_progress?: Record<number, number>;
  season_episode_counts?: Record<number, number>;
  /** Sezon → izlenmiş bölüm numaraları (sırasız izleme desteği). */
  watched_episodes?: Record<number, number[]>;
  /** Sezon ilerlemesinin son bilinçli değişim anı (geri alma ve çakışma çözümü). */
  progress_updated_at?: Record<number, string>;
  next_episode_to_air?: NextEpisode | null;
  current_season?: number;
  episodes_watched?: number;
  next_episode?: number;
  status: 'watching' | 'watchlist' | 'completed';
  personal_rating: number | '';
  personal_rating_cleared?: boolean;
  /**
   * Aşama 1 — Durum alanının en son kullanıcı tarafından değiştirildiği an.
   * Alan bazlı birleştirmede `updatedAt`'ten (not düzenlemesi) ayrı tutulur.
   */
  status_changed_at?: string;
  /**
   * Aşama 1 — Puan alanının (puan verme, değiştirme veya temizleme) en son
   * değiştirildiği an. `ratedAt` yalnızca dolu puanı temsil eder.
   */
  rating_changed_at?: string;
  ratedAt?: string;
  /** İzleme etkileşiminin (bölüm işaretleme dahil) son anı. `updatedAt` değildir. */
  watchedAt?: string;
  completedAt?: string;
  addedAt?: string;
  firstAddedAt?: string;
  totalWatchTimeMinutes?: number;
  updatedAt?: string;
  custom?: boolean;
  cast?: { id: number; name: string; popularity?: number; profile_path?: string; character?: string }[];
  crew?: { id: number; name: string; job: string; department?: string }[];
  poolSource?: string;
  poolReason?: string;
  poolSources?: number;
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
  } | null;
  isDemo?: boolean;
}

export interface Preferences {
  disliked: string[];
  hidden?: string[];
  providers: string[];
  mood: string;
  reminders: boolean;
  notified: string[];
}

export interface FavoriteActorInfo {
  id: number;
  name: string;
  profile_path?: string | null;
  character?: string;
  [key: string]: any;
}

export interface Profile {
  id: string;
  name: string;
  createdAt: string;
  preferences: Preferences;
  items: SavedItem[];
  favoriteActors?: FavoriteActorInfo[];
  deleted_keys?: Record<string, string>;
  isDemo?: boolean;
}

export const CURRENT_SCHEMA_VERSION = 3;
export const ENGINE_VERSION = 'v3.2.0';
export const TOMBSTONE_RETENTION_DAYS = 30;

export interface DataDocument {
  version: 3;
  schemaVersion: number;
  engineVersion?: string;
  activeProfileId: string;
  profiles: Profile[];
  revision?: number;
  updatedAt?: string;
}

export const TARGET_RECOMMENDATION_COUNT = 20;

/**
 * B-13: Sunucu zevk sinyalinin skordaki ağırlığı ve açıklama eşiği.
 * Ağırlık yalnızca sinyal gerçekten hesaplanabildiğinde ağırlık kümesine eklenir;
 * sinyal yokken puanlar birebir değişmez.
 */
export const SERVER_TASTE_WEIGHT = 0.06;
/** `parts.serverTaste` bu değerin altındaysa açıklamada katkı iddia edilmez. */
export const SERVER_TASTE_EXPLANATION_PART_THRESHOLD = 0.62;

export const LATEST_BACKUP_VERSION = 4;
export const SUPPORTED_BACKUP_VERSIONS: readonly number[] = [1, 2, 3, 4];

import type { CinemaKunyeDocument } from '../cinema-kunye.ts';

export interface ParsedBackupProfile {
  id: string;
  name: string;
  createdAt?: string;
  preferences: any;
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
  preferences: any;
  favoriteActors: FavoriteActorInfo[];
  cinemaKunye: CinemaKunyeDocument;
  isDemo: boolean;
  revision?: number;
  deletedKeys: Record<string, string>;
}
