import React, { lazy } from 'react';

/**
 * M1 — Tekrar denemeli lazy yükleme.
 *
 * Ağ dalgalanmalarında (özellikle PWA/çevrimdışı geçişleri) chunk yükleme
 * başarısızlıklarına karşı tek seferlik 250 ms beklemeyle yeniden dener.
 * App.tsx'ten buraya taşındı; kayıt defteri modül bölümlerini bu yardımcıyla
 * tembel yükler (kod bölünmesi korunur).
 */
export function lazyWithRetry<T extends React.ComponentType<any>>(
  importer: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await importer();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return importer();
    }
  });
}
