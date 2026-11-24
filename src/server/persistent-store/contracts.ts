/**
 * Kalıcı depo — senkronizasyon sözleşmeleri (F5-07).
 *
 * `persistent-store.ts` içindeki tip tanımları, durum şablonları ve küçük
 * sınıflandırıcılar buraya taşındı; davranış değişmedi. `persistent-store.ts`
 * bu modülün tüm public yüzeyini yeniden dışa aktarır (eski import yolları
 * korunur).
 */

import type {
  BidirectionalSyncReport,
  SyncComparisonSummary,
  SyncSideSummary,
} from '../../core/sync-display.ts';
import type { SyncQueueSnapshot } from '../../core/sync-operation-queue.ts';

export const SYNC_STATE_VERSION = 2;

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

export interface PersistentStoreOptions {
  dataDir: string;
  maxDataBytes?: number;
  githubSyncEnabled?: boolean;
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
  authFailed?: boolean;
  githubSyncEnabled?: boolean;
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
  localSummary?: SyncSideSummary;
  lastRemoteSummary?: SyncSideSummary | null;
  lastComparison?: SyncComparisonSummary | null;
  lastSyncReport?: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null;
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
  /** Aşama 2 (B-10): çalışan/bekleyen işlemler ve son sonuç. */
  syncQueue?: SyncQueueSnapshot;
  /** Aşama 2 (B-10): önceki süreçte yarım kalan işlem. */
  interruptedSync?: {
    operation: string;
    startedAt: string;
    recoveredAt: string;
  } | null;
  syncStateVersion?: number;
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
  bidirectionalReport?: BidirectionalSyncReport | null;
}

export const STAGE_LABELS: Record<SyncFileStage, SyncFileStateRecord['statusLabel']> = {
  pending: 'bekliyor',
  syncing: 'gönderiliyor',
  succeeded: 'başarılı',
  failed: 'başarısız',
};

export function isPlainRecordObject(raw: any): boolean {
  return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw));
}

export function classifyHttpFailure(status: number, headers: Headers, bodyMessage: string): GitHubSyncErrorCategory {
  const remaining = headers.get('x-ratelimit-remaining');
  const lowerMsg = (bodyMessage || '').toLowerCase();
  if (
    status === 429 ||
    (status === 403 && (remaining === '0' || lowerMsg.includes('rate limit')))
  ) {
    return 'rate_limit';
  }
  if (status === 401 || status === 403) {
    return 'auth_error';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 404) {
    return 'not_found';
  }
  return 'http_error';
}

export function classifyTokenFormat(token?: string): TokenFormatKind {
  if (!token) return 'none';
  if (token.startsWith('github_pat_')) return 'fine_grained_pat';
  if (token.startsWith('ghp_')) return 'classic_pat';
  if (/^gh[ousr]_/.test(token)) return 'oauth_or_app';
  return 'custom';
}
