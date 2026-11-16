/**
 * MIA Faz 1 — Repository sözleşmeleri.
 *
 * Veri erişimi iş mantığından ayrılır: modüller depolama ayrıntısını (dosya,
 * SQLite, IndexedDB) bilmez; yalnız bu arayüzleri görür. Gerçek adaptörler
 * Faz 2'de (Data Manager) bu sözleşmelerin arkasına bağlanır.
 */

export type RepositoryErrorCode =
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'unavailable';

export interface RepositoryError {
  readonly code: RepositoryErrorCode;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type RepositoryResult<T> = { ok: true; value: T } | { ok: false; error: RepositoryError };

export interface Revisioned<T> {
  readonly value: T;
  readonly revision: number;
  readonly updatedAt: string;
}

/** Anahtar her zaman kanonik metindir (ör. `movie:157336`). */
export interface ReadRepository<T, K extends string = string> {
  keyOf(value: T): K;
  get(key: K): Promise<RepositoryResult<Revisioned<T> | null>>;
  list(): Promise<RepositoryResult<readonly Revisioned<T>[]>>;
}

export interface WriteRepository<T, K extends string = string> {
  /**
   * Kaydı yazar. `expectedRevision` verilirse ve diskteki revizyon farklıysa
   * `conflict` döner — yarışan yazma sessizce kazanmaz.
   */
  put(
    value: T,
    options?: { expectedRevision?: number }
  ): Promise<RepositoryResult<Revisioned<T>>>;
  delete(key: K): Promise<RepositoryResult<boolean>>;
}

export interface Repository<T, K extends string = string>
  extends ReadRepository<T, K>,
    WriteRepository<T, K> {
  readonly name: string;
}

export interface InMemoryRepositoryOptions<T, K extends string> {
  readonly name: string;
  keyOf(value: T): K;
  readonly now?: () => Date;
}

/**
 * Sözleşmelerin referans uygulaması. Testler ve Faz 1 prototipleri için; üretim
 * verisi Faz 2 adaptörlerine bağlanır.
 */
export function createInMemoryRepository<T, K extends string>(
  options: InMemoryRepositoryOptions<T, K>
): Repository<T, K> {
  const now = options.now ?? (() => new Date());
  const records = new Map<K, Revisioned<T>>();

  return {
    name: options.name,
    keyOf: options.keyOf,

    async get(key) {
      return { ok: true, value: records.get(key) ?? null };
    },

    async list() {
      return { ok: true, value: [...records.values()] };
    },

    async put(value, putOptions) {
      const key = options.keyOf(value);
      const existing = records.get(key);
      const currentRevision = existing?.revision ?? 0;
      if (
        putOptions?.expectedRevision !== undefined &&
        putOptions.expectedRevision !== currentRevision
      ) {
        return {
          ok: false,
          error: {
            code: 'conflict',
            message: `Revizyon çakışması: beklenen ${putOptions.expectedRevision}, mevcut ${currentRevision}`,
            details: { key, expectedRevision: putOptions.expectedRevision, currentRevision },
          },
        };
      }
      const record: Revisioned<T> = {
        value,
        revision: currentRevision + 1,
        updatedAt: now().toISOString(),
      };
      records.set(key, record);
      return { ok: true, value: record };
    },

    async delete(key) {
      return { ok: true, value: records.delete(key) };
    },
  };
}
