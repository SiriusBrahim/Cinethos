/**
 * Çekirdek seri kataloğu okuma portu (F5-04).
 *
 * `relationship-explorer` seri koleksiyonlarını istemci deposundan
 * (`src/services/storage-idb.ts`) okuyordu. Bu port ile çekirdek somut depoya
 * bağımlı olmaz; adaptör (`src/services/storage-idb.ts`) kendisini kaydeder.
 */

import type { SeriesCollection } from '../series-types.ts';

/** Çekirdeğin seri kataloğundan beklediği senkron okuma yüzeyi. */
export interface SeriesCatalogPort {
  getSeriesForMediaSync(mediaKey: string): SeriesCollection | null;
  getSeriesCollectionByKeySync(collectionKey: string): SeriesCollection | null;
}

let activePort: SeriesCatalogPort | null = null;

export function registerSeriesCatalogPort(port: SeriesCatalogPort): void {
  activePort = port;
}

export function getSeriesCatalogPort(): SeriesCatalogPort | null {
  return activePort;
}

/** Test izolasyonu: kayıtlı portu temizler. */
export function resetSeriesCatalogPortForTests(): void {
  activePort = null;
}
