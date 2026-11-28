/**
 * F5.3-05 — Yerel veri katmanı ↔ geliştirme entegrasyonu sınırı.
 *
 * Bu modül yalnızca **tip** tanımlar ve hiçbir GitHub modülünü import etmez.
 * `PersistentDataStore` uzak senkronizasyon motorunu bu arayüz üzerinden
 * kullanır; gerçek motor `remote-sync-registry.ts` üzerinden
 * dışarıdan kaydedilir. Böylece:
 *  - yerel veri katmanı sağlayıcıya derleme zamanında bağlı değildir,
 *  - entegrasyon yoksa uygulama yerel modda çalışır (unconfigured davranış),
 *  - entegrasyon kaldırıldığında yalnızca kayıt modülü ve motor silinir.
 */

import type {
  BidirectionalSyncReport,
  SyncComparisonSummary,
  SyncOperationKind,
  SyncSideSummary,
} from '../../core/sync-display.ts';
import type { SyncQueueSnapshot } from '../../core/sync-operation-queue.ts';
import type { SyncAttemptRecord } from '../sync-attempt-journal.ts';
import type { PersistentDataStoreSyncPort } from '../persistent-store-types.ts';
import type { createDataStorage } from '../storage.ts';

/** Uzak hedef yapılandırması. Alanlar sağlayıcıdan bağımsız adlandırılmıştır. */
export interface RemoteSyncConfig {
  token?: string;
  owner?: string;
  repo?: string;
  branch: string;
  isPublicRepo: boolean;
  allowPublicPersonalSync?: boolean;
  allowPublicCatalogSync?: boolean;
}

/** Motorun yerel veri katmanından ihtiyaç duyduğu dar bağlam. */
export interface RemoteSyncDeps {
  dataDir: string;
  maxDataBytes?: number;
  enableStartupRecovery?: boolean;
  store: PersistentDataStoreSyncPort;
  storage: ReturnType<typeof createDataStorage>;
  getConfig: () => RemoteSyncConfig;
  onCompleted?: (info: {
    report: BidirectionalSyncReport;
    lastRemoteSummary: SyncSideSummary | null;
    lastComparison: SyncComparisonSummary | null;
  }) => void;
}

export interface RemoteSyncPullOptions {
  conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote';
}

export interface RemoteSyncReconcileOptions {
  includePersonalOverride?: boolean;
  includeCatalogOverride?: boolean;
}

/**
 * Yerel veri katmanının gördüğü tek uzak senkronizasyon yüzeyi.
 * GitHub'a özgü hiçbir üye adı içermez.
 */
export interface RemoteSyncEngine {
  isBusy(): boolean;
  getQueueStatus(): SyncQueueSnapshot;
  getRecoveredInterruption(): SyncAttemptRecord | null;
  isExclusiveActive(): boolean;
  hasCompletedInitialReconcile(): boolean;
  runExclusive<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  inspectLocalSideSync(): { summary: SyncSideSummary };
  inspect(): Promise<BidirectionalSyncReport>;
  pull(options?: RemoteSyncPullOptions): Promise<BidirectionalSyncReport>;
  push(): Promise<BidirectionalSyncReport>;
  reconcile(options?: RemoteSyncReconcileOptions): Promise<BidirectionalSyncReport>;
}

export type RemoteSyncEngineFactory = (deps: RemoteSyncDeps) => RemoteSyncEngine;

/** Entegrasyon yokken kullanılan, yalnızca yerel modu bildiren rapor. */
export function createRemoteSyncUnavailableReport(
  operation: SyncOperationKind,
  startedAt: string,
  isPublicRepo: boolean,
  remoteTarget?: { owner: string; repo: string; branch: string }
): BidirectionalSyncReport {
  const emptySummary: SyncSideSummary = {
    inspectedAt: new Date().toISOString(),
    catalogMovieCount: 0,
    catalogTvCount: 0,
    catalogRawMovieRecords: 0,
    catalogRawTvRecords: 0,
    catalogContentHash: null,
    catalogSemanticHash: null,
    manifestPresent: false,
    manifestValid: false,
    manifestMovieCount: null,
    manifestTvCount: null,
    manifestContentHash: null,
    userDataPresent: false,
    userProfilesCount: 0,
    userTotalSavedItemsCount: 0,
    userUniqueSavedItemsCount: 0,
    userDataSemanticHash: null,
    userDataRawHash: null,
    derivedProfileFilesCount: 0,
    derivedProfileTotalRecordsCount: 0,
    files: {},
  };
  return {
    ok: false,
    partialFailure: false,
    operation,
    startedAt,
    completedAt: new Date().toISOString(),
    remoteTarget,
    isPublicRepo,
    localBefore: emptySummary,
    remoteBefore: null,
    localAfter: emptySummary,
    remoteAfter: null,
    comparison: null,
    filesDownloaded: [],
    filesUploaded: [],
    filesUnchanged: [],
    filesMerged: [],
    filesFailed: [],
    filesPending: [],
    filesBlockedPublic: [],
    recordsAdded: 0,
    recordsUpdated: 0,
    recordsConflicted: 0,
    conflicts: [],
    warnings: [],
    errors: [
      {
        category: 'config_error',
        message:
          'Uzak senkronizasyon entegrasyonu bu kurulumda etkin değil; uygulama yerel modda çalışıyor.',
      },
    ],
    verifiedEqual: false,
  };
}
