/**
 * MIA Faz 1B ② — PrimaryDataRepository adaptörü (sözleşme: `src/contracts/data.ts`).
 *
 * BAĞLAMA STRATEJİSİ (davranış değişikliği yasak):
 * Mevcut `createDataStorage` (src/server/storage.ts) okuma/yazım/revision
 * çelişkisi/SQLite durumunu zaten yönetiyor. Bu adaptör o davranışı
 * `PrimaryDataRepository` sözleşmesine SARAR — depolama mantığına
 * dokunulmaz, yalnızca dış yüz standardize edilir.
 *
 * §5.1 uyumu (sessiz fallback yasağı): `getHealth()` gerçek aktif sürücüyü
 * döner — `sqliteStatus().driver` alanı seçilen DEĞİL çalışan sürücüyü
 * yansıtır; `available=false` ise çağıran bunu görebilir.
 */

import type {
  PrimaryDataRepository,
  RepositoryReadResult,
  SaveDataOptions as ContractSaveOptions,
  SaveDataResult as ContractSaveResult,
  StorageHealth,
} from '../contracts/index.ts';
import type { DataDocument } from '../core/cinethos-core.ts';
import type { createDataStorage } from './storage.ts';

/** createDataStorage'in dönüş tipi (yapısal — döngüsüz). */
export type DataStorage = ReturnType<typeof createDataStorage>;

/** Depolama katmanının hata sonucunu sözleşme sonucuna çevirir. */
function mapFailure(failure: Extract<
  Awaited<ReturnType<DataStorage['saveDataSerialized']>>,
  { ok: false }
>): ContractSaveResult {
  const conflict = failure.code === 'revision_conflict';
  return {
    ok: false,
    error: `${failure.code}: ${failure.message}`,
    conflict,
  };
}

/**
 * PrimaryDataRepository uygulaması — mevcut createDataStorage üzerine.
 *
 * Not (Faz 2): `expectedRevision` doğrudan depolama katmanına taşınır;
 * `revision_conflict` → `conflict: true` olarak işaretlenir (arıza değil,
 * beklenen red — dead-letter'a düşmez).
 */
export function createPrimaryDataRepository(storage: DataStorage): PrimaryDataRepository<DataDocument> {
  function buildHealth(): StorageHealth {
    const status = storage.sqliteStatus();
    return {
      driver: status.driver,
      enabled: status.enabled,
      available: status.available,
      revision: status.revision,
      updatedAt: status.updatedAt,
      lastError: status.lastError,
    };
  }

  return {
    async read(): Promise<RepositoryReadResult<DataDocument>> {
      // Not: mevcut okuma senkron API (readData) + async (readDataAsync)
      // sunuyor; sözleşme async olduğundan async yol kullanılır.
      const document = await storage.readDataAsync();
      const health = buildHealth();
      return {
        document,
        revision: document.revision ?? null,
        health,
      };
    },

    async save(
      document: DataDocument,
      options?: ContractSaveOptions
    ): Promise<ContractSaveResult> {
      const result = await storage.saveDataSerialized(document, {
        expectedRevision: options?.expectedRevision ?? null,
      });
      if (result.ok) {
        return {
          ok: true,
          revision: result.document.revision ?? undefined,
        };
      }
      return mapFailure(result);
    },

    async getRevision(): Promise<number | null> {
      const document = await storage.readDataAsync();
      return document.revision ?? null;
    },

    async getHealth(): Promise<StorageHealth> {
      return buildHealth();
    },
  };
}
