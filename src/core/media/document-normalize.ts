/**
 * Belge doğrulama ve normalizasyon (F5-05).
 *
 * Omurgası saf fonksiyonlardır: bozuk/eksik veri kurtarma, alan allowlist'i,
 * tombstone temizliği, yedek ayrıştırma ve profil normalizasyonu. Davranış
 * birebir korunmuştur (bkz. tests/core.test.mjs, phase1-* testleri).
 */

import { backfillInteractionDates } from '../item-dates.ts';
import { canonicalizeMediaKeyList, makeMediaKey, parseMediaKey } from '../keys.ts';
import {
  normalizeCinemaKunyeActorList,
} from '../cinema-kunye.ts';
import { normalizeProfileId } from '../profile-id.ts';
import {
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
} from '../limits.ts';
import {
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  REMINDER_WINDOW_DAYS,
  TOMBSTONE_RETENTION_DAYS,
  type DataDocument,
  type FavoriteActorInfo,
  type NextEpisode,
  type Preferences,
  type Profile,
  type SavedItem,
} from './document-types.ts';


export * from './document-types.ts';

export function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeFavoriteActor(raw: any): FavoriteActorInfo | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = Number(raw.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const name = String(raw.name || '').trim();
  if (!name) return null;
  return {
    id,
    name: name.slice(0, 100),
    profile_path: typeof raw.profile_path === 'string' ? raw.profile_path : null,
    character: typeof raw.character === 'string' ? raw.character.slice(0, 100) : undefined,
  };
}

export function normalizeFavoriteActors(raw: any, maxActors = 100): FavoriteActorInfo[] {
  if (!Array.isArray(raw)) return [];
  const list: FavoriteActorInfo[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    if (list.length >= maxActors) break;
    const actor = normalizeFavoriteActor(item);
    if (!actor || seen.has(actor.id)) continue;
    seen.add(actor.id);
    list.push(actor);
  }
  return list;
}

export function validItemId(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  return (
    typeof value === 'string' &&
    (/^[1-9]\d{0,11}$/.test(value) || /^custom-[A-Za-z0-9_-]{1,80}$/.test(value))
  );
}

export function escapeHTML(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] || char
  );
}

export function safeHttpsUrl(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' ? parsed.href : '';
  } catch {
    return '';
  }
}

export function isValidCalendarDate(airDate: string): boolean {
  const parsed = new Date(`${airDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;
  return (
    `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(
      parsed.getDate()
    ).padStart(2, '0')}` === airDate
  );
}

export function sanitizeNextEpisode(value: any): NextEpisode | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const airDate =
    typeof value.air_date === 'string' && isValidCalendarDate(value.air_date) ? value.air_date : '';
  if (!airDate) return null;
  const integerAtLeastZero = (input: any) => {
    const numeric = Number(input);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.min(10000, Math.floor(numeric)) : 0;
  };
  return {
    air_date: airDate,
    episode_number: integerAtLeastZero(value.episode_number),
    season_number: integerAtLeastZero(value.season_number),
  };
}

export function sanitizeSeasonMap(
  value: any,
  { maxSeason = 300, maxValue = 10000, allowZero = true } = {}
): Record<number, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output: Record<number, number> = {};
  for (const [key, rawCount] of Object.entries(value)) {
    const season = Number(key);
    if (!Number.isSafeInteger(season) || season < 1 || season > maxSeason) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0 || (!allowZero && count < 1)) continue;
    output[season] = Math.min(maxValue, Math.floor(count));
  }
  return output;
}

export function sanitizeSeasonProgress(value: any): Record<number, number> {
  return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true }) || {};
}

/** Sezon → izlenmiş bölüm numaraları (sırasız izleme) haritasını güvenli biçimde normalize eder. */
export function sanitizeSeasonWatchedMarks(value: any): Record<number, number[]> {
  const out: Record<number, number[]> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawSeason, rawEpisodes] of Object.entries(value as Record<string, any>)) {
    const season = Number(rawSeason);
    if (!Number.isSafeInteger(season) || season < 1 || season > 300) continue;
    if (!Array.isArray(rawEpisodes)) continue;
    const episodes = Array.from(
      new Set(
        rawEpisodes
          .map((ep) => Number(ep))
          .filter((ep) => Number.isSafeInteger(ep) && ep >= 1 && ep <= 10000)
      )
    ).sort((a, b) => a - b);
    if (episodes.length > 0) out[season] = episodes;
  }
  return out;
}

/** Sezon → ISO damga haritasını güvenli biçimde normalize eder. */
export function sanitizeSeasonProgressTimestamps(value: any): Record<number, string> {
  const out: Record<number, string> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawSeason, rawIso] of Object.entries(value as Record<string, any>)) {
    const season = Number(rawSeason);
    if (!Number.isSafeInteger(season) || season < 1 || season > 300) continue;
    if (typeof rawIso !== 'string' || !rawIso.trim()) continue;
    if (!Number.isFinite(Date.parse(rawIso))) continue;
    out[season] = rawIso.trim();
  }
  return out;
}

export type SeasonWatchedMarks = Record<number, number[]>;
export type SeasonProgressTimestamps = Record<number, string>;

export function sanitizeSeasonCounts(value: any): Record<number, number> {
  return sanitizeSeasonMap(value, { maxSeason: 300, maxValue: 10000, allowZero: true }) || {};
}

export function buildSeasonCounts(details: any): Record<number, number> {
  const seasons = Array.isArray(details?.seasons) ? details.seasons : [];
  const counts: Record<number, number> = {};
  for (const season of seasons) {
    const number = Number(season?.season_number);
    if (!Number.isSafeInteger(number) || number < 1 || number > 300) continue;
    const count = Number(season?.episode_count);
    counts[number] = Number.isSafeInteger(count) && count > 0 ? Math.min(count, 10000) : 0;
  }
  return counts;
}

export function defaultCurrentSeason(
  progress: Record<number, number> = {},
  counts: Record<number, number> = {}
): number {
  const seasons = [
    ...new Set([
      ...Object.keys(progress || {}).map(Number),
      ...Object.keys(counts || {}).map(Number),
    ]),
  ]
    .filter((season) => Number.isSafeInteger(season) && season >= 1)
    .sort((a, b) => a - b);
  if (!seasons.length) return 1;
  const watched = (season: number) => (progress || {})[season] || 0;
  const totalOf = (season: number) => {
    const value = Number((counts || {})[season]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  const partiallyWatched = seasons.find((season) => {
    const total = totalOf(season);
    return total !== null && watched(season) > 0 && watched(season) < total;
  });
  if (partiallyWatched) return partiallyWatched;
  const queuedZero = [...seasons]
    .reverse()
    .find(
      (season) =>
        watched(season) === 0 &&
        seasons.some((previous) => previous < season && watched(previous) > 0)
    );
  if (queuedZero) return queuedZero;
  const started = [...seasons].reverse().find((season) => watched(season) > 0);
  return started || seasons[0];
}

export function normalizeSavedItem(item: any): SavedItem | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (!validItemId(item.id) || !['movie', 'tv'].includes(item.media_type)) return null;
  const rating = Number(item.personal_rating);
  const validRating = Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : 0;
  const numeric = (value: any, min: number, max: number) =>
    Number.isFinite(Number(value)) ? Math.min(max, Math.max(min, Math.floor(Number(value)))) : 0;
  let seasonProgress = sanitizeSeasonProgress(item.season_progress);
  if (!Object.keys(seasonProgress).length) {
    const legacySeason = numeric(item.current_season, 0, 300) || 1;
    const legacyWatched = numeric(item.episodes_watched, 0, 10000);
    seasonProgress = legacyWatched > 0 ? { [legacySeason]: legacyWatched } : {};
  }
  const totalWatched = Object.values(seasonProgress).reduce((sum, count) => sum + count, 0);
  const seasonCounts = sanitizeSeasonCounts(item.season_episode_counts);
  const watchedEpisodes = sanitizeSeasonWatchedMarks(item.watched_episodes);
  const progressUpdatedAt = sanitizeSeasonProgressTimestamps(item.progress_updated_at);
  const normalizedStatus: SavedItem['status'] = ['watching', 'watchlist', 'completed'].includes(
    item.status
  )
    ? item.status
    : 'watchlist';
  const normalizedRatedAt =
    validRating > 0 && typeof item.ratedAt === 'string' && item.ratedAt.trim()
      ? item.ratedAt.trim()
      : undefined;
  const normalizedCompletedAt =
    normalizedStatus === 'completed' &&
    typeof item.completedAt === 'string' &&
    item.completedAt.trim()
      ? item.completedAt.trim()
      : undefined;
  const normalizedWatchedAt =
    typeof item.watchedAt === 'string' && item.watchedAt.trim() && Number.isFinite(Date.parse(item.watchedAt))
      ? item.watchedAt.trim()
      : undefined;
  const normalizedStatusChangedAt =
    typeof item.status_changed_at === 'string' &&
    item.status_changed_at.trim() &&
    Number.isFinite(Date.parse(item.status_changed_at))
      ? item.status_changed_at.trim()
      : undefined;
  const normalizedRatingChangedAt =
    typeof item.rating_changed_at === 'string' &&
    item.rating_changed_at.trim() &&
    Number.isFinite(Date.parse(item.rating_changed_at))
      ? item.rating_changed_at.trim()
      : undefined;
  const normalizedCast = Array.isArray(item.cast)
    ? normalizeCinemaKunyeActorList(item.cast, 12)
    : [];
  const normalizedCrew: NonNullable<SavedItem['crew']> = Array.isArray(item.crew)
    ? item.crew
        .filter((c: any) => c && typeof c.name === 'string' && c.name.trim())
        .slice(0, 10)
        .map((c: any) => ({
          id: Number.isSafeInteger(Number(c.id)) && Number(c.id) > 0 ? Number(c.id) : 0,
          name: String(c.name).trim().slice(0, 120),
          job: typeof c.job === 'string' && c.job.trim() ? c.job.trim().slice(0, 80) : 'Crew',
          ...(typeof c.department === 'string' && c.department.trim()
            ? { department: c.department.trim().slice(0, 80) }
            : {}),
        }))
    : [];

  return {
    id: typeof item.id === 'string' && /^\d+$/.test(item.id) ? Number(item.id) : item.id,
    media_type: item.media_type,
    title: String(item.title || item.name || 'Başlıksız içerik').slice(0, 160),
    release_date:
      typeof (item.release_date || item.releaseDate) === 'string'
        ? (item.release_date || item.releaseDate).slice(0, 10)
        : '',
    first_air_date: typeof item.first_air_date === 'string' ? item.first_air_date.slice(0, 10) : '',
    last_air_date: typeof item.last_air_date === 'string' ? item.last_air_date.slice(0, 10) : '',
    vote_average: Number(item.vote_average ?? (Number.parseFloat(item.rating) || 0)) || 0,
    vote_count: Number(item.vote_count) || 0,
    popularity: Number(item.popularity) || 0,
    poster_url: safeHttpsUrl(item.poster_url || item.poster),
    poster_path: typeof item.poster_path === 'string' ? item.poster_path : '',
    backdrop_path: typeof item.backdrop_path === 'string' ? item.backdrop_path : '',
    overview: typeof item.overview === 'string' ? item.overview.slice(0, 5000) : '',
    genre_ids:
      Array.isArray(item.genre_ids) && item.genre_ids.length
        ? item.genre_ids
            .filter((id: any) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
            .map(Number)
        : Array.isArray(item.genres)
        ? item.genres
            .map((g: any) => (typeof g === 'object' && g ? g.id : g))
            .filter((id: any) => Number.isSafeInteger(Number(id)) && Number(id) > 0)
            .map(Number)
        : [],
    genres: Array.isArray(item.genres)
      ? item.genres
          .map((genre: any) => (typeof genre === 'string' ? genre : genre?.name))
          .filter((name: any) => typeof name === 'string')
          .slice(0, 12)
      : [],
    runtime: Number(item.runtime) || 0,
    episode_run_time: Array.isArray(item.episode_run_time)
      ? item.episode_run_time.filter((value: any) => Number.isFinite(Number(value))).map(Number).slice(0, 5)
      : [],
    number_of_seasons: numeric(item.number_of_seasons, 0, 300),
    number_of_episodes: numeric(item.number_of_episodes, 0, 10000),
    season_progress: seasonProgress,
    season_episode_counts: seasonCounts,
    ...(Object.keys(watchedEpisodes).length > 0 ? { watched_episodes: watchedEpisodes } : {}),
    ...(Object.keys(progressUpdatedAt).length > 0
      ? { progress_updated_at: progressUpdatedAt }
      : {}),
    next_episode_to_air: sanitizeNextEpisode(item.next_episode_to_air),
    current_season: numeric(item.current_season, 0, 300) || defaultCurrentSeason(seasonProgress, seasonCounts),
    episodes_watched: totalWatched,
    next_episode: numeric(item.next_episode, 0, 10000),
    status: normalizedStatus,
    personal_rating: validRating || '',
    personal_rating_cleared: validRating ? false : item.personal_rating_cleared === true,
    ...(normalizedStatusChangedAt ? { status_changed_at: normalizedStatusChangedAt } : {}),
    ...(normalizedRatingChangedAt ? { rating_changed_at: normalizedRatingChangedAt } : {}),
    ...(normalizedRatedAt ? { ratedAt: normalizedRatedAt } : {}),
    ...(normalizedWatchedAt ? { watchedAt: normalizedWatchedAt } : {}),
    ...(normalizedCompletedAt ? { completedAt: normalizedCompletedAt } : {}),
    addedAt: typeof item.addedAt === 'string' ? item.addedAt : '',
    firstAddedAt:
      typeof item.firstAddedAt === 'string'
        ? item.firstAddedAt
        : typeof item.addedAt === 'string'
        ? item.addedAt
        : '',
    totalWatchTimeMinutes:
      Number.isFinite(Number(item.totalWatchTimeMinutes)) && Number(item.totalWatchTimeMinutes) >= 0
        ? Math.floor(Number(item.totalWatchTimeMinutes))
        : undefined,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    custom: Boolean(item.custom || String(item.id).startsWith('custom-')),
    ...(normalizedCast.length > 0 ? { cast: normalizedCast } : {}),
    ...(normalizedCrew.length > 0 ? { crew: normalizedCrew } : {}),
    isDemo: item.isDemo === true,
  };
}

/**
 * Robust item lookup in the user's saved list.
 * Matches by ID and media_type, avoiding cross-matching between movies and tv shows with the same numeric ID.
 */
export function findSavedItem(
  savedItems: SavedItem[] | undefined | null,
  item: any
): SavedItem | undefined {
  if (!Array.isArray(savedItems) || !item || item.id == null) return undefined;
  const targetId = String(item.id);
  const targetType =
    item.media_type || (item.title ? 'movie' : (item.name ? 'tv' : undefined));

  // 1. Exact match by ID and media_type if type is known
  if (targetType) {
    const exact = savedItems.find(
      (entry) => String(entry.id) === targetId && entry.media_type === targetType
    );
    if (exact) return exact;
  }

  // 2. Fallback: match by ID alone ONLY when targetType was not specified at all
  if (!targetType) {
    const byId = savedItems.filter((entry) => String(entry.id) === targetId);
    if (byId.length > 0) return byId[0];
  }

  // 3. Fallback: match by title/name if available, respecting media_type if specified
  const rawTitle = (item.title || item.name || '').trim().toLowerCase();
  if (rawTitle) {
    const byTitle = savedItems.filter(
      (entry) =>
        (entry.title || '').trim().toLowerCase() === rawTitle &&
        (!targetType || entry.media_type === targetType)
    );
    if (byTitle.length > 0) {
      return byTitle[0];
    }
  }

  return undefined;
}

/**
 * Checks if an item is already in the user's saved list using standardized makeMediaKey.
 */
export function isItemSaved(
  savedItems: SavedItem[] | undefined | null,
  item: any,
  defaultType?: string
): boolean {
  if (!Array.isArray(savedItems) || !item || item.id == null) return false;
  const itemType = defaultType || item.media_type || (item.title ? 'movie' : (item.name ? 'tv' : 'movie'));
  const itemKey = makeMediaKey(itemType, item.id);
  if (savedItems.some((s) => makeMediaKey(s) === itemKey)) return true;
  const found = findSavedItem(savedItems, { ...item, media_type: itemType });
  return found != null;
}

export function filterHistoryByType(
  savedItems: SavedItem[] | undefined | null,
  mediaType: string = 'all'
): SavedItem[] {
  if (!Array.isArray(savedItems)) return [];
  if (mediaType !== 'movie' && mediaType !== 'tv') return [...savedItems];
  return savedItems.filter((item) => item.media_type === mediaType);
}

export function filterDislikedByType(
  dislikedKeys: string[] | undefined | null,
  mediaType: string = 'all'
): string[] {
  if (!Array.isArray(dislikedKeys)) return [];
  const canonical = canonicalizeMediaKeyList(dislikedKeys);
  if (mediaType !== 'movie' && mediaType !== 'tv') return canonical;
  return canonical.filter((key) => key.startsWith(`${mediaType}:`));
}

export function dedupeItems(items: SavedItem[]): SavedItem[] {
  const unique = new Map<string, SavedItem>();
  for (const item of items) {
    const key = makeMediaKey(item);
    const existing = unique.get(key);
    if (!existing) {
      unique.set(key, item);
      continue;
    }
    const existingTime = existing.updatedAt || existing.addedAt || '';
    const incomingTime = item.updatedAt || item.addedAt || '';
    const newest = incomingTime > existingTime ? item : existing;
    const older = newest === item ? existing : item;

    let rating = newest.personal_rating;
    let ratingCleared = newest.personal_rating_cleared === true;
    if (!rating && !ratingCleared && older.personal_rating !== '' && Number(older.personal_rating) > 0) {
      rating = older.personal_rating;
    }
    if (rating) ratingCleared = false;
    const isDemo = newest.isDemo === true && older.isDemo === true;
    const mergedRatedAt = ratingCleared ? undefined : newest.ratedAt || older.ratedAt;
    const mergedCompletedAt =
      newest.status === 'completed' ? newest.completedAt || older.completedAt : undefined;
    const mergedGenreIds = Array.from(
      new Set<number>([...(older.genre_ids || []), ...(newest.genre_ids || [])])
    );
    const mergedCast = [...(newest.cast || []), ...(older.cast || [])];
    const mergedCrew = [...(newest.crew || []), ...(older.crew || [])];
    const normalized = normalizeSavedItem({
      ...older,
      ...newest,
      genre_ids: mergedGenreIds,
      ...(mergedCast.length > 0 ? { cast: mergedCast } : {}),
      ...(mergedCrew.length > 0 ? { crew: mergedCrew } : {}),
      isDemo,
      status: newest.status,
      personal_rating: rating || '',
      personal_rating_cleared: ratingCleared,
      ...(mergedRatedAt ? { ratedAt: mergedRatedAt } : {}),
      ...(mergedCompletedAt ? { completedAt: mergedCompletedAt } : {}),
      season_progress: { ...older.season_progress, ...newest.season_progress },
      season_episode_counts: { ...older.season_episode_counts, ...newest.season_episode_counts },
      watched_episodes: { ...(older.watched_episodes || {}), ...(newest.watched_episodes || {}) },
      progress_updated_at: {
        ...(older.progress_updated_at || {}),
        ...(newest.progress_updated_at || {}),
      },
      next_episode_to_air:
        sanitizeNextEpisode(newest.next_episode_to_air) || sanitizeNextEpisode(older.next_episode_to_air),
      addedAt: [existing.addedAt, item.addedAt].filter(Boolean).sort()[0] || '',
      updatedAt: newest.updatedAt || newest.addedAt || '',
    });
    if (normalized) {
      unique.set(key, normalized);
    }
  }
  return [...unique.values()];
}

export const DISLIKED_KEY_PATTERN = /^(?:movie|tv)[:-](?:[1-9]\d{0,11}|custom-[A-Za-z0-9_-]{1,80})$/;

export function normalizePreferences(
  raw: any,
  { knownMoods = null }: { knownMoods?: string[] | null } = {}
): Preferences {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    disliked: Array.isArray(source.disliked)
      ? source.disliked
          .filter((key: any) => typeof key === 'string' && DISLIKED_KEY_PATTERN.test(key))
          .map((key: string) => {
            const parsed = parseMediaKey(key);
            return parsed ? makeMediaKey(parsed.type, parsed.id) : key;
          })
          .slice(-500)
      : [],
    ...(Array.isArray(source.hidden)
      ? {
          hidden: source.hidden
            .filter((key: any) => typeof key === 'string' && DISLIKED_KEY_PATTERN.test(key))
            .map((key: string) => {
              const parsed = parseMediaKey(key);
              return parsed ? makeMediaKey(parsed.type, parsed.id) : key;
            })
            .slice(-500),
        }
      : {}),
    providers: Array.isArray(source.providers)
      ? source.providers
          .filter(
            (id: any) =>
              (typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id <= 999_999) ||
              (typeof id === 'string' && /^\d{1,6}$/.test(id))
          )
          .map(String)
          .slice(-20)
      : [],
    mood:
      typeof source.mood === 'string'
        ? knownMoods
          ? knownMoods.includes(source.mood)
            ? source.mood
            : ''
          : source.mood.slice(0, 20)
        : '',
    reminders: source.reminders === true,
    notified: Array.isArray(source.notified)
      ? source.notified.filter((key: any) => typeof key === 'string' && key.length <= 200).slice(-200)
      : [],
  };
}

export function normalizeDeletedKeys(
  raw: unknown,
  options: { nowMs?: number; maxEntries?: number; retentionDays?: number } = {}
): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const nowMs = options.nowMs ?? Date.now();
  const maxEntries = options.maxEntries ?? 2000;
  const retentionMs = (options.retentionDays ?? TOMBSTONE_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - retentionMs;

  const validEntries: Array<[string, string]> = [];
  for (const [rawKey, rawTs] of Object.entries(raw as Record<string, unknown>)) {
    const parsedKey = parseMediaKey(rawKey);
    if (!parsedKey) continue;
    const canonical = `${parsedKey.type}:${parsedKey.id}`;
    if (!DISLIKED_KEY_PATTERN.test(canonical)) continue;
    if (typeof rawTs !== 'string' || !rawTs.trim()) continue;
    const tsMs = Date.parse(rawTs);
    if (!Number.isFinite(tsMs) || tsMs < cutoffMs) continue;
    const iso = new Date(tsMs).toISOString();
    validEntries.push([canonical, iso]);
  }

  validEntries.sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  const out: Record<string, string> = {};
  for (const [k, ts] of validEntries.slice(-maxEntries)) {
    if (!out[k] || ts > out[k]) {
      out[k] = ts;
    }
  }
  return out;
}

export function normalizeProfile(
  raw: any,
  { maxItems = DEFAULT_MAX_ITEMS_PER_PROFILE, knownMoods = null }: { maxItems?: number; knownMoods?: string[] | null } = {}
): Profile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const canonicalId = normalizeProfileId(raw.id);
  if (!canonicalId) return null;
  const items = Array.isArray(raw.items)
    ? (raw.items.map(normalizeSavedItem).filter(Boolean) as SavedItem[])
    : [];
  const deduped = dedupeItems(items).slice(0, maxItems);
  const liveKeys = new Set(deduped.map((it) => makeMediaKey(it)));
  const normalizedTombstones = normalizeDeletedKeys(raw.deleted_keys);
  for (const key of Object.keys(normalizedTombstones)) {
    if (liveKeys.has(key)) {
      delete normalizedTombstones[key];
    }
  }
  return {
    id: canonicalId,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : 'Profilim',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt.slice(0, 40) : '',
    preferences: normalizePreferences(raw.preferences, { knownMoods }),
    items: deduped,
    favoriteActors: normalizeFavoriteActors(raw.favoriteActors),
    ...(Object.keys(normalizedTombstones).length > 0 ? { deleted_keys: normalizedTombstones } : {}),
    isDemo: raw.isDemo === true,
  };
}

/**
 * Aşama 1 (B-04) — Sessiz kırpmayı önleyen limit denetimi.
 *
 * `normalizeDataDocument` limit aşımında profil/kayıt düşürür; bu fonksiyon
 * düşürmeden **önce** ihlalleri listeler. Boş dizi = ihlal yok.
 */
export function collectDataLimitViolations(
  raw: unknown,
  options: { maxProfiles?: number; maxItems?: number } = {}
): string[] {
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const violations: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return violations;
  const obj = raw as Record<string, any>;

  const candidates: any[] = Array.isArray(obj.profiles)
    ? obj.profiles
    : Array.isArray(obj.items)
    ? [{ id: obj.profileId ?? 'PROFILE-DEFAULT', name: obj.profileName, items: obj.items }]
    : [];

  const validIds = new Set<string>();
  for (const [index, candidate] of candidates.entries()) {
    if (!isPlainRecord(candidate)) {
      violations.push(`${index + 1}. profil nesne değil`);
      continue;
    }
    const canonicalId = normalizeProfileId(candidate.id);
    if (!canonicalId) {
      violations.push(`geçersiz profil kimliği: '${String(candidate.id ?? '')}' (profil sessizce düşürülmez)`);
      continue;
    }
    validIds.add(canonicalId);
    const rawItems = candidate.items;
    if (rawItems !== undefined && !Array.isArray(rawItems)) {
      violations.push(`'${canonicalId}' profilinin kayıtları dizi değil`);
      continue;
    }
    const itemCount = Array.isArray(rawItems) ? rawItems.length : 0;
    if (itemCount > maxItems) {
      violations.push(
        `'${canonicalId}' profili ${itemCount} kayıt içeriyor (izin verilen en fazla ${maxItems})`
      );
    }
  }

  if (validIds.size > maxProfiles) {
    violations.push(
      `belge ${validIds.size} profil içeriyor (izin verilen en fazla ${maxProfiles})`
    );
  }
  return violations;
}

export function normalizeDataDocument(
  raw: any,
  {
    maxProfiles = DEFAULT_MAX_PROFILES,
    maxItems = DEFAULT_MAX_ITEMS_PER_PROFILE,
  }: { maxProfiles?: number; maxItems?: number } = {}
): DataDocument | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  let candidates: any[];
  let activeCandidate = '';
  if (Array.isArray(raw.profiles)) {
    candidates = raw.profiles;
    activeCandidate = normalizeProfileId(raw.activeProfileId) ?? '';
  } else if (Array.isArray(raw.items)) {
    candidates = [
      {
        id: normalizeProfileId(raw.profileId) ?? 'PROFILE-DEFAULT',
        name: typeof raw.profileName === 'string' ? raw.profileName : 'Profilim',
        createdAt: '',
        preferences: raw.preferences,
        items: raw.items,
        favoriteActors: raw.favoriteActors,
        isDemo: raw.isDemo === true,
      },
    ];
    activeCandidate = candidates[0].id;
  } else {
    return null;
  }
  const profiles: Profile[] = [];
  const byCanonicalId = new Map<string, Profile>();
  for (const candidate of candidates) {
    const profile = normalizeProfile(candidate, { maxItems });
    if (!profile) continue;
    // Faz 3 migration: eski kayıtları yeni etkileşim alanlarıyla (watchedAt/
    // firstAddedAt) güvenli ve idempotent biçimde zenginleştir. Var olan değerler
    // korunur; `updatedAt` izlenme tarihi olarak kullanılmaz.
    if (Array.isArray(profile.items) && profile.items.length > 0) {
      profile.items = backfillInteractionDates(profile.items).items;
    }
    const existing = byCanonicalId.get(profile.id);
    if (existing) {
      existing.items = dedupeItems([...existing.items, ...profile.items]).slice(0, maxItems);
      existing.favoriteActors = normalizeFavoriteActors([
        ...(existing.favoriteActors || []),
        ...(profile.favoriteActors || []),
      ]);
      existing.preferences = normalizePreferences({
        ...existing.preferences,
        disliked: [...(existing.preferences.disliked || []), ...(profile.preferences.disliked || [])],
        hidden: [...(existing.preferences.hidden || []), ...(profile.preferences.hidden || [])],
        providers: [...(existing.preferences.providers || []), ...(profile.preferences.providers || [])],
        mood: existing.preferences.mood || profile.preferences.mood,
        reminders: existing.preferences.reminders || profile.preferences.reminders,
        notified: [...(existing.preferences.notified || []), ...(profile.preferences.notified || [])],
      });
      const mergedDeleted = normalizeDeletedKeys({
        ...(existing.deleted_keys || {}),
        ...(profile.deleted_keys || {}),
      });
      if (Object.keys(mergedDeleted).length) existing.deleted_keys = mergedDeleted;
      existing.isDemo = existing.isDemo && profile.isDemo;
      continue;
    }
    if (profiles.length >= maxProfiles) break;
    byCanonicalId.set(profile.id, profile);
    profiles.push(profile);
  }
  if (!profiles.length) return null;
  const rawRev = Number(raw.revision);
  const rawSchemaVer = Number(raw.schemaVersion || raw.version);
  const schemaVersion =
    Number.isSafeInteger(rawSchemaVer) && rawSchemaVer > 0 ? rawSchemaVer : CURRENT_SCHEMA_VERSION;
  return {
    version: 3,
    schemaVersion,
    engineVersion: ENGINE_VERSION,
    activeProfileId: byCanonicalId.has(normalizeProfileId(activeCandidate) ?? '') ? (normalizeProfileId(activeCandidate) ?? profiles[0].id) : profiles[0].id,
    profiles,
    revision: Number.isSafeInteger(rawRev) && rawRev > 0 ? rawRev : 1,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export function resolveAirDate(item: SavedItem | any): string {
  if (!item || typeof item !== 'object') return '';
  if (item.media_type === 'tv') {
    const next = item.next_episode_to_air;
    if (next?.air_date) return next.air_date;
    return typeof item.first_air_date === 'string' ? item.first_air_date : '';
  }
  return typeof item.release_date === 'string' ? item.release_date : '';
}

export function reminderDaysUntil(airDate: string, today: Date = new Date()): number | null {
  if (typeof airDate !== 'string' || !isValidCalendarDate(airDate)) return null;
  const release = new Date(`${airDate}T00:00:00`);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.ceil((release.getTime() - startOfToday.getTime()) / 86_400_000);
  return days >= 0 && days <= REMINDER_WINDOW_DAYS ? days : null;
}

export function createRequestGate() {
  let current = 0;
  let controller: AbortController | null = null;
  return {
    begin() {
      current += 1;
      controller?.abort();
      controller = new AbortController();
      return { id: current, signal: controller.signal };
    },
    isCurrent(id: number) {
      return id === current;
    },
    invalidate() {
      current += 1;
      controller?.abort();
      controller = null;
    },
  };
}
