import {
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeDataDocument,
  buildTasteProfileV3,
  collectDataLimitViolations,
  makeMediaKey,
  normalizeProfileId,
  CURRENT_SCHEMA_VERSION,
  ENGINE_VERSION,
  type DataDocument,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import {
  areUserDataDocumentsSemanticallyEqual,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';
import {
  DEFAULT_MAX_DATA_BYTES,
  DEFAULT_MAX_ITEMS_PER_PROFILE,
  DEFAULT_MAX_PROFILES,
  DEFAULT_MAX_SNAPSHOTS,
  formatMaxDataLimitMb,
  measureUtf8Bytes,
} from '../core/limits.ts';
import {
  cleanupStaleTempFiles,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
  tryParseValidJson,
  tryParseValidJsonAsync,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
} from './atomic-json.ts';
import {
  createSqlitePrimaryStore,
  resolveStorageDriver,
  type StorageDriver,
} from './sqlite-primary-store.ts';
import { assertSafeDataDir, assertSafeWritePath } from './test-data-guard.ts';
export interface StorageOptions {
  dataDir?: string;
  maxDataBytes?: number;
  maxProfiles?: number;
  maxItemsPerProfile?: number;
  maxSnapshots?: number;
  /** 'sqlite' seçildiğinde SQLite asıl kaynak, JSON yedek/taşınabilir kopya olur. */
  storageDriver?: StorageDriver;
}

export interface BackupMetadata {
  id: string;
  createdAt: string;
  revision: number;
  profilesCount: number;
  itemsCount: number;
}

export interface RestoreBackupOptions {
  expectedRevision?: number | null;
  hasInvalidIfMatch?: boolean;
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
}

export type RestoreBackupResult =
  | { ok: true; document: DataDocument }
  | {
      ok: false;
      status: 400 | 404 | 409 | 412 | 428 | 500;
      code:
        | 'backup_not_found'
        | 'revision_conflict'
        | 'precondition_required'
        | 'restore_failed';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
    };

export interface SaveDataOptions {
  expectedRevision?: number | null;
  expectedProfileId?: string;
  strictProfileMatch?: boolean;
  confirmBulkDelete?: boolean;
  requirePrecondition?: boolean;
  forceOverwrite?: boolean;
  hasInvalidIfMatch?: boolean;
  mergeStrategy?: 'lossless';
  foldUnhydratedDefaultProfile?: boolean;
}

export type SaveDataResult =
  | {
      ok: true;
      document: DataDocument;
      totalItems: number;
      merged?: boolean;
    }
  | {
      ok: false;
      status: 400 | 409 | 412 | 413 | 428 | 500;
      code:
        | 'invalid_document'
        | 'revision_conflict'
        | 'profile_conflict'
        | 'precondition_required'
        | 'sudden_item_drop'
        | 'item_drop'
        | 'profile_drop'
        | 'profile_metadata_drop'
        | 'tombstone_drop'
        | 'limits_exceeded'
        | 'payload_too_large'
        | 'corrupt_storage';
      message: string;
      currentRevision?: number;
      expectedRevision?: number;
      existingItems?: number;
      incomingItems?: number;
      serverDocument?: DataDocument;
    };

export function countTotalItems(doc: DataDocument | null | undefined): number {
  if (!doc || !Array.isArray(doc.profiles)) return 0;
  return doc.profiles.reduce(
    (sum, profile) => sum + (Array.isArray(profile.items) ? profile.items.length : 0),
    0
  );
}

function isWorthKeeping(doc: DataDocument): boolean {
  const profiles = Array.isArray(doc.profiles) ? doc.profiles : [];
  return (
    profiles.length > 0 &&
    (profiles.some((profile) => Array.isArray(profile?.items) && profile.items.length > 0) ||
      profiles.length > 1 ||
      (doc.revision ?? 0) > 0)
  );
}

const SNAPSHOT_FILE_PATTERN = /^cinetrack-[a-zA-Z0-9._-]+\.json$/;

/**
 * Aşama 1 (B-09) — profil kapsamlı veri kaybı istatistikleri.
 *
 * Anahtarlar `profileId` ile kapsamlandırılır (`profileId\u0000mediaKey`).
 * Global bir `Set` kullanılırsa aynı içerik başka bir profilde durduğu sürece
 * bir profilden silinen kayıt görünmez olur; bu kabul edilemez.
 */
interface ProfileLossStats {
  /** mediaKey -> en yeni etkileşim zamanı (ms). */
  items: Map<string, number>;
  /** mediaKey -> silme (tombstone) zamanı (ms). */
  tombstones: Map<string, number>;
  itemCount: number;
  hasMetadata: boolean;
}

interface DocumentLossStats {
  profiles: Map<string, ProfileLossStats>;
  uniqueItems: number;
  itemKeys: Set<string>;
  tombstones: number;
}

/** Bir kaydın bilinen en yeni etkileşim zamanı; yoksa 0. */
function itemInteractionTimestamp(item: any): number {
  const candidates = [item?.watchedAt, item?.updatedAt, item?.addedAt, item?.firstAddedAt];
  let newest = 0;
  for (const value of candidates) {
    if (typeof value !== 'string' || !value) continue;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > newest) newest = parsed;
  }
  return newest;
}

function tombstoneTimestamp(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Bir profilin içerik dışı anlamlı metaverisi var mı? */
function profileHasMetadata(profile: any): boolean {
  if (!profile || typeof profile !== 'object') return false;
  if (typeof profile.name === 'string' && profile.name.trim()) return true;
  if (typeof profile.createdAt === 'string' && profile.createdAt.trim()) return true;
  if (Array.isArray(profile.favoriteActors) && profile.favoriteActors.length > 0) return true;
  if (profile.cinemaKunye && typeof profile.cinemaKunye === 'object') return true;
  if (profile.settings && typeof profile.settings === 'object') return true;
  const preferences = profile.preferences;
  if (preferences && typeof preferences === 'object') {
    if (Array.isArray(preferences.disliked) && preferences.disliked.length > 0) return true;
    if (Array.isArray(preferences.providers) && preferences.providers.length > 0) return true;
    if (typeof preferences.mood === 'string' && preferences.mood.trim()) return true;
    if (preferences.reminders === true) return true;
    if (Array.isArray(preferences.notified) && preferences.notified.length > 0) return true;
  }
  return false;
}

/** Aşama 1 (B-09) — veri kaybı koruması için profil kapsamlı istatistikler. */
function collectDocumentLossStats(doc: DataDocument | null | undefined): DocumentLossStats {
  const profiles = new Map<string, ProfileLossStats>();
  const itemKeys = new Set<string>();
  let tombstones = 0;

  for (const profile of Array.isArray(doc?.profiles) ? doc.profiles : []) {
    const id = normalizeProfileId(profile?.id) ?? String(profile?.id ?? '');
    const items = Array.isArray(profile?.items) ? profile.items : [];
    const deletedKeys =
      profile?.deleted_keys && typeof profile.deleted_keys === 'object'
        ? (profile.deleted_keys as Record<string, unknown>)
        : {};

    const scopedItems = new Map<string, number>();
    for (const item of items) {
      const key = makeMediaKey(item);
      itemKeys.add(key);
      scopedItems.set(key, Math.max(scopedItems.get(key) ?? 0, itemInteractionTimestamp(item)));
    }
    const scopedTombstones = new Map<string, number>();
    for (const [key, value] of Object.entries(deletedKeys)) {
      scopedTombstones.set(key, Math.max(scopedTombstones.get(key) ?? 0, tombstoneTimestamp(value)));
    }
    tombstones += Object.keys(deletedKeys).length;

    // Aynı profil kimliği birden fazla kez görünürse (bozuk/legacy belge)
    // istatistikler birleştirilir; hiçbir kayıt sessizce düşürülmez.
    const existing = profiles.get(id);
    if (existing) {
      for (const [key, ts] of scopedItems) {
        existing.items.set(key, Math.max(existing.items.get(key) ?? 0, ts));
      }
      for (const [key, ts] of scopedTombstones) {
        existing.tombstones.set(key, Math.max(existing.tombstones.get(key) ?? 0, ts));
      }
      existing.itemCount += items.length;
      existing.hasMetadata = existing.hasMetadata || profileHasMetadata(profile);
      continue;
    }

    profiles.set(id, {
      items: scopedItems,
      tombstones: scopedTombstones,
      itemCount: items.length,
      hasMetadata: profileHasMetadata(profile),
    });
  }

  return { profiles, uniqueItems: itemKeys.size, itemKeys, tombstones };
}

function formatSnapshotFileName(revision: number): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(16).slice(2, 6);
  return `cinetrack-${stamp}-rev${revision}-${suffix}.json`;
}

export function createDataStorage(options: StorageOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError(
      "createDataStorage tek bir nesne parametresi bekler: createDataStorage({ dataDir }). " +
        "Eski iki argümanlı çağrı (createDataStorage(dataFile, {...})) artık desteklenmiyor."
    );
  }
  // Aşama 1 — test ortamı gerçek `data/` ağacına yazamaz; `dataDir` zorunludur (B-14).
  assertSafeDataDir(options.dataDir, 'data-storage');
  const resolvedDataDir = path.resolve(options.dataDir || path.join(process.cwd(), 'data'));
  const dataFile = path.join(resolvedDataDir, 'cinetrack-data.json');
  const backupFile = `${dataFile}.bak`;
  const isolatedProfileFile = path.join(resolvedDataDir, 'profile.json');
  const isolatedUserListsFile = path.join(resolvedDataDir, 'user-lists.json');
  const backupsDir = path.join(resolvedDataDir, 'backups');

  const maxDataBytes = options.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  const maxProfiles = options.maxProfiles ?? DEFAULT_MAX_PROFILES;
  const maxItemsPerProfile = options.maxItemsPerProfile ?? DEFAULT_MAX_ITEMS_PER_PROFILE;
  const maxSnapshots = Math.max(1, options.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);

  mkdirSync(resolvedDataDir, { recursive: true });
  mkdirSync(backupsDir, { recursive: true });
  cleanupStaleTempFiles(resolvedDataDir);
  cleanupStaleTempFiles(backupsDir);

  let unrecoverableCorruptionError: string | null = null;
  let writeQueue: Promise<unknown> = Promise.resolve();
  // Aşama 1 (B-04) — diskteki belge limitleri aşıyorsa yazma engellenir.
  let readLimitViolations: string[] = [];

  // Faz 7 — SQLite birincil kaynak (opt-in). JSON her zaman yedek olarak yazılır.
  const primaryStore = createSqlitePrimaryStore({
    dataDir: resolvedDataDir,
    enabled: (options.storageDriver ?? resolveStorageDriver()) === 'sqlite',
  });

  function serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task);
    writeQueue = run.catch(() => undefined);
    return run;
  }

  function emptyDocument(): DataDocument {
    return {
      version: 3,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      activeProfileId: '',
      profiles: [],
      revision: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  function validateRawDocument(raw: unknown): DataDocument | null {
    if (!raw || typeof raw !== 'object') return null;
    const obj = raw as Record<string, unknown>;
    // B-04: limit aşan belge okunurken kırpılmaz; yüksek limitlerle normalize
    // edilir ve yazma, ihlal giderilene kadar engellenir (`readLimitViolations`).
    const violations = collectDataLimitViolations(raw, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (violations.length > 0) readLimitViolations = violations;

    const rawProfiles = Array.isArray(obj.profiles)
      ? (obj.profiles as unknown[])
      : Array.isArray(obj.items)
      ? [obj]
      : [];
    let rawMaxItems = 0;
    for (const profile of rawProfiles) {
      const items = (profile as Record<string, unknown> | null)?.items;
      if (Array.isArray(items)) rawMaxItems = Math.max(rawMaxItems, items.length);
    }

    const normalized = normalizeDataDocument(raw, {
      maxProfiles: Math.max(maxProfiles, rawProfiles.length),
      maxItems: Math.max(maxItemsPerProfile, rawMaxItems),
    });
    if (!normalized) return null;
    const rawRev = Number(obj.revision);
    normalized.revision = Number.isSafeInteger(rawRev) && rawRev >= 0 ? rawRev : 0;
    normalized.updatedAt =
      typeof obj.updatedAt === 'string' && obj.updatedAt ? obj.updatedAt : undefined;
    return normalized;
  }

  function listDiskSnapshotFilesNewestFirstSync(): string[] {
    if (!existsSync(backupsDir)) return [];
    try {
      return readdirSync(backupsDir)
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  async function listDiskSnapshotFilesNewestFirstAsync(): Promise<string[]> {
    try {
      const entries = await fsPromises.readdir(backupsDir);
      return entries
        .filter((f) => f.startsWith('cinetrack-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
    } catch {
      return [];
    }
  }

  function getDiskRecoveryBackupPathsSync(): string[] {
    const snaps = listDiskSnapshotFilesNewestFirstSync().map((f) => path.join(backupsDir, f));
    return [backupFile, ...snaps];
  }

  async function getDiskRecoveryBackupPathsAsync(): Promise<string[]> {
    const snaps = (await listDiskSnapshotFilesNewestFirstAsync()).map((f) =>
      path.join(backupsDir, f)
    );
    return [backupFile, ...snaps];
  }

  function readJsonData(): DataDocument {
    const recovery = readJsonFileWithRecovery<DataDocument>(dataFile, {
      backupPaths: getDiskRecoveryBackupPathsSync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  async function readJsonDataAsync(): Promise<DataDocument> {
    const recovery = await readJsonFileWithRecoveryAsync<DataDocument>(dataFile, {
      backupPaths: await getDiskRecoveryBackupPathsAsync(),
      validate: validateRawDocument,
      label: 'cinetrack-data.json',
    });
    if (recovery.status === 'missing') {
      unrecoverableCorruptionError = null;
      return emptyDocument();
    }
    if (recovery.status === 'corrupt_unrecoverable') {
      unrecoverableCorruptionError = recovery.error;
      return emptyDocument();
    }
    unrecoverableCorruptionError = null;
    return recovery.data;
  }

  /**
   * JSON ile SQLite arasındaki birincil kaynak seçimi.
   * - SQLite boşsa mevcut JSON dokümanı tek seferlik migrate edilir.
   * - JSON revizyonu daha yüksekse (ör. SQLite silinmişse) JSON kazanır ve SQLite güncellenir.
   * - Aksi halde SQLite asıl kaynak kabul edilir.
   */
  function selectPrimaryDocument(jsonDoc: DataDocument): DataDocument {
    if (!primaryStore.enabled || !primaryStore.available) return jsonDoc;
    const row = primaryStore.read();
    if (!row) {
      if ((jsonDoc.revision ?? 0) > 0 || (jsonDoc.profiles?.length ?? 0) > 0) {
        primaryStore.write(jsonDoc, jsonDoc.revision ?? 0);
      }
      return jsonDoc;
    }
    const sqliteDoc = validateRawDocument(row.document);
    if (!sqliteDoc) return jsonDoc;
    sqliteDoc.revision = row.revision;
    if (row.updatedAt) sqliteDoc.updatedAt = row.updatedAt;
    if ((jsonDoc.revision ?? 0) > row.revision) {
      primaryStore.write(jsonDoc, jsonDoc.revision ?? 0);
      return jsonDoc;
    }
    unrecoverableCorruptionError = null;
    return sqliteDoc;
  }

  function readData(): DataDocument {
    return selectPrimaryDocument(readJsonData());
  }

  async function readDataAsync(): Promise<DataDocument> {
    return selectPrimaryDocument(await readJsonDataAsync());
  }

  function buildIsolatedProfilePayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      profiles: (doc.profiles || []).map((p) => {
        const taste = buildTasteProfileV3(p.items || [], {
          dislikedKeys: p.preferences?.disliked || [],
        });
        return {
          profileId: p.id,
          name: p.name,
          theme: 'dark-navy',
          dna: {
            positiveGenres: taste.positiveGenres.slice(0, 6),
            mediaPreference: taste.mediaPreference,
          },
          preferences: p.preferences,
          favoriteActors: p.favoriteActors || [],
          isDemo: Boolean(p.isDemo),
        };
      }),
    };
  }

  function toCompactListItem(it: SavedItem) {
    return {
      id: it.id,
      media_type: it.media_type,
      status: it.status,
      personal_rating: it.personal_rating,
      ...(it.addedAt ? { addedAt: it.addedAt } : {}),
      ...(it.updatedAt ? { updatedAt: it.updatedAt } : {}),
      ...(it.custom ? { custom: true } : {}),
      ...(it.current_season !== undefined ? { current_season: it.current_season } : {}),
      ...(it.episodes_watched !== undefined ? { episodes_watched: it.episodes_watched } : {}),
      ...(it.season_progress ? { season_progress: it.season_progress } : {}),
    };
  }

  function buildIsolatedUserListsPayload(doc: DataDocument) {
    const nowIso = doc.updatedAt || new Date().toISOString();
    const lists: Record<string, ReturnType<typeof toCompactListItem>[]> = {};
    for (const p of doc.profiles || []) {
      lists[p.id] = Array.isArray(p.items) ? p.items.map(toCompactListItem) : [];
    }
    return {
      schemaVersion: doc.schemaVersion ?? CURRENT_SCHEMA_VERSION,
      activeProfileId: doc.activeProfileId,
      updatedAt: nowIso,
      lists,
    };
  }

  async function readIsolatedProfileAsync() {
    return buildIsolatedProfilePayload(await readDataAsync());
  }

  async function readIsolatedUserListsAsync() {
    return buildIsolatedUserListsPayload(await readDataAsync());
  }

  function validateAndPrepareSave(
    current: DataDocument,
    rawPayload: unknown,
    saveOptions: SaveDataOptions
  ):
    | { ok: true; documentToPersist: DataDocument; incomingItems: number; merged: boolean }
    | Extract<SaveDataResult, { ok: false }> {
    if (unrecoverableCorruptionError) {
      return {
        ok: false,
        status: 500,
        code: 'corrupt_storage',
        message: `Mevcut veri bozuk olduğu ve geçerli bir yedek bulunamadığı için üzerine yazma engellendi (${unrecoverableCorruptionError}).`,
      };
    }

    if (readLimitViolations.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'limits_exceeded',
        message:
          `Diskteki veri yapılandırılmış limitleri aşıyor; kırpılmış bir belge kaydedilmedi: ` +
          `${readLimitViolations.join('; ')}. Veri kaybını önlemek için yazma engellendi.`,
      };
    }

    let rawBytes = 0;
    try {
      rawBytes = measureUtf8Bytes(JSON.stringify(rawPayload ?? null));
    } catch {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    if (rawBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    // B-04: gönderilen belge limitleri aşıyorsa sessizce kırpma yerine reddet.
    const incomingLimitViolations = collectDataLimitViolations(rawPayload, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (incomingLimitViolations.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'limits_exceeded',
        message: `Gönderilen veri limitleri aşıyor ve sessizce kırpılmadı: ${incomingLimitViolations.join('; ')}.`,
      };
    }

    const normalized = normalizeDataDocument(rawPayload, {
      maxProfiles,
      maxItems: maxItemsPerProfile,
    });
    if (!normalized) {
      return {
        ok: false,
        status: 400,
        code: 'invalid_document',
        message: 'Veri biçimi geçersiz.',
      };
    }

    const currentRevision = current.revision ?? 0;
    const expectedRevision = saveOptions.expectedRevision;

    if (saveOptions.strictProfileMatch || saveOptions.expectedProfileId) {
      const expectedPid = typeof saveOptions.expectedProfileId === 'string'
        ? saveOptions.expectedProfileId.trim()
        : '';
      if (!expectedPid || normalized.activeProfileId !== expectedPid) {
        return {
          ok: false,
          status: 409,
          code: 'profile_conflict',
          message: `Profil uyuşmazlığı: beklenen '${expectedPid || 'bilinmiyor'}', gelen '${normalized.activeProfileId || 'bilinmiyor'}'.`,
          currentRevision,
          serverDocument: current,
        };
      }
    }

    if (saveOptions.hasInvalidIfMatch) {
      return {
        ok: false,
        status: 412,
        code: 'revision_conflict',
        message: `Geçersiz If-Match başlığı gönderildi (mevcut rev-${currentRevision}).`,
        currentRevision,
        serverDocument: current,
      };
    }

    const useLosslessMerge =
      saveOptions.mergeStrategy === 'lossless' &&
      !saveOptions.forceOverwrite &&
      !saveOptions.confirmBulkDelete;

    if (useLosslessMerge) {
      let effectiveDoc: DataDocument = normalized;
      let mergedFlag = false;

      if (Array.isArray(current.profiles) && current.profiles.length > 0) {
        const isMatchingRevision =
          expectedRevision !== undefined &&
          expectedRevision !== null &&
          Number.isSafeInteger(expectedRevision) &&
          expectedRevision === currentRevision &&
          !saveOptions.foldUnhydratedDefaultProfile;

        const mergeOutcome = reconcileUserDataDocumentsLossless(normalized, current, {
          foldUnhydratedDefaultProfile: saveOptions.foldUnhydratedDefaultProfile,
          authoritativeScalarSide: isMatchingRevision ? 'local' : 'union',
        });
        effectiveDoc = mergeOutcome.mergedDoc;
        mergedFlag = !areUserDataDocumentsSemanticallyEqual(normalized, effectiveDoc);
      }

      const nextRevision = currentRevision + 1;
      const nowIso = new Date().toISOString();
      const documentToPersist: DataDocument = {
        ...effectiveDoc,
        revision: nextRevision,
        updatedAt: nowIso,
      };

      const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
      if (persistedBytes > maxDataBytes) {
        return {
          ok: false,
          status: 413,
          code: 'payload_too_large',
          message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
        };
      }

      return {
        ok: true,
        documentToPersist,
        incomingItems: countTotalItems(documentToPersist),
        merged: mergedFlag,
      };
    }

    if (
      expectedRevision !== undefined &&
      expectedRevision !== null &&
      Number.isSafeInteger(expectedRevision)
    ) {
      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          status: currentRevision === 0 ? 412 : 409,
          code: 'revision_conflict',
          message: `Sunucuda daha güncel veya farklı bir veri sürümü var (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}).`,
          currentRevision,
          expectedRevision,
          serverDocument: current,
        };
      }
    } else if (
      saveOptions.requirePrecondition &&
      !saveOptions.forceOverwrite &&
      currentRevision > 0
    ) {
      return {
        ok: false,
        status: 428,
        code: 'precondition_required',
        message: `Mevcut sunucu verisinin (rev-${currentRevision}) üzerine koşulsuz yazma engellendi. If-Match başlığı gönderin veya açık üzerine yazma onayı verin.`,
        currentRevision,
        serverDocument: current,
      };
    }

    const existingItems = countTotalItems(current);
    const incomingItems = countTotalItems(normalized);

    if (!saveOptions.confirmBulkDelete) {
      const before = collectDocumentLossStats(current);
      const after = collectDocumentLossStats(normalized);

      // 1) Profil kaybı ve profil metaverisi kaybı (profil kimliği bazlı).
      //    Boş bir profilin silinmesi bile kayıptır: ad, tercihler, favori
      //    oyuncular ve CinemaKünye verisi kayıt sayısından bağımsızdır.
      const droppedProfilesWithItems: string[] = [];
      const droppedProfilesMetadataOnly: string[] = [];
      for (const [id, stats] of before.profiles) {
        if (after.profiles.has(id)) continue;
        if (stats.itemCount > 0) {
          droppedProfilesWithItems.push(`${id} (${stats.itemCount} kayıt)`);
        } else if (stats.hasMetadata) {
          droppedProfilesMetadataOnly.push(id);
        }
      }

      if (droppedProfilesWithItems.length > 0) {
        return {
          ok: false,
          status: 409,
          code: 'profile_drop',
          message: `Profil kaybı koruması devreye girdi: ${droppedProfilesWithItems.join(
            ', '
          )} gelen belgede yok. Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems,
          currentRevision,
          serverDocument: current,
        };
      }

      if (droppedProfilesMetadataOnly.length > 0) {
        return {
          ok: false,
          status: 409,
          code: 'profile_metadata_drop',
          message: `Profil metaverisi kaybı koruması devreye girdi: ${droppedProfilesMetadataOnly.join(
            ', '
          )} profili gelen belgede yok (kayıt sayısı sıfır olsa bile profil bilgisi kaybı kabul edilmez). Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems,
          currentRevision,
          serverDocument: current,
        };
      }

      // 2) Tombstone kaybı: profil bazında anahtar karşılaştırması.
      //    Toplam sayının aynı kalması yeterli değildir; hangi işaretin
      //    kaybolduğu ve başka bir profile taşınıp taşınmadığı önemlidir.
      const lostTombstonesByProfile: string[] = [];
      let lostTombstoneCount = 0;
      for (const [id, stats] of before.profiles) {
        const afterStats = after.profiles.get(id);
        if (!afterStats) continue; // profil kaybı yukarıda reddedildi
        const lost: string[] = [];
        for (const [key, deletedAt] of stats.tombstones) {
          if (afterStats.tombstones.has(key)) continue;
          const readdedAt = afterStats.items.get(key);
          // Meşru yeniden ekleme: kayıt, silme zamanından daha yeni bir
          // etkileşimle geri getirilmişse tombstone temizlenebilir.
          if (readdedAt !== undefined && readdedAt > deletedAt) continue;
          lost.push(key);
        }
        if (lost.length === 0) continue;
        lostTombstoneCount += lost.length;
        lostTombstonesByProfile.push(`${id} (${lost.length} işaret)`);
      }

      if (lostTombstoneCount > 0) {
        return {
          ok: false,
          status: 409,
          code: 'tombstone_drop',
          message: `Silme işaretleri (tombstone) kaybı koruması devreye girdi: ${lostTombstonesByProfile.join(
            ', '
          )} kayboldu (${before.tombstones} işaretten ${after.tombstones} işarete düşüş). Silinen kayıtlar geri dirilebilir; toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems,
          currentRevision,
          serverDocument: current,
        };
      }

      // 3) Profil bazında kayıt kaybı. Global toplam, başka bir profildeki
      //    aynı içerikle maskelenemez (B-09).
      const suspiciousProfiles: Array<{
        id: string;
        removed: number;
        beforeCount: number;
        emptied: boolean;
      }> = [];
      let removedTotal = 0;
      let addedTotal = 0;

      for (const [id, stats] of before.profiles) {
        const afterStats = after.profiles.get(id);
        if (!afterStats) continue;
        const removed = [...stats.items.keys()].filter((key) => !afterStats.items.has(key));
        const added = [...afterStats.items.keys()].filter((key) => !stats.items.has(key));
        removedTotal += removed.length;
        addedTotal += added.length;
        if (removed.length === 0) continue;

        // Meşru silme: kaldırılan kaydın tombstone'u aynı profilde kayıtlıysa
        // kullanıcı bilinçli silmiştir; bu kayıp olarak sayılmaz.
        const uncovered = removed.filter((key) => !afterStats.tombstones.has(key));
        if (uncovered.length === 0) continue;

        const beforeCount = stats.items.size;
        const emptied = uncovered.length === beforeCount && beforeCount > 0;
        const largeDrop = uncovered.length >= 3 && uncovered.length >= beforeCount * 0.5;
        // Tek kaydın bilinçli silinmesi meşru bir kullanıcı işlemidir ve
        // tombstone yazmayan istemcilerde kayıptan ayırt edilemez. Bu yüzden
        // tek kayıplık boşalma yalnızca aynı içerik başka bir profilde durup
        // kaybı maskeliyorsa (B-09) ya da profil en az iki kayıtla tamamen
        // boşaltıldıysa kayıp sayılır.
        const sharedWithOtherProfile = uncovered.some((key) => {
          for (const [otherId, otherStats] of before.profiles) {
            if (otherId === id) continue;
            if (otherStats.items.has(key)) return true;
          }
          return false;
        });
        const suspicious =
          largeDrop || (emptied && beforeCount >= 2) || (emptied && sharedWithOtherProfile);
        if (!suspicious) continue;
        suspiciousProfiles.push({ id, removed: uncovered.length, beforeCount, emptied });
      }

      const largeItemDrops = suspiciousProfiles.filter((entry) => entry.removed >= 3);
      if (largeItemDrops.length > 0) {
        const detail = largeItemDrops
          .map((entry) => `${entry.id} (${entry.removed}/${entry.beforeCount} kayıt silindi)`)
          .join(', ');
        return {
          ok: false,
          status: 409,
          code: 'sudden_item_drop',
          message: `Ani veri kaybı koruması devreye girdi: ${detail}. ${removedTotal} silindi, ${addedTotal} eklendi. Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems: after.uniqueItems,
          currentRevision,
          serverDocument: current,
        };
      }

      if (suspiciousProfiles.length > 0) {
        const detail = suspiciousProfiles
          .map(
            (entry) =>
              `${entry.id} (${entry.removed}/${entry.beforeCount} kayıt silindi${
                entry.emptied ? ', profil boşaldı' : ''
              })`
          )
          .join(', ');
        return {
          ok: false,
          status: 409,
          code: 'item_drop',
          message: `Kayıt kaybı koruması devreye girdi: ${detail}. Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems: after.uniqueItems,
          currentRevision,
          serverDocument: current,
        };
      }

      // 4) Yedek kontrol: toplam sayıya dayalı ani düşüş.
      const legacyDrop =
        existingItems >= 5 &&
        existingItems - incomingItems >= 3 &&
        incomingItems < existingItems * 0.5;

      if (legacyDrop) {
        return {
          ok: false,
          status: 409,
          code: 'sudden_item_drop',
          message: `Ani veri kaybı koruması devreye girdi (${before.uniqueItems} kayıttan ${after.uniqueItems} kayda düşüş; ${removedTotal} silindi, ${addedTotal} eklendi). Toplu silmeyi onaylayın veya sunucu verisini yükleyin.`,
          existingItems,
          incomingItems: after.uniqueItems,
          currentRevision,
          serverDocument: current,
        };
      }
    }

    const nextRevision = currentRevision + 1;
    const nowIso = new Date().toISOString();
    const documentToPersist: DataDocument = {
      ...normalized,
      revision: nextRevision,
      updatedAt: nowIso,
    };

    const persistedBytes = measureUtf8Bytes(JSON.stringify(documentToPersist, null, 2));
    if (persistedBytes > maxDataBytes) {
      return {
        ok: false,
        status: 413,
        code: 'payload_too_large',
        message: `Gönderilen veri boyutu izin verilen sınırı (${formatMaxDataLimitMb(maxDataBytes)}) aşıyor.`,
      };
    }

    return { ok: true, documentToPersist, incomingItems, merged: false };
  }

  function writeDiskSnapshotSync(doc: DataDocument): void {
    mkdirSync(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    assertSafeWritePath(snapPath, 'data-storage');
    writeJsonFileAtomic(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = listDiskSnapshotFilesNewestFirstSync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        unlinkSync(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  async function writeDiskSnapshotAsync(doc: DataDocument): Promise<void> {
    await fsPromises.mkdir(backupsDir, { recursive: true });
    const snapName = formatSnapshotFileName(doc.revision ?? 0);
    const snapPath = path.join(backupsDir, snapName);
    assertSafeWritePath(snapPath, 'data-storage');
    await writeJsonFileAtomicAsync(snapPath, JSON.stringify(doc, null, 2), {
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    const allSnaps = await listDiskSnapshotFilesNewestFirstAsync();
    for (const staleName of allSnaps.slice(maxSnapshots)) {
      try {
        await fsPromises.unlink(path.join(backupsDir, staleName));
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  function persistDocumentDiskSync(current: DataDocument, next: DataDocument): void {
    // Aşama 1 (B-14) — yazma anında yeniden doğrulama: doğrulamadan sonra bir
    // dizin sembolik bağlantıya çevrilmişse gerçek data/ ağacına yazılamaz.
    assertSafeWritePath(dataFile, 'data-storage');
    assertSafeDataDir(backupsDir, 'data-storage');
    if (isWorthKeeping(current)) {
      writeDiskSnapshotSync(current);
    }
    writeJsonFileAtomic(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    if (primaryStore.enabled) {
      primaryStore.write(next, next.revision ?? 0);
    }
    try {
      writeJsonFileAtomic(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      writeJsonFileAtomic(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  async function persistDocument(current: DataDocument, next: DataDocument): Promise<void> {
    // Aşama 1 (B-14) — yazma anında yeniden doğrulama (TOCTOU).
    assertSafeWritePath(dataFile, 'data-storage');
    assertSafeDataDir(backupsDir, 'data-storage');
    if (isWorthKeeping(current)) {
      await writeDiskSnapshotAsync(current);
    }
    await writeJsonFileAtomicAsync(dataFile, JSON.stringify(next, null, 2), {
      backupPath: backupFile,
      validateParsed: (p) => validateRawDocument(p) !== null,
    });
    if (primaryStore.enabled) {
      primaryStore.write(next, next.revision ?? 0);
    }
    try {
      await writeJsonFileAtomicAsync(
        isolatedProfileFile,
        JSON.stringify(buildIsolatedProfilePayload(next), null, 2)
      );
      await writeJsonFileAtomicAsync(
        isolatedUserListsFile,
        JSON.stringify(buildIsolatedUserListsPayload(next), null, 2)
      );
    } catch {
      // Isolated mirror files are best-effort
    }
  }

  function saveData(rawPayload: unknown, saveOptions: SaveDataOptions = {}): SaveDataResult {
    const current = readData();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    persistDocumentDiskSync(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    readLimitViolations = [];
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  async function saveDataAsync(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    const current = await readDataAsync();
    const prepared = validateAndPrepareSave(current, rawPayload, saveOptions);
    if (!prepared.ok) {
      return prepared;
    }
    await persistDocument(current, prepared.documentToPersist);
    unrecoverableCorruptionError = null;
    readLimitViolations = [];
    return {
      ok: true,
      document: prepared.documentToPersist,
      totalItems: prepared.incomingItems,
      merged: prepared.merged,
    };
  }

  function saveDataSerialized(
    rawPayload: unknown,
    saveOptions: SaveDataOptions = {}
  ): Promise<SaveDataResult> {
    return serialize(() => saveDataAsync(rawPayload, saveOptions));
  }

  async function listBackupsAsync(): Promise<BackupMetadata[]> {
    const files = await listDiskSnapshotFilesNewestFirstAsync();
    const backups: BackupMetadata[] = [];
    for (const fileName of files) {
      const fullPath = path.join(backupsDir, fileName);
      const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
      if (!parsed.ok) continue;
      let createdAt = parsed.data.updatedAt || '';
      if (!createdAt) {
        try {
          const stat = await fsPromises.stat(fullPath);
          createdAt = stat.mtime.toISOString();
        } catch {
          createdAt = new Date().toISOString();
        }
      }
      backups.push({
        id: fileName,
        createdAt,
        revision: parsed.data.revision ?? 0,
        profilesCount: parsed.data.profiles.length,
        itemsCount: countTotalItems(parsed.data),
      });
    }
    return backups;
  }

  function restoreBackup(backupId: string): DataDocument | null {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;

    const parsed = tryParseValidJson<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = readData();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    persistDocumentDiskSync(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  async function restoreBackupAsync(backupId: string): Promise<DataDocument | null> {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) return null;
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) return null;
    const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) return null;

    const current = await readDataAsync();
    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: (current.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    await persistDocument(current, restoredDoc);
    unrecoverableCorruptionError = null;
    return restoredDoc;
  }

  function restoreBackupSerialized(backupId: string): Promise<DataDocument | null> {
    return serialize(() => restoreBackupAsync(backupId));
  }

  /**
   * Aşama 1 (B-08) — revizyon korumalı, atomik snapshot geri yükleme.
   *
   * Sıra: yedek doğrula → güncel revizyonu oku → ön koşulu karşılaştır →
   * güvenlik snapshot'ı → atomik yazım. Herhangi bir adım başarısızsa mevcut
   * veri korunur (kısmi yazım yok).
   */
  async function restoreBackupGuardedAsync(
    backupId: string,
    restoreOptions: RestoreBackupOptions = {}
  ): Promise<RestoreBackupResult> {
    const id = String(backupId || '').trim();
    if (!id || !SNAPSHOT_FILE_PATTERN.test(id)) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }
    const fullPath = path.resolve(backupsDir, id);
    if (!fullPath.startsWith(backupsDir + path.sep) || !existsSync(fullPath)) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }

    const parsed = await tryParseValidJsonAsync<DataDocument>(fullPath, validateRawDocument);
    if (!parsed.ok) {
      return {
        ok: false,
        status: 404,
        code: 'backup_not_found',
        message: 'Belirtilen yedek dosyası bulunamadı veya bozuk.',
      };
    }

    const current = await readDataAsync();
    const currentRevision = current.revision ?? 0;
    const expectedRevision = restoreOptions.expectedRevision;

    if (restoreOptions.hasInvalidIfMatch) {
      return {
        ok: false,
        status: 412,
        code: 'revision_conflict',
        message: `Geçersiz If-Match başlığı gönderildi (mevcut rev-${currentRevision}).`,
        currentRevision,
      };
    }

    if (typeof expectedRevision === 'number' && Number.isSafeInteger(expectedRevision)) {
      if (expectedRevision !== currentRevision) {
        return {
          ok: false,
          status: currentRevision === 0 ? 412 : 409,
          code: 'revision_conflict',
          message: `Geri yükleme reddedildi: sunucudaki veri revizyonu değişmiş (beklenen rev-${expectedRevision}, mevcut rev-${currentRevision}). Güncel veriyi okuyup tekrar deneyin.`,
          currentRevision,
          expectedRevision,
        };
      }
    } else if (
      restoreOptions.requirePrecondition &&
      !restoreOptions.forceOverwrite &&
      currentRevision > 0
    ) {
      return {
        ok: false,
        status: 428,
        code: 'precondition_required',
        message: `Mevcut sunucu verisinin (rev-${currentRevision}) üzerine koşulsuz geri yükleme engellendi. If-Match başlığı gönderin.`,
        currentRevision,
      };
    }

    const restoredDoc: DataDocument = {
      ...parsed.data,
      revision: currentRevision + 1,
      updatedAt: new Date().toISOString(),
    };

    try {
      // `persistDocument` önce mevcut (sağlam) belgenin snapshot'ını yazar,
      // sonra hedef dosyayı atomik olarak değiştirir.
      await persistDocument(current, restoredDoc);
    } catch (error: any) {
      return {
        ok: false,
        status: 500,
        code: 'restore_failed',
        message: `Geri yükleme yazılamadı; mevcut veri korundu (${error?.message || 'bilinmeyen hata'}).`,
        currentRevision,
      };
    }

    unrecoverableCorruptionError = null;
    return { ok: true, document: restoredDoc };
  }

  function restoreBackupGuarded(
    backupId: string,
    restoreOptions: RestoreBackupOptions = {}
  ): Promise<RestoreBackupResult> {
    return serialize(() => restoreBackupGuardedAsync(backupId, restoreOptions));
  }

  function backupExistingDataAsync(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (current.profiles.length === 0 && (current.revision ?? 0) === 0) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function createSafetySnapshotSerialized(): Promise<void> {
    return serialize(async () => {
      const current = await readDataAsync();
      if (!isWorthKeeping(current)) return;
      await writeDiskSnapshotAsync(current);
    });
  }

  function applySyncedDocumentSerialized(rawPayload: unknown): Promise<SaveDataResult> {
    return serialize(() =>
      saveDataAsync(rawPayload, {
        expectedRevision: null,
        confirmBulkDelete: true,
        forceOverwrite: true,
      })
    );
  }

  return {
    dataDir: resolvedDataDir,
    dataFile,
    backupsDir,
    maxDataBytes,
    hasUnrecoverableCorruption: () => Boolean(unrecoverableCorruptionError),
    limitViolations: () => [...readLimitViolations],
    readData,
    readDataAsync,
    readIsolatedProfileAsync,
    readIsolatedUserListsAsync,
    saveData,
    saveDataSerialized,
    backupExistingDataAsync,
    createSafetySnapshotSerialized,
    applySyncedDocumentSerialized,
    listBackupsAsync,
    restoreBackup,
    restoreBackupSerialized,
    restoreBackupGuarded,
    sqliteStatus: () => primaryStore.status(),
    closeSqliteStore: () => primaryStore.close(),
  };
}
