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

import {
  ProfileConflictError,
  StaleRevisionError,
  type PrimaryDataRepository,
  type RepositoryReadResult,
  type SaveDataOptions as ContractSaveDataOptions,
  type SaveDataResult as ContractSaveDataResult,
  type StorageDriverId,
  type StorageHealth,
  type WriteProfileRef,
} from '../contracts/index.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import type {
  createDataStorage,
  SaveDataOptions as StorageSaveDataOptions,
  SaveDataResult as StorageSaveDataResult,
} from './storage.ts';

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

  async readRaw(): Promise<{
    document: DataDocument;
    revision: number | null;
    health: StorageHealth;
    corrupt: boolean;
  }> {
    const doc = await this.storage.readDataAsync();
    if (this.storage.hasUnrecoverableCorruption()) {
      return {
        document: doc,
        revision: null,
        health: this.buildHealth(null, null),
        corrupt: true,
      };
    }
    const rev = typeof doc.revision === 'number' ? doc.revision : 0;
    return {
      document: doc,
      revision: rev,
      health: this.buildHealth(rev, doc.updatedAt ?? null),
      corrupt: false,
    };
  }

  async read(): Promise<RepositoryReadResult<DataDocument>> {
    const raw = await this.readRaw();
    if (raw.corrupt) {
      return {
        document: null,
        revision: null,
        health: raw.health,
      };
    }
    const hasData = (raw.document.profiles?.length ?? 0) > 0 || (raw.document.revision ?? 0) > 0;
    return {
      document: hasData ? raw.document : null,
      revision: raw.revision ?? 0,
      health: raw.health,
    };
  }

  async saveRaw(
    rawPayload: unknown,
    saveOptions: StorageSaveDataOptions = {}
  ): Promise<StorageSaveDataResult> {
    const enforcePrecondition =
      saveOptions.requirePrecondition ?? !saveOptions.forceOverwrite;
    return this.storage.saveDataSerialized(rawPayload, {
      ...saveOptions,
      requirePrecondition: enforcePrecondition,
    });
  }

  async save(
    document: DataDocument,
    options: ContractSaveDataOptions = {}
  ): Promise<ContractSaveDataResult> {
    const expected =
      options.expectedRevision !== undefined ? options.expectedRevision : null;
    const res = await this.saveRaw(document, {
      expectedRevision: expected,
      requirePrecondition: options.requirePrecondition ?? true,
    });

    if (res.ok) {
      return {
        ok: true,
        revision: res.document.revision ?? 1,
      };
    }

    const isConflict =
      res.code === 'revision_conflict' ||
      res.code === 'profile_conflict' ||
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
   * profil ve iyimser kilitleme doğrular; çelişkide `ProfileConflictError`
   * veya `StaleRevisionError` fırlatır.
   */
  async saveForProfileOrThrow(
    document: DataDocument,
    ref: WriteProfileRef,
    reason?: string
  ): Promise<number> {
    const expectedProfileId = typeof ref?.profileId === 'string' ? ref.profileId.trim() : '';
    if (!expectedProfileId || document.activeProfileId !== expectedProfileId) {
      throw new ProfileConflictError('profile-switched', {
        expectedRevision: ref.revision,
        message: `Profil uyuşmazlığı: yazma '${expectedProfileId || 'bilinmiyor'}' profili için istendi, belge '${document.activeProfileId || 'bilinmiyor'}' profiline ait.`,
      });
    }
    const res = await this.saveRaw(document, {
      expectedRevision: ref.revision,
      expectedProfileId,
      strictProfileMatch: true,
      requirePrecondition: true,
      ...(reason ? {} : {}),
    });
    if (!res.ok) {
      if (res.code === 'profile_conflict') {
        throw new ProfileConflictError('profile-switched', {
          expectedRevision: ref.revision,
          actualRevision: res.currentRevision,
          message: res.message,
        });
      }
      if (
        res.code === 'revision_conflict' ||
        res.code === 'precondition_required' ||
        res.code === 'sudden_item_drop'
      ) {
        throw new StaleRevisionError(ref.revision, res.currentRevision ?? null);
      }
      throw new Error(res.message || 'Birincil depoya yazılamadı.');
    }
    return res.document.revision ?? ref.revision + 1;
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
