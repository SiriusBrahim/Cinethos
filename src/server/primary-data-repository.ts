/**
 * MIA Faz 1B — Adım 7: Sunucu PrimaryDataRepository Adaptörü.
 *
 * Mevcut `createDataStorage` (`storage.ts` + `sqlite-primary-store.ts`)
 * altyapısını `PrimaryDataRepository<DataDocument>` sözleşmesine bağlar.
 *
 * Kurallar (§5.1):
 * - SQLite ve JSON aynı anda iki "birincil" kaynak olamaz.
 * - `getHealth().driver` her zaman gerçek aktif veri kaynağını döner
 *   (SQLite istenip açılamadıysa dürüstçe `'json'` + hata detayı bildirir).
 */

import type {
  PrimaryDataRepository,
  RepositoryReadResult,
  SaveDataOptions as ContractSaveDataOptions,
  SaveDataResult as ContractSaveDataResult,
  StorageDriverId,
  StorageHealth,
  WriteProfileRef,
} from '../contracts/index.ts';
import { StaleRevisionError } from '../contracts/index.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import type { createDataStorage } from './storage.ts';

export type DataStorageHandle = ReturnType<typeof createDataStorage>;

export class ServerPrimaryDataRepository implements PrimaryDataRepository<DataDocument> {
  private readonly storage: DataStorageHandle;

  constructor(storage: DataStorageHandle) {
    this.storage = storage;
  }

  private buildHealth(docRevision?: number | null, docUpdatedAt?: string | null): StorageHealth {
    const status = this.storage.sqliteStatus();
    // Dürüst sürücü raporu (§5.1): SQLite yalnızca hem enabled hem available ise aktiftir.
    const activeDriver: StorageDriverId = status.enabled && status.available ? 'sqlite' : 'json';

    let lastError = status.lastError;
    if (status.enabled && !status.available && !lastError) {
      lastError = 'SQLite etkinleştirildi ancak kullanılamıyor; geçici JSON moduna düşüldü.';
    }
    if (this.storage.hasUnrecoverableCorruption()) {
      lastError = 'Veri dosyası bozuk ve kurtarılabilecek geçerli yedek bulunamadı.';
    }

    const revision =
      docRevision !== undefined
        ? docRevision
        : activeDriver === 'sqlite'
          ? status.revision
          : null;

    const updatedAt = docUpdatedAt !== undefined ? docUpdatedAt : status.updatedAt;

    return {
      driver: activeDriver,
      enabled: status.enabled,
      available: status.enabled
        ? status.available && !this.storage.hasUnrecoverableCorruption()
        : !this.storage.hasUnrecoverableCorruption(),
      revision: revision ?? null,
      updatedAt: updatedAt ?? null,
      lastError: lastError ?? null,
    };
  }

  async read(): Promise<RepositoryReadResult<DataDocument>> {
    const doc = await this.storage.readDataAsync();
    if (this.storage.hasUnrecoverableCorruption()) {
      return {
        document: null,
        revision: null,
        health: this.buildHealth(null, null),
      };
    }
    const hasData = (doc.profiles?.length ?? 0) > 0 || (doc.revision ?? 0) > 0;
    const rev = typeof doc.revision === 'number' ? doc.revision : 0;
    return {
      document: hasData ? doc : null,
      revision: hasData ? rev : 0,
      health: this.buildHealth(rev, doc.updatedAt ?? null),
    };
  }

  async save(
    document: DataDocument,
    options: ContractSaveDataOptions = {}
  ): Promise<ContractSaveDataResult> {
    const expected =
      options.expectedRevision !== undefined ? options.expectedRevision : null;
    const res = await this.storage.saveDataSerialized(document, {
      expectedRevision: expected,
      requirePrecondition:
        options.requirePrecondition ?? options.expectedRevision !== undefined,
    });

    if (res.ok) {
      return {
        ok: true,
        revision: res.document.revision ?? 1,
      };
    }

    const isConflict =
      res.code === 'revision_conflict' ||
      res.code === 'precondition_required' ||
      res.code === 'sudden_item_drop';

    return {
      ok: false,
      conflict: isConflict,
      revision: res.currentRevision,
      error: res.message,
    };
  }

  /**
   * Profil izolasyonlu yazım yardımcısı: `WriteProfileRef` üzerinden
   * iyimser kilitleme uygular ve çelişkide `StaleRevisionError` fırlatabilir.
   */
  async saveForProfileOrThrow(
    document: DataDocument,
    ref: WriteProfileRef,
    reason?: string
  ): Promise<number> {
    const result = await this.save(document, {
      expectedRevision: ref.revision,
      requirePrecondition: true,
      reason,
    });
    if (!result.ok) {
      if (result.conflict) {
        throw new StaleRevisionError(ref.revision, result.revision ?? null);
      }
      throw new Error(result.error || 'Birincil depoya yazılamadı.');
    }
    return result.revision ?? ref.revision + 1;
  }

  async getRevision(): Promise<number | null> {
    const doc = await this.storage.readDataAsync();
    if (this.storage.hasUnrecoverableCorruption()) return null;
    return typeof doc.revision === 'number' ? doc.revision : 0;
  }

  async getHealth(): Promise<StorageHealth> {
    const doc = await this.storage.readDataAsync();
    const rev = this.storage.hasUnrecoverableCorruption()
      ? null
      : typeof doc.revision === 'number'
        ? doc.revision
        : 0;
    return this.buildHealth(rev, doc.updatedAt ?? null);
  }
}

export function createServerPrimaryDataRepository(
  storage: DataStorageHandle
): ServerPrimaryDataRepository {
  return new ServerPrimaryDataRepository(storage);
}
