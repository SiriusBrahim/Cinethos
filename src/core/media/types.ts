/**
 * MIA Faz 1A ① — Ortak medya/veri tip modülü.
 *
 * Amaç: `cinetrack-core.ts` ile alt modüller (actor-recommendations,
 * candidate-pool-store-port, cinema-kunye, ring-lifecycle) arasındaki
 * 4 tip-döngüsünü koparmak. Bu dosya YALNIZCA tip içerir; çalışma
 * zamanı davranışı yoktur ve yalnızca döngüsüz alt modüllere
 * (keys, loved-similarity, mood-affinity) referans verir.
 *
 * Uyumluluk: `cinetrack-core.ts` bu tipleri yeniden export etmeye
 * devam eder; mevcut import yolları bozulmaz.
 */

import type { LovedSimBreakdown } from '../loved-similarity.ts';
import type { MoodAffinityResult } from '../mood-affinity.ts';

// --- Ring tipleri (ring-lifecycle.ts'ten taşındı; orada yeniden export edilir) ---

export type LifecycleRing = 'ring0' | 'ring1' | 'ring2';
export type TasteRing = LifecycleRing | 'core' | 'inner' | 'outer' | 'orbit';

// --- Kütüphane veri modeli ---

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
  next_episode_to_air?: NextEpisode | null;
  current_season?: number;
  episodes_watched?: number;
  next_episode?: number;
  status: 'watching' | 'watchlist' | 'completed';
  personal_rating: number | '';
  personal_rating_cleared?: boolean;
  ratedAt?: string;
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
  /**
   * "Sana Özel" hesabının listeye yazılmış kalıcı damgası.
   * Render'da yeniden hesaplanmaz; silinen/yeni eklenen kayıtlarda tazelenir.
   */
  tasteFit?: number;
  tasteReason?: string;
  tasteTags?: string[];
  tasteConfidence?: 'standard' | 'high';
  tasteComputedAt?: string;
  belongs_to_collection?: {
    id: number;
    name: string;
    poster_path?: string | null;
    backdrop_path?: string | null;
  } | null;
  isDemo?: boolean;
}

export interface FavoriteActorInfo {
  id: number;
  name: string;
  profile_path?: string | null;
  character?: string;
  [key: string]: any;
}

// --- Zevk Haritası veri modeli ---

export interface TastePillarsSummary {
  genreStoryScore: number;       // 0-100 (Tür ve hikâye: tür, anahtar kelime, özet)
  castCreatorsScore: number;     // 0-100 (Kadro ve yaratıcılar: oyuncu, yönetmen, kadro uyumu)
  discoveryQualityScore: number; // 0-100 (Keşif ve kalite: kalite, popülerlik, yenilik)
}

export interface TasteMapImpression {
  shownAt: string;
  targetType: string;
  rank?: number;
}

export interface TasteMapEntry {
  mediaKey: string;
  mediaType: 'movie' | 'tv';
  id: number;
  title: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  popularity?: number;
  genre_ids?: number[];
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  matchScore: number;       // Gerçek zevk uyumu (1-100, demotion cezasından etkilenmez: örn 92)
  tasteScore: number;       // Gerçek zevk uyumu (matchScore ile eşdeğer, açık sinyal ayrımı)
  priorityScore: number;    // Gösterim ve seçim önceliği puanı (demotion cezası düşülmüş hali: örn 82)
  rawScore: number;
  ring: TasteRing;
  initialRing: TasteRing;
  pillars?: TastePillarsSummary;
  parts: Record<string, number>;
  tags: string[];
  shownCount: number;
  skippedCount: number;
  ringDemotions: number;
  demotionPenalty: number;
  firstShownAt?: string | null;
  lastShownAt: string | null;
  lastScoredAt: string;
  archivedImpressionCount?: number;
  impressionHistory?: TasteMapImpression[];
  status: 'active' | 'saved' | 'disliked' | 'hidden';
  isArchived?: boolean;
  archivedAt?: string | null;
  archiveReason?: 'evicted_from_pool' | 'status_change' | 'manual';
  scoreCoverage?: 'basic' | 'enriched';
  confidenceLevel?: 'standard' | 'high';
  lovedSimDetail?: LovedSimBreakdown | null;
  moodDetail?: MoodAffinityResult | null;
  atmosphereScore?: number;
}

export interface TasteProfileSnapshot {
  savedItemCount: number;
  ratingsSum: number;
  dislikedCount: number;
  dislikedHash?: string;
  providerHash?: string;
  mood: string;
  favActorCount: number;
  favActorIds?: number[];
  targetType: string;
  hasLiveItems: boolean;
  algorithmVersion?: string;
  weightsSignature?: string;
  scopedItemCount?: number;
  scopedRatingsSum?: number;
}

export interface TasteProfileSummary {
  topGenres: Array<{ id: string; name: string; score: number }>;
  topActors: Array<{ id: string; name: string; score: number; appearances: number }>;
  topDirectors: Array<{ id: string; name: string; score: number }>;
  storyKeywords: string[];
  totalEvaluatedCandidates: number;
  archivedCandidatesCount?: number;
  ringCounts: {
    core: number;
    inner: number;
    outer: number;
    orbit: number;
    ring0?: number;
    ring1?: number;
    ring2?: number;
  };
}

export interface PersistentTasteMapData {
  profileId: string;
  profileSignature?: string;
  profileSnapshot?: TasteProfileSnapshot;
  algorithmVersion?: string;
  engineVersion?: string;
  weightsSignature?: string;
  updatedAt: string;
  entries: Record<string, TasteMapEntry>;
  archivedEntries?: Record<string, TasteMapEntry>;
  lastRecommendedKeys: string[];
  lastBatchTimestamp: string | null;
  cachedBalancedItems?: any[];
  lastTargetType?: string;
  lastExplanation?: string;
  summary?: TasteProfileSummary;
}

// --- Aday havuzu veri modeli ---

export type PoolSourceType =
  | 'popular'
  | 'top_rated'
  | 'recent'
  | 'genre_discover'
  | 'similar'
  | 'person_credits'
  | 'exploration'
  | string;

export interface PoolCandidateItem {
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  overview: string;
  release_date?: string;
  first_air_date?: string;
  vote_average: number;
  vote_count: number;
  popularity: number;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids: number[];

  // Algoritma sinyalleri
  poolSource: PoolSourceType;
  poolReason?: string;
  poolSources: number;
  seedSourceType?: 'completed' | 'watching' | 'watchlist' | '';
  addedToPoolAt?: string;
  era: 'classic' | 'retro' | 'modern' | 'new';
  popularityTier: 'high' | 'medium' | 'low' | 'indie';
  cast?: { id: number; name: string; popularity?: number; profile_path?: string; character?: string }[];
  crew?: { id: number; name: string; job: string; department?: string }[];
  belongs_to_collection?: any;
  production_companies?: any[];

  // Sorun D: Kullanıcıya özel kalıcı öneri ve Zevk Haritası alanları
  matchScore?: number;
  rawScore?: number;
  ring?: TasteRing;
  initialRing?: TasteRing;
  signalBreakdown?: Record<string, number>;
  tags?: string[];
  lastShownAt?: string | null;
  lastScoredAt?: string | null;
  shownCount?: number;
  skippedCount?: number;
  ringDemotions?: number;
  demotionPenalty?: number;
}

export interface CandidatePoolCursors {
  popular: number;
  top_rated: number;
  recent: number;
  exploration: number;
  genre_discover: Record<string, number>; // genreId -> page
  similar: Record<string, number>;        // mediaKey -> page
  person_credits: Record<string, number>; // personId -> page
}

export interface PersistentCandidatePoolData {
  mediaType: 'movie' | 'tv';
  updatedAt: string;
  items: PoolCandidateItem[];
  cursors: CandidatePoolCursors;
}
