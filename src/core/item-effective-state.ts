/**
 * Faz 3 — İçerik durumunun tek çözümleyicisi.
 *
 * Aynı içerik hem profilin kütüphanesinde (`items`) hem de tercihlerde
 * (`disliked` / `hidden`) bulunabiliyordu; her modül kendi filtresini yazdığı
 * için öneri, keşif, arama ve dışa aktarma farklı sonuç verebiliyordu.
 *
 * Bu modül tek bir etkin durum tanımlar ve tüm modüller aynı sonucu okur:
 *
 * - `disliked` > `hidden` > `saved` > `available` (öneri/keşif uygunluğu için
 *   kullanıcı tercihi kütüphane kaydından üstündür).
 * - `inLibrary` ayrı bir bayraktır; "ilgilenmiyorum" bir kütüphane durumu
 *   değildir ve kaydı silmez. Tercih geri alınınca içerik yeniden görünür.
 *
 * Silme (`deleted_keys`), gizleme (`hidden`), izleme (`status`) ve
 * ilgilenmeme (`disliked`) birbirine karıştırılmaz.
 */

import {
  canonicalizeMediaKey,
  makeMediaKey,
  type Preferences,
  type Profile,
  type SavedItem,
} from './cinetrack-core.ts';

export type EffectiveItemState = 'saved' | 'disliked' | 'hidden' | 'available';

export interface EffectiveStateInput {
  readonly savedItems?: readonly SavedItem[] | null;
  readonly preferences?: Partial<Preferences> | null;
}

export interface EffectiveItemStateResult {
  readonly state: EffectiveItemState;
  readonly inLibrary: boolean;
  readonly disliked: boolean;
  readonly hidden: boolean;
}

function canonicalSet(keys: readonly string[] | undefined | null): Set<string> {
  const set = new Set<string>();
  for (const key of keys || []) {
    if (typeof key !== 'string' || !key.trim()) continue;
    set.add(canonicalizeMediaKey(key));
  }
  return set;
}

/** Yalnızca anahtar bazlı sorgular için hızlı indeks. */
export interface EffectiveStateIndex {
  readonly savedKeys: ReadonlySet<string>;
  readonly dislikedKeys: ReadonlySet<string>;
  readonly hiddenKeys: ReadonlySet<string>;
}

export function buildEffectiveStateIndex(input: EffectiveStateInput): EffectiveStateIndex {
  const savedKeys = new Set<string>();
  for (const item of input.savedItems || []) {
    if (!item || item.id == null) continue;
    savedKeys.add(canonicalizeMediaKey(makeMediaKey(item)));
  }
  return {
    savedKeys,
    dislikedKeys: canonicalSet(input.preferences?.disliked),
    hiddenKeys: canonicalSet(input.preferences?.hidden),
  };
}

export function resolveStateFromIndex(
  index: EffectiveStateIndex,
  mediaKey: string
): EffectiveItemStateResult {
  const key = canonicalizeMediaKey(mediaKey);
  const inLibrary = index.savedKeys.has(key);
  const disliked = index.dislikedKeys.has(key);
  const hidden = !disliked && index.hiddenKeys.has(key);
  const state: EffectiveItemState = disliked
    ? 'disliked'
    : hidden
    ? 'hidden'
    : inLibrary
    ? 'saved'
    : 'available';
  return { state, inLibrary, disliked, hidden };
}

/** Tek bir içeriğin etkin durumu. */
export function resolveEffectiveItemState(
  input: EffectiveStateInput,
  item: Pick<SavedItem, 'id' | 'media_type'> | Record<string, unknown> | null | undefined
): EffectiveItemStateResult {
  if (!item || (item as SavedItem).id == null) {
    return { state: 'available', inLibrary: false, disliked: false, hidden: false };
  }
  return resolveStateFromIndex(buildEffectiveStateIndex(input), makeMediaKey(item as SavedItem));
}

/** Öneri/keşif listelerinde gösterilmemesi gereken durumlar. */
export function isItemExcludedFromRecommendations(state: EffectiveItemState): boolean {
  return state === 'disliked' || state === 'hidden';
}

/**
 * Tek filtre: ilgilenmiyorum ve gizli içerikleri her öneri/keşif yolundan
 * çıkarır. Kütüphanede olan ama tercihle işaretlenmemiş içerik korunur.
 */
export function filterRecommendableItems<T extends { id?: unknown; media_type?: unknown }>(
  input: EffectiveStateInput,
  items: readonly T[],
  options: { excludeSaved?: boolean } = {}
): T[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const index = buildEffectiveStateIndex(input);
  const out: T[] = [];
  for (const item of items) {
    if (!item || item.id == null) continue;
    const resolved = resolveStateFromIndex(index, makeMediaKey(item as unknown as SavedItem));
    if (isItemExcludedFromRecommendations(resolved.state)) continue;
    if (options.excludeSaved && resolved.inLibrary) continue;
    out.push(item);
  }
  return out;
}

export interface EffectiveStateConflict {
  readonly mediaKey: string;
  readonly title: string;
  readonly state: EffectiveItemState;
  readonly inLibrary: boolean;
}

/**
 * Hem kütüphanede hem tercih listesinde bulunan kayıtları raporlar.
 * Veri silinmez; çakışma görünür kılınır (dışa aktarma ve teşhis için).
 */
export function collectEffectiveStateConflicts(
  profile: Pick<Profile, 'items' | 'preferences'> | null | undefined
): EffectiveStateConflict[] {
  if (!profile) return [];
  const saved = profile.items || [];
  const index = buildEffectiveStateIndex({
    savedItems: saved,
    preferences: profile.preferences,
  });
  const conflicts: EffectiveStateConflict[] = [];
  for (const item of saved) {
    if (!item || item.id == null) continue;
    const key = canonicalizeMediaKey(makeMediaKey(item));
    const resolved = resolveStateFromIndex(index, key);
    if (resolved.state !== 'disliked' && resolved.state !== 'hidden') continue;
    conflicts.push({
      mediaKey: key,
      title: item.title || '',
      state: resolved.state,
      inLibrary: true,
    });
  }
  return conflicts;
}
