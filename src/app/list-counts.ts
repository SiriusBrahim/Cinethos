/**
 * F5.3-07 — Liste sayaçları (tek kaynak).
 *
 * `App.tsx` içinde beş ayrı `savedItems.filter(...)` çağrısı, aynı tür
 * yüklemini (`selectedType === 'all' || item.media_type === selectedType`)
 * beş kez kopyalıyordu ve "yaklaşanlar" sayacı sistem saatine doğrudan bağlı
 * olduğu için test edilemiyordu. Bu modül sayacı tek bir saf fonksiyona alır:
 *
 *  - tür yüklemi tek yerde tanımlıdır,
 *  - "bugün" parametre olarak verilir (tarih sınırı testte sabitlenebilir),
 *  - tek geçişte tüm sayaçlar hesaplanır,
 *  - geçersiz kayıtlar (null, nesne olmayan, türü uyuşmayan) sessizce atlanır.
 *
 * Davranış App.tsx'teki eski hesaplamayla birebir aynıdır: `upcoming`
 * sayacı durumdan bağımsızdır ve yayın tarihi bugüne eşit veya ileri ise
 * sayılır. React, ağ ve GitHub bağımlılığı yoktur.
 */

import { resolveAirDate } from '../core/cinetrack-core.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';

export interface ListCountInput {
  savedItems: readonly SavedItem[];
  /** `all` | `movie` | `tv` — diğer değerlerde hiçbir kayıt eşleşmez. */
  selectedType: string;
  /** Bugünün ISO tarihi (YYYY-MM-DD); çağıran sistem saatinden üretir. */
  today: string;
}

export interface ListCounts {
  allListCount: number;
  watchingCount: number;
  watchlistCount: number;
  completedCount: number;
  upcomingCount: number;
}

/** Tür yüklemi: tek kaynak (App.tsx'te beş kez kopyalanmıştı). */
function matchesSelectedType(item: SavedItem, selectedType: string): boolean {
  return selectedType === 'all' || item.media_type === selectedType;
}

export function computeListCounts({ savedItems, selectedType, today }: ListCountInput): ListCounts {
  const counts: ListCounts = {
    allListCount: 0,
    watchingCount: 0,
    watchlistCount: 0,
    completedCount: 0,
    upcomingCount: 0,
  };

  for (const item of savedItems || []) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    if (!matchesSelectedType(item, selectedType)) continue;

    counts.allListCount += 1;
    if (item.status === 'watching') counts.watchingCount += 1;
    else if (item.status === 'watchlist') counts.watchlistCount += 1;
    else if (item.status === 'completed') counts.completedCount += 1;

    const airDate = resolveAirDate(item);
    if (airDate && airDate >= today) counts.upcomingCount += 1;
  }

  return counts;
}
