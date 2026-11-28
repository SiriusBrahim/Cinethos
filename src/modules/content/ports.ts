/**
 * Content Manager portları.
 *
 * İçerik modülü TMDB/yerel katalog erişiminin somut sunucu adaptörüne
 * (`ContentMetadataSource`) bağımlı olmaz. Adaptör bu portu uygular; bağımlılık
 * yönü server → modules olarak kalır.
 */

import type { MediaKind } from '../../contracts/index.ts';

/** Yerel katalogdan okunan tekil içerik anlık görüntüsü. */
export interface CatalogEntrySnapshot {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly payload: Record<string, unknown>;
}

/** Metadata kaynağından dönen normalize edilmemiş zarf. */
export interface AcquiredMetadataEnvelope {
  readonly mediaKey: string;
  readonly mediaType: MediaKind;
  readonly tmdbId: number;
  readonly payload: Record<string, unknown>;
  readonly source: string;
  readonly sourceRevision?: string;
  readonly acquiredAt: string;
}

export interface AcquireMetadataParams {
  mediaKey: string;
  mediaType: MediaKind;
  tmdbId: number;
  providedPayload?: Record<string, unknown> | null;
  sourceRevision?: string | null;
}

/** İçerik modülünün metadata kaynağından beklediği en küçük yüzey. */
export interface ContentMetadataPort {
  listCatalogEntries(): Promise<CatalogEntrySnapshot[]>;
  acquireMetadata(params: AcquireMetadataParams): Promise<AcquiredMetadataEnvelope>;
}
