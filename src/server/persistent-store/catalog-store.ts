/**
 * F5.2-03 — Katalog dosya deposu.
 *
 * Katalog kayıtlarının ve manifest'in okunması, bozuk JSON kurtarması ve
 * dizin/dosya varlığının garanti edilmesi burada toplanır. Modül yalnızca
 * dosya yollarını içeren dar bir bağlam alır; sınıf durumu, kilit veya
 * senkronizasyon geçişleriyle ilgilenmez. `PersistentDataStore` bu işlevlere
 * delege eden facade olarak kalır; public API ve davranış değişmez.
 */

import { existsSync, mkdirSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import {
  CorruptJsonFileError,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
  writeJsonFileAtomic,
  writeJsonFileAtomicAsync,
} from '../atomic-json.ts';
import { isPlainRecordObject } from './contracts.ts';
import {
  hashContent,
  stringifyDeterministic,
} from '../persistent-store-utils.ts';
import type { CatalogManifest, CatalogRecord } from '../persistent-store-types.ts';

export interface CatalogStoreContext {
  catalogDir: string;
  moviesFile: string;
  tvFile: string;
  manifestFile: string;
}

export interface CatalogReadOptions {
  allowEmptyOnCorrupt?: boolean;
}

export function catalogFilePath(
  context: CatalogStoreContext,
  mediaType: 'movie' | 'tv'
): string {
  return mediaType === 'movie' ? context.moviesFile : context.tvFile;
}

function manifestRecoveryOptions(manifestFile: string) {
  return {
    backupPaths: [`${manifestFile}.bak`],
    validate: (raw: unknown): CatalogManifest | null =>
      isPlainRecordObject(raw) && typeof raw.contentHash === 'string'
        ? // F5.2-05 istisnası: yalnızca `contentHash` doğrulanır (mevcut davranış);
          // şema genişletilirse bu dar geçiş kaldırılmalıdır.
          (raw as unknown as CatalogManifest)
        : null,
    label: 'manifest.json',
    restoreRecoveredToTarget: true,
  };
}

export function readCatalog(
  context: CatalogStoreContext,
  mediaType: 'movie' | 'tv',
  options: CatalogReadOptions = {}
): Record<string, CatalogRecord> {
  const file = catalogFilePath(context, mediaType);
  const recovery = readJsonFileWithRecovery<Record<string, CatalogRecord>>(file, {
    backupPaths: [`${file}.bak`],
    validate: (raw) =>
      isPlainRecordObject(raw) ? (raw as Record<string, CatalogRecord>) : null,
    label: path.basename(file),
    restoreRecoveredToTarget: true,
  });

  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }

  if (recovery.status === 'corrupt_unrecoverable') {
    if (options.allowEmptyOnCorrupt) return {};
    throw new CorruptJsonFileError(file, recovery.error);
  }

  return {};
}

export function readCatalogManifest(context: CatalogStoreContext): CatalogManifest | null {
  const recovery = readJsonFileWithRecovery<CatalogManifest>(
    context.manifestFile,
    manifestRecoveryOptions(context.manifestFile)
  );
  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }
  return null;
}

export async function readCatalogAsync(
  context: CatalogStoreContext,
  mediaType: 'movie' | 'tv',
  options: CatalogReadOptions = {}
): Promise<Record<string, CatalogRecord>> {
  const file = catalogFilePath(context, mediaType);
  const recovery = await readJsonFileWithRecoveryAsync<Record<string, CatalogRecord>>(file, {
    backupPaths: [`${file}.bak`],
    validate: (raw) =>
      isPlainRecordObject(raw) ? (raw as Record<string, CatalogRecord>) : null,
    label: path.basename(file),
    restoreRecoveredToTarget: true,
  });

  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }

  if (recovery.status === 'corrupt_unrecoverable') {
    if (options.allowEmptyOnCorrupt) return {};
    throw new CorruptJsonFileError(file, recovery.error);
  }

  return {};
}

export async function readCatalogManifestAsync(
  context: CatalogStoreContext
): Promise<CatalogManifest | null> {
  const recovery = await readJsonFileWithRecoveryAsync<CatalogManifest>(
    context.manifestFile,
    manifestRecoveryOptions(context.manifestFile)
  );
  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }
  return null;
}

function buildManifest(
  movies: Record<string, CatalogRecord>,
  tv: Record<string, CatalogRecord>
): CatalogManifest {
  const combinedHash = hashContent(
    stringifyDeterministic(movies) + stringifyDeterministic(tv)
  );
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    movieCount: Object.keys(movies).length,
    tvCount: Object.keys(tv).length,
    contentHash: combinedHash,
  };
}

/**
 * Yerel katalog dizini ve dosyalarının (movies.json, tv.json, manifest.json)
 * varlığını garanti eder.
 */
export function ensureCatalogFiles(context: CatalogStoreContext): void {
  if (!existsSync(context.catalogDir)) mkdirSync(context.catalogDir, { recursive: true });
  if (!existsSync(context.moviesFile)) {
    writeJsonFileAtomic(context.moviesFile, '{}', {
      backupPath: `${context.moviesFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
  if (!existsSync(context.tvFile)) {
    writeJsonFileAtomic(context.tvFile, '{}', {
      backupPath: `${context.tvFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
  if (!existsSync(context.manifestFile)) {
    const movies = readCatalog(context, 'movie', { allowEmptyOnCorrupt: true });
    const tv = readCatalog(context, 'tv', { allowEmptyOnCorrupt: true });
    const manifest = buildManifest(movies, tv);
    writeJsonFileAtomic(context.manifestFile, stringifyDeterministic(manifest), {
      backupPath: `${context.manifestFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
}

export async function ensureCatalogFilesAsync(context: CatalogStoreContext): Promise<void> {
  await fsPromises.mkdir(context.catalogDir, { recursive: true });
  const existsAsync = async (target: string) => {
    try {
      await fsPromises.access(target);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await existsAsync(context.moviesFile))) {
    await writeJsonFileAtomicAsync(context.moviesFile, '{}', {
      backupPath: `${context.moviesFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
  if (!(await existsAsync(context.tvFile))) {
    await writeJsonFileAtomicAsync(context.tvFile, '{}', {
      backupPath: `${context.tvFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
  if (!(await existsAsync(context.manifestFile))) {
    const movies = await readCatalogAsync(context, 'movie', { allowEmptyOnCorrupt: true });
    const tv = await readCatalogAsync(context, 'tv', { allowEmptyOnCorrupt: true });
    const manifest = buildManifest(movies, tv);
    await writeJsonFileAtomicAsync(context.manifestFile, stringifyDeterministic(manifest), {
      backupPath: `${context.manifestFile}.bak`,
      validateParsed: isPlainRecordObject,
    });
  }
}
