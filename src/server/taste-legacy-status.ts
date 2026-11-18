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
  const profilesRoot = path.join(dataDir, 'taste', 'profiles');
  try {
    const entries = await fs.readdir(profilesRoot, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    if (dirs.length > 0) return { count: dirs.length, unreadable: false };
  } catch {
    // profiles/ yok → henüz profil partition'ı yok.
  }
  try {
    const map = await readTasteProfileIdMap(dataDir);
    if (map.status === 'missing') return { count: 0, unreadable: false };
    return { count: Object.keys(map.data.entries).length, unreadable: false };
  } catch {
    return { count: 0, unreadable: true };
  }
}

/**
 * Legacy taste durumunu salt okunur biçimde raporlar.
 *
 * Sınıflandırma:
 * - legacy yok → `present:false`, `scenario:null`
 * - legacy var, profil partition'ı yok → `S1` (atanmamış legacy adayı)
 * - legacy var, profil partition'ı var → `S3` (çakışan/belirsiz; dışlanır)
 */
export async function describeTasteLegacyState(dataDir: string): Promise<TasteLegacyStatus> {
  const paths = resolveTastePaths(dataDir);
  const legacyFiles: string[] = [];
  for (const filePath of Object.values(paths)) {
    if (await fileExists(filePath)) legacyFiles.push(filePath);
  }
  const { count, unreadable } = await countProfilePartitions(dataDir);
  const present = legacyFiles.length > 0;

  let scenario: TasteLegacyScenario | null = null;
  if (present) {
    scenario = count === 0 ? 'S1' : 'S3';
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
