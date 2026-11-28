/**
 * M1 — Tipli kabuk olay yolu.
 *
 * Modüller yalnızca kabukla konuşur; çapraz-modül bildirimleri bu tipli kanaldan
 * geçer. Yayın/abonelik string tabanlı değildir — `ShellEventMap` derleyici
 * tarafından denetlenir. Kasıtlı olarak minimal tutulur: genel amaçlı bir bus
 * değil, kabuğun tanımladığı sözleşme.
 */

export interface ShellEventMap {
  /** Bir yapım kaydedildi/listeye eklendi (quick save, status değişimi vb.). */
  'item:saved': { key: string; title?: string };
  /** Bir yapım beğenmeme listesine eklendi/çıkarıldı. */
  'item:disliked': { key: string; disliked: boolean };
  /** Aktif profil değişti. */
  'profile:changed': { profileId: string };
  /** Sunucuya yazma/senkron tamamlandı. */
  'sync:completed': { uploaded: number; downloaded: number; merged: number };
}

type ShellEventName = keyof ShellEventMap;
type Listener<K extends ShellEventName> = (payload: ShellEventMap[K]) => void;

const listeners = new Map<ShellEventName, Set<Listener<ShellEventName>>>();

/** Olay yayınlar; dinleyici yoksa sessizce no-op'tur (asla fırlatmaz). */
export function emitShellEvent<K extends ShellEventName>(
  name: K,
  payload: ShellEventMap[K]
): void {
  const set = listeners.get(name);
  if (!set) return;
  for (const listener of set) {
    try {
      listener(payload);
    } catch (error) {
      // Dinleyici hatası yayını bozmamalı; teşhis için loglanır.
      console.warn(`[ShellEvent] ${name} dinleyicisi hata fırlattı:`, error);
    }
  }
}

/** Olaya abone olur; aboneliği kesen fonksiyon döner. */
export function subscribeShellEvent<K extends ShellEventName>(
  name: K,
  listener: Listener<K>
): () => void {
  let set = listeners.get(name);
  if (!set) {
    set = new Set();
    listeners.set(name, set);
  }
  set.add(listener as Listener<ShellEventName>);
  return () => {
    set?.delete(listener as Listener<ShellEventName>);
  };
}

/** Yalnızca testler için: tüm dinleyicileri temizler. */
export function resetShellEventsForTests(): void {
  listeners.clear();
}
