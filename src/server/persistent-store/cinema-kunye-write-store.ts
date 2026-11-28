/**
 * F5.3-02 — Sinema künyesi yazma işlemi (data/sinema-kunyesi.json).
 *
 * `saveCinemaKunyeSerialized` gövdesi `persistent-store.ts` içinden buraya
 * taşındı: merge/overwrite kuralı, `updatedAt` koruması, boş belge
 * normalizasyonu, atomik yazma ve `.bak` kurtarma birebir korunur.
 * Serileştirme (`FileWriteSerializer.run`) facade'da kalır; modül yalnızca
 * dosya yolu ve mevcut belge okumasını içeren dar bağlam alır.
 */

import { writeJsonFileAtomicAsync } from '../atomic-json.ts';
import { isPlainRecordObject } from './contracts.ts';
import { stringifyDeterministic } from '../persistent-store-utils.ts';
import {
  createEmptyCinemaKunyeDocument,
  mergeCinemaKunyeDocumentsLossless,
  normalizeCinemaKunyeDocument,
  type CinemaKunyeDocument,
} from '../../core/cinema-kunye.ts';

export interface CinemaKunyeSaveResult {
  ok: boolean;
  document: CinemaKunyeDocument;
  entriesCount: number;
  merged: boolean;
}

export interface CinemaKunyeWriteContext {
  filePath: string;
  readExisting(): Promise<CinemaKunyeDocument | null>;
}

export async function saveCinemaKunyeOp(
  context: CinemaKunyeWriteContext,
  incoming: unknown,
  options: { mode?: 'merge' | 'overwrite' } = {}
): Promise<CinemaKunyeSaveResult> {
  const filePath = context.filePath;
  const mode = options.mode === 'overwrite' ? 'overwrite' : 'merge';
  const normalizedIncoming = normalizeCinemaKunyeDocument(incoming);
  const existing = await context.readExisting();

  const nextDoc: CinemaKunyeDocument =
    mode === 'merge' && existing
      ? mergeCinemaKunyeDocumentsLossless(existing, normalizedIncoming)
      : normalizedIncoming.updatedAt
      ? normalizedIncoming
      : {
          ...normalizedIncoming,
          updatedAt: new Date().toISOString(),
        };

  const finalDoc: CinemaKunyeDocument = nextDoc.updatedAt
    ? nextDoc
    : createEmptyCinemaKunyeDocument(new Date().toISOString());

  await writeJsonFileAtomicAsync(filePath, stringifyDeterministic(finalDoc), {
    backupPath: `${filePath}.bak`,
    validateParsed: isPlainRecordObject,
  });

  return {
    ok: true,
    document: finalDoc,
    entriesCount: Object.keys(finalDoc.entries).length,
    merged: Boolean(mode === 'merge' && existing),
  };
}
