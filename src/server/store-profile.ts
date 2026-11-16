import type { DerivedPillarsRecord } from '../core/derived-profile-cache.ts';

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

/**
 * Sanitize profileId for safe file naming on disk.
 */
export function sanitizeProfileId(profileId: string): string {
  const cleaned = profileId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.slice(0, 80) || 'default';
}
