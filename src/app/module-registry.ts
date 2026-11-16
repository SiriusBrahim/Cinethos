import React from 'react';
import { Bookmark, Compass, Fingerprint, Network } from 'lucide-react';
import { lazyWithRetry } from './lazy-with-retry.ts';
import { DiscoverSection } from '../modules/discover/DiscoverSection.tsx';
import { ListSection } from '../modules/list/ListSection.tsx';

/**
 * M1 — Modül Kayıt Defteri (tek doğruluk kaynağı).
 *
 * Yönetici (AppShell) ile işçi modüller arasındaki sözleşme. Her birincil modül
 * burada bir kez tanımlanır; kenar çubuğu, üst sekmeler, mobil dock, klavye
 * kısayolları, komut paleti ve hash yönlendirmesi bu kayıttan türetilir.
 *
 * Kural: Yeni bir birincil modül eklemek = bu dizideki tek girdi + view bileşeni.
 */

/** Birincil çalışma alanı modüllerinin kimlikleri. */
export type ModuleId = 'discover' | 'list' | 'taste-map' | 'relationships';

/**
 * Geriye dönük uyumluluk: mobil bileşenlerin kullandığı eski ad.
 * Kayıt defteri tek doğruluk kaynağı olduğundan buradan yeniden dışa aktarılır.
 */
export type MainTab = ModuleId;

export type ModuleIcon = React.ComponentType<{
  className?: string;
  'aria-hidden'?: boolean;
}>;

export interface ModuleDefinition {
  /** Modül kimliği — hash rotası ve olay adlarında kullanılır. */
  readonly id: ModuleId;
  /**
   * Modülün ana bölüm bileşeni. Tanımlıysa yönetici (App), ilgili sekmede bu
   * bileşeni render eder — sekme içeriği App'te değil, modül dosyasında yaşar.
   */
  readonly Section?: React.ComponentType<any>;
  /** Görünen ad. */
  readonly label: string;
  /** Kenar çubuğu/üst sekmelerde kullanılan SVG sembol referansı (`<use href>`). */
  readonly iconRef: string;
  /** Mobil dock ve tasarım sistemi kartlarında kullanılan Lucide ikonu. */
  readonly Icon: ModuleIcon;
  /** Klavye kısayolu (rakam). Ayarlara ayrılan '5' burada yer almaz. */
  readonly shortcut: string;
  /** Hash rotası (`#/` sonrası bölüm). */
  readonly hash: string;
  /** Komut paleti aramasında eşleşen anahtar kelimeler (modülle birlikte tek kaynak). */
  readonly keywords: readonly string[];
  /** Aktifken listelenen sayaç türü; tanımsızsa sayaç yok. */
  readonly counter?: 'myList';
}

/**
 * Birincil modüller — dizi sırası, kenar çubuğu/üst sekme/dock sırasıdır.
 */
export const MODULES: readonly ModuleDefinition[] = [
  {
    id: 'discover',
    label: 'Keşfet',
    iconRef: '#icon-film',
    Icon: Compass,
    shortcut: '1',
    hash: 'discover',
    keywords: ['katalog', 'trend', 'öneri', 'discover'],
    // Varsayılan sekme: statik bölüm (ilk boyamada Suspense flaşı olmasın).
    Section: DiscoverSection,
  },
  {
    id: 'list',
    label: 'Listem',
    iconRef: '#icon-bookmark',
    Icon: Bookmark,
    shortcut: '2',
    hash: 'list',
    keywords: ['kütüphane', 'izlediklerim', 'list'],
    counter: 'myList',
    Section: ListSection,
  },
  {
    id: 'taste-map',
    label: 'Zevkim',
    iconRef: '#icon-dna',
    Icon: Fingerprint,
    shortcut: '3',
    hash: 'taste-map',
    keywords: ['zevkim', 'kimliğim', 'istatistik', 'tat', 'dna'],
    Section: lazyWithRetry(
      () => import('../modules/taste-map/TasteMapSection.tsx')
    ) as unknown as React.ComponentType<any>,
  },
  {
    id: 'relationships',
    label: 'Evrenler',
    iconRef: '#icon-network',
    Icon: Network,
    shortcut: '4',
    hash: 'relationships',
    keywords: ['ilişkiler', 'ağ', 'evrenler', 'relationships'],
    Section: lazyWithRetry(
      () => import('../modules/relationships/RelationshipsSection.tsx')
    ) as unknown as React.ComponentType<any>,
  },
];

/** Kimliğe göre modül tanımı (bilinmiyorsa `undefined`). */
export function getModule(id: string): ModuleDefinition | undefined {
  return MODULES.find((module) => module.id === id);
}

/** Kısayol tuşuna göre modül tanımı. */
export function getModuleByShortcut(key: string): ModuleDefinition | undefined {
  return MODULES.find((module) => module.shortcut === key);
}

/** Hash bölümünden (`#/discover` → `discover`) modül çözümleme. */
export function getModuleByHash(hashSegment: string): ModuleDefinition | undefined {
  const clean = hashSegment.replace(/^\/+/, '').toLowerCase();
  return MODULES.find((module) => module.hash === clean);
}

/** Modülün hash adresi (`#/discover` biçiminde). */
export function moduleHash(id: ModuleId): string {
  const module = getModule(id);
  return `#/${module ? module.hash : id}`;
}
