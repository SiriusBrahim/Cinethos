import { useEffect, useRef } from 'react';
import type { ModuleId } from './module-registry.ts';
import { hashForTab, tabFromHash } from './navigation.ts';

/**
 * M1 — Hash tabanlı derin bağlantı yönlendirmesi.
 *
 * `#/discover`, `#/list`, `#/taste-map`, `#/relationships` adresleri sekmelerle
 * çift yönlü eşitlenir. Hash tabanlı seçim sunucu tarafı gerektirmez; PWA ve
 * çevrimdışı mod ile `createSpaFallbackMiddleware` ile uyumludur.
 *
 * - Açılışta hash geçerli bir modüle işaret ediyorsa o modüle gidilir.
 * - Kullanıcı tarayıcı geri/ileri tuşlarını kullanırsa sekme güncellenir.
 * - Sekme programatik değiştiğinde adres `history.replaceState` ile eşitlenir
 *   (geçmiş kirlenmez; geri tuşu her zaman önceki hash modülüne döner).
 */
export function useHashNavigation(
  tab: ModuleId,
  onTabChange: (tab: ModuleId) => void
): void {
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const onTabChangeRef = useRef(onTabChange);
  onTabChangeRef.current = onTabChange;

  // Açılışta ve geri/ileri gezinmede hash → sekme
  useEffect(() => {
    const applyHash = () => {
      const fromHash = tabFromHash(window.location.hash);
      if (fromHash && fromHash !== tabRef.current) {
        onTabChangeRef.current(fromHash);
      }
    };
    applyHash();
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  }, []);

  // Sekme → hash (yalnızca adres zaten eşleşmiyorken)
  useEffect(() => {
    const target = hashForTab(tab);
    if (window.location.hash !== target) {
      window.history.replaceState(null, '', target);
    }
  }, [tab]);
}
