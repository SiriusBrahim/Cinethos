import type { ModuleId } from './module-ids.ts';

/**
 * F5.2-01 — Kontrol çubuğunun ikincil filtre satırını gösterip göstermeyeceği.
 *
 * Favori Oyuncular sekmesinde alt filtre çubuğu gizlenir; oyuncu araması ve
 * öneri alt sekmeleri kendi araç çubuklarını taşır.
 */
export function shouldHideSecondaryToolbar(tab: ModuleId, listStatus: string): boolean {
  return tab === 'list' && listStatus === 'actors';
}
