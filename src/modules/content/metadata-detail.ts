/**
 * Content Manager — metadata yeterlilik yüklemi.
 *
 * Saf fonksiyon: içerik yükünün (payload) içerik zekâsı için yeterli
 * ayrıntı taşıyıp taşımadığını belirler. Sunucu adaptörü ve içerik kuyruğu bu
 * tek kaynağı kullanır (davranış değişmedi).
 */

export function hasSufficientDetail(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload) return false;
  const hasTitle =
    (typeof payload.title === 'string' && payload.title.trim().length > 0) ||
    (typeof payload.name === 'string' && payload.name.trim().length > 0);
  const hasGenres =
    (Array.isArray(payload.genre_ids) && payload.genre_ids.length > 0) ||
    (Array.isArray(payload.genreIds) && payload.genreIds.length > 0) ||
    (Array.isArray(payload.genres) && payload.genres.length > 0);
  const hasOverview = typeof payload.overview === 'string' && payload.overview.trim().length > 0;
  const hasKeywords =
    (Array.isArray(payload.keywords) && payload.keywords.length > 0) ||
    Boolean(
      payload.keywords &&
        typeof payload.keywords === 'object' &&
        (Array.isArray((payload.keywords as Record<string, unknown>).keywords) ||
          Array.isArray((payload.keywords as Record<string, unknown>).results))
    );
  return hasTitle && hasGenres && hasOverview && hasKeywords;
}
