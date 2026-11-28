import crypto from 'node:crypto';
import { normalizeProfileId } from '../core/profile-id.ts';
import type { CatalogRecord } from './persistent-store-types.ts';

/**
 * Hata mesajları veya günlük metinlerinden GitHub token ve Bearer başlıklarını temizler.
 */
export function redactSecrets(input: string, extraSecrets: Array<string | undefined> = []): string {
  if (!input) return '';
  let sanitized = String(input);
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join('[REDACTED]');
    }
  }
  sanitized = sanitized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\btoken\s+[A-Za-z0-9._-]{16,}/gi, 'token [REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]');
  return sanitized;
}

/**
 * Deterministic JSON stringifier that sorts object keys recursively and alphabetically.
 */
export function stringifyDeterministic(obj: any, space = 2): string {
  const sortRecursively = (val: any): any => {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(sortRecursively);
    const sortedKeys = Object.keys(val)
      .filter((k) => val[k] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const out: Record<string, any> = {};
    for (const k of sortedKeys) {
      out[k] = sortRecursively(val[k]);
    }
    return out;
  };
  return JSON.stringify(sortRecursively(obj), null, space);
}

/**
 * Calculate sha256 hash of a string
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Normalize TMDB or local item to a canonical key: `movie:<id>` or `tv:<id>`
 */
export function toCanonicalKey(item: any): string | null {
  if (!item || typeof item !== 'object') return null;
  const rawId = Number(item.id);
  if (!Number.isSafeInteger(rawId) || rawId <= 0) return null;
  const rawType = item.media_type || (item.title ? 'movie' : item.name ? 'tv' : 'movie');
  const type = rawType === 'tv' ? 'tv' : 'movie';
  return `${type}:${rawId}`;
}

/**
 * Merge new partial incoming record into existing rich record without losing data.
 */
export function mergeCatalogItem(existing: CatalogRecord | undefined, incoming: any): CatalogRecord {
  const rawId = Number(incoming.id);
  const mediaType: 'movie' | 'tv' = incoming.media_type === 'tv' ? 'tv' : 'movie';
  const key = `${mediaType}:${rawId}`;
  const now = new Date().toISOString();

  const title = (incoming.title || incoming.name || existing?.title || '').trim();
  const originalTitle = (
    incoming.original_title ||
    incoming.original_name ||
    existing?.original_title ||
    ''
  ).trim();
  const overview =
    typeof incoming.overview === 'string' && incoming.overview.trim()
      ? incoming.overview.trim()
      : existing?.overview || '';
  const posterPath =
    incoming.poster_path !== undefined ? incoming.poster_path : existing?.poster_path ?? null;
  const backdropPath =
    incoming.backdrop_path !== undefined ? incoming.backdrop_path : existing?.backdrop_path ?? null;

  // Merge genre_ids deterministically (supports both list `genre_ids` and detail `genres: [{id, name}]`)
  const genreSet = new Set<number>();
  if (Array.isArray(existing?.genre_ids)) {
    for (const g of existing.genre_ids) if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
  }
  if (Array.isArray(incoming.genre_ids)) {
    for (const g of incoming.genre_ids) if (Number.isSafeInteger(g) && g > 0) genreSet.add(g);
  }
  if (Array.isArray(incoming.genres)) {
    for (const g of incoming.genres) {
      const gid = typeof g === 'number' ? g : Number(g?.id);
      if (Number.isSafeInteger(gid) && gid > 0) genreSet.add(gid);
    }
  }
  const genreIds = Array.from(genreSet).sort((a, b) => a - b);

  const voteAverage =
    Number.isFinite(incoming.vote_average) && incoming.vote_average > 0
      ? Number(incoming.vote_average)
      : existing?.vote_average ?? 0;

  const voteCount =
    Number.isSafeInteger(incoming.vote_count) && incoming.vote_count > 0
      ? Number(incoming.vote_count)
      : existing?.vote_count ?? 0;

  const releaseDate =
    incoming.release_date ||
    incoming.first_air_date ||
    existing?.release_date ||
    existing?.first_air_date ||
    undefined;
  const firstAirDate =
    mediaType === 'tv'
      ? incoming.first_air_date || existing?.first_air_date || releaseDate
      : undefined;
  const popularity = Number.isFinite(incoming.popularity)
    ? Number(incoming.popularity)
    : existing?.popularity ?? undefined;

  return {
    key,
    id: rawId,
    media_type: mediaType,
    title,
    original_title: originalTitle || undefined,
    overview: overview || undefined,
    poster_path: posterPath,
    backdrop_path: backdropPath,
    genre_ids: genreIds,
    vote_average: voteAverage,
    vote_count: voteCount || undefined,
    release_date: releaseDate,
    first_air_date: firstAirDate,
    popularity,
    firstStoredAt: existing?.firstStoredAt || now,
    lastUpdatedAt: now,
    source: incoming._source || existing?.source || 'tmdb',
  };
}

/**
 * Sanitize profileId for safe file naming on disk.
 */
export function sanitizeProfileId(profileId: string): string {
  const canonical = normalizeProfileId(profileId);
  if (!canonical) throw new Error('Geçersiz profil kimliği; dosya adı oluşturulamadı.');
  // Eski türetilmiş profil dosyaları küçük harfli adlandırma kullanıyordu.
  // Kanonik kimlik tekilleştirilirken dosya yolu geriye dönük uyumlu kalır.
  return canonical.toLowerCase();
}

/**
 * F5.2-05 — `catch` bağlaması `unknown`'dır; kullanıcıya gösterilecek mesajı
 * tip güvenli biçimde çıkarır. Nesne olmayan/boş hata değerleri için yedek
 * metin döner (önceki `err?.message || fallback` davranışıyla aynı).
 */
export function errorMessageOf(value: unknown, fallback = ''): string {
  if (value instanceof Error && value.message) return value.message;
  if (typeof value === 'string' && value) return value;
  return fallback;
}
