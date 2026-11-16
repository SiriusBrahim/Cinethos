import crypto from 'node:crypto';

export type TokenSourceKind =
  | 'env:CINETRACK_GITHUB_TOKEN'
  | 'env:CINETRACK_GITHUB_PAT'
  | 'file:CINETRACK_GITHUB_TOKEN'
  | 'file:CINETRACK_GITHUB_PAT'
  | 'file:.env.local:CINETRACK_GITHUB_PAT'
  | 'file:.env.local:CINETRACK_GITHUB_TOKEN'
  | 'file:.env:CINETRACK_GITHUB_PAT'
  | 'file:.env:CINETRACK_GITHUB_TOKEN'
  | 'dotenv_local_pat'
  | 'dotenv_pat'
  | 'options'
  | 'none';

export type TokenFormatKind =
  | 'fine_grained_pat'
  | 'classic_pat'
  | 'oauth_or_app'
  | 'custom'
  | 'none';

export interface GitHubTokenCandidateInfo {
  token: string;
  source: TokenSourceKind;
}

export type SyncFileStage = 'pending' | 'syncing' | 'succeeded' | 'failed';

export type GitHubSyncErrorCategory =
  | 'config_error'
  | 'network_error'
  | 'rate_limit'
  | 'auth_error'
  | 'conflict'
  | 'not_found'
  | 'malformed_response'
  | 'corrupt_local_file'
  | 'http_error';

export interface RemoteRepoAccessCheck {
  ok: boolean;
  accessible: boolean;
  repoExists: boolean;
  branchExists: boolean;
  isEmptyRepo: boolean;
  isPrivate: boolean;
  effectiveIsPublicRepo: boolean;
  defaultBranch?: string;
  configuredBranch: string;
  hasPushPermission: boolean;
  acceptedPermissionsHeader?: string | null;
  warning?: string;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
}

export interface SyncFileStateRecord {
  repoPath: string;
  status: SyncFileStage;
  statusLabel: 'bekliyor' | 'gönderiliyor' | 'başarılı' | 'başarısız';
  noop?: boolean;
  blockedPublic?: boolean;
  localContentHash?: string;
  readBackHash?: string | null;
  verifiedReadBack?: boolean;
  sha?: string;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
  updatedAt: string;
}

export interface SyncStatus {
  configured: boolean;
  mode: 'github' | 'local_only';
  reason?: string;
  isPublicRepo: boolean;
  configuredEnvIsPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  personalSyncBlockedByPublicGuard?: boolean;
  catalogSyncBlockedByPublicGuard?: boolean;
  publicConsentUpdatedAt?: string | null;
  publicCatalogConsentUpdatedAt?: string | null;
  configDiagnostics?: {
    processEnvIsPublicRepo: string | null;
    localEnvIsPublicRepo: string | null;
    effectiveConfiguredIsPublicRepo: boolean;
    observedRemoteIsPublicRepo: boolean | null;
    allowPublicPersonalSync: boolean;
    allowPublicCatalogSync?: boolean;
    persistedUserConsent: boolean | null;
    persistedCatalogConsent?: boolean | null;
  };
  tokenDiagnostics?: {
    configured: boolean;
    source: TokenSourceKind;
    format: TokenFormatKind;
    length: number;
  };
  repoVisibilityWarning?: string;
  corruptionWarnings?: string[];
  lastSyncAt: string | null;
  syncInProgress?: boolean;
  initialReconcileCompleted?: boolean;
  lastError?: string | null;
  catalogCounts: {
    movies: number;
    tv: number;
  };
  profilesCount: number;
  localSummary?: any;
  lastRemoteSummary?: any;
  lastComparison?: any;
  lastSyncReport?: any;
  fileSummaryCounts?: {
    pending: number;
    syncing: number;
    succeeded: number;
    skipped: number;
    downloaded: number;
    uploaded: number;
    merged: number;
    failed: number;
  };
  fileStates: Record<string, SyncFileStateRecord>;
  remoteTarget?: {
    owner: string;
    repo: string;
    branch: string;
  };
}

export interface SyncResult {
  ok: boolean;
  partialFailure: boolean;
  filesCommitted: string[];
  filesSkipped: string[];
  filesFailed: string[];
  filesBlockedPublic: string[];
  fileStates: Record<string, SyncFileStateRecord>;
  repoVisibilityWarning?: string;
  errors: string[];
}

export interface StagedFileOutcome {
  repoPath: string;
  stage: 'probe' | 'catalog' | 'personal';
  status: 'succeeded' | 'failed' | 'skipped' | 'blocked';
  writeStatus:
    | 'committed'
    | 'unchanged_noop'
    | 'failed'
    | 'skipped_due_to_probe_failure'
    | 'skipped_due_to_catalog_failure'
    | 'blocked_public_guard';
  sizeBytes: number;
  localHash: string | null;
  readBackHash: string | null;
  sha?: string;
  verifiedReadBack: boolean;
  error?: string;
  errorCategory?: GitHubSyncErrorCategory;
}

export interface StagedSyncReport {
  ok: boolean;
  verifiedEqual: boolean;
  haltedAtStage?: 'probe' | 'catalog' | 'personal';
  probe: {
    ok: boolean;
    repoPath: string;
    step: string;
    sizeBytes: number;
    localHash: string | null;
    readBackHash: string | null;
    sha?: string;
    verifiedReadBack: boolean;
    error?: string;
    errorCategory?: GitHubSyncErrorCategory;
  };
  catalogStage: {
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
  };
  personalStage: {
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
  };
  access: RemoteRepoAccessCheck;
  allowPersonalSync: boolean;
  allowCatalogSync?: boolean;
  repoVisibilityWarning?: string;
  files: StagedFileOutcome[];
  fileOutcomes: StagedFileOutcome[];
  bidirectionalReport?: any;
}

export interface PersistentStoreOptions {
  dataDir: string;
  maxDataBytes?: number;
  githubToken?: string;
  githubTokenSource?: TokenSourceKind;
  githubTokenCandidates?: GitHubTokenCandidateInfo[];
  getLiveGitHubTokenCandidates?: () => GitHubTokenCandidateInfo[];
  onAuthFailureRefreshToken?: (
    failedToken: string
  ) => Promise<{ token: string; source?: TokenSourceKind } | string | null>;
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  isPublicRepo?: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
  processEnvIsPublicRepo?: string | null;
  localEnvIsPublicRepo?: string | null;
}

/**
 * Hata mesajları veya günlük metinlerinden GitHub token ve Bearer başlıklarını temizler.
 */
export function redactSecrets(input: string, extraSecrets: Array<string | undefined> = []): string {
  if (!input) return '';
  let sanitized = String(input);
  for (const secret of extraSecrets) {
    const trimmed = secret?.trim();
    if (trimmed && trimmed.length >= 4) {
      sanitized = sanitized.split(trimmed).join('[REDACTED]');
    }
  }
  sanitized = sanitized
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/\btoken\s+[A-Za-z0-9._-]{16,}/gi, 'token [REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]');
  return sanitized;
}

/**
 * Deterministic JSON stringifier that sorts object keys recursively and alphabetically.
 */
export function stringifyDeterministic(obj: any, space = 2): string {
  const sortRecursively = (val: any): any => {
    if (val === null || typeof val !== 'object') return val;
    if (Array.isArray(val)) return val.map(sortRecursively);
    const sortedKeys = Object.keys(val)
      .filter((k) => val[k] !== undefined)
      .sort((a, b) => a.localeCompare(b));
    const out: Record<string, any> = {};
    for (const k of sortedKeys) {
      out[k] = sortRecursively(val[k]);
    }
    return out;
  };
  return JSON.stringify(sortRecursively(obj), null, space);
}

/**
 * Calculate sha256 hash of a string
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
