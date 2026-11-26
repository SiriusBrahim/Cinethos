/**
 * B-37 — `data/exports` dışa aktarma dosyaları için saklama (retention) politikası.
 *
 * Güvenlik sınırları:
 * - Yalnızca uygulamanın ürettiği, `EXPORT_FILE_NAME_PATTERN` ile eşleşen
 *   dosyalar adaydır. Kullanıcı dosyaları, `data/backups` yedekleri ve ana veri
 *   dosyaları hiçbir koşulda silinmez.
 * - Dosya adı dizin dışına çıkamaz; her silme yolu mutlaklaştırılıp `exports/`
 *   altında olduğu doğrulanır.
 * - En yeni dışa aktarma (son başarılı yedek) her zaman korunur.
 * - Silme kararı saf `selectExportsForRetention` ile üretilir; test edilebilir.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { EXPORT_FILE_NAME_PATTERN } from './export-file-names.ts';

export interface ExportFileEntry {
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

export interface ExportRetentionPolicy {
  /** Bu yaştan eski dosyalar (en yenisi hariç) silinir. */
  maxAgeDays: number;
  /** Dizinde tutulacak en fazla dosya sayısı (en yenisi dahil). */
  maxFiles: number;
  /** Korunacak toplam bayt üst sınırı. */
  maxTotalBytes: number;
}

export type RetentionRemovalReason = 'age' | 'count' | 'size';

export interface RetentionDecision {
  keep: ExportFileEntry[];
  remove: Array<{ file: ExportFileEntry; reason: RetentionRemovalReason }>;
}

export interface ExportRetentionReport {
  examined: number;
  kept: Array<{ name: string; sizeBytes: number; protectedReason: 'latest' | 'policy' }>;
  removed: Array<{ name: string; sizeBytes: number; reason: RetentionRemovalReason }>;
  skipped: Array<{ name: string; reason: string }>;
  totalBytesBefore: number;
  totalBytesAfter: number;
  errors: Array<{ name: string; message: string }>;
}

/**
 * Varsayılan politika — mevcut kullanım ve veri güvenliğine göre:
 * - Dışa aktarma elle tetiklenen tam yedektir (JSON + XLSX, 1.000 kayıtta ~0,1 MB
 *   XLSX). Ayda bir yedek alan kullanıcı için 12 dosya ≈ bir yıllık geçmiş.
 * - 180 gün, "geçen yılın aynı dönemi" karşılaştırmasını kaybetmeden eskileri atar.
 * - 256 MiB üst sınır, posterli büyük çalışma kitaplarında bile disk şişmesini
 *   engeller; en yeni dosya her durumda korunur.
 */
export const DEFAULT_EXPORT_RETENTION_POLICY: Readonly<ExportRetentionPolicy> = Object.freeze({
  maxAgeDays: 180,
  maxFiles: 12,
  maxTotalBytes: 256 * 1024 * 1024,
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Yalnızca uygulamanın ürettiği, dizin bileşeni içermeyen dosya adları. */
export function isManagedExportFileName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name !== path.basename(name)) return false;
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false;
  return EXPORT_FILE_NAME_PATTERN.test(name);
}

/**
 * Silinecek dosyaları saf olarak belirler. Girdi sırasından bağımsızdır;
 * çıktı her zaman eskiden yeniye sıralıdır.
 */
export function selectExportsForRetention(
  files: ExportFileEntry[],
  policy: ExportRetentionPolicy,
  nowMs: number
): RetentionDecision {
  const managed = files.filter((file) => isManagedExportFileName(file.name));
  const sorted = [...managed].sort(
    (a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name)
  );

  if (sorted.length === 0) return { keep: [], remove: [] };

  const newest = sorted[0];
  const removal = new Map<string, RetentionRemovalReason>();
  const maxAgeMs = Math.max(0, policy.maxAgeDays) * DAY_MS;

  for (const file of sorted.slice(1)) {
    if (nowMs - file.mtimeMs > maxAgeMs) removal.set(file.name, 'age');
  }

  const remaining = () => sorted.filter((file) => !removal.has(file.name));
  const maxFiles = Math.max(1, Math.trunc(policy.maxFiles));
  while (remaining().length > maxFiles) {
    const oldest = remaining()[remaining().length - 1];
    if (oldest.name === newest.name) break;
    removal.set(oldest.name, 'count');
  }

  const maxTotalBytes = Math.max(0, policy.maxTotalBytes);
  const totalBytes = () => remaining().reduce((acc, file) => acc + file.sizeBytes, 0);
  while (remaining().length > 1 && totalBytes() > maxTotalBytes) {
    const oldest = remaining()[remaining().length - 1];
    if (oldest.name === newest.name) break;
    removal.set(oldest.name, 'size');
  }

  return {
    keep: sorted.filter((file) => !removal.has(file.name)),
    remove: sorted
      .filter((file) => removal.has(file.name))
      .map((file) => ({ file, reason: removal.get(file.name) as RetentionRemovalReason })),
  };
}

export interface ApplyExportRetentionOptions {
  policy?: ExportRetentionPolicy;
  nowMs?: number;
  /** Yalnızca kararı üretir, dosya silmez. */
  dryRun?: boolean;
  /** Bu ada sahip dosya (az önce yazılan export) her koşulda korunur. */
  keepFileName?: string;
}

function assertInsideDir(dir: string, candidate: string): void {
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
    throw new Error('Dışa aktarma yolu dizin dışına çıkıyor.');
  }
}

/**
 * Retention politikasını `exportsDir` üzerinde uygular. Dizin yoksa hiçbir şey
 * yapmaz. Silme hataları raporlanır; kalan dosyalar korunur.
 */
export async function applyExportRetention(
  exportsDir: string,
  options: ApplyExportRetentionOptions = {}
): Promise<ExportRetentionReport> {
  const policy = options.policy ?? DEFAULT_EXPORT_RETENTION_POLICY;
  const nowMs = options.nowMs ?? Date.now();
  const report: ExportRetentionReport = {
    examined: 0,
    kept: [],
    removed: [],
    skipped: [],
    totalBytesBefore: 0,
    totalBytesAfter: 0,
    errors: [],
  };

  let names: string[];
  try {
    names = await fs.readdir(exportsDir);
  } catch {
    return report;
  }

  const files: ExportFileEntry[] = [];
  for (const name of names) {
    if (!isManagedExportFileName(name)) {
      report.skipped.push({ name, reason: 'yönetilmeyen dosya' });
      continue;
    }
    const fullPath = path.join(exportsDir, name);
    try {
      assertInsideDir(exportsDir, fullPath);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) {
        report.skipped.push({ name, reason: 'dosya değil' });
        continue;
      }
      files.push({ name, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
    } catch (error) {
      report.errors.push({ name, message: (error as Error)?.message || 'okunamadı' });
    }
  }

  report.examined = files.length;
  report.totalBytesBefore = files.reduce((acc, file) => acc + file.sizeBytes, 0);

  const decision = selectExportsForRetention(files, policy, nowMs);
  const latestName = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;

  for (const entry of decision.keep) {
    report.kept.push({
      name: entry.name,
      sizeBytes: entry.sizeBytes,
      protectedReason:
        entry.name === latestName || entry.name === options.keepFileName ? 'latest' : 'policy',
    });
  }

  let totalBytesAfter = report.totalBytesBefore;
  for (const entry of decision.remove) {
    if (entry.file.name === options.keepFileName) {
      report.kept.push({
        name: entry.file.name,
        sizeBytes: entry.file.sizeBytes,
        protectedReason: 'latest',
      });
      continue;
    }
    if (options.dryRun) {
      report.removed.push({
        name: entry.file.name,
        sizeBytes: entry.file.sizeBytes,
        reason: entry.reason,
      });
      totalBytesAfter -= entry.file.sizeBytes;
      continue;
    }
    const fullPath = path.join(exportsDir, entry.file.name);
    try {
      assertInsideDir(exportsDir, fullPath);
      await fs.unlink(fullPath);
      report.removed.push({
        name: entry.file.name,
        sizeBytes: entry.file.sizeBytes,
        reason: entry.reason,
      });
      totalBytesAfter -= entry.file.sizeBytes;
    } catch (error) {
      report.errors.push({
        name: entry.file.name,
        message: (error as Error)?.message || 'silinemedi',
      });
    }
  }

  report.totalBytesAfter = Math.max(0, totalBytesAfter);
  return report;
}
