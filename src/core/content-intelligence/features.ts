/**
 * Özellik çıkarımı — sağlayıcı verisinden öneri motorunun kullandığı türetilmiş
 * alanlar. Saf ve deterministiktir: aynı kaynak → aynı özellikler.
 *
 * `featureVersion` artırıldığında kayıtlar `reprocess` ile yeniden üretilir;
 * sağlayıcı verisi yeniden indirilmez (mimari ilke 5).
 */

import { canonicalContentKey, normalizeMediaType } from './identity.ts';
import {
  CONTENT_FEATURE_VERSION,
  type DerivedFeatures,
  type SourceMetadata,
} from './contracts.ts';

const MAX_KEYWORD_TOKENS = 12;
const MAX_CAST_IDS = 5;

function runtimeBucketOf(runtimeMinutes: number | undefined): DerivedFeatures['runtimeBucket'] {
  if (typeof runtimeMinutes !== 'number' || !Number.isFinite(runtimeMinutes) || runtimeMinutes <= 0) {
    return 'unknown';
  }
  if (runtimeMinutes < 80) return 'short';
  if (runtimeMinutes > 140) return 'long';
  return 'standard';
}

function popularityTierOf(popularity: number | undefined): DerivedFeatures['popularityTier'] {
  if (typeof popularity !== 'number' || !Number.isFinite(popularity)) return 'low';
  if (popularity >= 100) return 'high';
  if (popularity >= 30) return 'medium';
  return 'low';
}

function qualityTierOf(
  voteAverage: number | undefined,
  voteCount: number | undefined
): DerivedFeatures['qualityTier'] {
  const average = typeof voteAverage === 'number' && Number.isFinite(voteAverage) ? voteAverage : 0;
  const count = typeof voteCount === 'number' && Number.isFinite(voteCount) ? voteCount : 0;
  if (count < 50) return 'low';
  if (average >= 7.5) return 'high';
  if (average >= 6) return 'medium';
  return 'low';
}

function keywordTokensOf(keywords: readonly string[] | undefined): readonly string[] {
  if (!keywords || keywords.length === 0) return [];
  const seen = new Set<string>();
  for (const keyword of keywords) {
    if (typeof keyword !== 'string') continue;
    const token = keyword.trim().toLowerCase();
    if (token.length === 0) continue;
    seen.add(token);
    if (seen.size >= MAX_KEYWORD_TOKENS) break;
  }
  return [...seen].sort();
}

export function deriveFeatures(
  source: SourceMetadata,
  options: { readonly now?: () => Date; readonly featureVersion?: number } = {}
): DerivedFeatures {
  const mediaType = normalizeMediaType(source.mediaType);
  if (!mediaType) throw new Error('Özellik çıkarımı için medya türü gerekli');

  const genres = [...new Set(source.genres.filter((genre) => typeof genre === 'string'))].sort();
  const releaseYear =
    typeof source.releaseYear === 'number' && Number.isFinite(source.releaseYear)
      ? source.releaseYear
      : null;

  return {
    key: canonicalContentKey(mediaType, source.tmdbId),
    featureVersion: options.featureVersion ?? CONTENT_FEATURE_VERSION,
    genreSet: genres,
    primaryGenre: genres[0] ?? null,
    decade: releaseYear === null ? null : Math.floor(releaseYear / 10) * 10,
    runtimeBucket: runtimeBucketOf(source.runtimeMinutes),
    popularityTier: popularityTierOf(source.popularity),
    qualityTier: qualityTierOf(source.voteAverage, source.voteCount),
    keywordTokens: keywordTokensOf(source.keywords),
    castIds: (source.cast ?? [])
      .map((member) => member.id)
      .filter((id) => Number.isSafeInteger(id) && id > 0)
      .slice(0, MAX_CAST_IDS),
    directorIds: (source.directors ?? [])
      .map((member) => member.id)
      .filter((id) => Number.isSafeInteger(id) && id > 0),
    computedAt: (options.now ?? (() => new Date()))().toISOString(),
  };
}
