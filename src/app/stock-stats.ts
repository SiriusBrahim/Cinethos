/**
 * Stok havuzu sayaçları (tek kaynak).
 *
 * `App.tsx` aynı sayımı iki yerde kopyalıyordu: abonelik yolunda
 * `getStockMovies/getStockSeries` sonucundan, ilk yüklemede ise
 * `loadStockIdb()` + `isCandidateEligibleForStock` sonucundan. Her iki yol da
 * aynı üç değeri (`movieCount`, `tvCount`, `tvdbCount`) üretip `source ===
 * 'tvdb'` filtresini tekrar yazıyordu.
 *
 * Bu modül yalnızca **zaten filtrelenmiş** listeleri sayar; hangi kaydın havuza
 * uygun olduğuna karar vermez. Böylece iki yolun filtreleme davranışı
 * değişmeden sayım tek yerde tutulur ve React olmadan test edilebilir.
 */

export interface StockPoolStats {
  readonly movieCount: number;
  readonly tvCount: number;
  readonly tvdbCount: number;
}

/** `source` alanı tam olarak `tvdb` olan geçerli kayıtları sayar. */
function countTvdbEntries(entries: readonly unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if ((entry as { source?: unknown }).source === 'tvdb') count += 1;
  }
  return count;
}

/**
 * Film ve dizi listelerinden sayaçları üretir.
 *
 * Geçersiz girdi (dizi olmayan, `null`, `undefined`) boş liste sayılır; bu,
 * çağıran taraftaki savunmacı `stock.movies || []` davranışıyla aynıdır.
 */
export function summarizeStockPool(
  movies: readonly unknown[] | null | undefined,
  tv: readonly unknown[] | null | undefined
): StockPoolStats {
  const movieList = Array.isArray(movies) ? movies : [];
  const tvList = Array.isArray(tv) ? tv : [];

  return {
    movieCount: movieList.length,
    tvCount: tvList.length,
    tvdbCount: countTvdbEntries(movieList) + countTvdbEntries(tvList),
  };
}
