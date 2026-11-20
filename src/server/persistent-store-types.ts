import type { DerivedPillarsRecord } from '../core/derived-profile-cache.ts';

export interface CatalogRecord {
  key: string;
  id: number;
  media_type: 'movie' | 'tv';
  title: string;
  original_title?: string;
  overview?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids: number[];
  vote_average: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
  firstStoredAt: string;
  lastUpdatedAt: string;
  source?: 'tmdb' | 'demo';
}

export interface CatalogManifest {
  version: 1;
  updatedAt: string;
  movieCount: number;
  tvCount: number;
  contentHash: string;
}

export interface DerivedProfileItem {
  mediaKey: string;
  matchScore: number;
  tasteScore?: number;
  priorityScore?: number;
  lifecycleRing: 'ring0' | 'ring1' | 'ring2';
  signals?: Record<string, number>;
  reasons?: string[];
  shownCount?: number;
  skippedCount?: number;
  demotionPenalty?: number;
  status?: 'active' | 'saved' | 'disliked' | 'hidden';
  scoreCoverage?: 'basic' | 'enriched';
  pillars?: DerivedPillarsRecord;
  calculatedAt: string;
}

export interface DerivedProfileDocument {
  schemaVersion: number;
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash?: string;
  contentHash?: string;
  generatedAt: string;
  items: Record<string, DerivedProfileItem>;
}

/** Narrow adapter contract consumed by the bidirectional sync manager. */
export interface PersistentDataStoreSyncPort {
  recoverGitHubTokenOn401?: (failedToken?: string) => Promise<string | null>;
  verifyRemoteRepoAccess: () => Promise<any>;
  getProfileFilePath: (profileId: string) => string;
  syncToGitHub: (options?: any) => Promise<any>;
  commitFileToGitHub: (repoPath: string, content: string, message: string, options?: any) => Promise<any>;
}
