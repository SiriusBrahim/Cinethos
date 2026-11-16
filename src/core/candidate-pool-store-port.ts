import type { PersistentCandidatePoolData } from './media/types.ts';

export interface CandidatePoolStorePort {
  hydrateDiscoveryHistory(profileId: string): Promise<unknown>;
  hydrateCandidatePools(profileId: string): Promise<unknown>;
  loadPool(profileId: string, mediaType: 'movie' | 'tv'): PersistentCandidatePoolData;
  savePool(profileId: string, data: PersistentCandidatePoolData): void;
  /** Port sahibinin bellek içi aynalarını sıfırlar (test izolasyonu için). */
  resetMirrors?(): void;
}

let activePort: CandidatePoolStorePort | null = null;

export function registerCandidatePoolStorePort(port: CandidatePoolStorePort): void {
  activePort = port;
}

export function getCandidatePoolStorePort(): CandidatePoolStorePort | null {
  return activePort;
}
