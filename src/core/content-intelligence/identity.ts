/**
 * İçerik kimliği ve tekilleştirme kuralları.
 *
 * Kural: kimlik **medya türü + TMDB kimliği**dir. Başlık, yıl veya kaynak
 * değişse bile anahtar değişmez; böylece aynı içerik ikinci kez indirilmez.
 * Film ve dizi aynı TMDB kimliğini taşıyabilir, bu yüzden tür kimliğin parçasıdır.
 */

import type { ContentIdentity, ContentRecord, MediaType, SourceMetadata } from './contracts.ts';

const KEY_PATTERN = /^(movie|tv):([1-9]\d{0,9})$/;

export function normalizeMediaType(value: unknown): MediaType | null {
  if (value === 'movie' || value === 'tv') return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'movie' || lowered === 'film') return 'movie';
    if (lowered === 'tv' || lowered === 'series' || lowered === 'dizi') return 'tv';
  }
  return null;
}

export function canonicalContentKey(mediaType: MediaType, tmdbId: number): string {
  return `${mediaType}:${tmdbId}`;
}

export function createContentIdentity(mediaType: MediaType, tmdbId: number): ContentIdentity {
  return { mediaType, tmdbId, key: canonicalContentKey(mediaType, tmdbId) };
}

export function parseContentKey(key: string): ContentIdentity | null {
  const match = KEY_PATTERN.exec(key);
  if (!match) return null;
  return createContentIdentity(match[1] as MediaType, Number(match[2]));
}

export type DedupeAction = 'inserted' | 'updated' | 'skipped';

export interface DedupeDecision {
  readonly action: DedupeAction;
  readonly reason: string;
}

/**
 * Aynı anahtar için gelen kayıt yeni mi eskimi karar verir.
 * Kural: `fetchedAt` daha yeni değilse sağlayıcı verisi yeniden yazılmaz
 * (tekrarlı indirme yok); türetilmiş özellik üretimi de tekrarlanmaz.
 */
export function decideDedupe(
  existing: ContentRecord | null,
  incoming: SourceMetadata
): DedupeDecision {
  if (!existing) return { action: 'inserted', reason: 'yeni içerik' };
  const previous = Date.parse(existing.source.fetchedAt);
  const next = Date.parse(incoming.fetchedAt);
  if (Number.isNaN(previous) || Number.isNaN(next)) {
    return { action: 'updated', reason: 'kaynak zamanı okunamadı' };
  }
  if (next <= previous) {
    return { action: 'skipped', reason: 'kaynak verisi daha yeni değil' };
  }
  return { action: 'updated', reason: 'kaynak verisi yenilendi' };
}

/** Gelen kaydın doğrulaması — geçersiz içerik depoya yazılmaz. */
export function validateSourceMetadata(source: SourceMetadata): string | null {
  if (!source || typeof source !== 'object') return 'kaynak verisi yok';
  if (!normalizeMediaType(source.mediaType)) return 'geçersiz medya türü';
  if (!Number.isSafeInteger(source.tmdbId) || source.tmdbId <= 0) return 'geçersiz TMDB kimliği';
  if (typeof source.title !== 'string' || source.title.trim().length === 0) return 'başlık boş';
  if (!Array.isArray(source.genreIds)) return 'tür listesi yok';
  if (typeof source.fetchedAt !== 'string' || Number.isNaN(Date.parse(source.fetchedAt))) {
    return 'kaynak zamanı geçersiz';
  }
  return null;
}
