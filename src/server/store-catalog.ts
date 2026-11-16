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
