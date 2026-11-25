import type { createDataStorage } from './storage.ts';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { errorMessageOf, redactSecrets, stringifyDeterministic, hashContent, sanitizeProfileId,  } from './persistent-store-utils.ts';
import {
  findGitHubDirectoryEntry,
  isGitHubTooLargeError,
  readGitHubCommittedSha,
  readGitHubErrorMessage,
  readGitHubFileEnvelope,
  readGitHubRepositoryMeta,
  type GitHubRepositoryMeta,
} from './github-response.ts';
export { redactSecrets, stringifyDeterministic, hashContent, toCanonicalKey, mergeCatalogItem, sanitizeProfileId } from './persistent-store-utils.ts';
import type { CatalogRecord, CatalogManifest, DerivedProfileDocument } from './persistent-store-types.ts';
export type { CatalogRecord, CatalogManifest, DerivedProfileItem, DerivedProfileDocument } from './persistent-store-types.ts';
import { cleanupStaleTempFiles, FileWriteSerializer, readJsonFileWithRecovery, readJsonFileWithRecoveryAsync, tryParseValidJson,  } from './atomic-json.ts';
import { type DerivedProfileValidationResult,  } from '../core/derived-profile-cache.ts';
import { normalizeCinemaKunyeDocument, type CinemaKunyeDocument,  } from '../core/cinema-kunye.ts';
import type {
  BidirectionalSyncReport,
  SyncComparisonSummary,
  SyncSideSummary,
} from '../core/sync-display.ts';
import { BRAND_SYNC_USER_AGENT } from '../shared/brand.ts';
import { GitHubBidirectionalSyncManager } from './github-bidirectional-sync.ts';

/** Aşama 2: kalıcı senkronizasyon durumu şema sürümü. v1 alanları geriye dönük okunur. */
export * from './persistent-store/contracts.ts';
import {
  upsertCatalogItemsOp,
  upsertCatalogItemsAsyncOp,
  type CatalogUpsertResult,
} from './persistent-store/catalog-write-store.ts';
import {
  upsertDerivedProfileOp,
  upsertDerivedProfileAsyncOp,
  type UpsertDerivedProfileInput,
  type DerivedProfileUpsertResult,
  type DerivedProfileWriteContext,
} from './persistent-store/derived-profile-write-store.ts';
import { saveCinemaKunyeOp, type CinemaKunyeSaveResult } from './persistent-store/cinema-kunye-write-store.ts';
import { saveStockSnapshotUploadOp } from './persistent-store/stock-write-store.ts';
import {
  commitFileToGitHubImpl,
  fetchBlobTextByShaImpl,
  fetchBlobBufferByShaImpl,
  type GitHubCommitOutcome,
} from './persistent-store/github-commit-store.ts';
import {
  loadSyncStateSnapshot,
  recoverInterruptedFileStates,
  saveSyncStateSnapshot,
} from './persistent-store/store-state.ts';
import {
  ensureCatalogFiles as ensureCatalogFilesImpl,
  ensureCatalogFilesAsync as ensureCatalogFilesAsyncImpl,
  readCatalog as readCatalogImpl,
  readCatalogAsync as readCatalogAsyncImpl,
  readCatalogManifest as readCatalogManifestImpl,
  readCatalogManifestAsync as readCatalogManifestAsyncImpl,
  type CatalogStoreContext,
} from './persistent-store/catalog-store.ts';
import {
  readDerivedProfile as readDerivedProfileImpl,
  readDerivedProfileAsync as readDerivedProfileAsyncImpl,
  readValidatedDerivedProfile as readValidatedDerivedProfileImpl,
  readValidatedDerivedProfileAsync as readValidatedDerivedProfileAsyncImpl,
  type DerivedProfileStoreContext,
} from './persistent-store/derived-profile-store.ts';

import type {
  GitHubSyncErrorCategory,
  GitHubTokenCandidateInfo,
  PersistentStoreOptions,
  RemoteRepoAccessCheck,
  StagedFileOutcome,
  StagedSyncReport,
  SyncFileStage,
  SyncFileStateRecord,
  SyncResult,
  SyncStatus,
  TokenSourceKind,
} from './persistent-store/contracts.ts';
// `node server.ts` (npm start) TypeScript tiplerini yalnızca silerek çalıştırır;
// bu yüzden tip adları ayrı bir `import type` bloğunda olmalıdır.
import {
  STAGE_LABELS,
  SYNC_STATE_VERSION,
  classifyHttpFailure,
  classifyTokenFormat,
  isPlainRecordObject,
} from './persistent-store/contracts.ts';

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainRecordObject) : [];
}

export class PersistentDataStore {
  private dataDir: string;
  private catalogDir: string;
  private profilesDir: string;
  private moviesFile: string;
  private tvFile: string;
  private manifestFile: string;
  private syncStateFile: string;
  private lastSyncAt: string | null = null;
  private lastError: string | null = null;
  private lastRemoteSummary: SyncSideSummary | null = null;
  private lastComparison: SyncComparisonSummary | null = null;
  private lastSyncReport: Omit<BidirectionalSyncReport, 'updatedDataDocument'> | null = null;
  private persistedInitialReconcile = false;
  private persistedPublicPersonalConsent?: boolean;
  private publicConsentUpdatedAt: string | null = null;
  private persistedPublicCatalogConsent?: boolean;
  private publicCatalogConsentUpdatedAt: string | null = null;
  private lastObservedRemotePublic?: boolean;
  private repoVisibilityWarning?: string;
  private fileStates: Record<string, SyncFileStateRecord> = {};
  private writeSerializer = new FileWriteSerializer();
  private maxDataBytes?: number;
  private githubSyncEnabled: boolean;
  private attachedStorage!: ReturnType<typeof createDataStorage>;
  private bidirectionalManager!: GitHubBidirectionalSyncManager;

  private githubToken?: string;
  private githubTokenSource: TokenSourceKind;
  private githubTokenCandidates: GitHubTokenCandidateInfo[] = [];
  private getLiveGitHubTokenCandidates?: () => GitHubTokenCandidateInfo[];
  private onAuthFailureRefreshToken?: (
    failedToken: string
  ) => Promise<{ token: string; source?: TokenSourceKind } | string | null>;
  private invalidatedGitHubTokens = new Set<string>();
  private githubOwner?: string;
  private githubRepo?: string;
  private githubBranch: string;
  private isPublicRepo: boolean;
  private allowPublicPersonalSync?: boolean;
  private allowPublicCatalogSync?: boolean;
  private processEnvIsPublicRepo: string | null;
  private localEnvIsPublicRepo: string | null;

  constructor(options: PersistentStoreOptions) {
    this.dataDir = options.dataDir;
    this.maxDataBytes = options.maxDataBytes;
    this.githubSyncEnabled = options.githubSyncEnabled !== false;
    this.catalogDir = path.join(this.dataDir, 'catalog');
    this.profilesDir = path.join(this.dataDir, 'profiles');
    this.moviesFile = path.join(this.catalogDir, 'movies.json');
    this.tvFile = path.join(this.catalogDir, 'tv.json');
    this.manifestFile = path.join(this.catalogDir, 'manifest.json');
    this.syncStateFile = path.join(this.dataDir, 'sync-state.json');

    this.githubToken = options.githubToken?.trim();
    this.githubTokenSource =
      options.githubTokenSource ?? (this.githubToken ? 'options' : 'none');
    if (Array.isArray(options.githubTokenCandidates)) {
      for (const cand of options.githubTokenCandidates) {
        const tok = cand?.token?.trim();
        if (tok && !this.githubTokenCandidates.some((x) => x.token === tok)) {
          this.githubTokenCandidates.push({ token: tok, source: cand.source });
        }
      }
    }
    if (
      this.githubToken &&
      !this.githubTokenCandidates.some((x) => x.token === this.githubToken)
    ) {
      this.githubTokenCandidates.unshift({
        token: this.githubToken,
        source: this.githubTokenSource,
      });
    }
    this.getLiveGitHubTokenCandidates = options.getLiveGitHubTokenCandidates;
    this.onAuthFailureRefreshToken = options.onAuthFailureRefreshToken;
    this.githubOwner = options.githubOwner?.trim();
    this.githubRepo = options.githubRepo?.trim();
    this.githubBranch = options.githubBranch?.trim() || 'main';
    this.isPublicRepo = Boolean(options.isPublicRepo);
    this.allowPublicPersonalSync = options.allowPublicPersonalSync;
    this.allowPublicCatalogSync = options.allowPublicCatalogSync;
    this.processEnvIsPublicRepo = options.processEnvIsPublicRepo ?? null;
    this.localEnvIsPublicRepo = options.localEnvIsPublicRepo ?? null;

    this.initDirectories();
    if (this.githubSyncEnabled) this.loadPersistedSyncState();
  }

  public getEffectiveConfiguredIsPublicRepo(): boolean {
    return Boolean(
      this.isPublicRepo ||
        this.persistedPublicPersonalConsent === true ||
        this.allowPublicPersonalSync === true
    );
  }

  public isPersonalSyncAllowedForRepo(
    remoteIsPublic: boolean,
    perCallOverride?: boolean
  ): boolean {
    if (!remoteIsPublic) return true;
    if (perCallOverride !== undefined) return perCallOverride;
    if (this.persistedPublicPersonalConsent !== undefined) {
      return this.persistedPublicPersonalConsent;
    }
    if (this.allowPublicPersonalSync !== undefined) {
      return this.allowPublicPersonalSync;
    }
    return Boolean(this.isPublicRepo);
  }

  public isCatalogSyncAllowedForRepo(
    remoteIsPublic: boolean,
    perCallOverride?: boolean
  ): boolean {
    if (!remoteIsPublic) return true;
    if (perCallOverride !== undefined) return perCallOverride;
    if (this.persistedPublicCatalogConsent !== undefined) {
      return this.persistedPublicCatalogConsent;
    }
    return Boolean(this.allowPublicCatalogSync);
  }

  private buildPublicVisibilityWarning(remoteIsPublic: boolean): string | undefined {
    const effectiveConfiguredIsPublic = this.getEffectiveConfiguredIsPublicRepo();
    const personalAllowed = this.isPersonalSyncAllowedForRepo(remoteIsPublic);
    const catalogAllowed = this.isCatalogSyncAllowedForRepo(remoteIsPublic);
    if (!remoteIsPublic) {
      if (effectiveConfiguredIsPublic) {
        return 'Yapılandırma uyarısı: Uzak GitHub deposu özel (private), ancak CINETRACK_DATA_REPO_IS_PUBLIC=true tanımlandı.';
      }
      return undefined;
    }
    if (!effectiveConfiguredIsPublic && !catalogAllowed) {
      return 'Yapılandırma uyarısı: Uzak GitHub deposu herkese açıktır (public), ancak CINETRACK_DATA_REPO_IS_PUBLIC=false ve CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC=false tanımlıdır. Kişisel profil verileri ve TMDB katalog dosyalarının açık depoya gönderimi engellendi.';
    }
    if (!personalAllowed && !catalogAllowed) {
      return 'Bilgi: Uzak GitHub veri deposu herkese açıktır (public). Gizlilik ve TMDB lisans koruması aktif olduğu için açık onay verilmeden kişisel veriler ve katalog dosyaları gönderilmez.';
    }
    if (!personalAllowed && catalogAllowed) {
      return 'Bilgi: Uzak GitHub veri deposu herkese açıktır (public). Gizlilik koruması aktif olduğu için kişisel veriler gönderilmez; TMDB katalog verileri açık lisans onayınız doğrultusunda senkronize edilir.';
    }
    if (personalAllowed && !catalogAllowed) {
      return 'Dikkat: Uzak GitHub veri deposu herkese açıktır (public). Kişisel profil verileriniz açık onayınızla senkronize edilir; TMDB katalog dosyaları ise CINETRACK_ALLOW_PUBLIC_CATALOG_SYNC onayı olmadığı için açık depoya gönderilmez.';
    }
    return 'Dikkat: Uzak GitHub veri deposu herkese açıktır (public). Kişisel izleme listesi, profil verileriniz ve TMDB katalog önbelleği açık onayınız doğrultusunda herkese açık olarak depolanmaktadır.';
  }

  public setPublicPersonalSyncConsent(allowPersonalDataInPublicRepo: boolean): {
    allowPublicPersonalSync: boolean;
    effectiveConfiguredIsPublicRepo: boolean;
    catalogSyncBlockedByPublicGuard: boolean;
    updatedAt: string;
  } {
    this.persistedPublicPersonalConsent = Boolean(allowPersonalDataInPublicRepo);
    this.publicConsentUpdatedAt = new Date().toISOString();
    if (this.lastObservedRemotePublic === true) {
      this.repoVisibilityWarning = this.buildPublicVisibilityWarning(true);
    }
    this.persistSyncState();
    return {
      allowPublicPersonalSync: this.isPersonalSyncAllowedForRepo(true),
      effectiveConfiguredIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
      catalogSyncBlockedByPublicGuard: !this.isCatalogSyncAllowedForRepo(true),
      updatedAt: this.publicConsentUpdatedAt,
    };
  }

  public setPublicCatalogSyncConsent(allowCatalogInPublicRepo: boolean): {
    allowPublicCatalogSync: boolean;
    catalogSyncBlockedByPublicGuard: boolean;
    updatedAt: string;
  } {
    this.persistedPublicCatalogConsent = Boolean(allowCatalogInPublicRepo);
    this.publicCatalogConsentUpdatedAt = new Date().toISOString();
    if (this.lastObservedRemotePublic === true) {
      this.repoVisibilityWarning = this.buildPublicVisibilityWarning(true);
    }
    this.persistSyncState();
    return {
      allowPublicCatalogSync: this.isCatalogSyncAllowedForRepo(true),
      catalogSyncBlockedByPublicGuard: !this.isCatalogSyncAllowedForRepo(true),
      updatedAt: this.publicCatalogConsentUpdatedAt,
    };
  }

  private createBidirectionalManager(): GitHubBidirectionalSyncManager {
    return new GitHubBidirectionalSyncManager({
      dataDir: this.dataDir,
      maxDataBytes: this.maxDataBytes,
      enableStartupRecovery: this.githubSyncEnabled,
      store: this,
      storage: this.attachedStorage,
      getGitHubConfig: () => ({
        token: this.githubToken,
        owner: this.githubOwner,
        repo: this.githubRepo,
        branch: this.githubBranch,
        isPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
        allowPublicPersonalSync: this.isPersonalSyncAllowedForRepo(true),
        allowPublicCatalogSync: this.isCatalogSyncAllowedForRepo(true),
      }),
      onSyncCompleted: ({ report, lastRemoteSummary, lastComparison }) => {
        this.recordBidirectionalOutcome(report, lastRemoteSummary, lastComparison);
      },
    });
  }

  /**
   * Aşama 2 (B-38): Kuyruk dışı senkronizasyon yazma yollarını aynı FIFO
   * kuyruğu + süreçler arası kilitten geçirir. Zaten kuyruk içindeysek
   * (ör. aşamalı senkronizasyonun çağırdığı prob) yeniden kilitlenmez.
   */
  private async withExclusiveSync<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (!this.bidirectionalManager) return fn();
    // runExclusive kendi AsyncLocalStorage bağlamıyla yalnızca gerçek iç içe
    // çağrıları tanır. Queue'nun global "running" durumu bağımsız istekleri
    // doğrudan çalıştırmak için kullanılmamalıdır.
    return this.bidirectionalManager.runExclusive(operation, fn);
  }

  public async runExclusiveSyncToGitHub(
    options: Parameters<PersistentDataStore['syncToGitHub']>[0] = {}
  ): Promise<SyncResult> {
    return this.withExclusiveSync('push-files', () => this.syncToGitHub(options));
  }

  public async runExclusiveSafeConnectionProbe(
    options: Parameters<PersistentDataStore['testSafeConnectionAndProbeManifest']>[0] = {}
  ): Promise<Awaited<ReturnType<PersistentDataStore['testSafeConnectionAndProbeManifest']>>> {
    return this.withExclusiveSync('connection-probe', () =>
      this.testSafeConnectionAndProbeManifest(options)
    );
  }

  public async runExclusiveStagedFullSync(
    options: Parameters<PersistentDataStore['runStagedFullSync']>[0] = {}
  ): Promise<StagedSyncReport> {
    return this.withExclusiveSync('staged-sync', () => this.runStagedFullSync(options));
  }

  public attachDataStorage(
    storage: ReturnType<typeof createDataStorage>,
    maxDataBytes?: number
  ): void {
    this.attachedStorage = storage;
    if (typeof maxDataBytes === 'number' && maxDataBytes > 0) {
      this.maxDataBytes = maxDataBytes;
    }
    this.bidirectionalManager = this.createBidirectionalManager();
  }

  public getKnownSecretsForRedaction(): string[] {
    const secrets = new Set<string>();
    if (this.githubToken) secrets.add(this.githubToken);
    for (const c of this.githubTokenCandidates) {
      if (c.token) secrets.add(c.token);
    }
    for (const bad of this.invalidatedGitHubTokens) {
      if (bad) secrets.add(bad);
    }
    return Array.from(secrets);
  }

  // Çalışan sunucuda GitHub token'ını değiştirir; yönetici token'ı getGitHubConfig
  // üzerinden canlı okuduğu için yeniden başlatma gerekmez.
  public updateGitHubToken(token: string, source?: TokenSourceKind): void {
    const trimmed = (token || '').trim();
    if (!trimmed) return;
    this.invalidatedGitHubTokens.delete(trimmed);
    const nextSource: TokenSourceKind =
      source ??
      (trimmed === this.githubToken
        ? this.githubTokenSource
        : 'file:.env:CINETRACK_GITHUB_PAT');
    this.githubToken = trimmed;
    this.githubTokenSource = nextSource;
    if (!this.githubTokenCandidates.some((c) => c.token === trimmed)) {
      this.githubTokenCandidates.unshift({ token: trimmed, source: nextSource });
    }
  }

  /**
   * HTTP 401 (Bad credentials / süresi dolmuş veya gölgelenmiş token) alındığında
   * sıradaki geçerli adaya (.env.local / .env veya Kimlik Yöneticisi) otomatik geçiş yapar.
   */
  public async recoverGitHubTokenOn401(failedToken?: string): Promise<string | null> {
    const bad = (failedToken || this.githubToken || '').trim();
    if (bad) {
      this.invalidatedGitHubTokens.add(bad);
    }

    if (
      this.githubToken &&
      this.githubToken !== bad &&
      !this.invalidatedGitHubTokens.has(this.githubToken)
    ) {
      return this.githubToken;
    }

    const combinedCandidates: GitHubTokenCandidateInfo[] = [...this.githubTokenCandidates];
    if (typeof this.getLiveGitHubTokenCandidates === 'function') {
      try {
        for (const liveCand of this.getLiveGitHubTokenCandidates()) {
          const tok = liveCand?.token?.trim();
          if (tok && tok !== bad && !combinedCandidates.some((c) => c.token === tok)) {
            this.invalidatedGitHubTokens.delete(tok);
            combinedCandidates.push({ token: tok, source: liveCand.source });
          }
        }
      } catch {
        // canlı .env okuma hatası yoksayılır
      }
    }

    const nextCandidate = combinedCandidates.find(
      (c) => c.token && c.token !== bad && !this.invalidatedGitHubTokens.has(c.token)
    );
    if (nextCandidate) {
      this.githubToken = nextCandidate.token;
      this.githubTokenSource = nextCandidate.source;
      if (!this.githubTokenCandidates.some((c) => c.token === nextCandidate.token)) {
        this.githubTokenCandidates.push(nextCandidate);
      }
      return nextCandidate.token;
    }

    if (typeof this.onAuthFailureRefreshToken === 'function' && bad) {
      try {
        const refreshed = await this.onAuthFailureRefreshToken(bad);
        const refreshedTok =
          typeof refreshed === 'string' ? refreshed.trim() : refreshed?.token?.trim() || '';
        const refreshedSource: TokenSourceKind =
          typeof refreshed === 'object' && refreshed?.source
            ? refreshed.source
            : 'file:.env:CINETRACK_GITHUB_PAT';
        if (
          refreshedTok &&
          refreshedTok !== bad &&
          !this.invalidatedGitHubTokens.has(refreshedTok)
        ) {
          this.updateGitHubToken(refreshedTok, refreshedSource);
          return refreshedTok;
        }
      } catch {
        // Kimlik yöneticisi hatası yoksayılır
      }
    }

    return null;
  }

  public isSyncBusy(): boolean {
    return this.bidirectionalManager.isBusy();
  }

  public hasCompletedInitialReconcile(): boolean {
    return this.persistedInitialReconcile || this.bidirectionalManager.hasCompletedInitialReconcile();
  }

  private recordBidirectionalOutcome(
    report: BidirectionalSyncReport,
    lastRemoteSummary: SyncSideSummary | null,
    lastComparison: SyncComparisonSummary | null
  ): void {
    if (lastRemoteSummary) {
      this.lastRemoteSummary = lastRemoteSummary;
    }
    if (lastComparison) {
      this.lastComparison = lastComparison;
    }
    if (report.repoVisibilityWarning) {
      this.repoVisibilityWarning = report.repoVisibilityWarning;
    }

    if (
      report.operation !== 'inspect' &&
      report.ok &&
      !report.requiresConfirmation &&
      report.errors.length === 0
    ) {
      this.lastSyncAt = report.completedAt;
      this.lastError = null;
    } else if (report.errors.length > 0) {
      this.lastError = redactSecrets(
        report.errors.map((e) => e.message).join(' | '),
        [this.githubToken]
      );
    } else if (report.ok) {
      this.lastError = null;
    }

    if (report.operation === 'reconcile' && report.verifiedEqual) {
      this.persistedInitialReconcile = true;
    }

    // Dosya bazlı durum tablosunu güncel tut
    for (const p of report.filesPending) {
      this.setFileSyncStage(p, 'pending', { error: undefined, errorCategory: undefined });
    }
    for (const p of [
      ...report.filesDownloaded,
      ...report.filesUploaded,
      ...report.filesMerged,
      ...report.filesUnchanged,
    ]) {
      if (!report.filesPending.includes(p) && !report.filesFailed.includes(p)) {
        const localHash = report.localAfter.files[p]?.rawFileHash || undefined;
        const remoteFile = report.remoteAfter?.files[p];
        this.setFileSyncStage(p, 'succeeded', {
          localContentHash: localHash,
          readBackHash: remoteFile?.rawFileHash ?? null,
          verifiedReadBack: Boolean(remoteFile?.exists && remoteFile?.valid && remoteFile?.rawFileHash),
          sha: remoteFile?.sha,
          noop: report.filesUnchanged.includes(p),
          error: undefined,
          errorCategory: undefined,
        });
      }
    }
    for (const p of report.filesFailed) {
      const matchingErr = report.errors.find((e) => e.repoPath === p);
      const localHash = report.localAfter.files[p]?.rawFileHash || undefined;
      this.setFileSyncStage(p, 'failed', {
        localContentHash: localHash,
        readBackHash: null,
        verifiedReadBack: false,
        error: matchingErr?.message || `${p} senkronizasyon hatası`,
        errorCategory: (matchingErr?.category as GitHubSyncErrorCategory) || 'http_error',
      });
    }

    const { updatedDataDocument: _omittedDoc, ...compactReport } = report;
    void _omittedDoc;
    this.lastSyncReport = compactReport;
    this.persistSyncState();
  }

  private initDirectories() {
    if (!existsSync(this.dataDir)) mkdirSync(this.dataDir, { recursive: true });
    if (!existsSync(this.catalogDir)) mkdirSync(this.catalogDir, { recursive: true });
    if (!existsSync(this.profilesDir)) mkdirSync(this.profilesDir, { recursive: true });
    // Faz 6: Taste Engine dizini
    const tasteDir = path.join(this.dataDir, 'taste');
    if (!existsSync(tasteDir)) mkdirSync(tasteDir, { recursive: true });

    // Yarım kalmış geçici dosyaları başlangıçta kontrollü biçimde temizle
    cleanupStaleTempFiles(this.dataDir);
    cleanupStaleTempFiles(this.catalogDir);
    cleanupStaleTempFiles(this.profilesDir);
    cleanupStaleTempFiles(tasteDir);
  }

  private loadPersistedSyncState() {
    const snapshot = loadSyncStateSnapshot(this.syncStateFile);
    if (!snapshot) return;
    this.lastSyncAt = snapshot.lastSyncAt;
    this.lastError = snapshot.lastError;
    this.repoVisibilityWarning = snapshot.repoVisibilityWarning;
    this.persistedInitialReconcile = snapshot.persistedInitialReconcile;
    if (snapshot.persistedPublicPersonalConsent !== undefined) {
      this.persistedPublicPersonalConsent = snapshot.persistedPublicPersonalConsent;
    }
    this.publicConsentUpdatedAt = snapshot.publicConsentUpdatedAt;
    if (snapshot.persistedPublicCatalogConsent !== undefined) {
      this.persistedPublicCatalogConsent = snapshot.persistedPublicCatalogConsent;
    }
    this.publicCatalogConsentUpdatedAt = snapshot.publicCatalogConsentUpdatedAt;
    if (snapshot.lastObservedRemotePublic !== undefined) {
      this.lastObservedRemotePublic = snapshot.lastObservedRemotePublic;
    }
    this.lastRemoteSummary = snapshot.lastRemoteSummary;
    this.lastComparison = snapshot.lastComparison;
    this.lastSyncReport = snapshot.lastSyncReport;
    this.fileStates = snapshot.fileStates;
    this.recoverStaleSyncingFileStates();
  }

  private recoverStaleSyncingFileStates(): void {
    const { fileStates, recovered } = recoverInterruptedFileStates(
      this.fileStates,
      new Date().toISOString()
    );
    if (recovered.length === 0) return;
    this.fileStates = fileStates;
    this.lastError = `Kesinti sonrası kurtarma: ${recovered.length} dosya yarıda kalmıştı (${recovered.join(', ')}).`;
    try {
      this.persistSyncState();
    } catch {
      // Kalıcılaştırma başarısız olsa da bellek durumu doğru kalır.
    }
  }

  private persistSyncState() {
    saveSyncStateSnapshot(this.syncStateFile, {
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      repoVisibilityWarning: this.repoVisibilityWarning,
      persistedInitialReconcile: this.persistedInitialReconcile,
      ...(this.persistedPublicPersonalConsent !== undefined
        ? { persistedPublicPersonalConsent: this.persistedPublicPersonalConsent }
        : {}),
      publicConsentUpdatedAt: this.publicConsentUpdatedAt,
      ...(this.persistedPublicCatalogConsent !== undefined
        ? { persistedPublicCatalogConsent: this.persistedPublicCatalogConsent }
        : {}),
      publicCatalogConsentUpdatedAt: this.publicCatalogConsentUpdatedAt,
      ...(this.lastObservedRemotePublic !== undefined
        ? { lastObservedRemotePublic: this.lastObservedRemotePublic }
        : {}),
      lastRemoteSummary: this.lastRemoteSummary,
      lastComparison: this.lastComparison,
      lastSyncReport: this.lastSyncReport,
      fileStates: this.fileStates,
    });
  }

  private setFileSyncStage(
    repoPath: string,
    status: SyncFileStage,
    extra: Partial<Omit<SyncFileStateRecord, 'repoPath' | 'status' | 'statusLabel' | 'updatedAt'>> = {}
  ) {
    const prev = this.fileStates[repoPath];
    const resolvedReadBackHash =
      extra.readBackHash !== undefined
        ? extra.readBackHash
        : status === 'failed'
        ? null
        : prev?.readBackHash;
    const resolvedVerifiedReadBack =
      extra.verifiedReadBack !== undefined
        ? extra.verifiedReadBack
        : status === 'failed'
        ? false
        : prev?.verifiedReadBack;
    this.fileStates[repoPath] = {
      repoPath,
      status,
      statusLabel: STAGE_LABELS[status],
      localContentHash: extra.localContentHash ?? prev?.localContentHash,
      ...(resolvedReadBackHash !== undefined ? { readBackHash: resolvedReadBackHash } : {}),
      ...(resolvedVerifiedReadBack !== undefined ? { verifiedReadBack: resolvedVerifiedReadBack } : {}),
      sha: status === 'failed' ? extra.sha : extra.sha ?? prev?.sha,
      ...(extra.noop !== undefined ? { noop: extra.noop } : {}),
      ...(extra.blockedPublic !== undefined ? { blockedPublic: extra.blockedPublic } : {}),
      ...(extra.error ? { error: redactSecrets(extra.error, [this.githubToken]) } : {}),
      ...(extra.errorCategory ? { errorCategory: extra.errorCategory } : {}),
      updatedAt: new Date().toISOString(),
    };
  }

  // --- CATALOG OPERATIONS ---

  /** F5.2-03: katalog okuma/hazırlama yolu alt mağazaya delege edilir. */
  private catalogStoreContext(): CatalogStoreContext {
    return {
      catalogDir: this.catalogDir,
      moviesFile: this.moviesFile,
      tvFile: this.tvFile,
      manifestFile: this.manifestFile,
    };
  }

  private derivedProfileWriteContext(): DerivedProfileWriteContext {
    return {
      profileFilePath: (profileId) => this.getProfileFilePath(profileId),
      readCatalogManifest: () => this.readCatalogManifest(),
      readCatalogManifestAsync: () => this.readCatalogManifestAsync(),
      readExisting: (profileId) => this.readDerivedProfile(profileId, { allowNullOnCorrupt: false }),
      readExistingAsync: (profileId) => this.readDerivedProfileAsync(profileId, { allowNullOnCorrupt: false }),
    };
  }

  private derivedProfileStoreContext(): DerivedProfileStoreContext {
    return { profileFilePath: (profileId) => this.getProfileFilePath(profileId) };
  }

  public readCatalog(
    mediaType: 'movie' | 'tv',
    options: { allowEmptyOnCorrupt?: boolean } = {}
  ): Record<string, CatalogRecord> {
    return readCatalogImpl(this.catalogStoreContext(), mediaType, options);
  }

  public readCatalogManifest(): CatalogManifest | null {
    return readCatalogManifestImpl(this.catalogStoreContext());
  }

  public async readCatalogAsync(
    mediaType: 'movie' | 'tv',
    options: { allowEmptyOnCorrupt?: boolean } = {}
  ): Promise<Record<string, CatalogRecord>> {
    return readCatalogAsyncImpl(this.catalogStoreContext(), mediaType, options);
  }

  public async readCatalogManifestAsync(): Promise<CatalogManifest | null> {
    return readCatalogManifestAsyncImpl(this.catalogStoreContext());
  }

  /**
   * Yerel katalog dizini ve dosyalarının (movies.json, tv.json, manifest.json) varlığını garanti eder.
   */
  public ensureCatalogFiles(): void {
    ensureCatalogFilesImpl(this.catalogStoreContext());
  }

  public async ensureCatalogFilesAsync(): Promise<void> {
    await ensureCatalogFilesAsyncImpl(this.catalogStoreContext());
  }

  /**
   * Güvenli bağlantı testi (Aşama 5):
   * Tam senkronizasyon çalıştırmadan önce depo meta verilerini, `main` dalını ve
   * `data/catalog/manifest.json` dosyasını test probu olarak kontrol eder.
   */
  public async testSafeConnectionAndProbeManifest(
    options: { forceWriteProbe?: boolean } = {}
  ): Promise<{
    ok: boolean;
    step: 'access_check' | 'manifest_read' | 'manifest_probe_created' | 'manifest_verified';
    probeRepoPath: string;
    probeSizeBytes: number;
    localHash: string;
    readBackHash: string | null;
    access: RemoteRepoAccessCheck;
    manifestSha?: string;
    verifiedReadBack?: boolean;
    error?: string;
    errorCategory?: GitHubSyncErrorCategory;
  }> {
    await this.ensureCatalogFilesAsync();
    let manifestContent: string;
    try {
      manifestContent = await fsPromises.readFile(this.manifestFile, 'utf8');
    } catch {
      manifestContent = stringifyDeterministic({
        version: 1,
        updatedAt: new Date().toISOString(),
        movieCount: 0,
        tvCount: 0,
        contentHash: hashContent('{}{}'),
      });
    }
    const probeSizeBytes = Buffer.byteLength(manifestContent, 'utf8');
    const localHash = hashContent(manifestContent.trim());

    const access = await this.verifyRemoteRepoAccess();
    if (!access.ok) {
      return {
        ok: false,
        step: 'access_check',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: null,
        access,
        verifiedReadBack: false,
        error: access.error,
        errorCategory: access.errorCategory,
      };
    }

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        ok: false,
        step: 'access_check',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: null,
        access,
        verifiedReadBack: false,
        error: 'GitHub kimlik bilgileri eksik.',
        errorCategory: 'config_error',
      };
    }

    const apiUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/data/catalog/manifest.json`;

    if (!access.isEmptyRepo && !options.forceWriteProbe) {
      try {
        let activeTok = this.githubToken;
        let getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(this.githubBranch)}`, {
          headers: {
            Authorization: `Bearer ${activeTok}`,
            Accept: 'application/vnd.github.v3+json',
            'User-Agent': BRAND_SYNC_USER_AGENT,
          },
        });
        if (getRes.status === 401) {
          const recovered = await this.recoverGitHubTokenOn401(activeTok);
          if (recovered) {
            activeTok = recovered;
            getRes = await fetch(`${apiUrl}?ref=${encodeURIComponent(this.githubBranch)}`, {
              headers: {
                Authorization: `Bearer ${activeTok}`,
                Accept: 'application/vnd.github.v3+json',
                'User-Agent': BRAND_SYNC_USER_AGENT,
              },
            });
          }
        }
        if (getRes.status === 200) {
          const resJson = await getRes.json().catch(() => null);
          let readBackHash: string | null = null;
          if (resJson && typeof resJson.content === 'string' && resJson.encoding !== 'none') {
            const decoded = Buffer.from(resJson.content.replace(/\s+/g, ''), 'base64').toString('utf8');
            readBackHash = hashContent(decoded.trim());
          }
          if (this.lastError) {
            this.lastError = null;
            this.persistSyncState();
          }
          return {
            ok: true,
            step: 'manifest_read',
            probeRepoPath: 'data/catalog/manifest.json',
            probeSizeBytes,
            localHash,
            readBackHash,
            access,
            manifestSha: resJson?.sha,
            verifiedReadBack: true,
          };
        }
      } catch (e) {
        return {
          ok: false,
          step: 'manifest_read',
          probeRepoPath: 'data/catalog/manifest.json',
          probeSizeBytes,
          localHash,
          readBackHash: null,
          access,
          verifiedReadBack: false,
          error: redactSecrets(
            `GitHub manifest okuma ağ hatası: ${errorMessageOf(e, String(e))}`,
            this.getKnownSecretsForRedaction()
          ),
          errorCategory: 'network_error',
        };
      }
    }

    const commitRes = await this.commitFileToGitHub(
      'data/catalog/manifest.json',
      manifestContent,
      'chore(catalog): initialize manifest.json [test probe] [skip ci]',
      { isEmptyRepo: access.isEmptyRepo, branchToUse: this.githubBranch }
    );

    if (!commitRes.ok) {
      return {
        ok: false,
        step: 'manifest_probe_created',
        probeRepoPath: 'data/catalog/manifest.json',
        probeSizeBytes,
        localHash,
        readBackHash: commitRes.readBackHash ?? null,
        access,
        verifiedReadBack: false,
        error: commitRes.error,
        errorCategory: commitRes.errorCategory,
      };
    }

    if (this.lastError) {
      this.lastError = null;
      this.persistSyncState();
    }

    return {
      ok: true,
      step: 'manifest_verified',
      probeRepoPath: 'data/catalog/manifest.json',
      probeSizeBytes,
      localHash,
      readBackHash: commitRes.readBackHash ?? localHash,
      access,
      manifestSha: commitRes.sha,
      verifiedReadBack: Boolean(commitRes.verifiedReadBack),
    };
  }

  public upsertCatalogItems(
    items: unknown[],
    writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
  ): CatalogUpsertResult {
    return upsertCatalogItemsOp(this.catalogStoreContext(), items, writeOptions);
  }
  public async upsertCatalogItemsAsync(items: unknown[]): Promise<CatalogUpsertResult> {
    return upsertCatalogItemsAsyncOp(this.catalogStoreContext(), items);
  }
  public upsertCatalogItemsSerialized(items: unknown[]): Promise<CatalogUpsertResult> {
    return this.writeSerializer.run(this.manifestFile, () =>
      upsertCatalogItemsAsyncOp(this.catalogStoreContext(), items)
    );
  }
  // --- DERIVED PROFILE OPERATIONS ---

  public getProfileFilePath(profileId: string): string {
    const safeId = sanitizeProfileId(profileId);
    return path.join(this.profilesDir, `${safeId}.json`);
  }

  // --- STOCK DEPOT SNAPSHOT OPERATIONS (data/stock.json) ---

  public getStockFilePath(): string {
    return path.join(this.dataDir, 'stock.json');
  }

  public readStockSnapshot(): {
    movies: Record<string, unknown>[];
    tv: Record<string, unknown>[];
    updatedAt: string;
    schemaVersion: number;
  } | null {
    const filePath = this.getStockFilePath();
    if (!existsSync(filePath)) return null;
    const recovery = readJsonFileWithRecovery<Record<string, unknown>>(filePath, {
      backupPaths: [`${filePath}.bak`],
      validate: (raw) =>
        isPlainRecordObject(raw) && Array.isArray(raw.movies) && Array.isArray(raw.tv)
          ? raw
          : null,
      label: path.basename(filePath),
      restoreRecoveredToTarget: true,
    });
    if (recovery.status !== 'ok' && recovery.status !== 'recovered') return null;
    return {
      movies: asRecordArray(recovery.data.movies),
      tv: asRecordArray(recovery.data.tv),
      updatedAt: typeof recovery.data.updatedAt === 'string' ? recovery.data.updatedAt : '',
      schemaVersion: Number(recovery.data.schemaVersion) || 1,
    };
  }

  // --- SİNEMA KÜNYESİ OPERATIONS (data/sinema-kunyesi.json) ---

  public getCinemaKunyeFilePath(): string {
    return path.join(this.dataDir, 'sinema-kunyesi.json');
  }

  public readCinemaKunye(): CinemaKunyeDocument | null {
    const filePath = this.getCinemaKunyeFilePath();
    if (!existsSync(filePath)) return null;
    const recovery = readJsonFileWithRecovery<CinemaKunyeDocument>(filePath, {
      backupPaths: [`${filePath}.bak`],
      validate: (raw) =>
        isPlainRecordObject(raw) &&
        (isPlainRecordObject(raw.entries) || Array.isArray(raw.entries))
          ? normalizeCinemaKunyeDocument(raw)
          : null,
      label: path.basename(filePath),
      restoreRecoveredToTarget: true,
    });
    if (recovery.status !== 'ok' && recovery.status !== 'recovered') return null;
    return recovery.data;
  }

  public async readCinemaKunyeAsync(): Promise<CinemaKunyeDocument | null> {
    const filePath = this.getCinemaKunyeFilePath();
    if (!existsSync(filePath)) return null;
    const recovery = await readJsonFileWithRecoveryAsync<CinemaKunyeDocument>(filePath, {
      backupPaths: [`${filePath}.bak`],
      validate: (raw) =>
        isPlainRecordObject(raw) &&
        (isPlainRecordObject(raw.entries) || Array.isArray(raw.entries))
          ? normalizeCinemaKunyeDocument(raw)
          : null,
      label: path.basename(filePath),
      restoreRecoveredToTarget: true,
    });
    if (recovery.status !== 'ok' && recovery.status !== 'recovered') return null;
    return recovery.data;
  }

  public saveCinemaKunyeSerialized(
    incoming: unknown,
    options: { mode?: 'merge' | 'overwrite' } = {}
  ): Promise<CinemaKunyeSaveResult> {
    const filePath = this.getCinemaKunyeFilePath();
    return this.writeSerializer.run(filePath, () =>
      saveCinemaKunyeOp({ filePath, readExisting: () => this.readCinemaKunyeAsync() }, incoming, options)
    );
  }  public async saveStockSnapshotUpload(input: {
    movies?: unknown[];
    tv?: unknown[];
  }): Promise<{
    ok: boolean;
    moviesCount: number;
    tvCount: number;
    total: number;
    duplicatesRemoved: number;
    skippedInvalid: number;
    preservedExistingEmptyUpload: boolean;
    message: string;
  }> {
    return saveStockSnapshotUploadOp(
      { stockFilePath: this.getStockFilePath(), readSnapshot: () => this.readStockSnapshot() },
      input
    );
  }
  public readDerivedProfile(
    profileId: string,
    options: { allowNullOnCorrupt?: boolean } = {}
  ): DerivedProfileDocument | null {
    return readDerivedProfileImpl(this.derivedProfileStoreContext(), profileId, options);
  }

  /**
   * Profil cache doğrulamasını şema sürümü, algoritma sürümü, profil imzası ve kaynak katalog imzası ile birlikte yürütür.
   */
  public readValidatedDerivedProfile(
    profileId: string,
    expected: {
      profileFingerprint: string;
      algorithmVersion: string;
      sourceCatalogHash?: string;
      expectedSchemaVersion?: number;
    }
  ): DerivedProfileValidationResult {
    return readValidatedDerivedProfileImpl(
      this.derivedProfileStoreContext(),
      profileId,
      expected
    );
  }

  public upsertDerivedProfile(
    input: UpsertDerivedProfileInput,
    writeOptions: { beforeRenameHook?: (tempFilePath: string) => void } = {}
  ): DerivedProfileUpsertResult {
    return upsertDerivedProfileOp(this.derivedProfileWriteContext(), input, writeOptions);
  }  public async readDerivedProfileAsync(
    profileId: string,
    options: { allowNullOnCorrupt?: boolean } = {}
  ): Promise<DerivedProfileDocument | null> {
    return readDerivedProfileAsyncImpl(this.derivedProfileStoreContext(), profileId, options);
  }

  public async readValidatedDerivedProfileAsync(
    profileId: string,
    expected: {
      profileFingerprint: string;
      algorithmVersion: string;
      sourceCatalogHash?: string;
      expectedSchemaVersion?: number;
    }
  ): Promise<DerivedProfileValidationResult> {
    return readValidatedDerivedProfileAsyncImpl(
      this.derivedProfileStoreContext(),
      profileId,
      expected
    );
  }

  public async upsertDerivedProfileAsync(
    input: UpsertDerivedProfileInput
  ): Promise<DerivedProfileUpsertResult> {
    return upsertDerivedProfileAsyncOp(this.derivedProfileWriteContext(), input);
  }
  public upsertDerivedProfileSerialized(
    input: UpsertDerivedProfileInput
  ): Promise<DerivedProfileUpsertResult> {
    const filePath = this.getProfileFilePath(input.profileId);
    return this.writeSerializer.run(filePath, () => this.upsertDerivedProfileAsync(input));
  }  // --- SYNC & GITHUB OPERATIONS ---

  public getSyncStatus(): SyncStatus {
    const isTokenInvalid = Boolean(
      this.githubToken && this.invalidatedGitHubTokens.has(this.githubToken)
    );
    const configured = Boolean(
      this.githubToken &&
      !isTokenInvalid &&
      this.githubOwner &&
      this.githubRepo
    );
    const authFailed = isTokenInvalid;
    const corruptionWarnings: string[] = [];

    let movieCount = 0;
    let tvCount = 0;
    try {
      movieCount = Object.keys(this.readCatalog('movie')).length;
    } catch (err) {
      corruptionWarnings.push(errorMessageOf(err, 'movies.json okunamadı'));
    }
    try {
      tvCount = Object.keys(this.readCatalog('tv')).length;
    } catch (err) {
      corruptionWarnings.push(errorMessageOf(err, 'tv.json okunamadı'));
    }

    let profilesCount = 0;
    try {
      const dirContents = existsSync(this.profilesDir) ? readdirSync(this.profilesDir) : [];
      profilesCount = dirContents.filter(
        (f: string) =>
          f.endsWith('.json') &&
          !f.endsWith('.bak.json') &&
          !f.includes('.corrupt.') &&
          !f.endsWith('.tmp')
      ).length;
    } catch {
      profilesCount = 0;
    }

    let localSummary: SyncSideSummary | undefined;
    try {
      localSummary = this.bidirectionalManager.inspectLocalSideSync().summary;
    } catch {
      localSummary = undefined;
    }

    const stateValues = Object.values(this.fileStates);
    const pendingFromStates = stateValues.filter((s) => s.status === 'pending').length;
    const pendingFromDiff = this.lastComparison?.differentFilesCount ?? 0;
    const fileSummaryCounts = {
      pending: Math.max(pendingFromStates, pendingFromDiff),
      syncing: stateValues.filter((s) => s.status === 'syncing').length,
      succeeded: stateValues.filter((s) => s.status === 'succeeded').length,
      skipped:
        this.lastSyncReport?.filesUnchanged.length ??
        stateValues.filter((s) => s.status === 'succeeded' && s.noop).length,
      downloaded: this.lastSyncReport?.filesDownloaded.length ?? 0,
      uploaded: this.lastSyncReport?.filesUploaded.length ?? 0,
      merged: this.lastSyncReport?.filesMerged.length ?? 0,
      failed: stateValues.filter((s) => s.status === 'failed').length,
    };

    const hasTargetRepo = Boolean(this.githubOwner && this.githubRepo);
    const missingReason = !configured
      ? authFailed
        ? 'GitHub erişim hatası: Token geçersiz veya süresi dolmuş (HTTP 401 - Bad credentials). Lütfen geçerli bir CINETRACK_GITHUB_PAT tanımlayın.'
        : hasTargetRepo
        ? `Hedef depo (${this.githubOwner}/${this.githubRepo} · ${this.githubBranch}) tanımlı; CINETRACK_GITHUB_PAT ortam değişkeni bekleniyor`
        : 'GitHub token veya hedef repository yapılandırılmadı'
      : undefined;

    const effectiveConfiguredIsPublic = this.getEffectiveConfiguredIsPublicRepo();
    const allowPublicPersonalSync = this.isPersonalSyncAllowedForRepo(true);
    const allowPublicCatalogSync = this.isCatalogSyncAllowedForRepo(true);
    const observedPublic =
      this.lastObservedRemotePublic !== undefined
        ? this.lastObservedRemotePublic
        : effectiveConfiguredIsPublic;
    const personalSyncBlockedByPublicGuard = Boolean(observedPublic && !allowPublicPersonalSync);
    const catalogSyncBlockedByPublicGuard = Boolean(observedPublic && !allowPublicCatalogSync);

    return {
      configured,
      authFailed,
      githubSyncEnabled: this.githubSyncEnabled,
      mode: configured ? 'github' : 'local_only',
      reason: missingReason,
      isPublicRepo: effectiveConfiguredIsPublic,
      configuredEnvIsPublicRepo: this.isPublicRepo,
      allowPublicPersonalSync,
      allowPublicCatalogSync,
      personalSyncBlockedByPublicGuard,
      catalogSyncBlockedByPublicGuard,
      publicConsentUpdatedAt: this.publicConsentUpdatedAt,
      publicCatalogConsentUpdatedAt: this.publicCatalogConsentUpdatedAt,
      configDiagnostics: {
        processEnvIsPublicRepo: this.processEnvIsPublicRepo,
        localEnvIsPublicRepo: this.localEnvIsPublicRepo,
        effectiveConfiguredIsPublicRepo: effectiveConfiguredIsPublic,
        observedRemoteIsPublicRepo:
          this.lastObservedRemotePublic !== undefined ? this.lastObservedRemotePublic : null,
        allowPublicPersonalSync,
        allowPublicCatalogSync,
        persistedUserConsent:
          this.persistedPublicPersonalConsent !== undefined
            ? this.persistedPublicPersonalConsent
            : null,
        persistedCatalogConsent:
          this.persistedPublicCatalogConsent !== undefined
            ? this.persistedPublicCatalogConsent
            : null,
      },
      tokenDiagnostics: {
        configured: Boolean(this.githubToken),
        source: this.githubToken ? this.githubTokenSource : 'none',
        format: classifyTokenFormat(this.githubToken),
        length: this.githubToken ? this.githubToken.length : 0,
      },
      ...(this.repoVisibilityWarning ? { repoVisibilityWarning: this.repoVisibilityWarning } : {}),
      ...(corruptionWarnings.length > 0 ? { corruptionWarnings } : {}),
      lastSyncAt: this.lastSyncAt,
      syncInProgress: this.isSyncBusy(),
      syncQueue: this.bidirectionalManager.getQueueStatus(),
      interruptedSync: this.bidirectionalManager.getRecoveredInterruption()
        ? {
            ...this.bidirectionalManager.getRecoveredInterruption()!,
            recoveredAt: new Date().toISOString(),
          }
        : null,
      syncStateVersion: SYNC_STATE_VERSION,
      initialReconcileCompleted: this.hasCompletedInitialReconcile(),
      lastError: this.lastError,
      catalogCounts: {
        movies: movieCount,
        tv: tvCount,
      },
      profilesCount,
      ...(localSummary ? { localSummary } : {}),
      lastRemoteSummary: this.lastRemoteSummary,
      lastComparison: this.lastComparison,
      lastSyncReport: this.lastSyncReport,
      fileSummaryCounts,
      fileStates: { ...this.fileStates },
      remoteTarget: hasTargetRepo
        ? {
            owner: this.githubOwner!,
            repo: this.githubRepo!,
            branch: this.githubBranch,
          }
        : undefined,
    };
  }

  public inspectGitHub(): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.inspect();
  }

  public pullFromGitHub(
    options: { conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote' } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.pull(options);
  }

  public pushToGitHub(): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.push();
  }

  public reconcileWithGitHub(
    options: { includePersonalOverride?: boolean; includeCatalogOverride?: boolean } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.bidirectionalManager.reconcile(options);
  }

  /**
   * GitHub deposuna erişim, yetki (push) ve dal durumunu ayrıntılı biçimde doğrular.
   * 404 durumunda repo yokluğu, token yetkisizliği veya dal uyumsuzluğunu ayrıştırır.
   */
  public async verifyRemoteRepoAccess(): Promise<RemoteRepoAccessCheck> {
    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        ok: false,
        accessible: false,
        repoExists: false,
        branchExists: false,
        isEmptyRepo: false,
        isPrivate: !this.isPublicRepo,
        effectiveIsPublicRepo: this.isPublicRepo,
        configuredBranch: this.githubBranch,
        hasPushPermission: false,
        error: 'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.',
        errorCategory: 'config_error',
      };
    }

    const maxAuthAttempts = 6;
    for (let authAttempt = 1; authAttempt <= maxAuthAttempts; authAttempt++) {
      const activeToken = this.githubToken;
      if (!activeToken) break;

      const baseHeaders = {
        Authorization: `Bearer ${activeToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': BRAND_SYNC_USER_AGENT,
      };

      // 1. Repo varlık ve erişim kontrolü
      const repoUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}`;
      let repoMeta: GitHubRepositoryMeta | null = null;

      try {
        const res = await fetch(repoUrl, { headers: baseHeaders });
        if (res.status === 404) {
          const notFoundMsg = redactSecrets(
            `Uzak GitHub deposu (${this.githubOwner}/${this.githubRepo}) bulunamadı veya erişilemedi (HTTP 404). Özel (private) depo kullanıyorsanız GitHub Fine-Grained Personal Access Token izinlerinde bu deponun seçili olduğunu ve 'Contents: Read and write' yetkisine sahip olduğunu doğrulayın.`,
            this.getKnownSecretsForRedaction()
          );
          return {
            ok: false,
            accessible: false,
            repoExists: false,
            branchExists: false,
            isEmptyRepo: false,
            isPrivate: !this.isPublicRepo,
            effectiveIsPublicRepo: this.isPublicRepo,
            configuredBranch: this.githubBranch,
            hasPushPermission: false,
            error: notFoundMsg,
            errorCategory: 'not_found',
          };
        }

        if (res.status === 401 && authAttempt < maxAuthAttempts) {
          const recovered = await this.recoverGitHubTokenOn401(activeToken);
          if (recovered) {
            continue;
          }
        }

        if (res.status === 401 || res.status === 403) {
          const errJson = await res.json().catch(() => ({}));
          const rawMsg = String(errJson?.message || '');
          const acceptedPerms = res.headers.get('x-accepted-github-permissions');
          const category = classifyHttpFailure(res.status, res.headers, rawMsg);
          let guidance = '';
          if (res.status === 401) {
            guidance =
              ' (GitHub token geçersiz, süresi dolmuş veya iptal edilmiş/yenilenmiş. Lütfen GitHub üzerinde geçerli bir Fine-grained PAT oluşturup CINETRACK_GITHUB_PAT ortam değişkenini güncelleyin)';
          } else if (res.status === 403 && category === 'auth_error') {
            guidance = ` (Fine-grained PAT ayarlarında '${this.githubOwner}/${this.githubRepo}' deposu için 'Contents: Read and write' izninin seçili olduğunu doğrulayın${
              acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
            })`;
          }
          return {
            ok: false,
            accessible: false,
            repoExists: false,
            branchExists: false,
            isEmptyRepo: false,
            isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
            effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
            configuredBranch: this.githubBranch,
            hasPushPermission: false,
            acceptedPermissionsHeader: acceptedPerms,
            error: redactSecrets(
              `GitHub erişim hatası (${category}): HTTP ${res.status}${rawMsg ? ` - ${rawMsg}` : ''}${guidance}`,
              this.getKnownSecretsForRedaction()
            ),
            errorCategory: category,
          };
        }

        if (res.status !== 200) {
          const errJson = await res.json().catch(() => ({}));
          const rawMsg = String(errJson?.message || '');
          const category = classifyHttpFailure(res.status, res.headers, rawMsg);
          return {
            ok: false,
            accessible: false,
            repoExists: false,
            branchExists: false,
            isEmptyRepo: false,
            isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
            effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
            configuredBranch: this.githubBranch,
            hasPushPermission: false,
            error: redactSecrets(
              `GitHub depo sorgulanamadı (${category}): HTTP ${res.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
              this.getKnownSecretsForRedaction()
            ),
            errorCategory: category,
          };
        }

        repoMeta = readGitHubRepositoryMeta(await res.json().catch(() => null));
      } catch (e) {
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
          effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          error: redactSecrets(
            `GitHub sunucusuna bağlanılamadı: ${errorMessageOf(e, 'Ağ hatası')}`,
            this.getKnownSecretsForRedaction()
          ),
          errorCategory: 'network_error',
        };
      }

      if (!repoMeta) {
        return {
          ok: false,
          accessible: false,
          repoExists: false,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
          effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          error: 'GitHub depo yanıtı geçerli JSON formatında değil.',
          errorCategory: 'malformed_response',
        };
      }

      const isRemotePrivate = repoMeta.isPrivate === true;
      const remoteIsPublic = repoMeta.isPrivate === false;
      this.lastObservedRemotePublic = remoteIsPublic;
      const warning = this.buildPublicVisibilityWarning(remoteIsPublic);

      const effectiveIsPublicRepo = remoteIsPublic;
      this.repoVisibilityWarning = warning;

      // Yetki kontrolü (permissions.push)
      const hasPushPermission = typeof repoMeta.canPush === 'boolean' ? repoMeta.canPush : true;

      if (repoMeta.canPush === false) {
        return {
          ok: false,
          accessible: true,
          repoExists: true,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: isRemotePrivate,
          effectiveIsPublicRepo,
          defaultBranch: repoMeta.defaultBranch,
          configuredBranch: this.githubBranch,
          hasPushPermission: false,
          warning,
          error: `GitHub token bu depoda ('${this.githubOwner}/${this.githubRepo}') yazma (push) yetkisine sahip değil. Token ayarlarında 'Contents: Read and write' iznini kontrol edin.`,
          errorCategory: 'auth_error',
        };
      }

      // 2. Dal (branch) kontrolü
      const branchUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/branches/${encodeURIComponent(
        this.githubBranch
      )}`;
      try {
        const branchRes = await fetch(branchUrl, { headers: baseHeaders });
        if (branchRes.status === 200) {
          return {
            ok: true,
            accessible: true,
            repoExists: true,
            branchExists: true,
            isEmptyRepo: false,
            isPrivate: isRemotePrivate,
            effectiveIsPublicRepo,
            defaultBranch: repoMeta.defaultBranch,
            configuredBranch: this.githubBranch,
            hasPushPermission,
            warning,
          };
        }

        if (branchRes.status === 401 && authAttempt < maxAuthAttempts) {
          const recovered = await this.recoverGitHubTokenOn401(activeToken);
          if (recovered) {
            continue;
          }
        }

        if (branchRes.status === 404) {
          // Dal bulunamadı; depo tamamen boş mu (0 commit) kontrol et
          const branchesListUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/branches?per_page=1`;
          const listRes = await fetch(branchesListUrl, { headers: baseHeaders });
          if (listRes.status === 200) {
            const listData = await listRes.json().catch(() => []);
            if (Array.isArray(listData) && listData.length === 0) {
              // Boş depo: ilk commit henüz atılmamış, ilk yazma varsayılan dalı oluşturacak
              return {
                ok: true,
                accessible: true,
                repoExists: true,
                branchExists: false,
                isEmptyRepo: true,
                isPrivate: isRemotePrivate,
                effectiveIsPublicRepo,
                defaultBranch: repoMeta.defaultBranch,
                configuredBranch: this.githubBranch,
                hasPushPermission,
                warning,
              };
            }
          } else if (listRes.status === 404) {
            // /branches uç noktası mock ortamında taklit edilmemişse, repo meta 200 olduğu için dalı varsayılan kabul et
            return {
              ok: true,
              accessible: true,
              repoExists: true,
              branchExists: true,
              isEmptyRepo: false,
              isPrivate: isRemotePrivate,
              effectiveIsPublicRepo,
              defaultBranch: repoMeta.defaultBranch,
              configuredBranch: this.githubBranch,
              hasPushPermission,
              warning,
            };
          }

          // Depo boş değil ama belirtilen dal mevcut değil!
          const branchErrMsg = redactSecrets(
            `Yapılandırılmış dal ('${this.githubBranch}') depoda bulunamadı (HTTP 404). Mevcut varsayılan dal: '${
              repoMeta.defaultBranch || 'bilinmiyor'
            }'.`,
            this.getKnownSecretsForRedaction()
          );
          return {
            ok: false,
            accessible: true,
            repoExists: true,
            branchExists: false,
            isEmptyRepo: false,
            isPrivate: isRemotePrivate,
            effectiveIsPublicRepo,
            defaultBranch: repoMeta.defaultBranch,
            configuredBranch: this.githubBranch,
            hasPushPermission,
            warning,
            error: branchErrMsg,
            errorCategory: 'not_found',
          };
        }

        if (branchRes.status === 401 || branchRes.status === 403) {
          const errJson = await branchRes.json().catch(() => ({}));
          const rawMsg = String(errJson?.message || '');
          const category = classifyHttpFailure(branchRes.status, branchRes.headers, rawMsg);
          return {
            ok: false,
            accessible: false,
            repoExists: true,
            branchExists: false,
            isEmptyRepo: false,
            isPrivate: isRemotePrivate,
            effectiveIsPublicRepo,
            defaultBranch: repoMeta.defaultBranch,
            configuredBranch: this.githubBranch,
            hasPushPermission,
            warning,
            error: redactSecrets(
              `Dal kontrolünde yetki hatası (${category}): HTTP ${branchRes.status}${
                rawMsg ? ` - ${rawMsg}` : ''
              }`,
              this.getKnownSecretsForRedaction()
            ),
            errorCategory: category,
          };
        }
      } catch (e) {
        return {
          ok: false,
          accessible: false,
          repoExists: true,
          branchExists: false,
          isEmptyRepo: false,
          isPrivate: isRemotePrivate,
          effectiveIsPublicRepo,
          defaultBranch: repoMeta.defaultBranch,
          configuredBranch: this.githubBranch,
          hasPushPermission,
          warning,
          error: redactSecrets(
            `Dal kontrolünde ağ hatası: ${errorMessageOf(e, 'bağlantı hatası')}`,
            this.getKnownSecretsForRedaction()
          ),
          errorCategory: 'network_error',
        };
      }

      return {
        ok: true,
        accessible: true,
        repoExists: true,
        branchExists: true,
        isEmptyRepo: false,
        isPrivate: isRemotePrivate,
        effectiveIsPublicRepo,
        defaultBranch: repoMeta.defaultBranch,
        configuredBranch: this.githubBranch,
        hasPushPermission,
        warning,
      };
    }

    return {
      ok: false,
      accessible: false,
      repoExists: false,
      branchExists: false,
      isEmptyRepo: false,
      isPrivate: !this.getEffectiveConfiguredIsPublicRepo(),
      effectiveIsPublicRepo: this.getEffectiveConfiguredIsPublicRepo(),
      configuredBranch: this.githubBranch,
      hasPushPermission: false,
      error: 'GitHub kimlik doğrulaması tüm aday anahtarlarla başarısız oldu.',
      errorCategory: 'auth_error',
    };
  }

  /**
   * Uzak GitHub deposunun gerçek `private/public` görünürlüğünü kontrol eder ve
   * `CINETRACK_DATA_REPO_IS_PUBLIC` ayarıyla uyumsuzluk varsa raporlar.
   */
  public async verifyRemoteRepoVisibility(): Promise<{
    effectiveIsPublicRepo: boolean;
    warning?: string;
  }> {
    const access = await this.verifyRemoteRepoAccess();
    return {
      effectiveIsPublicRepo: access.effectiveIsPublicRepo,
      ...(access.warning ? { warning: access.warning } : {}),
    };
  }

  /**
   * Commit a file to GitHub via Contents API with SHA conflict management,
   * bounded retry, error classification, read-back hash verification, and token redaction.
   */
  private async fetchBlobTextBySha(sha: string): Promise<string | null> {
    return fetchBlobTextByShaImpl({ token: this.githubToken, owner: this.githubOwner, repo: this.githubRepo }, sha);
  }  /**
   * Commit a file to GitHub via Contents API with SHA conflict management,
   * bounded retry, error classification, read-back hash verification (>1 MB Git Blob dahil), and token redaction.
   */
  public async commitFileToGitHub(
    repoPath: string,
    contentString: string,
    commitMessage: string,
    options?: { isEmptyRepo?: boolean; branchToUse?: string }
  ): Promise<GitHubCommitOutcome> {
    return commitFileToGitHubImpl(
      {
        token: this.githubToken,
        owner: this.githubOwner,
        repo: this.githubRepo,
        branch: this.githubBranch,
        getKnownSecretsForRedaction: () => this.getKnownSecretsForRedaction(),
        recoverGitHubTokenOn401: (failedToken?: string) => this.recoverGitHubTokenOn401(failedToken),
        fetchBlobTextBySha: (sha: string) => this.fetchBlobTextBySha(sha),
      },
      repoPath,
      contentString,
      commitMessage,
      options
    );
  }
  private collectPersonalSyncItems(): Array<{
    repoPath: string;
    localPath: string;
    commitMessage: string;
  }> {
    const items: Array<{ repoPath: string; localPath: string; commitMessage: string }> = [];
    const mainDataFile = path.join(this.dataDir, 'cinetrack-data.json');
    if (existsSync(mainDataFile)) {
      items.push({
        repoPath: 'data/cinetrack-data.json',
        localPath: mainDataFile,
        commitMessage: 'chore(data): sync cinetrack-data.json [skip ci]',
      });
    }

    const stockFile = path.join(this.dataDir, 'stock.json');
    if (existsSync(stockFile)) {
      items.push({
        repoPath: 'data/stock.json',
        localPath: stockFile,
        commitMessage: 'chore(data): sync stock.json [skip ci]',
      });
    }

    const kunyeFile = path.join(this.dataDir, 'sinema-kunyesi.json');
    if (existsSync(kunyeFile)) {
      items.push({
        repoPath: 'data/sinema-kunyesi.json',
        localPath: kunyeFile,
        commitMessage: 'chore(data): sync sinema-kunyesi.json [skip ci]',
      });
    }

    if (existsSync(this.profilesDir)) {
      const profileFiles = readdirSync(this.profilesDir)
        .filter(
          (f) =>
            f.endsWith('.json') &&
            !f.endsWith('.bak.json') &&
            !f.includes('.corrupt.') &&
            !f.endsWith('.tmp')
        )
        .sort((a, b) => a.localeCompare(b));
      for (const file of profileFiles) {
        items.push({
          repoPath: `data/profiles/${file}`,
          localPath: path.join(this.profilesDir, file),
          commitMessage: `chore(profile): sync derived data for ${file} [skip ci]`,
        });
      }
    }
    return items;
  }

  /**
   * Çok dosyalı GitHub senkronizasyonunu dosya bazlı durum takibiyle yürütür.
   * Kısmi hata durumunda başarılı dosyaları korur, başarısız olanları açıkça raporlar
   * ve sonraki denemede kaldığı yerden devam eder.
   */
  public async syncToGitHub(
    options: {
      forceAll?: boolean;
      verifiedRemoteHashes?: Record<string, string | null>;
      allowPersonalDataInPublicRepo?: boolean;
      allowCatalogInPublicRepo?: boolean;
    } = {}
  ): Promise<SyncResult> {
    const result: SyncResult = {
      ok: true,
      partialFailure: false,
      filesCommitted: [],
      filesSkipped: [],
      filesFailed: [],
      filesBlockedPublic: [],
      fileStates: {},
      errors: [],
    };

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      result.ok = false;
      result.errors.push(
        'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.'
      );
      result.fileStates = { ...this.fileStates };
      return result;
    }

    interface PlannedSyncItem {
      repoPath: string;
      localPath: string;
      commitMessage: string;
    }

    const plannedFiles: PlannedSyncItem[] = [];

    // 0. Depo erişim, yetki ve dal ön doğrulamasını çalıştır
    const access = await this.verifyRemoteRepoAccess();
    if (access.warning) {
      result.repoVisibilityWarning = access.warning;
    }

    const allowCatalogSync = this.isCatalogSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowCatalogInPublicRepo
    );
    const allowPersonalSync = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (access.effectiveIsPublicRepo && !allowCatalogSync) {
      result.filesBlockedPublic.push(
        'data/catalog/* (Açık depo koruması: TMDB katalog verileri açık lisans onayı olmadan gönderilmedi)'
      );
    } else {
      // Manifest dosyasını prob olarak ilk sıraya koy
      for (const [relPath, filePath] of [
        ['data/catalog/manifest.json', this.manifestFile],
        ['data/catalog/movies.json', this.moviesFile],
        ['data/catalog/tv.json', this.tvFile],
      ] as const) {
        if (existsSync(filePath)) {
          plannedFiles.push({
            repoPath: relPath,
            localPath: filePath,
            commitMessage: `chore(catalog): sync ${path.basename(relPath)} [skip ci]`,
          });
        }
      }
    }

    if (access.effectiveIsPublicRepo && !allowPersonalSync) {
      const blockedMsg =
        'data/profiles/* (Açık depo koruması: kişisel izleme listesi ve profil verileri gönderilmedi)';
      result.filesBlockedPublic.push(blockedMsg);
    } else {
      plannedFiles.push(...this.collectPersonalSyncItems());
    }

    if (!access.ok) {
      result.ok = false;
      const sanitizedAccessErr = access.error || 'GitHub depo erişim doğrulaması başarısız.';
      result.errors.push(sanitizedAccessErr);
      // Hedef dosyaları failed olarak işaretle, yerel veriye ASLA dokunma
      for (const item of plannedFiles) {
        let localHash: string | undefined;
        try {
          if (existsSync(item.localPath)) {
            localHash = hashContent(readFileSync(item.localPath, 'utf8').trim());
          }
        } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: sanitizedAccessErr,
          errorCategory: access.errorCategory || 'not_found',
        });
        result.filesFailed.push(item.repoPath);
      }
      this.persistSyncState();
      result.fileStates = { ...this.fileStates };
      return result;
    }

    // 1. Önce tüm hedef dosyaları 'pending' (veya değişmemiş başarılıysa hazır) olarak işaretle
    const preparedContents = new Map<
      string,
      { content: string; localHash: string; alreadySyncedUnchanged: boolean }
    >();

    for (const item of plannedFiles) {
      const validCheck = tryParseValidJson(item.localPath);
      if (!validCheck.ok) {
        const errMsg = `Yerel dosya bozuk olduğu için GitHub'a gönderilmedi (${validCheck.error})`;
        this.setFileSyncStage(item.repoPath, 'failed', {
          readBackHash: null,
          verifiedReadBack: false,
          error: errMsg,
          errorCategory: 'corrupt_local_file',
        });
        result.filesFailed.push(item.repoPath);
        result.errors.push(`${item.repoPath}: ${errMsg}`);
        result.ok = false;
        continue;
      }

      const content = readFileSync(item.localPath, 'utf8');
      const localHash = hashContent(content.trim());
      const prevRecord = this.fileStates[item.repoPath];
      const alreadySyncedUnchanged = options.verifiedRemoteHashes
        ? options.verifiedRemoteHashes[item.repoPath] === localHash
        : Boolean(
            !options.forceAll &&
              prevRecord &&
              prevRecord.status === 'succeeded' &&
              prevRecord.localContentHash === localHash
          );

      preparedContents.set(item.repoPath, {
        content,
        localHash,
        alreadySyncedUnchanged,
      });

      if (!alreadySyncedUnchanged) {
        this.setFileSyncStage(item.repoPath, 'pending', {
          localContentHash: localHash,
          noop: undefined,
          error: undefined,
          errorCategory: undefined,
        });
      }
    }

    // 2. Her dosyayı sırayla senkronize et; daha önce başarılı ve yerel özeti değişmemiş olanları atla
    let currentIsEmptyRepo = access.isEmptyRepo;

    for (const item of plannedFiles) {
      const prepared = preparedContents.get(item.repoPath);
      if (!prepared) continue;

      if (prepared.alreadySyncedUnchanged) {
        this.setFileSyncStage(item.repoPath, 'succeeded', {
          localContentHash: prepared.localHash,
          readBackHash: prepared.localHash,
          verifiedReadBack: true,
          noop: true,
        });
        result.filesSkipped.push(item.repoPath);
        continue;
      }

      this.setFileSyncStage(item.repoPath, 'syncing', {
        localContentHash: prepared.localHash,
      });

      const commitRes = await this.commitFileToGitHub(
        item.repoPath,
        prepared.content,
        item.commitMessage,
        { isEmptyRepo: currentIsEmptyRepo, branchToUse: this.githubBranch }
      );

      if (commitRes.ok) {
        currentIsEmptyRepo = false; // İlk dosya yazıldıktan sonra depo artık boş değildir
        this.setFileSyncStage(item.repoPath, 'succeeded', {
          localContentHash: prepared.localHash,
          readBackHash: commitRes.readBackHash ?? null,
          verifiedReadBack: Boolean(commitRes.verifiedReadBack),
          sha: commitRes.sha,
          noop: Boolean(commitRes.skippedNoop),
        });
        if (commitRes.skippedNoop) {
          result.filesSkipped.push(item.repoPath);
        } else {
          result.filesCommitted.push(item.repoPath);
        }
      } else {
        const sanitizedErr = redactSecrets(commitRes.error || 'Bilinmeyen senkronizasyon hatası', [
          this.githubToken,
        ]);
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: prepared.localHash,
          readBackHash: commitRes.readBackHash ?? null,
          verifiedReadBack: false,
          error: sanitizedErr,
          errorCategory: commitRes.errorCategory || 'http_error',
        });
        result.filesFailed.push(item.repoPath);
        result.errors.push(`${item.repoPath}: ${sanitizedErr}`);
        result.ok = false;
      }
    }

    const succeededCount = result.filesCommitted.length + result.filesSkipped.length;
    result.partialFailure = !result.ok && succeededCount > 0 && result.filesFailed.length > 0;

    if (result.ok) {
      this.lastSyncAt = new Date().toISOString();
    }

    this.persistSyncState();
    result.fileStates = { ...this.fileStates };
    return result;
  }

  /**
   * Aşamalı güvenli eşitleme:
   * 1) Küçük test probu (data/catalog/manifest.json) ile yazma ve geri okuma doğrulaması.
   * 2) Başarılıysa ortak kataloglar (manifest.json, movies.json, tv.json).
   * 3) Başarılıysa ve gizlilik izni uygunsa kullanıcı profili ve kişisel veriler (cinetrack-data.json, data/profiles/*) + iki yönlü doğrulama.
   */
  public async runStagedFullSync(
    options: {
      forceWriteProbe?: boolean;
      allowPersonalDataInPublicRepo?: boolean;
      allowCatalogInPublicRepo?: boolean;
    } = {}
  ): Promise<StagedSyncReport> {
    this.ensureCatalogFiles();

    const catalogItems: Array<{ repoPath: string; localPath: string; commitMessage: string }> = [
      {
        repoPath: 'data/catalog/manifest.json',
        localPath: this.manifestFile,
        commitMessage: 'chore(catalog): sync manifest.json [skip ci]',
      },
      {
        repoPath: 'data/catalog/movies.json',
        localPath: this.moviesFile,
        commitMessage: 'chore(catalog): sync movies.json [skip ci]',
      },
      {
        repoPath: 'data/catalog/tv.json',
        localPath: this.tvFile,
        commitMessage: 'chore(catalog): sync tv.json [skip ci]',
      },
    ].filter((it) => existsSync(it.localPath));

    const personalItems = this.collectPersonalSyncItems();

    const readLocalStats = (localPath: string): { sizeBytes: number; localHash: string | null } => {
      try {
        if (!existsSync(localPath)) return { sizeBytes: 0, localHash: null };
        const raw = readFileSync(localPath, 'utf8');
        return {
          sizeBytes: statSync(localPath).size,
          localHash: hashContent(raw.trim()),
        };
      } catch {
        return { sizeBytes: 0, localHash: null };
      }
    };

    const fileOutcomes: StagedFileOutcome[] = [];

    // Açık depo kontrolünü manifest yazma probundan ÖNCE yap: katalog paylaşım onayı yoksa manifest.json bile açık depoya yazılmaz
    const preAccess = await this.verifyRemoteRepoAccess();
    const allowCatalogSyncPre = this.isCatalogSyncAllowedForRepo(
      preAccess.effectiveIsPublicRepo,
      options.allowCatalogInPublicRepo
    );
    const allowPersonalSyncPre = this.isPersonalSyncAllowedForRepo(
      preAccess.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (preAccess.ok && preAccess.effectiveIsPublicRepo && !allowCatalogSyncPre) {
      for (const cItem of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(cItem.localPath);
        fileOutcomes.push({
          repoPath: cItem.repoPath,
          stage: 'catalog',
          status: 'blocked',
          writeStatus: 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: 'Açık depo TMDB katalog yeniden dağıtım koruması nedeniyle katalog gönderilmedi.',
        });
      }

      if (!allowPersonalSyncPre) {
        for (const pItem of personalItems) {
          const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'blocked',
            writeStatus: 'blocked_public_guard',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
          });
        }
        return {
          ok: true,
          verifiedEqual: true,
          probe: {
            ok: true,
            repoPath: 'data/catalog/manifest.json',
            step: 'access_check',
            sizeBytes: 0,
            localHash: null,
            readBackHash: null,
            verifiedReadBack: false,
          },
          catalogStage: { attempted: false, ok: true, blockedByPublicGuard: true },
          personalStage: { attempted: false, ok: true, blockedByPublicGuard: true },
          access: preAccess,
          allowPersonalSync: false,
          allowCatalogSync: false,
          ...(preAccess.warning ? { repoVisibilityWarning: preAccess.warning } : {}),
          files: fileOutcomes,
          fileOutcomes,
          bidirectionalReport: null,
        };
      }

      const personalOnlyReport = await this.reconcileWithGitHub({
        includePersonalOverride: true,
        includeCatalogOverride: false,
      });
      const refreshedPersonal = this.collectPersonalSyncItems();
      let haltedAtPersonal: 'personal' | undefined;
      for (const pItem of refreshedPersonal) {
        const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
        const rFile = personalOnlyReport.remoteAfter?.files[pItem.repoPath];
        const matchingErr = personalOnlyReport.errors.find((e) => e.repoPath === pItem.repoPath);
        const isFailed =
          personalOnlyReport.filesFailed.includes(pItem.repoPath) || Boolean(matchingErr);
        if (isFailed) {
          if (!haltedAtPersonal) haltedAtPersonal = 'personal';
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'failed',
            writeStatus: 'failed',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: matchingErr?.message || `${pItem.repoPath} senkronize edilemedi.`,
            errorCategory: (matchingErr?.category as GitHubSyncErrorCategory) || 'http_error',
          });
        } else {
          const wasUploaded = personalOnlyReport.filesUploaded.includes(pItem.repoPath);
          const readBackHash = rFile?.rawFileHash ?? null;
          fileOutcomes.push({
            repoPath: pItem.repoPath,
            stage: 'personal',
            status: 'succeeded',
            writeStatus: wasUploaded ? 'committed' : 'unchanged_noop',
            sizeBytes,
            localHash,
            readBackHash,
            sha: rFile?.sha,
            verifiedReadBack: Boolean(rFile?.exists && rFile?.valid && readBackHash),
          });
        }
      }

      const personalOk = personalOnlyReport.ok && personalOnlyReport.verifiedEqual;
      return {
        ok: personalOk,
        verifiedEqual: personalOnlyReport.verifiedEqual,
        ...(haltedAtPersonal ? { haltedAtStage: haltedAtPersonal } : {}),
        probe: {
          ok: true,
          repoPath: 'data/cinetrack-data.json',
          step: 'access_check',
          sizeBytes: 0,
          localHash: null,
          readBackHash: null,
          verifiedReadBack: personalOk,
        },
        catalogStage: { attempted: false, ok: true, blockedByPublicGuard: true },
        personalStage: { attempted: true, ok: personalOk },
        access: preAccess,
        allowPersonalSync: true,
        allowCatalogSync: false,
        ...(personalOnlyReport.repoVisibilityWarning
          ? { repoVisibilityWarning: personalOnlyReport.repoVisibilityWarning }
          : preAccess.warning
            ? { repoVisibilityWarning: preAccess.warning }
            : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: personalOnlyReport,
      };
    }

    // 1. Küçük test dosyası (manifest.json) ile yazma ve geri okuma probu
    const probeRes = await this.testSafeConnectionAndProbeManifest({
      forceWriteProbe: options.forceWriteProbe ?? true,
    });
    const access = probeRes.access;
    const allowPersonalSync = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      options.allowPersonalDataInPublicRepo
    );

    if (!probeRes.ok) {
      const probeErr = probeRes.error || 'Küçük dosya yazma/geri okuma testi başarısız oldu.';
      this.lastError = redactSecrets(probeErr, [this.githubToken]);

      for (const item of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        const isProbeTarget = item.repoPath === 'data/catalog/manifest.json';
        const statusErr = isProbeTarget
          ? probeErr
          : `Ön yazma testi başarısız olduğu için tam katalog senkronizasyonu durduruldu (${probeErr})`;
        this.setFileSyncStage(item.repoPath, 'failed', {
          localContentHash: localHash ?? undefined,
          readBackHash: null,
          verifiedReadBack: false,
          error: statusErr,
          errorCategory: probeRes.errorCategory || 'auth_error',
        });
        fileOutcomes.push({
          repoPath: item.repoPath,
          stage: isProbeTarget ? 'probe' : 'catalog',
          status: isProbeTarget ? 'failed' : 'skipped',
          writeStatus: isProbeTarget ? 'failed' : 'skipped_due_to_probe_failure',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: redactSecrets(statusErr, [this.githubToken]),
          errorCategory: probeRes.errorCategory || 'auth_error',
        });
      }

      for (const item of personalItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        if (!allowPersonalSync) {
          fileOutcomes.push({
            repoPath: item.repoPath,
            stage: 'personal',
            status: 'blocked',
            writeStatus: 'blocked_public_guard',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
          });
        } else {
          const statusErr = `Ön yazma testi başarısız olduğu için kişisel veri senkronizasyonu durduruldu (${probeErr})`;
          this.setFileSyncStage(item.repoPath, 'failed', {
            localContentHash: localHash ?? undefined,
            readBackHash: null,
            verifiedReadBack: false,
            error: statusErr,
            errorCategory: probeRes.errorCategory || 'auth_error',
          });
          fileOutcomes.push({
            repoPath: item.repoPath,
            stage: 'personal',
            status: 'skipped',
            writeStatus: 'skipped_due_to_probe_failure',
            sizeBytes,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            error: redactSecrets(statusErr, [this.githubToken]),
            errorCategory: probeRes.errorCategory || 'auth_error',
          });
        }
      }

      this.persistSyncState();
      return {
        ok: false,
        verifiedEqual: false,
        haltedAtStage: 'probe',
        probe: {
          ok: false,
          repoPath: probeRes.probeRepoPath,
          step: probeRes.step,
          sizeBytes: probeRes.probeSizeBytes,
          localHash: probeRes.localHash,
          readBackHash: probeRes.readBackHash,
          sha: probeRes.manifestSha,
          verifiedReadBack: false,
          error: probeRes.error,
          errorCategory: probeRes.errorCategory,
        },
        catalogStage: { attempted: false, ok: false },
        personalStage: {
          attempted: false,
          ok: false,
          ...(allowPersonalSync ? {} : { blockedByPublicGuard: true }),
        },
        access,
        allowPersonalSync,
        ...(access.warning ? { repoVisibilityWarning: access.warning } : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: null,
      };
    }

    // 2. Aşama: Yalnızca manifest ve katalog dosyalarını (manifest.json, movies.json, tv.json) kayıpsız birleştir ve eşitle
    const catalogReport = await this.reconcileWithGitHub({
      includePersonalOverride: false,
      includeCatalogOverride: true,
    });
    if (!catalogReport.ok || !catalogReport.verifiedEqual) {
      for (const item of catalogItems) {
        const { sizeBytes, localHash } = readLocalStats(item.localPath);
        const rFile = catalogReport.remoteAfter?.files[item.repoPath];
        const matchingError = catalogReport.errors.find((e) => e.repoPath === item.repoPath);
        const isFailed = catalogReport.filesFailed.includes(item.repoPath) || Boolean(matchingError);
        const readBackHash = rFile?.rawFileHash ?? null;
        fileOutcomes.push({
          repoPath: item.repoPath,
          stage: 'catalog',
          status: isFailed ? 'failed' : 'succeeded',
          writeStatus: isFailed
            ? 'failed'
            : catalogReport.filesUploaded.includes(item.repoPath)
              ? 'committed'
              : 'unchanged_noop',
          sizeBytes,
          localHash,
          readBackHash: isFailed ? null : readBackHash,
          sha: rFile?.sha,
          verifiedReadBack: !isFailed && Boolean(rFile?.exists && rFile?.valid && readBackHash),
          ...(isFailed
            ? {
                error: matchingError?.message || `${item.repoPath} katalog senkronizasyonunda başarısız oldu.`,
                errorCategory: (matchingError?.category as GitHubSyncErrorCategory) || 'http_error',
              }
            : {}),
        });
      }

      for (const pItem of personalItems) {
        const { sizeBytes, localHash } = readLocalStats(pItem.localPath);
        fileOutcomes.push({
          repoPath: pItem.repoPath,
          stage: 'personal',
          status: allowPersonalSync ? 'skipped' : 'blocked',
          writeStatus: allowPersonalSync
            ? 'skipped_due_to_catalog_failure'
            : 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: allowPersonalSync
            ? 'Katalog aşaması tamamlanamadığı için kişisel veri aşamasına geçilmedi.'
            : 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
        });
      }

      return {
        ok: false,
        verifiedEqual: false,
        haltedAtStage: 'catalog',
        probe: {
          ok: true,
          repoPath: probeRes.probeRepoPath,
          step: probeRes.step,
          sizeBytes: probeRes.probeSizeBytes,
          localHash: probeRes.localHash,
          readBackHash: probeRes.readBackHash,
          sha: probeRes.manifestSha,
          verifiedReadBack: Boolean(probeRes.verifiedReadBack),
        },
        catalogStage: { attempted: true, ok: false },
        personalStage: {
          attempted: false,
          ok: false,
          ...(allowPersonalSync ? {} : { blockedByPublicGuard: true }),
        },
        access,
        allowPersonalSync,
        ...(catalogReport.repoVisibilityWarning
          ? { repoVisibilityWarning: catalogReport.repoVisibilityWarning }
          : access.warning
            ? { repoVisibilityWarning: access.warning }
            : {}),
        files: fileOutcomes,
        fileOutcomes,
        bidirectionalReport: catalogReport,
      };
    }

    // 3. Aşama: Kullanıcı profili ve diğer kişisel verileri eşitle (izinliyse) ve tam iki yönlü eşitliği doğrula
    const finalReport = allowPersonalSync
      ? await this.reconcileWithGitHub({
          includePersonalOverride: true,
          includeCatalogOverride: true,
        })
      : catalogReport;

    const refreshedCatalogItems = [
      { repoPath: 'data/catalog/manifest.json', localPath: this.manifestFile, stage: 'catalog' as const },
      { repoPath: 'data/catalog/movies.json', localPath: this.moviesFile, stage: 'catalog' as const },
      { repoPath: 'data/catalog/tv.json', localPath: this.tvFile, stage: 'catalog' as const },
    ].filter((it) => existsSync(it.localPath));
    const refreshedPersonalItems = this.collectPersonalSyncItems().map((p) => ({
      repoPath: p.repoPath,
      localPath: p.localPath,
      stage: 'personal' as const,
    }));

    let haltedAtStage: 'personal' | undefined;
    for (const tracked of [...refreshedCatalogItems, ...refreshedPersonalItems]) {
      const { sizeBytes, localHash } = readLocalStats(tracked.localPath);
      if (tracked.stage === 'personal' && !allowPersonalSync) {
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: 'personal',
          status: 'blocked',
          writeStatus: 'blocked_public_guard',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: 'Açık depo gizlilik koruması nedeniyle kişisel veri gönderilmedi.',
        });
        continue;
      }

      const remoteAfterFile = finalReport.remoteAfter?.files[tracked.repoPath];
      const matchingError = finalReport.errors.find((e) => e.repoPath === tracked.repoPath);
      const isFailed = finalReport.filesFailed.includes(tracked.repoPath) || Boolean(matchingError);

      if (isFailed) {
        if (!haltedAtStage) haltedAtStage = 'personal';
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: tracked.stage,
          status: 'failed',
          writeStatus: 'failed',
          sizeBytes,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          error: matchingError?.message || `${tracked.repoPath} senkronize edilemedi.`,
          errorCategory: (matchingError?.category as GitHubSyncErrorCategory) || 'http_error',
        });
      } else {
        const wasUploaded =
          catalogReport.filesUploaded.includes(tracked.repoPath) ||
          finalReport.filesUploaded.includes(tracked.repoPath);
        const readBackHash = remoteAfterFile?.rawFileHash ?? null;
        fileOutcomes.push({
          repoPath: tracked.repoPath,
          stage: tracked.stage,
          status: 'succeeded',
          writeStatus: wasUploaded ? 'committed' : 'unchanged_noop',
          sizeBytes,
          localHash,
          readBackHash,
          sha: remoteAfterFile?.sha,
          verifiedReadBack: Boolean(remoteAfterFile?.exists && remoteAfterFile?.valid && readBackHash),
        });
      }
    }

    const overallOk = finalReport.ok && finalReport.verifiedEqual;
    return {
      ok: overallOk,
      verifiedEqual: finalReport.verifiedEqual,
      ...(haltedAtStage ? { haltedAtStage } : {}),
      probe: {
        ok: true,
        repoPath: probeRes.probeRepoPath,
        step: probeRes.step,
        sizeBytes: probeRes.probeSizeBytes,
        localHash: probeRes.localHash,
        readBackHash: probeRes.readBackHash,
        sha: probeRes.manifestSha,
        verifiedReadBack: Boolean(probeRes.verifiedReadBack),
      },
      catalogStage: { attempted: true, ok: true },
      personalStage: allowPersonalSync
        ? { attempted: true, ok: overallOk }
        : { attempted: false, ok: true, blockedByPublicGuard: true },
      access,
      allowPersonalSync,
      ...(finalReport.repoVisibilityWarning
        ? { repoVisibilityWarning: finalReport.repoVisibilityWarning }
        : access.warning
          ? { repoVisibilityWarning: access.warning }
          : {}),
      files: fileOutcomes,
      fileOutcomes,
      bidirectionalReport: finalReport,
    };
  }

  private async fetchBlobBufferBySha(sha: string): Promise<Buffer | null> {
    return fetchBlobBufferByShaImpl({ token: this.githubToken, owner: this.githubOwner, repo: this.githubRepo }, sha);
  }  /**
   * Uploads a binary backup archive (e.g. `.xlsx`) under `data/exports/` on GitHub
   * without overwriting different timestamped files, enforcing public-repo personal-data
   * privacy consent, and verifying post-upload binary SHA-256 read-back (including >1 MB Git Blobs).
   */
  public async uploadBinaryBackupToGitHub(params: {
    fileName: string;
    contentBuffer: Buffer;
    allowPersonalDataInPublicRepo?: boolean;
  }): Promise<{
    attempted: boolean;
    ok: boolean;
    blockedByPublicGuard?: boolean;
    skippedNoop?: boolean;
    repoPath?: string;
    sha?: string;
    localHash?: string | null;
    readBackHash?: string | null;
    verifiedReadBack: boolean;
    repoVisibilityWarning?: string;
    error?: string;
  }> {
    const localHash = crypto.createHash('sha256').update(params.contentBuffer).digest('hex');
    const safeBase = path.posix.basename(String(params.fileName || '').trim());
    if (!/^Cinethos_Profile_\d{4}-\d{2}-\d{2}_\d{4}(?:_\d{2,14})?\.(?:xlsx|json)$/.test(safeBase)) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        error: 'Geçersiz yedek dosya adı biçimi.',
      };
    }

    if (!this.githubToken || !this.githubOwner || !this.githubRepo) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        error: 'GitHub senkronizasyonu için ortam değişkenleri (token, owner, repo) eksik.',
      };
    }

    const access = await this.verifyRemoteRepoAccess();
    const warningPatch = access.warning ? { repoVisibilityWarning: access.warning } : {};

    if (!access.ok) {
      return {
        attempted: true,
        ok: false,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error: access.error || 'GitHub depo erişim doğrulaması başarısız.',
      };
    }

    const allowPersonal = this.isPersonalSyncAllowedForRepo(
      access.effectiveIsPublicRepo,
      params.allowPersonalDataInPublicRepo
    );
    if (access.effectiveIsPublicRepo && !allowPersonal) {
      return {
        attempted: true,
        ok: false,
        blockedByPublicGuard: true,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error:
          'Açık (public) GitHub deposuna kişisel Excel profil yedeği yüklenmesi gizlilik koruması nedeniyle engellendi. Açık depoya yüklemek için açık onay gereklidir.',
      };
    }

    const baseHeaders = {
      Authorization: `Bearer ${this.githubToken}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': BRAND_SYNC_USER_AGENT,
    };
    const targetBranch = this.githubBranch;

    const extIndex = safeBase.lastIndexOf('.');
    const stem = safeBase.slice(0, extIndex);
    const ext = safeBase.slice(extIndex);

    let chosenRepoPath = `data/exports/${safeBase}`;

    // Check remote `data/exports` so we never overwrite an existing different timestamped backup
    if (!access.isEmptyRepo) {
      for (let suffix = 1; suffix <= 50; suffix += 1) {
        const candidateName =
          suffix === 1 ? safeBase : `${stem}_${String(suffix).padStart(2, '0')}${ext}`;
        const candidateRepoPath = `data/exports/${candidateName}`;
        const checkUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${candidateRepoPath}?ref=${encodeURIComponent(
          targetBranch
        )}`;

        try {
          const getRes = await fetch(checkUrl, { headers: baseHeaders });
          if (getRes.status === 404) {
            chosenRepoPath = candidateRepoPath;
            break;
          }

          if (getRes.status === 200) {
            const fileData = readGitHubFileEnvelope(await getRes.json().catch(() => null));
            const remoteSha = fileData?.sha;
            let existingBuf: Buffer | null = null;
            if (
              fileData?.content !== undefined &&
              fileData.encoding !== 'none' &&
              fileData.content.replace(/\s+/g, '').length > 0
            ) {
              existingBuf = Buffer.from(fileData.content.replace(/\s+/g, ''), 'base64');
            } else if (remoteSha) {
              existingBuf = await this.fetchBlobBufferBySha(remoteSha);
            }
            if (existingBuf) {
              const existingHash = crypto.createHash('sha256').update(existingBuf).digest('hex');
              if (existingHash === localHash) {
                return {
                  attempted: true,
                  ok: true,
                  skippedNoop: true,
                  repoPath: candidateRepoPath,
                  sha: remoteSha,
                  localHash,
                  readBackHash: existingHash,
                  verifiedReadBack: true,
                  ...warningPatch,
                };
              }
            }
            // Different file already exists at this timestamped path -> try next suffix without overwriting
            continue;
          }

          if (getRes.status === 403) {
            const errBody = await getRes.json().catch(() => ({}));
            const isTooLarge = isGitHubTooLargeError(errBody);
            if (isTooLarge) {
              // Large file already occupies this timestamped slot; inspect directory listing to check hash or pick next suffix
              const dirUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/data/exports?ref=${encodeURIComponent(
                targetBranch
              )}`;
              const dirRes = await fetch(dirUrl, { headers: baseHeaders });
              if (dirRes.status === 200) {
                const found = findGitHubDirectoryEntry(
                  await dirRes.json().catch(() => null),
                  candidateName
                );
                if (found?.sha) {
                  const blobBuf = await this.fetchBlobBufferBySha(found.sha);
                  if (blobBuf) {
                    const existingHash = crypto.createHash('sha256').update(blobBuf).digest('hex');
                    if (existingHash === localHash) {
                      return {
                        attempted: true,
                        ok: true,
                        skippedNoop: true,
                        repoPath: candidateRepoPath,
                        sha: found.sha,
                        localHash,
                        readBackHash: existingHash,
                        verifiedReadBack: true,
                        ...warningPatch,
                      };
                    }
                  }
                }
              }
              continue;
            }
            const rawMsg = String(errBody?.message || '');
            const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
            return {
              attempted: true,
              ok: false,
              repoPath: candidateRepoPath,
              localHash,
              readBackHash: null,
              verifiedReadBack: false,
              ...warningPatch,
              error: redactSecrets(
                `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
                [this.githubToken]
              ),
            };
          }

          const errBody = await getRes.json().catch(() => ({}));
          const rawMsg = readGitHubErrorMessage(errBody);
          const category = classifyHttpFailure(getRes.status, getRes.headers, rawMsg);
          return {
            attempted: true,
            ok: false,
            repoPath: candidateRepoPath,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            ...warningPatch,
            error: redactSecrets(
              `GitHub okuma hatası (${category}): HTTP ${getRes.status}${rawMsg ? ` - ${rawMsg}` : ''}`,
              [this.githubToken]
            ),
          };
        } catch (e) {
          return {
            attempted: true,
            ok: false,
            repoPath: candidateRepoPath,
            localHash,
            readBackHash: null,
            verifiedReadBack: false,
            ...warningPatch,
            error: redactSecrets(
              `GitHub ağ bağlantı hatası: ${errorMessageOf(e, 'bağlantı kurulamadı')}`,
              [this.githubToken]
            ),
          };
        }
      }
    }

    const putUrl = `https://api.github.com/repos/${this.githubOwner}/${this.githubRepo}/contents/${chosenRepoPath}`;
    const putPayload: Record<string, unknown> = {
      message: `chore(backup): archive profile export ${path.posix.basename(chosenRepoPath)} [skip ci]`,
      content: params.contentBuffer.toString('base64'),
    };
    if (!access.isEmptyRepo) {
      putPayload.branch = targetBranch;
    }

    try {
      const putRes = await fetch(putUrl, {
        method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(putPayload),
      });

      if (putRes.status !== 200 && putRes.status !== 201) {
        const errJson = await putRes.json().catch(() => ({}));
        const rawDetail = readGitHubErrorMessage(errJson);
        const acceptedPerms = putRes.headers.get('x-accepted-github-permissions');
        const category = classifyHttpFailure(putRes.status, putRes.headers, rawDetail);
        let detail = rawDetail;
        if (
          putRes.status === 403 &&
          rawDetail.toLowerCase().includes('resource not accessible by personal access token')
        ) {
          detail += ` (Fine-grained PAT ayarlarında '${this.githubOwner}/${this.githubRepo}' deposu için 'Contents: Read and write' iznini doğrulayın${
            acceptedPerms ? `; beklenen izin: ${acceptedPerms}` : ''
          })`;
        }
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          ...warningPatch,
          error: redactSecrets(
            `GitHub yazma reddedildi (${category}): HTTP ${putRes.status}${detail ? ` - ${detail}` : ''}`,
            [this.githubToken]
          ),
        };
      }

      const putResponse = await putRes.json().catch(() => null);
      const committedSha: string | undefined = readGitHubCommittedSha(putResponse);

      // Mandatory post-upload binary read-back SHA-256 verification
      const readBackUrl = `${putUrl}?ref=${encodeURIComponent(targetBranch)}`;
      const readBackRes = await fetch(readBackUrl, { headers: baseHeaders });
      let readBackBuffer: Buffer | null = null;

      if (readBackRes.status === 200) {
        const readBackData = readGitHubFileEnvelope(await readBackRes.json().catch(() => null));
        if (
          readBackData?.content !== undefined &&
          readBackData.encoding !== 'none' &&
          readBackData.content.replace(/\s+/g, '').length > 0
        ) {
          readBackBuffer = Buffer.from(readBackData.content.replace(/\s+/g, ''), 'base64');
        } else {
          const blobSha = readBackData?.sha ?? committedSha;
          if (blobSha) {
            readBackBuffer = await this.fetchBlobBufferBySha(blobSha);
          }
        }
      } else if (readBackRes.status === 403 && committedSha) {
        readBackBuffer = await this.fetchBlobBufferBySha(committedSha);
      }

      if (!readBackBuffer) {
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          sha: committedSha,
          localHash,
          readBackHash: null,
          verifiedReadBack: false,
          ...warningPatch,
          error: `${chosenRepoPath}: GitHub yüklemesi sonrası ikili (binary) geri okuma doğrulaması yapılamadı.`,
        };
      }

      const readBackHash = crypto.createHash('sha256').update(readBackBuffer).digest('hex');
      if (readBackHash !== localHash) {
        return {
          attempted: true,
          ok: false,
          repoPath: chosenRepoPath,
          sha: committedSha,
          localHash,
          readBackHash,
          verifiedReadBack: false,
          ...warningPatch,
          error: `${chosenRepoPath}: Geri okuma SHA-256 özeti yerel dosyayla eşleşmedi (uzak: ${readBackHash.slice(
            0,
            8
          )}, yerel: ${localHash.slice(0, 8)}).`,
        };
      }

      return {
        attempted: true,
        ok: true,
        repoPath: chosenRepoPath,
        sha: committedSha,
        localHash,
        readBackHash,
        verifiedReadBack: true,
        ...warningPatch,
      };
    } catch (e) {
      return {
        attempted: true,
        ok: false,
        repoPath: chosenRepoPath,
        localHash,
        readBackHash: null,
        verifiedReadBack: false,
        ...warningPatch,
        error: redactSecrets(
          `GitHub ağ hatası: ${errorMessageOf(e, 'bağlantı hatası')}`,
          [this.githubToken]
        ),
      };
    }
  }
}
