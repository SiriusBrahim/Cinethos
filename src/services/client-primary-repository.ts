/**
 * MIA Faz 1B — Adım 7 & Adım 11: İstemci PrimaryDataRepository Adaptörü.
 *
 * Tarayıcı katmanında (`/api/data` HTTP uçları + `lastKnownServerRevision`)
 * `PrimaryDataRepository<DataDocument>` sözleşmesini uygular. Böylece
 * `OfflineQueue` ve istemci senkron akışı sunucudan bağımsız ortak depo
 * sözleşmesiyle konuşabilir.
 */

import type {
  PrimaryDataRepository,
  RepositoryReadResult,
  SaveDataOptions,
  SaveDataResult,
  StorageDriverId,
  StorageHealth,
} from '../contracts/index.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import { apiFetch } from './api-client.ts';
import {
  fetchServerData,
  getLastKnownServerRevision,
  pushServerDataDetailed,
  type PushServerDataResult,
} from './api.ts';

export interface HttpSaveDataOptions extends SaveDataOptions {
  expectedProfileId?: string;
  confirmBulkDelete?: boolean;
  forceOverwrite?: boolean;
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile?: boolean;
}

export class HttpPrimaryDataRepository implements PrimaryDataRepository<DataDocument> {
  async read(): Promise<RepositoryReadResult<DataDocument>> {
    const doc = await fetchServerData();
    const rev =
      typeof doc?.revision === 'number' ? doc.revision : getLastKnownServerRevision();
    return {
      document: doc,
      revision: rev ?? null,
      health: await this.getHealthFromDoc(doc, rev ?? null),
    };
  }

  async saveDetailed(
    document: DataDocument,
    options: HttpSaveDataOptions = {}
  ): Promise<PushServerDataResult> {
    const baseRevision =
      options.expectedRevision !== undefined
        ? options.expectedRevision
        : getLastKnownServerRevision();

    return pushServerDataDetailed(document, {
      baseRevision: options.forceOverwrite ? null : baseRevision,
      expectedProfileId: options.expectedProfileId,
      confirmBulkDelete: options.confirmBulkDelete,
      forceOverwrite: options.forceOverwrite,
      mergeStrategy: options.mergeStrategy,
      foldUnhydratedDefaultProfile: options.foldUnhydratedDefaultProfile,
    });
  }

  async save(
    document: DataDocument,
    options: HttpSaveDataOptions = {}
  ): Promise<SaveDataResult> {
    const res = await this.saveDetailed(document, {
      ...options,
      mergeStrategy: options.mergeStrategy ?? 'lossless',
    });

    if (res.ok) {
      return {
        ok: true,
        revision: res.revision ?? res.document?.revision,
      };
    }

    if (res.conflict) {
      return {
        ok: false,
        conflict: true,
        revision: res.conflict.currentRevision,
        error: res.conflict.message,
      };
    }

    return {
      ok: false,
      conflict: false,
      error: res.errorMessage || `Sunucu kaydı başarısız (HTTP ${res.status}).`,
    };
  }

  async getRevision(): Promise<number | null> {
    const cached = getLastKnownServerRevision();
    if (cached !== null) return cached;
    const doc = await fetchServerData();
    return typeof doc?.revision === 'number' ? doc.revision : null;
  }

  async getHealth(): Promise<StorageHealth> {
    if (typeof fetch === 'function') {
      try {
        const res = await apiFetch('/api/health', { cache: 'no-store' });
        if (res.ok) {
          const json = (await res.json()) as {
            storage?: Partial<StorageHealth>;
          };
          if (json?.storage) {
            const driver: StorageDriverId =
              json.storage.driver === 'sqlite' ? 'sqlite' : 'json';
            return {
              driver,
              enabled: Boolean(json.storage.enabled),
              available: json.storage.available ?? true,
              revision:
                typeof json.storage.revision === 'number'
                  ? json.storage.revision
                  : getLastKnownServerRevision(),
              updatedAt: json.storage.updatedAt ?? null,
              lastError: json.storage.lastError ?? null,
            };
          }
        }
      } catch {
        // Ağ yoksa önbellekten dürüst sağlık bilgisi döndürülür
      }
    }
    return this.getHealthFromDoc(null, getLastKnownServerRevision());
  }

  private async getHealthFromDoc(
    doc: DataDocument | null,
    revision: number | null
  ): Promise<StorageHealth> {
    return {
      driver: 'json',
      enabled: true,
      available: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
      revision,
      updatedAt: doc?.updatedAt ?? null,
      lastError: null,
    };
  }
}

export function createHttpPrimaryDataRepository(): HttpPrimaryDataRepository {
  return new HttpPrimaryDataRepository();
}
