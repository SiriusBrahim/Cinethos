import { MODULES, type ModuleDefinition, type ModuleId } from './module-registry.ts';

/**
 * M1 — Navigasyon türetimi (tek kaynak).
 *
 * Kenar çubuğu, üst sekmeler, mobil dock ve klavye kısayolları bu dosyadaki
 * türetilmiş listeleri kullanır; hiçbir bileşen kendi sekme listesini tutmaz.
 */

export interface SidebarNavItem {
  readonly id: ModuleId;
  readonly label: string;
  readonly iconRef: string;
  readonly shortcut: string;
  readonly counter?: 'myList';
}

export interface HeaderNavItem {
  readonly id: ModuleId;
  readonly label: string;
  readonly counter?: 'myList';
}

export interface DockNavItem {
  readonly id: ModuleId;
  readonly label: string;
  readonly Icon: ModuleDefinition['Icon'];
  readonly counter?: 'myList';
}

/** Kenar çubuğu sıralaması (AppSidebar). */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = MODULES.map((module) => ({
  id: module.id,
  label: module.label,
  iconRef: module.iconRef,
  shortcut: module.shortcut,
  ...(module.counter ? { counter: module.counter } : {}),
}));

/** Masaüstü üst sekme sıralaması (Header). */
export const HEADER_NAV_ITEMS: readonly HeaderNavItem[] = MODULES.map((module) => ({
  id: module.id,
  label: module.label,
  ...(module.counter ? { counter: module.counter } : {}),
}));

/**
 * Mobil dock sekme sıralaması (MobileDock).
 * Dock'ta dar alan nedeniyle yalnızca üç modül gösterilir; sıra ve etiketler
 * mevcut mobil UX'i birebir korur (Listem → 'Kütüphane', Keşfet, Zevkim).
 */
const DOCK_ITEM_ORDER: ReadonlyArray<{ id: ModuleId; label: string }> = [
  { id: 'list', label: 'Kütüphane' },
  { id: 'discover', label: 'Keşfet' },
  { id: 'taste-map', label: 'Zevkim' },
];

export const DOCK_NAV_ITEMS: readonly DockNavItem[] = DOCK_ITEM_ORDER.flatMap((entry) => {
  const module = MODULES.find((item) => item.id === entry.id);
  if (!module) return [];
  return [
    {
      id: module.id,
      label: entry.label,
      Icon: module.Icon,
      ...(module.counter ? { counter: module.counter } : {}),
    },
  ];
});

/** Kısayol tuşu → modül kimliği haritası (useKeyboardShortcuts). */
export const SHORTCUT_TAB_MAP: Readonly<Record<string, ModuleId>> = Object.fromEntries(
  MODULES.map((module) => [module.shortcut, module.id])
);

// --- Hash yönlendirme yardımcıları ---

/** Geçerli hash adresini modül kimliğine çevirir; tanınmıyorsa `null`. */
export function tabFromHash(rawHash: string): ModuleId | null {
  const segment = rawHash.replace(/^#\/?/, '').split('/')[0] ?? '';
  if (!segment) return null;
  const match = MODULES.find((module) => module.hash === segment.toLowerCase());
  return match ? match.id : null;
}

/** Modül kimliğini hash adresine çevirir. */
export function hashForTab(id: ModuleId): string {
  const module = MODULES.find((item) => item.id === id);
  return `#/${module ? module.hash : id}`;
}
