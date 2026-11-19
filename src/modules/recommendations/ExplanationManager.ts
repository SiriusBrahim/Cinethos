/**
 * MIA Faz 6 — Açıklama Yöneticisi.
 *
 * Öneri sonuçlarını kullanıcıya gösterilecek kart verilerine ve gerekçe
 * metinlerine dönüştürür. Puan ÜRETMEZ: Zevk Haritası'ndaki mevcut
 * `tasteScore` / `priorityScore` değerlerini korur; yalnızca halka (ring)
 * çözümlemesi ve gerekçe eşlemesi yapar.
 */

import { inferLifecycleRing, type PersistentTasteMapData, type TasteRing } from '../../core/cinetrack-core.ts';
import { canonicalizeMediaKey, makeMediaKey } from '../../core/keys.ts';
import { enforceStrictMediaTypePool } from './CandidatePoolManager.ts';

function isValidLifecycleRing(val: unknown): val is 'ring0' | 'ring1' | 'ring2' {
  return val === 'ring0' || val === 'ring1' || val === 'ring2';
}

/**
 * Gösterim halkasını (ring0 / ring1 / ring2) kalıcı Zevk Haritası kaydından veya
 * doğru yaşam döngüsü çıkarımından çözümler; `ring1` değerini asla varsayılan `ring0` ile ezmez.
 */
export function resolveDisplayedLifecycleRing(
  itemOrEntry: any,
  tasteMap?: PersistentTasteMapData | null
): 'ring0' | 'ring1' | 'ring2' {
  const cand =
    itemOrEntry?.candidate && typeof itemOrEntry.candidate === 'object'
      ? itemOrEntry.candidate
      : itemOrEntry;
  const key = cand && cand.id != null ? canonicalizeMediaKey(makeMediaKey(cand)) : '';
  const lastKeys = Array.isArray(tasteMap?.lastRecommendedKeys)
    ? tasteMap!.lastRecommendedKeys
    : [];

  if (key && tasteMap) {
    const mapEntry = tasteMap.entries?.[key] || tasteMap.archivedEntries?.[key];
    if (mapEntry) {
      if (isValidLifecycleRing(mapEntry.ring)) {
        return mapEntry.ring;
      }
      return inferLifecycleRing(key, mapEntry, lastKeys);
    }
    if (lastKeys.some((k) => canonicalizeMediaKey(k) === key)) {
      return 'ring1';
    }
  }

  const explicitRing =
    itemOrEntry?.lifecycleRing ??
    itemOrEntry?.ring ??
    cand?.lifecycleRing ??
    cand?.ring ??
    itemOrEntry?.selectionRing;

  if (isValidLifecycleRing(explicitRing)) {
    return explicitRing;
  }

  if (key) {
    return inferLifecycleRing(key, cand || itemOrEntry, lastKeys);
  }

  return 'ring0';
}

/**
 * Seçilmiş öneri grubunu (`picked` veya `restored`) UI bileşenlerine gidecek kart verilerine
 * ve gerekçe haritasına dönüştürür (`ring1` durumunu koruyarak).
 */
export function mapRecommendationBatchToDisplayItems(
  batchEntries: any[],
  tasteMap?: PersistentTasteMapData | null,
  targetType: 'all' | 'movie' | 'tv' | string = 'all'
): {
  displayItems: any[];
  reasonsMap: Map<string, string>;
} {
  const strictEntries = enforceStrictMediaTypePool(batchEntries, targetType);
  const reasonsMap = new Map<string, string>();

  const displayItems = strictEntries.map((entry: any) => {
    const cand = entry?.candidate && typeof entry.candidate === 'object' ? entry.candidate : entry;
    const key = canonicalizeMediaKey(makeMediaKey(cand));
    const mapEntry = tasteMap?.entries?.[key] || tasteMap?.archivedEntries?.[key];

    const tagsList: string[] = Array.isArray(entry?.tags) && entry.tags.length > 0
      ? entry.tags
      : Array.isArray(mapEntry?.tags) && mapEntry.tags.length > 0
      ? mapEntry.tags
      : Array.isArray(cand?.tags)
      ? cand.tags
      : [];

    if (key) {
      reasonsMap.set(key, tagsList.join(' · '));
    }

    const tasteScore =
      mapEntry?.tasteScore ??
      mapEntry?.matchScore ??
      Math.max(
        1,
        Math.min(100, Math.round(Number(cand?.tasteScore ?? entry?.tasteScore ?? entry?.score) || 75))
      );

    const priorityScore =
      mapEntry?.priorityScore ??
      Math.max(
        1,
        Math.min(
          100,
          Math.round(Number(cand?.priorityScore ?? entry?.priorityScore ?? entry?.score) || tasteScore)
        )
      );

    const resolvedRing: TasteRing = resolveDisplayedLifecycleRing(entry, tasteMap);

    return {
      ...cand,
      matchScore: tasteScore,
      tasteScore,
      priorityScore,
      tags: tagsList,
      scoreCoverage:
        mapEntry?.scoreCoverage ?? entry?.scoreCoverage ?? (cand?.cast?.length ? 'enriched' : 'basic'),
      confidenceLevel:
        mapEntry?.confidenceLevel ??
        entry?.confidenceLevel ??
        (cand?.cast?.length ? 'high' : 'standard'),
      ring: resolvedRing,
      lifecycleRing: resolvedRing,
      ...(entry?.selectionRing ? { selectionRing: entry.selectionRing } : {}),
      tasteMapEntry: mapEntry,
    };
  });

  return { displayItems, reasonsMap };
}

export interface ExplanationManager {
  readonly resolveDisplayedLifecycleRing: typeof resolveDisplayedLifecycleRing;
  readonly mapRecommendationBatchToDisplayItems: typeof mapRecommendationBatchToDisplayItems;
}

/** Açıklama yöneticisi (tek örnek; durum tutmaz). */
export function createExplanationManager(): ExplanationManager {
  return { resolveDisplayedLifecycleRing, mapRecommendationBatchToDisplayItems };
}
