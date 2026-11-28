/**
 * F5.3-02 — Türetilmiş profil yazma işlemleri.
 *
 * `upsertDerivedProfile` (+Async) gövdesi `persistent-store.ts` içinden buraya
 * taşındı. Bağlam (şema, algoritma, profil imzası, kaynak katalog imzası)
 * doğrulaması, kayıpsız merge ve prev-single-hash zaman damgası koruması
 * birebir korunur; atomik yazma ve `.bak` kurtarma değişmez. Modül dar
 * `DerivedProfileWriteContext` arayüzüyle çalışır; profil dosyası yolu, mevcut
 * belge okuma ve manifest imza okuma facade'dan verilir. Serializer ile
 * çalışan `upsertDerivedProfileSerialized` facade'da kalır.
 */

import { writeJsonFileAtomic, writeJsonFileAtomicAsync } from '../atomic-json.ts';
import { isPlainRecordObject } from './contracts.ts';
import { stringifyDeterministic } from '../persistent-store-utils.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  normalizeDerivedProfileItem,
} from '../../core/derived-profile-cache.ts';
import type {
  CatalogManifest,
  DerivedProfileDocument,
  DerivedProfileItem,
} from '../persistent-store-types.ts';

export type UpsertDerivedProfileInput = Partial<DerivedProfileDocument> & {
  profileId: string;
  algorithmVersion: string;
  profileFingerprint: string;
  sourceCatalogHash?: string;
  items: Record<string, Partial<DerivedProfileItem> & { mediaKey?: string }>;
};

export interface DerivedProfileUpsertResult {
  updated: boolean;
  count: number;
  contentHash: string;
}

export interface DerivedProfileWriteContext {
  profileFilePath(profileId: string): string;
  readCatalogManifest(): CatalogManifest | null;
  readCatalogManifestAsync(): Promise<CatalogManifest | null>;
  readExisting(profileId: string): DerivedProfileDocument | null;
  readExistingAsync(profileId: string): Promise<DerivedProfileDocument | null>;
}

export function upsertDerivedProfileOp(
  context: DerivedProfileWriteContext,
  input: UpsertDerivedProfileInput,
  writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
): DerivedProfileUpsertResult {
  const profileId = normalizeProfileId(input.profileId);
  if (!profileId) throw new Error('Geçersiz profil kimliği; türetilmiş profil yazılamadı.');
  const { algorithmVersion, profileFingerprint, items } = input;
  const targetSchemaVersion = input.schemaVersion ?? DERIVED_PROFILE_SCHEMA_VERSION;
  const resolvedSourceCatalogHash =
    input.sourceCatalogHash !== undefined
      ? String(input.sourceCatalogHash)
      : context.readCatalogManifest()?.contentHash || '';

  // Kurtarılamayan bozuk JSON varsa CorruptJsonFileError fırlatır ve mevcut dosyayı ezmez
  const existing = context.readExisting(profileId);
  const filePath = context.profileFilePath(profileId);

  const sameContext = Boolean(
    existing &&
      Number(existing.schemaVersion) === targetSchemaVersion &&
      existing.algorithmVersion === algorithmVersion &&
      existing.profileFingerprint === profileFingerprint &&
      String(existing.sourceCatalogHash || '') === resolvedSourceCatalogHash
  );

  // Bağlam (şema, algoritma, profil imzası veya kaynak katalog imzası) değiştiyse eski önbellek maddeleri taşınmaz
  const mergedItems: Record<string, DerivedProfileItem> = {};
  if (sameContext && existing?.items) {
    for (const [k, prevVal] of Object.entries(existing.items)) {
      const normPrev = normalizeDerivedProfileItem(k, prevVal);
      if (normPrev) {
        mergedItems[normPrev.mediaKey] = normPrev;
      }
    }
  }

  for (const [rawKey, item] of Object.entries(items || {})) {
    const normalized = normalizeDerivedProfileItem(rawKey, item);
    if (!normalized) continue;
    const prevItem = mergedItems[normalized.mediaKey];
    if (prevItem) {
      const prevSingleHash = computeDerivedProfileContentHash({
        schemaVersion: targetSchemaVersion,
        profileId,
        algorithmVersion,
        profileFingerprint,
        sourceCatalogHash: resolvedSourceCatalogHash,
        items: { [normalized.mediaKey]: prevItem },
      });
      const nextSingleHash = computeDerivedProfileContentHash({
        schemaVersion: targetSchemaVersion,
        profileId,
        algorithmVersion,
        profileFingerprint,
        sourceCatalogHash: resolvedSourceCatalogHash,
        items: { [normalized.mediaKey]: normalized },
      });
      if (prevSingleHash === nextSingleHash) {
        // Anlamlı alanlar aynıysa önceki calculatedAt zaman damgasını koru
        mergedItems[normalized.mediaKey] = prevItem;
        continue;
      }
    }
    mergedItems[normalized.mediaKey] = normalized;
  }

  const nextContentHash = computeDerivedProfileContentHash({
    schemaVersion: targetSchemaVersion,
    profileId,
    algorithmVersion,
    profileFingerprint,
    sourceCatalogHash: resolvedSourceCatalogHash,
    items: mergedItems,
  });

  if (sameContext && existing) {
    const existingContentHash =
      existing.contentHash ||
      computeDerivedProfileContentHash({
        schemaVersion: Number(existing.schemaVersion) || 1,
        profileId: existing.profileId,
        algorithmVersion: existing.algorithmVersion,
        profileFingerprint: existing.profileFingerprint,
        sourceCatalogHash: existing.sourceCatalogHash || '',
        items: existing.items || {},
      });

    if (
      existingContentHash === nextContentHash &&
      Object.keys(existing.items || {}).length === Object.keys(mergedItems).length
    ) {
      return {
        updated: false,
        count: Object.keys(mergedItems).length,
        contentHash: existingContentHash,
      };
    }
  }

  const doc: DerivedProfileDocument = {
    schemaVersion: targetSchemaVersion,
    profileId,
    algorithmVersion,
    profileFingerprint,
    sourceCatalogHash: resolvedSourceCatalogHash,
    contentHash: nextContentHash,
    generatedAt: new Date().toISOString(),
    items: mergedItems,
  };

  writeJsonFileAtomic(filePath, stringifyDeterministic(doc), {
    backupPath: `${filePath}.bak`,
    validateParsed: (parsed) =>
      isPlainRecordObject(parsed) &&
      typeof parsed.profileId === 'string' &&
      isPlainRecordObject(parsed.items),
    beforeRenameHook: writeOptions.beforeRenameHook,
  });

  return {
    updated: true,
    count: Object.keys(mergedItems).length,
    contentHash: nextContentHash,
  };
}

export async function upsertDerivedProfileAsyncOp(
  context: DerivedProfileWriteContext,
  input: UpsertDerivedProfileInput
): Promise<DerivedProfileUpsertResult> {
  const profileId = normalizeProfileId(input.profileId);
  if (!profileId) throw new Error('Geçersiz profil kimliği; türetilmiş profil yazılamadı.');
  const { algorithmVersion, profileFingerprint, items } = input;
  const targetSchemaVersion = input.schemaVersion ?? DERIVED_PROFILE_SCHEMA_VERSION;
  const resolvedSourceCatalogHash =
    input.sourceCatalogHash !== undefined
      ? String(input.sourceCatalogHash)
      : (await context.readCatalogManifestAsync())?.contentHash || '';

  const existing = await context.readExistingAsync(profileId);
  const filePath = context.profileFilePath(profileId);

  const sameContext = Boolean(
    existing &&
      Number(existing.schemaVersion) === targetSchemaVersion &&
      existing.algorithmVersion === algorithmVersion &&
      existing.profileFingerprint === profileFingerprint &&
      String(existing.sourceCatalogHash || '') === resolvedSourceCatalogHash
  );

  const mergedItems: Record<string, DerivedProfileItem> = {};
  if (sameContext && existing?.items) {
    for (const [k, prevVal] of Object.entries(existing.items)) {
      const normPrev = normalizeDerivedProfileItem(k, prevVal);
      if (normPrev) {
        mergedItems[normPrev.mediaKey] = normPrev;
      }
    }
  }

  for (const [rawKey, item] of Object.entries(items || {})) {
    const normalized = normalizeDerivedProfileItem(rawKey, item);
    if (!normalized) continue;
    const prevItem = mergedItems[normalized.mediaKey];
    if (prevItem) {
      const prevSingleHash = computeDerivedProfileContentHash({
        schemaVersion: targetSchemaVersion,
        profileId,
        algorithmVersion,
        profileFingerprint,
        sourceCatalogHash: resolvedSourceCatalogHash,
        items: { [normalized.mediaKey]: prevItem },
      });
      const nextSingleHash = computeDerivedProfileContentHash({
        schemaVersion: targetSchemaVersion,
        profileId,
        algorithmVersion,
        profileFingerprint,
        sourceCatalogHash: resolvedSourceCatalogHash,
        items: { [normalized.mediaKey]: normalized },
      });
      if (prevSingleHash === nextSingleHash) {
        mergedItems[normalized.mediaKey] = prevItem;
        continue;
      }
    }
    mergedItems[normalized.mediaKey] = normalized;
  }

  const nextContentHash = computeDerivedProfileContentHash({
    schemaVersion: targetSchemaVersion,
    profileId,
    algorithmVersion,
    profileFingerprint,
    sourceCatalogHash: resolvedSourceCatalogHash,
    items: mergedItems,
  });

  if (sameContext && existing) {
    const existingContentHash =
      existing.contentHash ||
      computeDerivedProfileContentHash({
        schemaVersion: Number(existing.schemaVersion) || 1,
        profileId: existing.profileId,
        algorithmVersion: existing.algorithmVersion,
        profileFingerprint: existing.profileFingerprint,
        sourceCatalogHash: existing.sourceCatalogHash || '',
        items: existing.items || {},
      });

    if (
      existingContentHash === nextContentHash &&
      Object.keys(existing.items || {}).length === Object.keys(mergedItems).length
    ) {
      return {
        updated: false,
        count: Object.keys(mergedItems).length,
        contentHash: existingContentHash,
      };
    }
  }

  const doc: DerivedProfileDocument = {
    schemaVersion: targetSchemaVersion,
    profileId,
    algorithmVersion,
    profileFingerprint,
    sourceCatalogHash: resolvedSourceCatalogHash,
    contentHash: nextContentHash,
    generatedAt: new Date().toISOString(),
    items: mergedItems,
  };

  await writeJsonFileAtomicAsync(filePath, stringifyDeterministic(doc), {
    backupPath: `${filePath}.bak`,
    validateParsed: (parsed) =>
      isPlainRecordObject(parsed) &&
      typeof parsed.profileId === 'string' &&
      isPlainRecordObject(parsed.items),
  });

  return {
    updated: true,
    count: Object.keys(mergedItems).length,
    contentHash: nextContentHash,
  };
}
