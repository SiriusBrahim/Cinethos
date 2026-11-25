/**
 * F5.3-02 — Katalog yazma işlemleri.
 *
 * `upsertCatalogItems` (+Async) gövdesi `persistent-store.ts` içinden buraya
 * taşındı; birleştirme kuralları (lossless merge), zaman damgasız içerik
 * karşılaştırması, gereksiz yazımı engelleme, atomik yazma, `.bak` kurtarma,
 * hash/manifest doğrulama davranışı birebir korunur. Modül yalnızca dosya
 * yollarını içeren dar `CatalogStoreContext` alır; sınıf durumu, serializer
 * veya senkronizasyon geçişi ile ilgilenmez. Eşzamanlılık güvenliği
 * (`upsertCatalogItemsSerialized`) facade'daki `FileWriteSerializer` ile
 * orada kalır.
 */

import fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { writeJsonFileAtomic, writeJsonFileAtomicAsync } from '../atomic-json.ts';
import { isPlainRecordObject } from './contracts.ts';
import {
  hashContent,
  stringifyDeterministic,
  toCanonicalKey,
  mergeCatalogItem,
} from '../persistent-store-utils.ts';
import type { CatalogManifest } from '../persistent-store-types.ts';
import {
  readCatalog as readCatalogImpl,
  readCatalogAsync as readCatalogAsyncImpl,
  readCatalogManifest as readCatalogManifestImpl,
  readCatalogManifestAsync as readCatalogManifestAsyncImpl,
  type CatalogStoreContext,
} from './catalog-store.ts';

export interface CatalogUpsertResult {
  inserted: number;
  updated: number;
  unchanged: number;
  total: number;
  contentHash: string;
}

export function upsertCatalogItemsOp(
  context: CatalogStoreContext,
  items: unknown[],
  writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
): CatalogUpsertResult {
  // Önce mevcut katalog dosyalarını oku; kurtarılamayan bozuk JSON varsa CorruptJsonFileError fırlatır ve üzerine yazmaz!
  const movies = readCatalogImpl(context, 'movie', { allowEmptyOnCorrupt: false });
  const tv = readCatalogImpl(context, 'tv', { allowEmptyOnCorrupt: false });

  if (!Array.isArray(items) || items.length === 0) {
  const existingManifest = readCatalogManifestImpl(context);
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    total: 0,
    contentHash:
      existingManifest?.contentHash ||
      hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv)),
  };
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let moviesChanged = false;
  let tvChanged = false;

  for (const item of items) {
  const key = toCanonicalKey(item);
  if (!key) continue;
  const isTv = key.startsWith('tv:');
  const targetMap = isTv ? tv : movies;
  const existing = targetMap[key];

  const merged = mergeCatalogItem(existing, item);

  if (!existing) {
    targetMap[key] = merged;
    inserted++;
    if (isTv) tvChanged = true;
    else moviesChanged = true;
  } else {
    // Compare content without timestamps to prevent noisy commits
    const existingCopy = { ...existing, firstStoredAt: '', lastUpdatedAt: '' };
    const mergedCopy = { ...merged, firstStoredAt: '', lastUpdatedAt: '' };

    if (stringifyDeterministic(existingCopy) !== stringifyDeterministic(mergedCopy)) {
      targetMap[key] = merged;
      updated++;
      if (isTv) tvChanged = true;
      else moviesChanged = true;
    } else {
      unchanged++;
    }
  }
  }

  if (moviesChanged) {
  writeJsonFileAtomic(context.moviesFile, stringifyDeterministic(movies), {
    backupPath: `${context.moviesFile}.bak`,
    validateParsed: isPlainRecordObject,
    beforeRenameHook: writeOptions.beforeRenameHook,
  });
  }
  if (tvChanged) {
  writeJsonFileAtomic(context.tvFile, stringifyDeterministic(tv), {
    backupPath: `${context.tvFile}.bak`,
    validateParsed: isPlainRecordObject,
    beforeRenameHook: writeOptions.beforeRenameHook,
  });
  }

  const serializedMovies = stringifyDeterministic(movies);
  const serializedTv = stringifyDeterministic(tv);
  const combinedHash = hashContent(serializedMovies + serializedTv);

  if (moviesChanged || tvChanged || !existsSync(context.manifestFile)) {
  const manifest: CatalogManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    movieCount: Object.keys(movies).length,
    tvCount: Object.keys(tv).length,
    contentHash: combinedHash,
  };
  writeJsonFileAtomic(context.manifestFile, stringifyDeterministic(manifest), {
    backupPath: `${context.manifestFile}.bak`,
    validateParsed: isPlainRecordObject,
  });
  }

  return {
  inserted,
  updated,
  unchanged,
  total: inserted + updated + unchanged,
  contentHash: combinedHash,
  };
}

export async function upsertCatalogItemsAsyncOp(
  context: CatalogStoreContext,
  items: unknown[]
): Promise<CatalogUpsertResult> {
  const movies = await readCatalogAsyncImpl(context, 'movie', { allowEmptyOnCorrupt: false });
  const tv = await readCatalogAsyncImpl(context, 'tv', { allowEmptyOnCorrupt: false });

  if (!Array.isArray(items) || items.length === 0) {
  const existingManifest = await readCatalogManifestAsyncImpl(context);
  return {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    total: 0,
    contentHash:
      existingManifest?.contentHash ||
      hashContent(stringifyDeterministic(movies) + stringifyDeterministic(tv)),
  };
  }

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let moviesChanged = false;
  let tvChanged = false;

  for (const item of items) {
  const key = toCanonicalKey(item);
  if (!key) continue;
  const isTv = key.startsWith('tv:');
  const targetMap = isTv ? tv : movies;
  const existing = targetMap[key];
  const merged = mergeCatalogItem(existing, item);

  if (!existing) {
    targetMap[key] = merged;
    inserted++;
    if (isTv) tvChanged = true;
    else moviesChanged = true;
  } else {
    const existingCopy = { ...existing, firstStoredAt: '', lastUpdatedAt: '' };
    const mergedCopy = { ...merged, firstStoredAt: '', lastUpdatedAt: '' };
    if (stringifyDeterministic(existingCopy) !== stringifyDeterministic(mergedCopy)) {
      targetMap[key] = merged;
      updated++;
      if (isTv) tvChanged = true;
      else moviesChanged = true;
    } else {
      unchanged++;
    }
  }
  }

  if (moviesChanged) {
  await writeJsonFileAtomicAsync(context.moviesFile, stringifyDeterministic(movies), {
    backupPath: `${context.moviesFile}.bak`,
    validateParsed: isPlainRecordObject,
  });
  }
  if (tvChanged) {
  await writeJsonFileAtomicAsync(context.tvFile, stringifyDeterministic(tv), {
    backupPath: `${context.tvFile}.bak`,
    validateParsed: isPlainRecordObject,
  });
  }

  const serializedMovies = stringifyDeterministic(movies);
  const serializedTv = stringifyDeterministic(tv);
  const combinedHash = hashContent(serializedMovies + serializedTv);

  let manifestExists = false;
  try {
  await fsPromises.access(context.manifestFile);
  manifestExists = true;
  } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }

  if (moviesChanged || tvChanged || !manifestExists) {
  const manifest: CatalogManifest = {
    version: 1,
    updatedAt: new Date().toISOString(),
    movieCount: Object.keys(movies).length,
    tvCount: Object.keys(tv).length,
    contentHash: combinedHash,
  };
  await writeJsonFileAtomicAsync(context.manifestFile, stringifyDeterministic(manifest), {
    backupPath: `${context.manifestFile}.bak`,
    validateParsed: isPlainRecordObject,
  });
  }

  return {
  inserted,
  updated,
  unchanged,
  total: inserted + updated + unchanged,
  contentHash: combinedHash,
  };
}
