/**
 * Faz 3 — TMDB tür kimliği → sürümlü zevk metrik kimliği eşlemesi.
 *
 * `modules/recommendations/taste-signal.ts` içinden çekirdeğe taşındı: çekirdek
 * katman (ör. karşılaştırma raporu) modül katmanına bağımlı olmamalıdır.
 * `taste-signal` bu fonksiyonu yeniden dışa aktarır; mevcut import yolları
 * bozulmaz.
 */

import { MOVIE_GENRE_IDS, TV_GENRE_IDS } from './tmdb-mappings.ts';

const MOVIE_GENRE_TO_METRIC = new Map<number, string>(
  Object.entries(MOVIE_GENRE_IDS).map(([slug, id]) => [id, `genre.${slug}`])
);
const TV_GENRE_TO_METRIC = new Map<number, string>(
  Object.entries(TV_GENRE_IDS).map(([slug, id]) => [
    id,
    // TV'de 10765 birleşik "Sci-Fi & Fantasy" türüdür; ana metrik sci-fi'dir.
    slug === 'scifi_fantasy' ? 'genre.scifi' : `genre.${slug}`,
  ])
);

/** TMDB tür kimliğini sürümlü zevk metrik kimliğine çevirir. */
export function genreMetricIdFor(
  mediaType: string | null | undefined,
  genreId: number
): string | null {
  if (!Number.isFinite(genreId)) return null;
  return mediaType === 'tv'
    ? TV_GENRE_TO_METRIC.get(genreId) ?? null
    : MOVIE_GENRE_TO_METRIC.get(genreId) ?? null;
}
