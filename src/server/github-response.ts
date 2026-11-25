/**
 * GitHub API yanıtlarının çalışma zamanı doğrulaması (F5.1-06).
 *
 * `fetch(...).json()` sonucu `unknown`'dır; senkronizasyon motoru bu
 * yardımcılarla alanları doğrular. Geçersiz/eksik alanlar `null` döner ve
 * çağıran `malformed_response` üretir — istisna fırlatılmaz.
 */

import { asExternalRecord, readFiniteNumber, readString } from './external-json.ts';

export interface GitHubBlobPayload {
  content: string;
  size?: number;
}

/** `GET /git/blobs/:sha` — base64 içerik ve boyut. */
export function readGitHubBlobPayload(value: unknown): GitHubBlobPayload | null {
  const record = asExternalRecord(value);
  if (!record) return null;
  const content = readString(record.content, 64 * 1024 * 1024);
  if (content === undefined) return null;
  const size = readFiniteNumber(record.size);
  return size === undefined ? { content } : { content, size };
}

export interface GitHubContentEntry {
  sha: string;
  size?: number;
  content?: string;
  encoding?: string;
  downloadUrl?: string;
}

/** `GET /contents/:path` — tek dosya zarfı. */
export function readGitHubContentEntry(value: unknown): GitHubContentEntry | null {
  const record = asExternalRecord(value);
  if (!record) return null;
  const sha = readString(record.sha, 256);
  if (!sha) return null;
  const entry: GitHubContentEntry = { sha };
  const size = readFiniteNumber(record.size);
  if (size !== undefined) entry.size = size;
  const content = typeof record.content === 'string' ? record.content : undefined;
  if (content !== undefined) entry.content = content;
  const encoding = readString(record.encoding, 32);
  if (encoding !== undefined) entry.encoding = encoding;
  const downloadUrl = readString(record.download_url, 2048);
  if (downloadUrl !== undefined) entry.downloadUrl = downloadUrl;
  return entry;
}

export interface GitHubDirectoryEntry {
  name: string;
  sha?: string;
  size?: number;
  type?: string;
}

/** `GET /contents/:dir` — dizin listesi (dizi değilse `null`). */
export function readGitHubDirectoryEntries(value: unknown): GitHubDirectoryEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: GitHubDirectoryEntry[] = [];
  for (const raw of value) {
    const record = asExternalRecord(raw);
    if (!record) continue;
    const name = readString(record.name, 512);
    if (!name) continue;
    const entry: GitHubDirectoryEntry = { name };
    const sha = readString(record.sha, 256);
    if (sha) entry.sha = sha;
    const size = readFiniteNumber(record.size);
    if (size !== undefined) entry.size = size;
    const type = readString(record.type, 32);
    if (type) entry.type = type;
    entries.push(entry);
  }
  return entries;
}

/** GitHub hata gövdesindeki `message` alanı (yoksa boş dize). */
export function readGitHubErrorMessage(value: unknown): string {
  const record = asExternalRecord(value);
  if (!record) return '';
  return readString(record.message, 2000) ?? '';
}

/** Contents API `too_large` hatası mı? */
export function isGitHubTooLargeError(value: unknown): boolean {
  const record = asExternalRecord(value);
  if (!record || !Array.isArray(record.errors)) return false;
  return record.errors.some((entry) => {
    const detail = asExternalRecord(entry);
    return detail?.code === 'too_large';
  });
}
