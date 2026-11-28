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

export interface GitHubFileEnvelope {
  sha?: string;
  content?: string;
  encoding?: string;
  size?: number;
}

/** Contents API dosya zarfı — `sha` zorunlu değildir (blob yanıtları). */
export function readGitHubFileEnvelope(value: unknown): GitHubFileEnvelope | null {
  const record = asExternalRecord(value);
  if (!record) return null;
  const envelope: GitHubFileEnvelope = {};
  const sha = readString(record.sha, 256);
  if (sha) envelope.sha = sha;
  if (typeof record.content === 'string') envelope.content = record.content;
  const encoding = readString(record.encoding, 32);
  if (encoding !== undefined) envelope.encoding = encoding;
  const size = readFiniteNumber(record.size);
  if (size !== undefined) envelope.size = size;
  return envelope;
}

/** `PUT /contents` yanıtındaki commit SHA'sı (`content.sha`). */
export function readGitHubCommittedSha(value: unknown): string | undefined {
  const record = asExternalRecord(value);
  if (!record) return undefined;
  const content = asExternalRecord(record.content);
  if (!content) return undefined;
  return readString(content.sha, 256);
}

export interface GitHubRepositoryMeta {
  defaultBranch?: string;
  isPrivate?: boolean;
  canPush?: boolean;
}

/** `GET /repos/:owner/:repo` — görünürlük, varsayılan dal ve yazma izni. */
export function readGitHubRepositoryMeta(value: unknown): GitHubRepositoryMeta | null {
  const record = asExternalRecord(value);
  if (!record) return null;
  const meta: GitHubRepositoryMeta = {};
  const defaultBranch = readString(record.default_branch, 256);
  if (defaultBranch) meta.defaultBranch = defaultBranch;
  if (typeof record.private === 'boolean') meta.isPrivate = record.private;
  const permissions = asExternalRecord(record.permissions);
  if (permissions && typeof permissions.push === 'boolean') meta.canPush = permissions.push;
  return meta;
}

/** Dizin listesinde ada göre dosya kaydı (liste geçersizse `null`). */
export function findGitHubDirectoryEntry(
  value: unknown,
  name: string
): GitHubDirectoryEntry | null {
  const entries = readGitHubDirectoryEntries(value);
  if (!entries) return null;
  return entries.find((entry) => entry.name === name) ?? null;
}
