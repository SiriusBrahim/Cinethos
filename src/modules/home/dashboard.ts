import type { SavedItem } from '../../core/cinetrack-core.ts';

/**
 * Ana Sayfa veri türetimi (saf, DOM'suz).
 *
 * Kabuk yalnızca kullanıcı verisini verir; "devam eden", "son aktivite" ve
 * "zevk izleri" listeleri burada deterministik olarak hesaplanır. Böylece
 * görünüm test edilebilir kalır ve aynı kurallar mobil/masaüstünde tekrar
 * yazılmaz.
 */

const DEFAULT_LIMIT = 8;
const MOVIE_MINUTES_FALLBACK = 110;
const TV_MINUTES_PER_EPISODE_FALLBACK = 45;
const RATING_AFFINITY_THRESHOLD = 7;

export interface HomeProgress {
  readonly watched: number;
  readonly total: number;
  readonly percent: number;
}

export interface HomeEntry {
  readonly key: string;
  readonly item: SavedItem;
  readonly title: string;
  readonly mediaType: 'movie' | 'tv';
  readonly year: string;
  readonly status: SavedItem['status'];
  readonly rating: number | null;
  readonly timestamp: string;
  readonly progress: HomeProgress | null;
}

export interface HomeGenreAffinity {
  readonly id: number;
  readonly name: string;
  readonly score: number;
}

export interface HomeStats {
  readonly watching: number;
  readonly watchlist: number;
  readonly completed: number;
  readonly rated: number;
  readonly averageRating: number | null;
  readonly estimatedMinutes: number;
}

export interface HomeDashboard {
  readonly stats: HomeStats;
  readonly continueWatching: readonly HomeEntry[];
  readonly recentActivity: readonly HomeEntry[];
  readonly picks: readonly SavedItem[];
  readonly genres: readonly HomeGenreAffinity[];
  readonly hasLibrary: boolean;
}

export interface HomeDashboardInput {
  readonly savedItems: readonly SavedItem[] | null | undefined;
  readonly forYouItems?: readonly SavedItem[] | null;
  readonly genresMap?: Readonly<Record<number, string>> | null;
  readonly limit?: number;
}

function clampLimit(value: number | undefined): number {
  if (!Number.isFinite(value as number)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(24, Math.floor(value as number)));
}

function itemKey(item: SavedItem): string {
  return `${item.media_type === 'tv' ? 'tv' : 'movie'}:${item.id}`;
}

function itemTimestamp(item: SavedItem): string {
  return (
    item.updatedAt ||
    item.ratedAt ||
    item.completedAt ||
    item.addedAt ||
    item.firstAddedAt ||
    ''
  );
}

function itemYear(item: SavedItem): string {
  const raw = item.release_date || item.first_air_date || '';
  return raw ? raw.slice(0, 4) : '';
}

function ratingOf(item: SavedItem): number | null {
  const rating = Number(item.personal_rating);
  return Number.isFinite(rating) && rating > 0 ? rating : null;
}

function progressOf(item: SavedItem): HomeProgress | null {
  if (item.media_type !== 'tv') return null;
  const watched = Math.max(0, Number(item.episodes_watched ?? 0));
  const total = Math.max(0, Number(item.number_of_episodes ?? 0));
  if (total <= 0 && watched <= 0) return null;
  const percent =
    total > 0
      ? Math.max(0, Math.min(100, Math.round((watched / total) * 100)))
      : item.status === 'completed'
        ? 100
        : 0;
  return { watched, total, percent };
}

function estimateMinutes(item: SavedItem): number {
  if (Number.isFinite(item.totalWatchTimeMinutes) && (item.totalWatchTimeMinutes ?? 0) > 0) {
    return Math.round(item.totalWatchTimeMinutes as number);
  }
  if (item.media_type === 'movie') {
    return Number.isFinite(item.runtime) && (item.runtime ?? 0) > 0
      ? Math.round(item.runtime as number)
      : MOVIE_MINUTES_FALLBACK;
  }
  const episodes = Math.max(0, Number(item.episodes_watched ?? 0));
  const perEpisode =
    Array.isArray(item.episode_run_time) && item.episode_run_time.length > 0
      ? Number(item.episode_run_time[0]) || TV_MINUTES_PER_EPISODE_FALLBACK
      : TV_MINUTES_PER_EPISODE_FALLBACK;
  return episodes > 0 ? Math.round(episodes * perEpisode) : 0;
}

function compareByTimestampDesc(a: HomeEntry, b: HomeEntry): number {
  if (a.timestamp === b.timestamp) return a.title.localeCompare(b.title, 'tr');
  if (!a.timestamp) return 1;
  if (!b.timestamp) return -1;
  return a.timestamp < b.timestamp ? 1 : -1;
}

function toEntry(item: SavedItem): HomeEntry {
  return {
    key: itemKey(item),
    item,
    title: item.title || item.name || 'Başlıksız içerik',
    mediaType: item.media_type === 'tv' ? 'tv' : 'movie',
    year: itemYear(item),
    status: item.status,
    rating: ratingOf(item),
    timestamp: itemTimestamp(item),
    progress: progressOf(item),
  };
}

function computeGenreAffinity(
  items: readonly SavedItem[],
  genresMap: Readonly<Record<number, string>> | null | undefined
): HomeGenreAffinity[] {
  const scores = new Map<number, number>();
  for (const item of items) {
    if (item.status !== 'completed') continue;
    const rating = ratingOf(item);
    if (rating !== null && rating < RATING_AFFINITY_THRESHOLD) continue;
    const weight = rating !== null && rating >= 8 ? 2 : 1;
    for (const rawId of item.genre_ids || []) {
      const id = Number(rawId);
      if (!Number.isFinite(id)) continue;
      scores.set(id, (scores.get(id) ?? 0) + weight);
    }
  }
  return [...scores.entries()]
    .map(([id, score]) => ({
      id,
      name: genresMap?.[id] || `Tür #${id}`,
      score,
    }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name, 'tr'))
    .slice(0, 8);
}

/**
 * Kütüphaneden Ana Sayfa panosunu üretir. Girdi dizileri değiştirilmez.
 */
export function buildHomeDashboard(input: HomeDashboardInput): HomeDashboard {
  const limit = clampLimit(input.limit);
  const items = (input.savedItems || []).filter(Boolean) as SavedItem[];
  const entries = items.map(toEntry);

  const watching = entries.filter((entry) => entry.status === 'watching');
  const watchlist = entries.filter((entry) => entry.status === 'watchlist');
  const completed = entries.filter((entry) => entry.status === 'completed');

  const continueWatching = [...watching].sort(compareByTimestampDesc).slice(0, limit);
  const recentActivity = [...entries].sort(compareByTimestampDesc).slice(0, limit);

  const ratings = entries
    .map((entry) => entry.rating)
    .filter((rating): rating is number => rating !== null);
  const averageRating =
    ratings.length > 0
      ? Math.round((ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length) * 10) / 10
      : null;

  const savedKeys = new Set(items.map(itemKey));
  const picks = (input.forYouItems || [])
    .filter((item): item is SavedItem => Boolean(item) && !savedKeys.has(itemKey(item as SavedItem)))
    .slice(0, limit);

  const estimatedMinutes = entries.reduce((sum, entry) => sum + estimateMinutes(entry.item), 0);

  return {
    stats: {
      watching: watching.length,
      watchlist: watchlist.length,
      completed: completed.length,
      rated: ratings.length,
      averageRating,
      estimatedMinutes: Number.isFinite(estimatedMinutes) ? estimatedMinutes : 0,
    },
    continueWatching,
    recentActivity,
    picks,
    genres: computeGenreAffinity(items, input.genresMap),
    hasLibrary: items.length > 0,
  };
}
