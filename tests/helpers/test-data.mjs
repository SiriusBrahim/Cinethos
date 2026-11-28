/**
 * Test yardımcıları — geçici, izole veri dizinleri (B-14 / N-04).
 *
 * Her test dosyası kendi geçici kökünü alır; gerçek `<repo>/data` dizinine
 * yazma girişimi `test-data-guard` tarafından çalışma zamanında engellenir.
 */

import { lstatSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const created = new Set();

/** Benzersiz geçici dizin üretir ve süreç çıkışında temizlenmek üzere kaydeder. */
export function makeTempDataDir(prefix = 'cinethos-test-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  created.add(dir);
  return dir;
}

/** Varsayılan veri dizinini kullanan modüller için süreç düzeyinde izolasyon. */
export function useIsolatedDataDir(prefix = 'cinethos-test-') {
  const dir = makeTempDataDir(prefix);
  process.env.CINETRACK_DATA_DIR = dir;
  return dir;
}

export function cleanupTempDataDirs() {
  for (const dir of created) {
    // Bazı güvenlik testleri geçici dizini bilinçli olarak gerçek `data/`
    // dizinine sembolik bağlantıya çevirir. `rmSync(recursive)` bir bağlantıyı
    // hedefinin içeriğiyle birlikte silebildiği için önce bağlantının kendisi
    // kaldırılır; hedef dizine hiç dokunulmaz.
    try {
      if (lstatSync(dir).isSymbolicLink()) {
        unlinkSync(dir);
        continue;
      }
    } catch {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
  }
  created.clear();
}

process.on('exit', () => {
  cleanupTempDataDirs();
});
