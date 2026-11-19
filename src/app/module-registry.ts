import React from 'react';
import {
  Bookmark,
  Compass,
  Fingerprint,
  Home,
  Layers,
  ListChecks,
  Network,
} from 'lucide-react';
import { lazyWithRetry } from './lazy-with-retry.ts';
import type { ModuleId } from './module-ids.ts';
import { DiscoverSection } from '../modules/discover/DiscoverSection.tsx';
import { ListSection } from '../modules/list/ListSection.tsx';

/**
 * M1 — Modül Kayıt Defteri (tek doğruluk kaynağı).
 *
 * Yönetici (App) ile işçi modüller arasındaki sözleşme. Her birincil modül
 * burada bir kez tanımlanır; kenar çubuğu, üst sekmeler, mobil dock, klavye
 * kısayolları, komut paleti ve hash yönlendirmesi bu kayıttan türetilir.
 *
 * Kural: Yeni bir birincil modül eklemek = bu dizideki tek girdi + view bileşeni.
 */

/**
 * Birincil çalışma alanı modüllerinin kimlikleri.
 *
 * Bilgi mimarisi: Ana Sayfa → Keşfet → Kütüphanem → Zevkim → İlişki Keşfi →
 * Seriler ve Evrenler → İşlem Merkezi. Profil ve Ayarlar bir modül değil,
 * kabuğun mevcut profil/ayarlar penceresidir (kenar çubuğu "Sistem" grubu).
 */
export type { ModuleId };

/** Geriye dönük uyumluluk: mobil bileşenlerin kullandığı eski ad. */
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
   * Veri bağlanması gereken modüllerde (home/series/operations) bölüm App
   * tarafından doğrudan çağrılır; kayıt bu modüller için görünüm sağlamaz.
   */
  readonly Section?: React.ComponentType<any>;
  /** Görünen ad. */
  readonly label: string;
  /** Kenar çubuğu/üst sekmelerde kullanılan SVG sembol referansı (`<use href>`). */
  readonly iconRef: string;
  /** Mobil dock ve tasarım sistemi kartlarında kullanılan Lucide ikonu. */
  readonly Icon: ModuleIcon;
  /** Klavye kısayolu (rakam). Ayarlara ayrılan '0' burada yer almaz. */
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
    id: 'home',
    label: 'Ana Sayfa',
    iconRef: '#icon-home',
    Icon: Home,
    shortcut: '1',
    hash: 'home',
    keywords: ['ana sayfa', 'özet', 'panel', 'home'],
  },
  {
    id: 'discover',
    label: 'Keşfet',
    iconRef: '#icon-film',
    Icon: Compass,
    shortcut: '2',
    hash: 'discover',
    keywords: ['katalog', 'trend', 'öneri', 'discover'],
    // Statik bölüm: ilk boyamada Suspense flaşı olmasın.
    Section: DiscoverSection,
  },
  {
    id: 'list',
    label: 'Kütüphanem',
    iconRef: '#icon-bookmark',
    Icon: Bookmark,
    shortcut: '3',
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
    shortcut: '4',
    hash: 'taste-map',
    keywords: ['zevkim', 'kimliğim', 'istatistik', 'tat', 'dna'],
    Section: lazyWithRetry(
      () => import('../modules/taste-map/TasteMapSection.tsx')
    ) as unknown as React.ComponentType<any>,
  },
  {
    id: 'relationships',
    label: 'İlişki Keşfi',
    iconRef: '#icon-network',
    Icon: Network,
    shortcut: '5',
    hash: 'relationships',
    keywords: ['ilişkiler', 'ağ', 'bağlantı', 'relationships'],
    Section: lazyWithRetry(
      () => import('../modules/relationships/RelationshipsSection.tsx')
    ) as unknown as React.ComponentType<any>,
  },
  {
    id: 'series',
    label: 'Seriler ve Evrenler',
    iconRef: '#icon-layers',
    Icon: Layers,
    shortcut: '6',
    hash: 'series',
    keywords: ['seriler', 'evrenler', 'koleksiyon', 'franchise', 'series'],
  },
  {
    id: 'operations',
    label: 'İşlem Merkezi',
    iconRef: '#icon-activity',
    Icon: ListChecks,
    shortcut: '7',
    hash: 'operations',
    keywords: ['işlem', 'kuyruk', 'görev', 'background', 'health', 'operations'],
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
