/**
 * Seri / franchise veri sözleşmeleri (F5-04).
 *
 * Bu tipler saf veri sözleşmeleridir; hem çekirdek seed verisi
 * (`src/core/series-tv-seeds.ts`) hem istemci deposu
 * (`src/services/storage-idb.ts`) tarafından kullanılır. Depo bu tipleri
 * yeniden dışa aktarır, böylece mevcut import yolları korunur.
 */

export type SeriesValidationStatus = 'verified' | 'probable' | 'conflict' | 'manual';

export interface SeriesCollectionPart {
  id: number | string;
  media_type: 'movie' | 'tv';
  title: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  genre_ids?: number[];
  overview?: string;
  order?: number;
  wikidata_id?: string;
  validation?: SeriesValidationStatus;
}

export interface SeriesCollection {
  id: number | string;
  name: string;
  media_type: 'movie' | 'tv';
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  parts: SeriesCollectionPart[];
  partKeys: string[];
  sourceItemKey?: string;
  isStub?: boolean;
  validation?: SeriesValidationStatus;
}
