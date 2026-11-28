/**
 * Görüntülenen öğe listesi (F5.1-01).
 *
 * `App.tsx` içindeki `filterAndSortItems` + `displayedItems` memo'sunun saf
 * hesaplaması. Filtre/sıralama sırası ve gizleme kuralları birebir korunur.
 */

import {
  HIDE_LISTED_CATEGORIES,
  filterHiddenUserRegisteredItems,
  isItemSaved,
  makeMediaKey,
  matchesSelectedGenre,
  resolveAirDate,
  type PersistentTasteMapData,
  type Preferences,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { computeProfileCentroid, cosineSimilarity } from '../core/encoding.ts';
import { getItemEncodingSync } from '../services/encoding-service.ts';
import { displayTitle } from '../utils/helpers.ts';

export interface DisplayedItemsInput {
  tab: string;
  category: string;
  forYouSubTab: string;
  query: string;
  hideListedItems: boolean;
  listStatus: string;
  selectedType: string;
  selectedGenre: string;
  selectedSort: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  tasteMap: PersistentTasteMapData;
  dislikedItems: any[];
  forYouItems: any[];
  catalogItems: any[];
  seriesItems: any[];
}

function filterAndSortItems(input: DisplayedItemsInput, items: any[]): any[] {
  const { tab, category, selectedType, selectedGenre, selectedSort, savedItems } = input;
  const currentSaved = savedItems;

  let filtered = items.filter((item) => {
    if (item.media_type !== 'movie' && item.media_type !== 'tv') return false;
    if (selectedType !== 'all' && item.media_type !== selectedType) return false;
    if (selectedGenre && !matchesSelectedGenre(item, selectedGenre)) return false;
    return true;
  });

  if (tab === 'discover' && category !== 'for-you' && selectedSort === 'popular') {
    return filtered;
  }

  if (selectedSort === 'similarity') {
    const savedEncodings = currentSaved.map((it) => ({
      encoding: getItemEncodingSync(it),
      personal_rating: it.personal_rating,
    }));
    const profileCentroid = computeProfileCentroid(savedEncodings);
    if (profileCentroid.length > 0) {
      const simMap = new Map<string, number>();
      for (const it of filtered) {
        const enc = getItemEncodingSync(it);
        const sim = cosineSimilarity(profileCentroid, enc.denseVector);
        simMap.set(`${it.media_type}:${it.id}`, sim);
      }
      filtered = [...filtered].sort(
        (a, b) =>
          (simMap.get(`${b.media_type}:${b.id}`) ?? 0) - (simMap.get(`${a.media_type}:${a.id}`) ?? 0)
      );
    }
  } else if (selectedSort === 'rating') {
    filtered = [...filtered].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  } else if (selectedSort === 'title') {
    filtered = [...filtered].sort((a, b) => displayTitle(a).localeCompare(displayTitle(b), 'tr'));
  } else if (selectedSort === 'recent') {
    filtered = [...filtered].sort((a, b) =>
      tab === 'list'
        ? (b.addedAt || '').localeCompare(a.addedAt || '')
        : (b.release_date || b.first_air_date || '').localeCompare(
            a.release_date || a.first_air_date || ''
          )
    );
  }
  return filtered;
}

export function buildDisplayedItems(input: DisplayedItemsInput): any[] {
  const {
    tab,
    category,
    forYouSubTab,
    query,
    hideListedItems,
    listStatus,
    savedItems,
    preferences,
    tasteMap,
    dislikedItems,
    forYouItems,
    catalogItems,
    seriesItems,
  } = input;

  if (tab === 'discover') {
    if (category === 'for-you' && forYouSubTab === 'series' && !query.trim()) {
      return filterAndSortItems(input, seriesItems);
    }

    const rawSource = category === 'for-you' ? forYouItems : catalogItems;
    const shouldHideUserRegistered =
      !query.trim() &&
      hideListedItems &&
      (HIDE_LISTED_CATEGORIES as readonly string[]).includes(category);

    const preFiltered = shouldHideUserRegistered
      ? filterHiddenUserRegisteredItems(rawSource, {
          savedItems,
          preferences,
          tasteMap,
          hideListedItems: true,
        })
      : rawSource;

    const filtered = preFiltered.filter((item) => {
      const itemType = item.media_type || (item.title ? 'movie' : 'tv');
      const key = makeMediaKey(itemType, item.id);
      if (preferences.disliked.includes(key)) return false;
      if (preferences.hidden?.includes(key)) return false;

      // In Sana Özel (recommendations), strictly filter out items already in the user's list
      if (category === 'for-you') {
        if (isItemSaved(savedItems, item, itemType)) return false;
      }

      return true;
    });
    return filterAndSortItems(input, filtered);
  }

  if (listStatus === 'disliked') {
    const activeDisliked = dislikedItems.filter((item) =>
      preferences.disliked.includes(`${item.media_type}:${item.id}`)
    );
    return filterAndSortItems(input, activeDisliked);
  }

  let list = savedItems;
  if (listStatus === 'upcoming') {
    const todayStr = new Date().toISOString().slice(0, 10);
    list = savedItems
      .filter((item) => {
        const airDate = resolveAirDate(item);
        return airDate && airDate >= todayStr;
      })
      .sort((a, b) => resolveAirDate(a).localeCompare(resolveAirDate(b)));
  } else if (listStatus !== 'all') {
    list = savedItems.filter((item) => item.status === listStatus);
  }
  return filterAndSortItems(input, list);
}
