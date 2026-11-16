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
  StorageHealth,
} from '../contracts/index.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import {
  fetchServerData,
  getLastKnownServerRevision,
  pushServerDataDetailed,
} from './api.ts';

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

  async save(
    document: DataDocument,
    options: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    const baseRevision =
      options.expectedRevision !== undefined
        ? options.expectedRevision
        : getLastKnownServerRevision();

    const res = await pushServerDataDetailed(document, {
      baseRevision,
      mergeStrategy: 'lossless',
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
