/**
 * GitHub senkronizasyonu (Faz 5.3 / F5.3-04C) — saf işlem sonucu üretimi.
 *
 * `createUnconfiguredReport` private yöntemi GitHubBidirectionalSyncManager
 * sınıfından buraya taşındı. Yöntem tamamen saftır: yalnızca parametreleri
 * okur, hiçbir sınıf/state/lock/journal bağımlılığı kullanmaz. Davranış
 * birebir korunmuştur (eksik konfigürasyonda ok=false config_error raporu).
 */

import type {
  BidirectionalSyncReport,
  SyncOperationKind,
  SyncSideSummary,
} from '../../core/sync-display.ts';

export function createGithubSyncUnconfiguredReport(
  operation: SyncOperationKind,
  startedAt: string,
  localBefore: SyncSideSummary,
  isPublicRepo: boolean,
  remoteTarget?: { owner: string; repo: string; branch: string }
): BidirectionalSyncReport {
  return {
    ok: false,
    partialFailure: false,
    operation,
    startedAt,
    completedAt: new Date().toISOString(),
    remoteTarget,
    isPublicRepo,
    localBefore,
    remoteBefore: null,
    localAfter: localBefore,
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
        message: 'GitHub senkronizasyonu için token, sahip (owner) ve depo (repo) ayarları eksik.',
      },
    ],
    verifiedEqual: false,
  };
}
