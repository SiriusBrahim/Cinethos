/**
 * MIA Faz 5 R2-A5 — Legacy taste verisi sınıflandırması (salt okunur).
 *
 * Tasarım kararı (docs/mia/faz5-r2-a1-tasarim.md §5):
 * - S1: Legacy verinin tek/kanıtlanabilir bir profile ait olduğu gösterilebiliyor.
 *   Otomatik atama YOKTUR; kopya/taşıma yalnızca açık kullanıcı onayı ve canlı
 *   veri kanıtıyla ayrı bir adımda yapılabilir.
 * - S2: Çakışmayan ayrı legacy izleri; salt okunur kabul edilir, birleştirilmez.
 * - S3: Sahipliği belirsiz/çakışan veri; hiçbir profile sessizce bağlanmaz,
 *   profil metriklerine karıştırılmaz.
 *
 * Bu modül HİÇBİR dosyayı DEĞİŞTİRMEZ, taşımaz veya silmez. Yalnızca durum
 * raporlar; yanlış atfetmeyi önlemek için okuma katmanı bu raporu kullanır.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { readTasteProfileIdMap, resolveTastePaths } from './taste-store.ts';

/** Legacy sınıflandırma senaryosu (tasarım §5). */
export type TasteLegacyScenario = 'S1' | 'S2' | 'S3';

export interface TasteLegacyOwnershipEvidence {
  /** Profile identity proven by an external, auditable source (never title heuristics). */
  readonly profileId: string;
  /** Stable legacy record keys attributed to this profile. */
  readonly recordKeys: readonly string[];
  /** Must be explicitly true; unverified evidence is ignored. */
  readonly verified: true;
}

export interface TasteLegacyStatus {
  /** Legacy (global) taste dosyası var mı? */
  readonly present: boolean;
  /** Sınıflandırma; legacy veri yoksa `null`. */
  readonly scenario: TasteLegacyScenario | null;
  /** Bulunan legacy dosya yolları (göreli değil, dataDir tabanlı). */
  readonly legacyFiles: readonly string[];
  /** Profil eşleme manifestindeki kayıt sayısı (okunamıyorsa 0). */
  readonly profilePartitions: number;
  /** Eşleme manifesti okunamadı/bozuk mu? (fail-fast, otomatik onarım yok) */
  readonly mappingUnreadable: boolean;
  /** Uygulanan politika — yanlış atfetme yasağı. */
  readonly policy: string;
}

const LEGACY_POLICY =
  'Legacy taste verisi hiçbir profile otomatik bağlanmaz; S1 kopyası yalnızca açık kullanıcı onayı ve canlı veri kanıtıyla ayrı adımda yapılır.';

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countProfilePartitions(
  dataDir: string
): Promise<{ count: number; unreadable: boolean }> {
  // Mapping validation is independent of directory discovery. A populated
  // profiles/ folder must not mask a corrupt _profile-id-map.json manifest.
  let manifestCount = 0;
  let unreadable = false;
  try {
    const map = await readTasteProfileIdMap(dataDir);
    if (map.status !== 'missing') {
      manifestCount = Object.keys(map.data.entries).length;
    }
  } catch {
    unreadable = true;
  }

  let directoryCount = 0;
  const profilesRoot = path.join(dataDir, 'taste', 'profiles');
  try {
    const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
    directoryCount = entries.filter((entry) => entry.isDirectory()).length;
  } catch {
    // profiles/ yok → henüz profil partition'ı yok.
  }

  return { count: Math.max(directoryCount, manifestCount), unreadable };
}

/**
 * Legacy taste durumunu salt okunur biçimde raporlar.
 *
 * Sınıflandırma:
 * - legacy yok → `present:false`, `scenario:null`
 * - legacy var + doğrulanmış, çakışmayan çoklu sahiplik kanıtı → `S2`
 * - legacy var, profil partition'ı yok → `S1` (atanmamış legacy adayı)
 * - legacy var, profil partition'ı var veya sahiplik çakışıyor → `S3`
 */
export async function describeTasteLegacyState(
  dataDir: string,
  options: { ownershipEvidence?: readonly TasteLegacyOwnershipEvidence[] } = {}
): Promise<TasteLegacyStatus> {
  const paths = resolveTastePaths(dataDir);
  const legacyFiles: string[] = [];
  for (const filePath of Object.values(paths)) {
    if (await fileExists(filePath)) legacyFiles.push(filePath);
  }
  const { count, unreadable } = await countProfilePartitions(dataDir);
  const present = legacyFiles.length > 0;

  let scenario: TasteLegacyScenario | null = null;
  if (present) {
    const evidence = options.ownershipEvidence ?? [];
    const profileIds = evidence.map((entry) => entry.profileId);
    const recordOwners = new Map<string, string>();
    let conflictingOwnership = false;
    for (const entry of evidence) {
      if (entry.verified !== true || !Array.isArray(entry.recordKeys)) continue;
      for (const key of entry.recordKeys) {
        if (typeof key !== 'string' || !key.trim()) continue;
        const owner = recordOwners.get(key);
        if (owner && owner !== entry.profileId) conflictingOwnership = true;
        else recordOwners.set(key, entry.profileId);
      }
    }
    const hasVerifiedDisjointEvidence =
      evidence.length >= 2 &&
      evidence.every((entry) =>
        entry.verified === true &&
        typeof entry.profileId === 'string' &&
        entry.profileId.trim().length > 0 &&
        Array.isArray(entry.recordKeys) &&
        entry.recordKeys.length > 0 &&
        entry.recordKeys.every((key) => typeof key === 'string' && key.trim().length > 0)
      ) &&
      new Set(profileIds).size === profileIds.length &&
      !conflictingOwnership;

    // S2 is only emitted with explicit, verified, disjoint ownership evidence.
    // Conflicting evidence is S3; missing/unverified evidence is never guessed.
    scenario = hasVerifiedDisjointEvidence
      ? 'S2'
      : conflictingOwnership || count > 0
        ? 'S3'
        : 'S1';
  }

  return {
    present,
    scenario,
    legacyFiles,
    profilePartitions: count,
    mappingUnreadable: unreadable,
    policy: LEGACY_POLICY,
  };
}
