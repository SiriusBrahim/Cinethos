/**
 * İstemci tarafı sunucu zevk sinyali yükleyicisi.
 *
 * `/api/taste/profile` yanıtını `ServerTasteSignal`e indirger ve profil başına
 * kısa süreli önbellekler. Ağ/servis hatasında `null` döner: sıralama yerel
 * profille devam eder, öneri akışı bloklanmaz.
 */

import { fetchTasteProfile } from './taste-api.ts';
import {
  buildServerTasteSignal,
  type ServerTasteSignal,
} from '../modules/recommendations/taste-signal.ts';

const CACHE_TTL_MS = 5 * 60 * 1000;

interface CacheEntry {
  readonly signal: ServerTasteSignal | null;
  readonly fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<ServerTasteSignal | null>>();

export interface LoadServerTasteSignalOptions {
  readonly profileId: string;
  readonly mood?: string;
  readonly force?: boolean;
  readonly now?: number;
}

export function clearServerTasteSignalCache(profileId?: string): void {
  if (profileId) {
    cache.delete(profileId);
    inFlight.delete(profileId);
    return;
  }
  cache.clear();
  inFlight.clear();
}

export async function loadServerTasteSignal(
  options: LoadServerTasteSignalOptions
): Promise<ServerTasteSignal | null> {
  const { profileId } = options;
  if (!profileId) return null;
  const now = options.now ?? Date.now();
  const cached = cache.get(profileId);
  if (!options.force && cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.signal;
  }
  const pending = inFlight.get(profileId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const profile = await fetchTasteProfile();
      const signal = buildServerTasteSignal(
        { ...profile, profileId } as Parameters<typeof buildServerTasteSignal>[0],
        { mood: options.mood }
      );
      cache.set(profileId, { signal, fetchedAt: Date.now() });
      return signal;
    } catch {
      cache.set(profileId, { signal: null, fetchedAt: Date.now() });
      return null;
    } finally {
      inFlight.delete(profileId);
    }
  })();

  inFlight.set(profileId, request);
  return request;
}

/** Testler için: sunucu yanıtından doğrudan sinyal üretir. */
export function buildSignalFromProfileResponse(
  profile: unknown,
  options: { profileId: string; mood?: string }
): ServerTasteSignal | null {
  if (!profile || typeof profile !== 'object') return null;
  return buildServerTasteSignal(
    { ...(profile as object), profileId: options.profileId } as Parameters<
      typeof buildServerTasteSignal
    >[0],
    { mood: options.mood }
  );
}
