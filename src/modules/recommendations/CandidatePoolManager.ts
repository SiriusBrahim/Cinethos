/**
 * MIA Faz 6 — Aday Havuzu Yöneticisi.
 *
 * Öneri motorunun aday havuzu sınırlarını korur: film-only / TV-only
 * görünümlerde karşı medya tipinin havuza sızmasını engeller. Puanlama
 * YAPMAZ; yalnızca havuza girebilecek kayıtları belirler.
 */

import { resolveMediaType } from '../../core/keys.ts';

/**
 * Film-only veya TV-only modlarında karşı medya tipinin havuza ya da vitrine sızmasını katı biçimde engeller.
 * `media_type` alanı olmayan belirsiz kayıtları tahmin etmeden uyarı günlüğüyle eler (EXT-04).
 */
export function enforceStrictMediaTypePool<T extends Record<string, any>>(
  items: T[],
  targetType: 'all' | 'movie' | 'tv' | string
): T[] {
  if (!Array.isArray(items)) return [];

  return items.filter((entry) => {
    const cand = entry?.candidate && typeof entry.candidate === 'object' ? entry.candidate : entry;
    if (!cand || typeof cand !== 'object') return false;
    const resolvedType = resolveMediaType(cand);
    if (resolvedType === 'unknown') {
      console.warn(
        `[Recommendation] media_type alanı belirsiz kayıt havuzdan elendi (id=${String(
          cand.id ?? 'bilinmiyor'
        )}).`
      );
      return false;
    }
    if (targetType !== 'movie' && targetType !== 'tv') return true;
    return resolvedType === targetType;
  });
}

export interface CandidatePoolManager {
  readonly enforceStrictMediaTypePool: typeof enforceStrictMediaTypePool;
}

/** Aday havuzu yöneticisi (tek örnek; durum tutmaz). */
export function createCandidatePoolManager(): CandidatePoolManager {
  return { enforceStrictMediaTypePool };
}
