/**
 * "Seriler" evren listesi (F5.1-01).
 *
 * `App.tsx` içindeki `seriesUniverseData` memo'sunun saf hesaplaması.
 * Filtre sırası ve neden metni birebir korunur.
 */

import { isItemSaved, makeMediaKey, type SavedItem } from '../core/cinetrack-core.ts';
import { computeUserSeriesUniverses } from '../services/series-service.ts';

export interface SeriesUniverseData {
  items: any[];
  reasonsMap: Map<string, string>;
  universesCount: number;
}

export interface SeriesUniverseInput {
  savedItems: SavedItem[];
  disliked: string[];
  hidden?: string[];
  includeStubs: boolean;
}

export function buildSeriesUniverseData(input: SeriesUniverseInput): SeriesUniverseData {
  const { savedItems, disliked, hidden, includeStubs } = input;
  const universes = computeUserSeriesUniverses(savedItems, {
    includeStubs,
    dislikedKeys: disliked,
    hiddenKeys: hidden,
  });

  const items: any[] = [];
  const reasonsMap = new Map<string, string>();
  const seenKeys = new Set<string>();
  const dislikedSet = new Set(disliked || []);
  const hiddenSet = new Set(hidden || []);

  for (const u of universes) {
    const ownedTitles = u.userOwnedParts
      .slice(0, 2)
      .map((p) => p.title || p.name)
      .filter(Boolean)
      .join(', ');
    const reason = ownedTitles
      ? `${u.collection.name} · Listenizdeki "${ownedTitles}" ile aynı seride`
      : `${u.collection.name} serisinin devam halkası`;

    for (const part of u.userMissingParts) {
      const mType = part.media_type === 'tv' ? 'tv' : 'movie';
      const key = makeMediaKey(mType, part.id);
      if (seenKeys.has(key) || dislikedSet.has(key) || hiddenSet.has(key)) continue;
      if (isItemSaved(savedItems, part, mType)) continue;
      seenKeys.add(key);
      items.push({
        ...part,
        media_type: mType,
        belongs_to_collection:
          mType === 'movie' ? { id: u.collection.id, name: u.collection.name } : undefined,
      });
      reasonsMap.set(key, reason);
    }
  }

  return { items, reasonsMap, universesCount: universes.length };
}
