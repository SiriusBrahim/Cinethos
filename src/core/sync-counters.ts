/**
 * Aşama 2 (B-39) — Senkronizasyon sayaçlarının tek otoritesi.
 *
 * Önceki kod sayaçları işlem sırasında ad hoc artırıyordu; bazı yerlerde uzak
 * taraftaki **toplam** kayıt sayısı "eklenen" gibi raporlanıyor, türetilmiş
 * profil önbelleği kayıt gibi sayılıyor ve aynı kayıt iki kez sayılabiliyordu.
 *
 * Bu modül sayaçları işlem öncesi/sonrası belgelerden **türetir**:
 *
 * - `added`  : işlem sonrası var olup öncesinde olmayan kayıtlar.
 * - `updated`: iki tarafta da var olup anlamlı alanları değişen kayıtlar.
 * - `skipped`: iki tarafta da var olup hiçbir anlamlı alanı değişmeyen kayıtlar.
 *
 * Kapsam: kullanıcı profili kayıtları, katalog kayıtları ve Sinema Künyesi
 * kayıtları. Türetilmiş profil (`data/profiles/*.json`) bir **önbellek**
 * olduğu için sayaçlara dâhil edilmez; aksi halde aynı içerik iki kez sayılır.
 * Zaman damgası benzeri uçucu alanlar "güncellendi" sayılmaz.
 */

import type { DataDocument, SavedItem } from './cinetrack-core.ts';
import { makeMediaKey } from './keys.ts';

export interface SyncRecordCounts {
  readonly added: number;
  readonly updated: number;
  readonly skipped: number;
}

export const EMPTY_SYNC_RECORD_COUNTS: SyncRecordCounts = Object.freeze({
  added: 0,
  updated: 0,
  skipped: 0,
});

/** Sayaç hesabında dikkate alınan anlamlı kullanıcı kaydı alanları. */
const ITEM_TRACKED_FIELDS = [
  'media_type',
  'title',
  'status',
  'personal_rating',
  'personal_rating_cleared',
  'season_progress',
  'season_episode_counts',
  'genre_ids',
  'overview',
  'poster_path',
  'backdrop_path',
  'isDemo',
] as const;

const VOLATILE_FIELD_PATTERN = /(?:At|_at|updatedAt|lastUpdatedAt|firstStoredAt|syncedAt|generatedAt)$/;

function stableStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(String(value));
  if (seen.has(value as object)) return '"[cycle]"';
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => stableStringify(entry, seen)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => !VOLATILE_FIELD_PATTERN.test(key))
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key], seen)}`)
      .join(',')}}`;
  } finally {
    seen.delete(value as object);
  }
}

function fingerprintItem(item: SavedItem): string {
  const record = item as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of ITEM_TRACKED_FIELDS) {
    picked[field] = record[field] ?? null;
  }
  return stableStringify(picked);
}

function itemKey(profileId: string, item: SavedItem): string {
  const mediaKey = makeMediaKey(item) || `${item?.media_type || '?'}:${item?.id ?? '?'}`;
  return `${profileId}\u0000${mediaKey}`;
}

interface FingerprintSets {
  readonly before: Map<string, string>;
  readonly after: Map<string, string>;
}

function countSetChanges(sets: FingerprintSets): SyncRecordCounts {
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const [key, afterFingerprint] of sets.after) {
    if (!sets.before.has(key)) {
      added += 1;
      continue;
    }
    if (sets.before.get(key) === afterFingerprint) skipped += 1;
    else updated += 1;
  }
  return { added, updated, skipped };
}

export function collectUserDataFingerprints(
  doc: DataDocument | null | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const profile of doc?.profiles ?? []) {
    const profileId = String(profile?.id ?? '');
    for (const item of profile?.items ?? []) {
      map.set(itemKey(profileId, item), fingerprintItem(item));
    }
  }
  return map;
}

export function countUserDataRecordChanges(
  before: DataDocument | null | undefined,
  after: DataDocument | null | undefined
): SyncRecordCounts {
  return countSetChanges({
    before: collectUserDataFingerprints(before),
    after: collectUserDataFingerprints(after),
  });
}

export function countCatalogRecordChanges(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined
): SyncRecordCounts {
  const toFingerprints = (map: Record<string, unknown> | null | undefined) => {
    const result = new Map<string, string>();
    for (const [key, value] of Object.entries(map ?? {})) {
      result.set(key, stableStringify(value));
    }
    return result;
  };
  return countSetChanges({ before: toFingerprints(before), after: toFingerprints(after) });
}

export function countCinemaKunyeRecordChanges(
  before: { entries?: Record<string, unknown> | null } | null | undefined,
  after: { entries?: Record<string, unknown> | null } | null | undefined
): SyncRecordCounts {
  return countCatalogRecordChanges(before?.entries ?? null, after?.entries ?? null);
}

interface KeyChangeSets {
  readonly added: Set<string>;
  readonly updated: Set<string>;
  readonly skipped: Set<string>;
}

function emptyKeySets(): KeyChangeSets {
  return { added: new Set(), updated: new Set(), skipped: new Set() };
}

function keySetsFromFingerprints(
  before: Map<string, string>,
  after: Map<string, string>,
  prefix: string
): KeyChangeSets {
  const sets = emptyKeySets();
  for (const [key, afterFingerprint] of after) {
    const scoped = `${prefix}${key}`;
    if (!before.has(key)) {
      sets.added.add(scoped);
    } else if (before.get(key) === afterFingerprint) {
      sets.skipped.add(scoped);
    } else {
      sets.updated.add(scoped);
    }
  }
  return sets;
}

function mergeKeySets(...sets: readonly KeyChangeSets[]): KeyChangeSets {
  const merged = emptyKeySets();
  for (const set of sets) {
    for (const key of set.added) merged.added.add(key);
    for (const key of set.updated) merged.updated.add(key);
    for (const key of set.skipped) merged.skipped.add(key);
  }
  return merged;
}

function catalogFingerprints(
  map: Record<string, unknown> | null | undefined
): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, value] of Object.entries(map ?? {})) {
    result.set(key, stableStringify(value));
  }
  return result;
}

function sideKeyChanges(
  before: SyncCounterSide | null | undefined,
  after: SyncCounterSide | null | undefined
): KeyChangeSets {
  return mergeKeySets(
    keySetsFromFingerprints(
      collectUserDataFingerprints(before?.userData),
      collectUserDataFingerprints(after?.userData),
      'user\u0000'
    ),
    keySetsFromFingerprints(
      catalogFingerprints(before?.movies),
      catalogFingerprints(after?.movies),
      'movie\u0000'
    ),
    keySetsFromFingerprints(
      catalogFingerprints(before?.tv),
      catalogFingerprints(after?.tv),
      'tv\u0000'
    ),
    keySetsFromFingerprints(
      catalogFingerprints(before?.cinemaKunye?.entries),
      catalogFingerprints(after?.cinemaKunye?.entries),
      'kunye\u0000'
    )
  );
}

function intersectKeySets(a: Set<string>, b: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const key of a) {
    if (b.has(key)) result.add(key);
  }
  return result;
}

export function combineSyncRecordCounts(...counts: readonly SyncRecordCounts[]): SyncRecordCounts {
  return counts.reduce<SyncRecordCounts>(
    (acc, entry) => ({
      added: acc.added + entry.added,
      updated: acc.updated + entry.updated,
      skipped: acc.skipped + entry.skipped,
    }),
    { added: 0, updated: 0, skipped: 0 }
  );
}

export interface SyncCounterSide {
  readonly userData?: DataDocument | null;
  readonly movies?: Record<string, unknown> | null;
  readonly tv?: Record<string, unknown> | null;
  readonly cinemaKunye?: { entries?: Record<string, unknown> | null } | null;
}

export interface SyncCounterInput {
  readonly localBefore?: SyncCounterSide | null;
  readonly localAfter?: SyncCounterSide | null;
  readonly remoteBefore?: SyncCounterSide | null;
  readonly remoteAfter?: SyncCounterSide | null;
}

/**
 * İşlem öncesi/sonrası yerel ve uzak taraflardan rapor sayaçlarını üretir.
 *
 * Anahtar düzeyinde birleşim uygulanır:
 * - Bir kayıt bir tarafta eklendiyse **eklendi** sayılır; diğer tarafta zaten
 *   var olması onu ayrıca "değişmeyen" yapmaz (çift sayım yok).
 * - `skipped` yalnızca **her iki tarafta da** değişmeden duran kayıtlardır.
 * - `remoteAfter` bilinmiyorsa (taşıma hatası) yalnızca yerel taraf sayılır.
 */
export function buildBidirectionalSyncCounters(input: SyncCounterInput): SyncRecordCounts {
  const sides: KeyChangeSets[] = [];
  if (input.localBefore !== undefined || input.localAfter !== undefined) {
    sides.push(sideKeyChanges(input.localBefore, input.localAfter));
  }
  if (input.remoteBefore !== undefined || input.remoteAfter !== undefined) {
    sides.push(sideKeyChanges(input.remoteBefore, input.remoteAfter));
  }
  if (sides.length === 0) return { ...EMPTY_SYNC_RECORD_COUNTS };

  const added = new Set<string>();
  const updated = new Set<string>();
  for (const side of sides) {
    for (const key of side.added) added.add(key);
    for (const key of side.updated) updated.add(key);
  }

  let skipped = new Set<string>(sides[0].skipped);
  for (const side of sides.slice(1)) {
    skipped = intersectKeySets(skipped, side.skipped);
  }
  for (const key of added) skipped.delete(key);
  for (const key of updated) skipped.delete(key);

  return {
    added: added.size,
    updated: updated.size,
    skipped: skipped.size,
  };
}
