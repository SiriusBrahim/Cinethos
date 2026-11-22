import { MODULES, type ModuleDefinition, type ModuleId } from './module-registry.ts';

/**
 * M1 — Navigasyon türetimi (tek kaynak).
 *
 * Kenar çubuğu grupları, üst sekmeler, mobil dock, taşma menüsü ve klavye
 * kısayolları bu dosyadaki türetilmiş listeleri kullanır; hiçbir bileşen kendi
 * sekme listesini tutmaz.
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
  readonly iconRef: string;
  readonly counter?: 'myList';
}

export interface DockNavItem {
  readonly id: ModuleId;
  readonly label: string;
  readonly Icon: ModuleDefinition['Icon'];
  readonly counter?: 'myList';
}

export type NavGroupId = 'overview' | 'library' | 'analysis' | 'system';

export interface NavGroup {
  readonly id: NavGroupId;
  readonly label: string;
  readonly items: readonly SidebarNavItem[];
}

/** Kenar çubuğu gruplandırması — bilgi mimarisinin görsel karşılığı. */
const GROUP_DEFINITIONS: ReadonlyArray<{
  id: NavGroupId;
  label: string;
  modules: readonly ModuleId[];
}> = [
  { id: 'overview', label: 'GENEL BAKIŞ', modules: ['home', 'discover'] },
  { id: 'library', label: 'ARŞİV', modules: ['list', 'series'] },
  { id: 'analysis', label: 'ANALİZ', modules: ['taste-map', 'relationships'] },
  { id: 'system', label: 'SİSTEM', modules: ['operations'] },
];

function toSidebarItem(module: ModuleDefinition): SidebarNavItem {
  return {
    id: module.id,
    label: module.label,
    iconRef: module.iconRef,
    shortcut: module.shortcut,
    ...(module.counter ? { counter: module.counter } : {}),
  };
}

/** Kenar çubuğu sıralaması (AppSidebar) — gruplara ayrılmış. */
export const SIDEBAR_NAV_GROUPS: readonly NavGroup[] = GROUP_DEFINITIONS.map((group) => ({
  id: group.id,
  label: group.label,
  items: group.modules.flatMap((id) => {
    const module = MODULES.find((item) => item.id === id);
    return module ? [toSidebarItem(module)] : [];
  }),
}));

/** Düz kenar çubuğu listesi (uyumluluk ve klavye testleri için). */
export const SIDEBAR_NAV_ITEMS: readonly SidebarNavItem[] = SIDEBAR_NAV_GROUPS.flatMap(
  (group) => group.items
);

/** Masaüstü üst sekme sıralaması (Header). */
export const HEADER_NAV_ITEMS: readonly HeaderNavItem[] = MODULES.map((module) => ({
  id: module.id,
  label: module.label,
  iconRef: module.iconRef,
  ...(module.counter ? { counter: module.counter } : {}),
}));

/**
 * Mobil dock — dar alanda en sık kullanılan dört modül.
 * Kalan modüller dock'taki "Daha fazla" sayfasından erişilir.
 */
const DOCK_ITEM_ORDER: ReadonlyArray<{ id: ModuleId; label: string }> = [
  { id: 'home', label: 'Ana' },
  { id: 'discover', label: 'Keşfet' },
  { id: 'list', label: 'Kütüphane' },
  { id: 'taste-map', label: 'Zevkim' },
];

function toDockItem(entry: { id: ModuleId; label: string }): DockNavItem[] {
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
}

export const DOCK_NAV_ITEMS: readonly DockNavItem[] = DOCK_ITEM_ORDER.flatMap(toDockItem);

/** Mobil "Daha fazla" sayfası — dock dışındaki tüm modüller. */
const DOCK_IDS = new Set(DOCK_ITEM_ORDER.map((entry) => entry.id));

export const MOBILE_OVERFLOW_ITEMS: readonly SidebarNavItem[] = MODULES.filter(
  (module) => !DOCK_IDS.has(module.id)
).map(toSidebarItem);

/** Kısayol tuşu → modül kimliği haritası (useKeyboardShortcuts). */
export const SHORTCUT_TAB_MAP: Readonly<Record<string, ModuleId>> = Object.fromEntries(
  MODULES.map((module) => [module.shortcut, module.id])
);

/** Profil ve Ayarlar kısayolu — modül değildir, mevcut ayar penceresini açar. */
export const SETTINGS_SHORTCUT = '0';

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
