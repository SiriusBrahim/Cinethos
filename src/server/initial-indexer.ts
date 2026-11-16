/**
 * MIA Faz 2 — Adım 2.7 (Dilim G): Başlangıç indekslemesi.
 *
 * Sunucu açılışında PrimaryDataRepository üzerinden okunan belgedeki TÜM
 * profillerin beş liste kapsamını ortak içerik kuyruğuna verir:
 *   - İzledim (status=completed), İzliyorum (watching), İzleyeceğim (watchlist)
 *     → profil `items` dizisi
 *   - İlgilenmiyorum (not-interested) → `preferences.disliked` / `disliked`
 *   - Gizlenen → `preferences.hidden` / `hidden`
 *
 * KURALLAR:
 * - Profil verisi ortak kuyruğa gönderilmeden önce allowlist ile temizlenir.
 * - Aynı içerik birden fazla profilde varsa TEK ortak media_key işi oluşur.
 * - Yalnızca kullanıcı listelerindeki içerikler kuyruğa alınır; tüm TMDB
 *   kataloğu taranmaz.
 * - Sayfalı çalışır; olay döngüsünü kilitlemez.
 */

import type { MediaKind } from '../contracts/index.ts';
import type { DataDocument, Profile } from '../core/cinetrack-core.ts';
import { makeMediaKey, parseMediaKey } from '../core/keys.ts';
import { sanitizeRawContentInput } from '../modules/content/content-metadata-processor.ts';

export interface InitialIndexItem {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly tmdbId: number;
  readonly payload: Record<string, unknown>;
}

export interface InitialIndexStats {
  status: 'idle' | 'running' | 'completed' | 'partial' | 'failed';
  lastRunAt: string | null;
  totalUnique: number;
  queued: number;
  rejected: number;
  failed: number;
  lastError: string | null;
}

export function createInitialIndexStats(): InitialIndexStats {
  return {
    status: 'idle',
    lastRunAt: null,
    totalUnique: 0,
    queued: 0,
    rejected: 0,
    failed: 0,
    lastError: null,
  };
}

function resolveProfilePreferenceKeys(profile: Profile, key: 'disliked' | 'hidden'): string[] {
  const preferences = (profile as unknown as { preferences?: Record<string, unknown> }).preferences;
  const fromPreferences = preferences?.[key];
  const fromTopLevel = (profile as unknown as Record<string, unknown>)[key];
  const source = Array.isArray(fromPreferences) ? fromPreferences : Array.isArray(fromTopLevel) ? fromTopLevel : [];
  return source.filter((k): k is string => typeof k === 'string' && k.trim().length > 0);
}

/**
 * Belgedeki beş liste kapsamını tarar; mediaKey başına tek ve allowlist
 * temizliğini geçmiş iş listesi üretir.
 */
export function collectInitialIndexItems(doc: DataDocument | null | undefined): InitialIndexItem[] {
  const byKey = new Map<string, InitialIndexItem>();

  const pushRaw = (raw: unknown): void => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Record<string, unknown>;
    const mediaType: MediaKind | null = item.media_type === 'tv' ? 'tv' : item.media_type === 'movie' ? 'movie' : null;
    const numericId = Number(item.id ?? item.tmdbId ?? item.tmdb_id);
    if (!mediaType || !Number.isInteger(numericId) || numericId <= 0) return;
    const mediaKey = makeMediaKey(mediaType, numericId);
    if (byKey.has(mediaKey)) return; // aynı içerik birden fazla profilde → tek iş

    const { sanitized } = sanitizeRawContentInput(item);
    byKey.set(mediaKey, {
      mediaKey,
      mediaType,
      tmdbId: numericId,
      payload: {
        ...sanitized,
        id: sanitized.id ?? numericId,
        mediaType,
        mediaKey,
      },
    });
  };

  const pushKeyOnly = (rawKey: string): void => {
    const parsed = parseMediaKey(rawKey);
    if (!parsed) return;
    const tmdbId = /^\d+$/.test(parsed.id) ? Number(parsed.id) : NaN;
    if (!Number.isInteger(tmdbId) || tmdbId <= 0) return;
    const mediaKey = `${parsed.type}:${tmdbId}`;
    if (byKey.has(mediaKey)) return;
    byKey.set(mediaKey, {
      mediaKey,
      mediaType: parsed.type,
      tmdbId,
      payload: { id: tmdbId, media_type: parsed.type, mediaKey },
    });
  };

  for (const profile of doc?.profiles ?? []) {
    // Beş listenin ana kapsamı: profil items dizisi (tüm durumlar).
    for (const item of profile.items ?? []) {
      pushRaw(item);
    }
    // İlgilenmiyorum ve gizlenenler de kapsama girer (plan 2.5/2.7).
    for (const key of resolveProfilePreferenceKeys(profile, 'disliked')) pushKeyOnly(key);
    for (const key of resolveProfilePreferenceKeys(profile, 'hidden')) pushKeyOnly(key);
  }

  return [...byKey.values()];
}
