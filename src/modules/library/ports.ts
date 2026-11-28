/**
 * Library Manager portları.
 *
 * Modül, birincil kullanıcı verisi deposunun SOMUT sunucu adaptörüne
 * (`ServerPrimaryDataRepository`) bağımlı olmaz. Burada yalnızca ihtiyaç
 * duyduğu en küçük yüzey tanımlanır; adaptör yapısal olarak bu sözleşmeyi
 * karşılar (server → modules yönü korunur, modules → server yönü kaldırılır).
 */

import type { StorageHealth, WriteProfileRef } from '../../contracts/index.ts';
import type { DataDocument } from '../../core/cinetrack-core.ts';

/** Birincil depodan okunan ham belge zarfı (adaptörle birebir aynı biçim). */
export interface LibraryRepositoryReadResult {
  document: DataDocument;
  revision: number | null;
  health: StorageHealth;
  corrupt: boolean;
}

/** Kütüphane yazma hattının beklediği birincil depo yüzeyi. */
export interface LibraryWriteRepository {
  /** Belgeyi ve revision'ı okur. */
  readRaw(): Promise<LibraryRepositoryReadResult>;
  /** Profil doğrulamalı yazma; yazımın revision'ını döner. */
  saveForProfileOrThrow(
    document: DataDocument,
    ref: WriteProfileRef,
    reason?: string
  ): Promise<number>;
}
