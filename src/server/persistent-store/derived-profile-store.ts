/**
 * F5.2-03 — Türetilmiş profil deposu (okuma + doğrulama).
 *
 * Profil başına türetilmiş öneri belgesinin okunması, bozuk JSON kurtarması ve
 * şema/imza doğrulaması burada toplanır. Yazma akışı bilinçli olarak facade'da
 * kalır: atomik yazma, seri hale getirici ve katalog imzası ile aynı işlem
 * sınırını paylaşır (kilit/journal davranışı değiştirilmemelidir).
 */

import path from 'node:path';
import {
  CorruptJsonFileError,
  readJsonFileWithRecovery,
  readJsonFileWithRecoveryAsync,
} from '../atomic-json.ts';
import {
  validateDerivedProfileCache,
  type DerivedProfileValidationResult,
} from '../../core/derived-profile-cache.ts';
import { isPlainRecordObject } from './contracts.ts';
import type { DerivedProfileDocument } from '../persistent-store-types.ts';

export interface DerivedProfileStoreContext {
  profileFilePath: (profileId: string) => string;
}

export interface DerivedProfileReadOptions {
  allowNullOnCorrupt?: boolean;
}

export interface DerivedProfileExpectations {
  profileFingerprint: string;
  algorithmVersion: string;
  sourceCatalogHash?: string;
  expectedSchemaVersion?: number;
}

function validateDerivedDocument(raw: unknown): DerivedProfileDocument | null {
  return isPlainRecordObject(raw) &&
    typeof raw.profileId === 'string' &&
    isPlainRecordObject(raw.items)
    ? // F5.2-05 istisnası: profil kimliği ve öğe haritası doğrulanır; tam
      // şema doğrulaması `readValidatedDerivedProfile` içinde yapılır.
      (raw as unknown as DerivedProfileDocument)
    : null;
}

export function readDerivedProfile(
  context: DerivedProfileStoreContext,
  profileId: string,
  options: DerivedProfileReadOptions = {}
): DerivedProfileDocument | null {
  const filePath = context.profileFilePath(profileId);
  const recovery = readJsonFileWithRecovery<DerivedProfileDocument>(filePath, {
    backupPaths: [`${filePath}.bak`],
    validate: validateDerivedDocument,
    label: path.basename(filePath),
    restoreRecoveredToTarget: true,
  });

  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }
  if (recovery.status === 'corrupt_unrecoverable') {
    if (options.allowNullOnCorrupt) return null;
    throw new CorruptJsonFileError(filePath, recovery.error);
  }
  return null;
}

/**
 * Profil cache doğrulamasını şema sürümü, algoritma sürümü, profil imzası ve
 * kaynak katalog imzası ile birlikte yürütür.
 */
export function readValidatedDerivedProfile(
  context: DerivedProfileStoreContext,
  profileId: string,
  expected: DerivedProfileExpectations
): DerivedProfileValidationResult {
  const rawDoc = readDerivedProfile(context, profileId, { allowNullOnCorrupt: true });
  if (!rawDoc) return { valid: false, reason: 'missing_document' };
  return validateDerivedProfileCache(rawDoc, {
    profileId,
    profileFingerprint: expected.profileFingerprint,
    algorithmVersion: expected.algorithmVersion,
    sourceCatalogHash: expected.sourceCatalogHash,
    expectedSchemaVersion: expected.expectedSchemaVersion,
  });
}

export async function readDerivedProfileAsync(
  context: DerivedProfileStoreContext,
  profileId: string,
  options: DerivedProfileReadOptions = {}
): Promise<DerivedProfileDocument | null> {
  const filePath = context.profileFilePath(profileId);
  const recovery = await readJsonFileWithRecoveryAsync<DerivedProfileDocument>(filePath, {
    backupPaths: [`${filePath}.bak`],
    validate: validateDerivedDocument,
    label: path.basename(filePath),
    restoreRecoveredToTarget: true,
  });

  if (recovery.status === 'ok' || recovery.status === 'recovered') {
    return recovery.data;
  }
  if (recovery.status === 'corrupt_unrecoverable') {
    if (options.allowNullOnCorrupt) return null;
    throw new CorruptJsonFileError(filePath, recovery.error);
  }
  return null;
}

export async function readValidatedDerivedProfileAsync(
  context: DerivedProfileStoreContext,
  profileId: string,
  expected: DerivedProfileExpectations
): Promise<DerivedProfileValidationResult> {
  const rawDoc = await readDerivedProfileAsync(context, profileId, {
    allowNullOnCorrupt: true,
  });
  if (!rawDoc) return { valid: false, reason: 'missing_document' };
  return validateDerivedProfileCache(rawDoc, {
    profileId,
    profileFingerprint: expected.profileFingerprint,
    algorithmVersion: expected.algorithmVersion,
    sourceCatalogHash: expected.sourceCatalogHash,
    expectedSchemaVersion: expected.expectedSchemaVersion,
  });
}
