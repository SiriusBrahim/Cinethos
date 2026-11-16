import React, { createContext, useContext } from 'react';
import type { SavedItem } from '../core/cinethos-core.ts';
import type { TmdbItem } from '../types/tmdb.ts';

/**
 * M1 — Kabuk bağlamı: modüllerin ortak kabuk servislerine erişim sözleşmesi.
 *
 * Modüller birbirlerine prop drilling ile değil, kabuğun sunduğu bu eylemler
 * üzerinden ulaşır. Yönetici (App) sağlayıcıdır; modüller tüketicidir.
 */

export type ShellMediaItem = TmdbItem | SavedItem;

export interface ShellActions {
  /** Detay penceresini açar. */
  openDetails: (item: ShellMediaItem) => void;
  /** Hızlı kaydetme penceresini açar. */
  openQuickSave: (item: ShellMediaItem) => void;
  /** İzleme durumunu ayarlar (watching/watchlist/completed). */
  setStatus: (item: ShellMediaItem, status: 'watching' | 'watchlist' | 'completed') => void;
  /** Beğenmeme listesine ekler/çıkarır. */
  toggleDislike: (key: string) => void;
  /** Zevk haritasını yeniden hesaplar/tazeler. */
  refreshTasteMap: () => void;
  /** Komut paletini açar. */
  openCommandPalette: () => void;
  /** Özel yapım ekleme penceresini açar. */
  openAddCustom: () => void;
  /** Profil yönetimini açar. */
  openProfile: () => void;
}

const ShellContext = createContext<ShellActions | null>(null);

export const ShellProvider: React.FC<{ value: ShellActions; children: React.ReactNode }> = ({
  value,
  children,
}) => <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;

/**
 * Kabuk eylemlerine erişim. Sağlayıcı dışında çağrılırsa açık hata verir —
 * sessiz boş nesne döndürmek yerine hata, yanlış kablolamayı erken yakalar.
 */
export function useShell(): ShellActions {
  const actions = useContext(ShellContext);
  if (!actions) {
    throw new Error(
      'useShell() yalnızca <ShellProvider> içinde kullanılabilir. Bileşen kabuk dışında render ediliyor.'
    );
  }
  return actions;
}

/** Testler ve kenar durumları için: sağlayıcı yoksa null döner (fırlatmaz). */
export function useOptionalShell(): ShellActions | null {
  return useContext(ShellContext);
}
