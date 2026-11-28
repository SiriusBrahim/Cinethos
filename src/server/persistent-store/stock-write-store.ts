/**
 * F5.3-02 — Stok anlık görüntüsü yazma işlemi (data/stock.json).
 *
 * `saveStockSnapshotUpload` gövdesi `persistent-store.ts` içinden buraya
 * taşındı: boş yüklemede mevcut yedeği koruma, listelerde kayıpsız
 * tekilleştirme, `schemaVersion`/`updatedAt` şeması, atomik yazma ve `.bak`
 * kurtarma birebir korunur. Serileştirme facade'da kalır.
 */

import { writeJsonFileAtomicAsync } from '../atomic-json.ts';
import { isPlainRecordObject } from './contracts.ts';

export interface StockSnapshotView {
  movies: Record<string, unknown>[];
  tv: Record<string, unknown>[];
  updatedAt: string;
  schemaVersion: number;
}

export interface StockWriteContext {
  stockFilePath: string;
  readSnapshot(): StockSnapshotView | null;
}

export async function saveStockSnapshotUploadOp(
  context: StockWriteContext,
  input: {
    movies?: unknown;
    tv?: unknown;
    note?: unknown;
  } = {}
): Promise<{
  ok: boolean;
  moviesCount: number;
  tvCount: number;
  total: number;
  message: string;
  duplicatesRemoved: number;
  skippedInvalid: number;
  preservedExistingEmptyUpload: boolean;
}> {
  const filePath = context.stockFilePath;
  const existing = context.readSnapshot();
  const result = {
    ok: true,
    moviesCount: existing?.movies.length ?? 0,
    tvCount: existing?.tv.length ?? 0,
    total: (existing?.movies.length ?? 0) + (existing?.tv.length ?? 0),
    duplicatesRemoved: 0,
    skippedInvalid: 0,
    preservedExistingEmptyUpload: false,
    message: '',
  };

  const dedupList = (raw: unknown[], namespace: 'movie' | 'tv'): Record<string, unknown>[] => {
    const seen = new Set<string>();
    const out: Record<string, unknown>[] = [];
    for (const candidate of raw) {
      if (!isPlainRecordObject(candidate)) {
        result.skippedInvalid++;
        continue;
      }
      const idRaw = candidate.id;
      const idNum = Number(idRaw);
      const validId =
        (Number.isSafeInteger(idNum) && idNum > 0) ||
        (typeof idRaw === 'string' && idRaw.trim().length > 0);
      if (!validId) {
        result.skippedInvalid++;
        continue;
      }
      const key = `${namespace}:${idRaw}`;
      if (seen.has(key)) {
        result.duplicatesRemoved++;
        continue;
      }
      seen.add(key);
      out.push(candidate);
    }
    return out;
  };

  let movies = existing?.movies ?? [];
  let tv = existing?.tv ?? [];
  if (Array.isArray(input.movies) && input.movies.length > 0) {
    movies = dedupList(input.movies, 'movie');
  } else if (Array.isArray(input.movies) && input.movies.length === 0 && movies.length > 0) {
    result.preservedExistingEmptyUpload = true;
  }
  if (Array.isArray(input.tv) && input.tv.length > 0) {
    tv = dedupList(input.tv, 'tv');
  } else if (Array.isArray(input.tv) && input.tv.length === 0 && tv.length > 0) {
    result.preservedExistingEmptyUpload = true;
  }

  const doc = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    movies,
    tv,
  };
  await writeJsonFileAtomicAsync(filePath, JSON.stringify(doc, null, 2), {
    backupPath: `${filePath}.bak`,
    validateParsed: (raw) =>
      isPlainRecordObject(raw) && Array.isArray(raw.movies) && Array.isArray(raw.tv),
  });

  result.moviesCount = movies.length;
  result.tvCount = tv.length;
  result.total = movies.length + tv.length;
  result.message = result.preservedExistingEmptyUpload
    ? 'Boş stok yüklemesi yok sayıldı; mevcut yedek korundu.'
    : 'Stok anlık görüntüsü güncellendi.';
  return result;
}
