/**
 * Çekirdek anahtar-değer deposu portu (F5-04).
 *
 * Çekirdek katmanı `idb-keyval` veya doğrudan IndexedDB kullanmaz. Tarayıcı
 * adaptörü (`src/services/core-idb-store.ts`) bu portu kaydeder; davranış
 * (DB adları, store adları, hata yutma) adaptörde birebir korunur.
 */

/** Çekirdeğin ihtiyaç duyduğu en küçük depo yüzeyi. */
export interface CoreKvStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** DB + store açan fabrika (idb-keyval `createStore` eşdeğeri). */
export type CoreKvStoreFactory = (dbName: string, storeName: string) => CoreKvStore;

let activeFactory: CoreKvStoreFactory | null = null;

export function registerKvStoreFactory(factory: CoreKvStoreFactory): void {
  activeFactory = factory;
}

export function getKvStoreFactory(): CoreKvStoreFactory | null {
  return activeFactory;
}

/** Test izolasyonu: kayıtlı fabrikayı temizler. */
export function resetKvStoreFactoryForTests(): void {
  activeFactory = null;
}
