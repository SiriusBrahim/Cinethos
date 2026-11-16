import crypto from 'node:crypto';
import type { DataDocument } from '../core/cinethos-core.ts';

/**
 * P0-01: Arşiv geri yüklemesinde "gerçekten aynı içerik mi?" sorusunu yanıtlar.
 *
 * Sadece profil/kayıt sayısı karşılaştırmak, aynı sayıda ama farklı içerikte bir
 * belgeyi (örn. kaybolmuş tercihler) kurtarılmış gibi gösterir. Bu modül belgenin
 * kanonik özetini üretir; `revision`/`updatedAt` gibi yazma sırasında değişen
 * alanlar hariç tutulur.
 */

const VOLATILE_DOCUMENT_KEYS = new Set(['revision', 'updatedAt']);

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      if (input[key] === undefined) continue;
      out[key] = stableValue(input[key]);
    }
    return out;
  }
  return value;
}

/** Anahtar sırasından bağımsız, deterministik JSON. */
export function canonicalDocumentJson(document: DataDocument | null | undefined): string {
  if (!document) return 'null';
  const input = document as unknown as Record<string, unknown>;
  const filtered: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (VOLATILE_DOCUMENT_KEYS.has(key)) continue;
    if (input[key] === undefined) continue;
    filtered[key] = input[key];
  }
  return JSON.stringify(stableValue(filtered));
}

/** Kanonik belge içeriğinin sha256 özeti (ilk 16 hex karakter yeterli). */
export function hashDocument(document: DataDocument | null | undefined): string {
  return crypto
    .createHash('sha256')
    .update(canonicalDocumentJson(document), 'utf8')
    .digest('hex');
}
