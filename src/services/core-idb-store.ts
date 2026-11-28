/**
 * Çekirdek anahtar-değer portunun tarayıcı adaptörü (F5-04).
 *
 * `idb-keyval` yalnızca burada (uygulama altyapısı katmanı) kullanılır;
 * çekirdek `src/core/ports/kv-store-port.ts` üzerinden erişir. DB ve store
 * adları, yazma/hata davranışı önceki kullanımla birebir aynıdır.
 */

import { createStore, get, set } from 'idb-keyval';

import { registerKvStoreFactory } from '../core/ports/kv-store-port.ts';

/** Çekirdeğin beklediği fabrika: (dbName, storeName) → depo. */
registerKvStoreFactory((dbName: string, storeName: string) => {
  const store = createStore(dbName, storeName);
  return {
    get: <T = unknown>(key: string) => get<T>(key, store),
    set: (key: string, value: unknown) => set(key, value, store),
  };
});
