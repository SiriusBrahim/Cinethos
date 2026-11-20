/**
 * Faz 3 — İçerik Zekâsı semantik sinyalinin sıralamaya bağlanması.
 *
 * Sunucudaki analiz kayıtları (anlamsal vektör, atmosfer, kavramlar) Keşfet'in
 * genel katalog sıralamasında da kullanılır. Kurallar:
 *
 * - Katkı **sınırlıdır** (azami `SEMANTIC_MAX_BOOST` uyum puanı); semantik
 *   benzerlik tür/oyuncu/ruh hâli sinyallerinin önüne geçmez.
 * - Analizi olmayan içerik cezalandırılmaz; yalnızca sinyali olanlar hafifçe
 *   öne alınır. Sunucu erişilemezse harita boş kalır ve sıralama değişmez.
 * - Kişiselleştirilmiş "Sana Özel" hattı bu modülü kullanmaz; genel keşif
 *   sıralaması ile kişisel öneri birbirine karıştırılmaz.
 */

import { canonicalizeMediaKey } from './cinetrack-core.ts';

export interface SemanticSignalLike {
  readonly targetKey?: string;
  readonly cosineSimilarity?: number;
  readonly atmosphereSimilarity?: number;
  readonly confidence?: number;
}

/** Semantik katkının uyum puanındaki azami ağırlığı. */
export const SEMANTIC_MAX_BOOST = 8;

function clamp01(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

/**
 * Benzerlik sinyallerini içerik anahtarı → 0..1 afinite haritasına çevirir.
 * Anlamsal kosinüs ana sinyaldir; atmosfer benzerliği varsa %30 ağırlıkla
 * birleşir. Güven (confidence) varsa sonucu ölçekler.
 */
export function buildSemanticAffinityMap(
  signals: readonly SemanticSignalLike[] | null | undefined
): Map<string, number> {
  const map = new Map<string, number>();
  for (const signal of signals || []) {
    const rawKey = typeof signal?.targetKey === 'string' ? signal.targetKey : '';
    if (!/^(movie|tv):\d+$/.test(rawKey)) continue;
    const key = canonicalizeMediaKey(rawKey);
    const cosine = clamp01(signal.cosineSimilarity);
    const atmosphere =
      signal.atmosphereSimilarity === undefined ? null : clamp01(signal.atmosphereSimilarity);
    const blended = atmosphere === null ? cosine : cosine * 0.7 + atmosphere * 0.3;
    const confidence =
      signal.confidence === undefined ? 1 : Math.max(0, Math.min(1, Number(signal.confidence)));
    const value = Math.max(0, Math.min(1, blended * (0.5 + 0.5 * confidence)));
    if (value <= 0) continue;
    map.set(key, Math.max(map.get(key) ?? 0, value));
  }
  return map;
}

export function mergeSemanticAffinityMaps(
  ...maps: Array<ReadonlyMap<string, number> | null | undefined>
): Map<string, number> {
  const merged = new Map<string, number>();
  for (const map of maps) {
    for (const [key, value] of map || []) {
      merged.set(key, Math.max(merged.get(key) ?? 0, value));
    }
  }
  return merged;
}

export function semanticAffinityFor(
  hints: ReadonlyMap<string, number> | null | undefined,
  mediaKey: string
): number {
  if (!hints) return 0;
  return clamp01(hints.get(canonicalizeMediaKey(mediaKey)) ?? 0);
}

/** Uyum puanına eklenecek sınırlı katkı. */
export function semanticBoostFor(
  hints: ReadonlyMap<string, number> | null | undefined,
  mediaKey: string
): number {
  return Math.round(semanticAffinityFor(hints, mediaKey) * SEMANTIC_MAX_BOOST);
}

/**
 * Keşfet sonuçlarını semantik afiniteye göre **kararlı** biçimde yeniden sıralar.
 * Semantik katkı, mevcut sıralama anahtarının yanında ikincil bir anahtardır:
 * kategori kendi doğal sıralamasını (tarih, oy ortalaması) korumak istiyorsa bu
 * fonksiyon çağrılmaz.
 */
export function rankBySemanticAffinity<T extends { id?: unknown; media_type?: unknown }>(
  items: readonly T[],
  hints: ReadonlyMap<string, number> | null | undefined,
  options: { maxBoost?: number } = {}
): T[] {
  if (!Array.isArray(items) || items.length === 0 || !hints || hints.size === 0) {
    return Array.isArray(items) ? [...items] : [];
  }
  const maxBoost = Math.max(0, Math.min(SEMANTIC_MAX_BOOST, options.maxBoost ?? SEMANTIC_MAX_BOOST));
  const decorate = items.map((item, index) => {
    const key = `${(item as { media_type?: string }).media_type === 'tv' ? 'tv' : 'movie'}:${String(
      (item as { id?: unknown }).id
    )}`;
    const affinity = semanticAffinityFor(hints, key);
    return { item, index, boost: Math.round(affinity * maxBoost) };
  });
  decorate.sort((a, b) => (b.boost !== a.boost ? b.boost - a.boost : a.index - b.index));
  return decorate.map((entry) => entry.item);
}
