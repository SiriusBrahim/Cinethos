/**
 * `relationship-explorer` için port köprüleri (F5-04).
 *
 * Çekirdek, istemci servislerine doğrudan bağımlı değildir; kodlama ve seri
 * kataloğu erişimi `src/core/ports/` üzerinden yapılır. Bu modül, port
 * çağrılarını explorer'ın ihtiyaç duyduğu dar yüzeye indirger.
 */

import type { ItemFeatureEncoding } from './encoding.ts';
import { getItemEncodingResolver } from './ports/encoding-port.ts';
import { getSeriesCatalogPort } from './ports/series-catalog-port.ts';
import type { SeriesCollection } from './series-types.ts';

/**
 * Öğe kodlamasını port üzerinden çözer.
 * Port kayıtlı değilse sessizce yutmaz; açık hata fırlatır (davranış
 * görünür kalır, adaptör `src/services/core-adapters.ts` ile kaydedilir).
 */
export function resolveItemEncoding(item: unknown): ItemFeatureEncoding {
  const resolver = getItemEncodingResolver();
  if (!resolver) {
    throw new Error(
      'Kodlama portu kayıtlı değil: uygulama katmanı registerItemEncodingResolver() çağırmalı.'
    );
  }
  return resolver(item);
}

/** Seri koleksiyonunu port üzerinden okur (port yoksa null). */
export function resolveSeriesForMedia(mediaKey: string): SeriesCollection | null {
  return getSeriesCatalogPort()?.getSeriesForMediaSync(mediaKey) ?? null;
}

export function resolveSeriesCollectionByKey(collectionKey: string): SeriesCollection | null {
  return getSeriesCatalogPort()?.getSeriesCollectionByKeySync(collectionKey) ?? null;
}
