import { AsyncLocalStorage } from 'node:async_hooks';
import {
  existsSync,
  readdirSync,
  readFileSync,
} from 'node:fs';
import path from 'node:path';
import { createGithubSyncUnconfiguredReport } from './github-sync/sync-operation-result.ts';
import {
  type DataDocument,
} from '../core/cinetrack-core.ts';
import {
  mergeTwoSavedItemsLossless,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';
export { mergeTwoSavedItemsLossless, reconcileUserDataDocumentsLossless };
import {
  type CinemaKunyeDocument,
} from '../core/cinema-kunye.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb, measureUtf8Bytes } from '../core/limits.ts';
import { githubFetch } from './github-request.ts';
import {
  readGitHubBlobPayload,
  readGitHubErrorMessage,
} from './github-response.ts';
import {
  SyncOperationQueue,
  type SyncQueueSnapshot,
  type SyncQueueTaskContext,
} from '../core/sync-operation-queue.ts';
import { SyncAttemptJournal, type SyncAttemptRecord } from './sync-attempt-journal.ts';
import { acquireSyncFileLease, tryAcquireSyncFileLease } from './sync-file-lease.ts';
import type {
  BidirectionalSyncReport,
  SyncErrorRecord,
  SyncFileInspection,
  SyncSideSummary,
} from '../core/sync-display.ts';
import {
  hashContent,
  redactSecrets,
} from './persistent-store-utils.ts';
import type {
  CatalogManifest,
  CatalogRecord,
  DerivedProfileDocument,
} from './persistent-store-types.ts';

import {
  classifyGitHubHttpStatus,
  computeCatalogSemanticMapHash,
  computeCatalogManifestContentHash,
  inspectCatalogRawContent,
  inspectManifestRawContent,
  inspectUserDataRawContent,
  inspectStockRawContent,
  inspectCinemaKunyeRawContent,
  inspectDerivedProfileRawContent,
  compareSyncSides,
  buildBlockedPublicPaths,
} from './github-sync/sync-core.ts';
import type {
  BidirectionalSyncDependencies,
  ParsedSideBundle,
} from './github-sync/sync-core.ts';
export * from './github-sync/sync-core.ts';
import {
  fetchRemoteFileRaw,
  inspectRemoteSide,
  listRemoteProfilePaths,
  type RemoteInspectionHost,
} from './github-sync/inspect-operation.ts';
import { runPullOperation } from './github-sync/pull-operation.ts';
import { runPushOperation } from './github-sync/push-operation.ts';
import { runReconcileOperation } from './github-sync/reconcile-operation.ts';
import type {
  ReconcileOperationHost,
  SyncOperationHost,
} from './github-sync/sync-operation-host.ts';

export class GitHubBidirectionalSyncManager {
  private deps: BidirectionalSyncDependencies;
  private readonly queue: SyncOperationQueue;
  private readonly journal: SyncAttemptJournal;
  private readonly leasePath: string;
  private recoveredInterrupted: SyncAttemptRecord | null = null;
  private initialReconcileCompleted = false;
  private readonly operationContext = new AsyncLocalStorage<{
    manager: GitHubBidirectionalSyncManager;
    signal: AbortSignal;
  }>();
  private readonly recoveryPromise: Promise<void>;

  constructor(deps: BidirectionalSyncDependencies) {
    this.deps = deps;
    this.queue = new SyncOperationQueue();
    this.journal = new SyncAttemptJournal({ dataDir: deps.dataDir });
    this.leasePath = path.join(deps.dataDir, 'locks', 'github-sync.lock');
    this.recoveryPromise =
      deps.enableStartupRecovery === false
        ? Promise.resolve()
        : this.recoverInterruptedJournalAtStartup().catch(() => undefined);
  }

  private async recoverJournalWhileLeaseHeld(): Promise<void> {
    const interrupted = this.journal.read();
    if (!interrupted) return;
    const removed = await this.journal.complete(interrupted.leaseToken);
    if (!removed) return;
    this.recoveredInterrupted = interrupted;
    this.queue.markRecoveredInterrupted(1);
  }

  private async recoverInterruptedJournalAtStartup(): Promise<void> {
    const lease = tryAcquireSyncFileLease(this.leasePath);
    if (!lease) return;
    try {
      await this.recoverJournalWhileLeaseHeld();
    } finally {
      lease.release();
    }
  }

  public isBusy(): boolean {
    return this.queue.isBusy();
  }

  public getQueueStatus(): SyncQueueSnapshot {
    return this.queue.getSnapshot();
  }

  public getRecoveredInterruption(): SyncAttemptRecord | null {
    return this.recoveredInterrupted;
  }

  /** Senkronizasyon kuyruğunda fiilen çalışan bir işlem var mı? */
  public isExclusiveActive(): boolean {
    return this.queue.getSnapshot().running;
  }

  /**
   * Kuyruk dışındaki yazma yollarını (ör. aşamalı yükleme, bağlantı probu)
   * aynı FIFO kuyruğu + süreçler arası kilitten geçirir. Kuyruk içinden
   * çağrılırsa yeniden kilitlemeye çalışmaz (deadlock yok).
   */
  public async runExclusive<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (this.operationContext.getStore()?.manager === this) return fn();
    return this.runSerialized(operation, async () => fn(), operation);
  }

  public hasCompletedInitialReconcile(): boolean {
    return this.initialReconcileCompleted;
  }

  /**
   * B-10 / B-38: Süreç içi FIFO kuyruk + süreçler arası dosya kilidi + kalıcı
   * deneme günlüğü. Kilit `finally` ile her durumda (başarı, hata, abort)
   * serbest bırakılır; deadlock oluşmaz.
   */
  private async runSerialized<T>(
    operation: string,
    fn: (context: SyncQueueTaskContext) => Promise<T>,
    dedupeKey?: string
  ): Promise<T> {
    // Yalnızca aynı async çağrı zincirindeki iç içe işlem kuyruğu atlayabilir.
    const activeContext = this.operationContext.getStore();
    if (activeContext?.manager === this) {
      return fn({ signal: activeContext.signal });
    }
    return this.queue.enqueue(
      operation,
      async (queueContext) => {
        await this.recoveryPromise;
        const lease = acquireSyncFileLease(this.leasePath);
        const leaseAbort = new AbortController();
        const operationSignal = AbortSignal.any([queueContext.signal, leaseAbort.signal]);
        const heartbeat = setInterval(() => {
          if (!lease.renew()) {
            leaseAbort.abort(new Error('Senkronizasyon lease yenilemesi başarısız; işlem güvenli biçimde durdurulmalı.'));
          }
        }, Math.max(100, Math.floor(lease.staleMs / 3)));
        heartbeat.unref?.();
        try {
          await this.recoverJournalWhileLeaseHeld();
          await this.journal.begin(operation, lease.token);
          const result = await this.operationContext.run(
            { manager: this, signal: operationSignal },
            () => fn({ signal: operationSignal })
          );
          if (leaseAbort.signal.aborted) {
            throw leaseAbort.signal.reason ?? new Error('Senkronizasyon lease kaybedildi.');
          }
          return result;
        } finally {
          clearInterval(heartbeat);
          try {
            await this.journal.complete(lease.token);
          } catch {
            // Günlük temizliği başarısızsa sonraki lease sahibi güvenli kurtarma yapar.
          }
          lease.release();
        }
      },
      { dedupeKey: dedupeKey ?? operation }
    );
  }

  /** F5.3-01: işlemler bu dar host bağlamını alır; private state sızdırılmaz. */
  private get syncOperationHost(): SyncOperationHost {
    return {
      deps: this.deps,
      maxBytes: this.maxBytes,
      inspectLocalSide: () => this.inspectLocalSide(),
      inspectRemoteSide: (cfg, options) => this.inspectRemoteSide(cfg, options),
    };
  }

  private get maxBytes(): number {
    return this.deps.maxDataBytes ?? DEFAULT_MAX_DATA_BYTES;
  }

  public inspectLocalSideSync(): ParsedSideBundle {
    return this.buildLocalSideBundle(null);
  }

  public async inspectLocalSide(): Promise<ParsedSideBundle> {
    const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
    let remoteRepoDoc: DataDocument | null = null;
    // MIA Faz 1 — Adım 1.4 GEREKÇE: Bu modül senkronizasyon/yedek altyapı
    // katmanıdır; storage handle'ına deps üzerinden erişen düşük seviye
    // (low-level) bir istisnadır. API/uygulama yolları PrimaryDataRepository
    // kullanmak zorundadır; senkron katmanı ham belgeye erişebilir.
    if (!existsSync(userDataPath) && this.deps.storage?.readDataAsync) {
      try {
        remoteRepoDoc = await this.deps.storage.readDataAsync();
      } catch {
        remoteRepoDoc = null;
      }
    }
    return this.buildLocalSideBundle(remoteRepoDoc);
  }

  private buildLocalSideBundle(fallbackStoredDoc: DataDocument | null): ParsedSideBundle {
    const inspectedAt = new Date().toISOString();
    const files: Record<string, SyncFileInspection> = {};
    const errors: SyncErrorRecord[] = [];

    const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
    const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
    const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
    const userDataPath = path.join(this.deps.dataDir, 'cinetrack-data.json');
    const profilesDir = path.join(this.deps.dataDir, 'profiles');

    let movies: Record<string, CatalogRecord> = {};
    let tv: Record<string, CatalogRecord> = {};
    let manifest: CatalogManifest | null = null;
    let userData: DataDocument | null = null;
    let cinemaKunye: CinemaKunyeDocument | null = null;
    const derivedProfiles: Record<string, DerivedProfileDocument> = {};

    if (existsSync(moviesPath)) {
      const raw = readFileSync(moviesPath, 'utf8');
      const res = inspectCatalogRawContent(
        'data/catalog/movies.json',
        raw,
        'movie',
        this.maxBytes
      );
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/movies.json'] = res.inspection;
      if (res.parsedMap) movies = res.parsedMap;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/movies.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/catalog/movies.json'] = {
        repoPath: 'data/catalog/movies.json',
        category: 'catalog_movies',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    if (existsSync(tvPath)) {
      const raw = readFileSync(tvPath, 'utf8');
      const res = inspectCatalogRawContent('data/catalog/tv.json', raw, 'tv', this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/tv.json'] = res.inspection;
      if (res.parsedMap) tv = res.parsedMap;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/catalog/tv.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/catalog/tv.json'] = {
        repoPath: 'data/catalog/tv.json',
        category: 'catalog_tv',
        personal: false,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    let manifestValid = true;
    let manifestMismatchReason: string | undefined;
    if (existsSync(manifestPath)) {
      const raw = readFileSync(manifestPath, 'utf8');
      const res = inspectManifestRawContent(raw, movies, tv, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/catalog/manifest.json'] = res.inspection;
      manifest = res.manifest || null;
      manifestValid = res.manifestConsistent;
      manifestMismatchReason = res.mismatchReason;
    } else {
      const hasCatalogRecords = Object.keys(movies).length > 0 || Object.keys(tv).length > 0;
      manifestValid = !hasCatalogRecords;
      manifestMismatchReason = hasCatalogRecords
        ? 'Katalog kayıtları var ancak manifest.json eksik'
        : undefined;
      files['data/catalog/manifest.json'] = {
        repoPath: 'data/catalog/manifest.json',
        category: 'catalog_manifest',
        personal: false,
        exists: false,
        valid: !hasCatalogRecords,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
        ...(hasCatalogRecords
          ? {
              error: manifestMismatchReason,
              errorCategory: 'schema_mismatch' as const,
            }
          : {}),
      };
    }

    let userRawItems = 0;
    let userUniqueItems = 0;
    if (existsSync(userDataPath)) {
      const raw = readFileSync(userDataPath, 'utf8');
      const res = inspectUserDataRawContent(raw, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/cinetrack-data.json'] = res.inspection;
      if (res.doc) userData = res.doc;
      userRawItems = res.rawItemsCount;
      userUniqueItems = res.uniqueItemsCount;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/cinetrack-data.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else if (
      fallbackStoredDoc &&
      (fallbackStoredDoc.profiles.length > 0 || (fallbackStoredDoc.revision ?? 0) > 0)
    ) {
      const raw = JSON.stringify(fallbackStoredDoc, null, 2);
      const res = inspectUserDataRawContent(raw, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/cinetrack-data.json'] = res.inspection;
      if (res.doc) userData = res.doc;
      userRawItems = res.rawItemsCount;
      userUniqueItems = res.uniqueItemsCount;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/cinetrack-data.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/cinetrack-data.json'] = {
        repoPath: 'data/cinetrack-data.json',
        category: 'user_data',
        personal: true,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    const stockPath = path.join(this.deps.dataDir, 'stock.json');
    if (existsSync(stockPath)) {
      const raw = readFileSync(stockPath, 'utf8');
      const res = inspectStockRawContent(raw, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/stock.json'] = res.inspection;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/stock.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/stock.json'] = {
        repoPath: 'data/stock.json',
        category: 'stock',
        personal: true,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    const kunyePath = path.join(this.deps.dataDir, 'sinema-kunyesi.json');
    if (existsSync(kunyePath)) {
      const raw = readFileSync(kunyePath, 'utf8');
      const res = inspectCinemaKunyeRawContent(raw, this.maxBytes);
      if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
        res.inspection.errorCategory = 'corrupt_local_file';
      }
      files['data/sinema-kunyesi.json'] = res.inspection;
      if (res.doc) cinemaKunye = res.doc;
      if (!res.inspection.valid && res.inspection.error) {
        errors.push({
          repoPath: 'data/sinema-kunyesi.json',
          category: res.inspection.errorCategory || 'corrupt_local_file',
          message: res.inspection.error,
        });
      }
    } else {
      files['data/sinema-kunyesi.json'] = {
        repoPath: 'data/sinema-kunyesi.json',
        category: 'cinema_kunye',
        personal: true,
        exists: false,
        valid: true,
        sizeBytes: 0,
        rawFileHash: null,
        semanticHash: null,
        recordCount: 0,
        uniqueKeyCount: 0,
      };
    }

    let derivedRecordsTotal = 0;
    if (existsSync(profilesDir)) {
      const dirFiles = readdirSync(profilesDir)
        .filter(
          (f) =>
            f.endsWith('.json') &&
            !f.endsWith('.bak.json') &&
            !f.includes('.corrupt.') &&
            !f.endsWith('.tmp')
        )
        .sort((a, b) => a.localeCompare(b));

      for (const fileName of dirFiles) {
        const repoPath = `data/profiles/${fileName}`;
        const fullPath = path.join(profilesDir, fileName);
        const raw = readFileSync(fullPath, 'utf8');
        const res = inspectDerivedProfileRawContent(repoPath, raw, this.maxBytes);
        if (!res.inspection.valid && res.inspection.errorCategory === 'corrupt_remote_json') {
          res.inspection.errorCategory = 'corrupt_local_file';
        }
        files[repoPath] = res.inspection;
        if (res.doc) {
          derivedProfiles[repoPath] = res.doc;
          derivedRecordsTotal += res.inspection.uniqueKeyCount;
        } else if (res.inspection.error) {
          errors.push({
            repoPath,
            category: res.inspection.errorCategory || 'corrupt_local_file',
            message: res.inspection.error,
          });
        }
      }
    }

    const catalogContentHash = computeCatalogManifestContentHash(movies, tv);
    const catalogSemanticHash = hashContent(
      computeCatalogSemanticMapHash(movies) + computeCatalogSemanticMapHash(tv)
    );

    const summary: SyncSideSummary = {
      inspectedAt,
      catalogMovieCount: Object.keys(movies).length,
      catalogTvCount: Object.keys(tv).length,
      catalogRawMovieRecords: files['data/catalog/movies.json']?.recordCount ?? 0,
      catalogRawTvRecords: files['data/catalog/tv.json']?.recordCount ?? 0,
      catalogContentHash,
      catalogSemanticHash,
      manifestPresent: Boolean(files['data/catalog/manifest.json']?.exists),
      manifestValid,
      manifestMovieCount: manifest ? Number(manifest.movieCount) : null,
      manifestTvCount: manifest ? Number(manifest.tvCount) : null,
      manifestContentHash: manifest?.contentHash || null,
      ...(manifestMismatchReason ? { manifestMismatchReason } : {}),
      userDataPresent: Boolean(files['data/cinetrack-data.json']?.exists),
      userProfilesCount: userData?.profiles?.length ?? 0,
      userTotalSavedItemsCount: userRawItems,
      userUniqueSavedItemsCount: userUniqueItems,
      userDataSemanticHash: files['data/cinetrack-data.json']?.semanticHash ?? null,
      userDataRawHash: files['data/cinetrack-data.json']?.rawFileHash ?? null,
      derivedProfileFilesCount: Object.keys(derivedProfiles).length,
      derivedProfileTotalRecordsCount: derivedRecordsTotal,
      files,
    };

    return { summary, movies, tv, manifest, userData, cinemaKunye, derivedProfiles, errors };
  }

  private async fetchGitBlobBySha(
    sha: string,
    owner: string,
    repo: string,
    token: string
  ): Promise<{ ok: true; content: string } | { ok: false; error: SyncErrorRecord }> {
    const blobUrl = `https://api.github.com/repos/${owner}/${repo}/git/blobs/${encodeURIComponent(sha)}`;
    try {
      const res = await githubFetch(blobUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Cinethos-Sync-Agent',
        },
      });
      if (res.status !== 200) {
        const errBody: unknown = await res.json().catch(() => ({}));
        const msg = readGitHubErrorMessage(errBody);
        const category = classifyGitHubHttpStatus(res.status, res.headers, msg);
        return {
          ok: false,
          error: {
            category,
            status: res.status,
            message: redactSecrets(
              `GitHub Git Blob okuma hatası (${category}): HTTP ${res.status}${msg ? ` - ${msg}` : ''}`,
              [token]
            ),
          },
        };
      }
      const blobJson = readGitHubBlobPayload(await res.json().catch(() => null));
      if (!blobJson) {
        return {
          ok: false,
          error: {
            category: 'malformed_response',
            message: 'GitHub Git Blob yanıtında geçerli base64 içerik bulunamadı.',
          },
        };
      }
      if (typeof blobJson.size === 'number' && blobJson.size > this.maxBytes) {
        return {
          ok: false,
          error: {
            category: 'payload_too_large',
            message: `Uzak dosya boyutu sınırı (${formatMaxDataLimitMb(this.maxBytes)}) aşıyor.`,
          },
        };
      }
      const decoded = Buffer.from(blobJson.content.replace(/\s+/g, ''), 'base64').toString('utf8');
      if (measureUtf8Bytes(decoded) > this.maxBytes) {
        return {
          ok: false,
          error: {
            category: 'payload_too_large',
            message: `Uzak dosya UTF-8 bayt boyutu sınırı (${formatMaxDataLimitMb(this.maxBytes)}) aşıyor.`,
          },
        };
      }
      return { ok: true, content: decoded };
    } catch (err: any) {
      return {
        ok: false,
        error: {
          category: 'network_error',
          message: redactSecrets(
            `GitHub Git Blob ağ hatası: ${err?.message || 'bağlantı kurulamadı'}`,
            [token]
          ),
        },
      };
    }
  }

  /** F5.2-04: uzak taraf incelemesi `github-sync/inspect-operation.ts` içindedir. */
  private remoteInspectionHost(): RemoteInspectionHost {
    return {
      deps: this.deps,
      maxBytes: this.maxBytes,
      fetchGitBlobBySha: (sha, owner, repo, token) =>
        this.fetchGitBlobBySha(sha, owner, repo, token),
    };
  }

  private fetchRemoteFileRaw(
    repoPath: string,
    cfg: { token: string; owner: string; repo: string; branch: string }
  ): Promise<
    | { ok: true; exists: false }
    | { ok: true; exists: true; content: string; sha: string }
    | { ok: false; error: SyncErrorRecord }
  > {
    return fetchRemoteFileRaw(this.remoteInspectionHost(), repoPath, cfg);
  }

  private listRemoteProfilePaths(
    cfg: { token: string; owner: string; repo: string; branch: string },
    localHintPaths: string[]
  ): Promise<{ ok: true; paths: string[] } | { ok: false; error: SyncErrorRecord }> {
    return listRemoteProfilePaths(this.remoteInspectionHost(), cfg, localHintPaths);
  }

  private inspectRemoteSide(
    cfg: { token: string; owner: string; repo: string; branch: string },
    options: {
      includePersonalFiles: boolean;
      includeCatalogFiles?: boolean;
      localProfilePaths: string[];
    }
  ): Promise<{
    bundle: ParsedSideBundle;
    rawRemoteContents: Record<string, { content: string; sha: string }>;
    transportFailed: boolean;
  }> {
    return inspectRemoteSide(this.remoteInspectionHost(), cfg, options);
  }

  /**
   * 1. INSPECT: Hiçbir yerel veya uzak veriyi değiştirmeden GitHub dosyalarını inceler,
   * kayıt sayılarını, ham dosya ve semantik içerik hash'lerini karşılaştırır.
   */
  public async inspect(): Promise<BidirectionalSyncReport> {
    return this.runSerialized('inspect', async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = await this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return createGithubSyncUnconfiguredReport(
          'inspect',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const allowPersonalOnPublic =
        cfg.allowPublicPersonalSync !== undefined
          ? cfg.allowPublicPersonalSync
          : Boolean(cfg.isPublicRepo);
      const allowCatalogOnPublic = Boolean(cfg.allowPublicCatalogSync);
      const access = await this.deps.store.verifyRemoteRepoAccess();
      if (!access.ok) {
        return {
          ok: false,
          partialFailure: false,
          operation: 'inspect',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: access.effectiveIsPublicRepo,
          ...(access.warning ? { repoVisibilityWarning: access.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: null,
          localAfter: localBefore.summary,
          remoteAfter: null,
          comparison: null,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: [],
          filesPending: [],
          filesBlockedPublic: buildBlockedPublicPaths(
            !access.effectiveIsPublicRepo || allowCatalogOnPublic,
            !access.effectiveIsPublicRepo || allowPersonalOnPublic
          ),
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: 0,
          conflicts: [],
          warnings: access.warning ? [access.warning] : [],
          errors: [
            {
              category: access.errorCategory || 'http_error',
              message: access.error || 'GitHub depo erişim doğrulaması başarısız.',
            },
          ],
          verifiedEqual: false,
        };
      }
      const visibility = {
        effectiveIsPublicRepo: access.effectiveIsPublicRepo,
        warning: access.warning,
      };
      const includePersonal = !visibility.effectiveIsPublicRepo || allowPersonalOnPublic;
      const includeCatalog = !visibility.effectiveIsPublicRepo || allowCatalogOnPublic;
      const localProfilePaths = Object.keys(localBefore.derivedProfiles);

      const activeToken = this.deps.getGitHubConfig().token || cfg.token;
      const remoteInspect = await this.inspectRemoteSide(
        { token: activeToken, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          includeCatalogFiles: includeCatalog,
          localProfilePaths,
        }
      );

      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);
      if (includeCatalog && localBefore.summary.manifestMismatchReason) {
        warnings.push(`Yerel manifest: ${localBefore.summary.manifestMismatchReason}`);
      }
      if (includeCatalog && remoteInspect.bundle.summary.manifestMismatchReason) {
        warnings.push(`GitHub manifest: ${remoteInspect.bundle.summary.manifestMismatchReason}`);
      }

      const allErrors: SyncErrorRecord[] = [
        ...localBefore.errors,
        ...remoteInspect.bundle.errors,
      ];

      const comparison = compareSyncSides(localBefore, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
        includeCatalogFiles: includeCatalog,
      });

      const ok = !remoteInspect.transportFailed && allErrors.length === 0;
      const verifiedEqual = ok && comparison.semanticEqual;

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure: false,
        operation: 'inspect',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteInspect.bundle.summary,
        localAfter: localBefore.summary,
        remoteAfter: remoteInspect.bundle.summary,
        comparison,
        filesDownloaded: [],
        filesUploaded: [],
        filesUnchanged: comparison.differingFiles.length === 0
          ? Object.keys(localBefore.summary.files).filter((p) => {
              const info = localBefore.summary.files[p];
              if (!info?.exists) return false;
              if (info.personal && !includePersonal) return false;
              if (!info.personal && !includeCatalog) return false;
              return true;
            })
          : [],
        filesMerged: [],
        filesFailed: allErrors.map((e) => e.repoPath).filter(Boolean) as string[],
        filesPending: comparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
        recordsAdded: 0,
        recordsUpdated: 0,
        recordsConflicted: comparison.conflictingUserItemsCount,
        conflicts: comparison.userDataConflicts,
        warnings,
        errors: allErrors,
        verifiedEqual,
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteInspect.bundle.summary,
        lastComparison: comparison,
      });

      return report;
    });
  }

  /**
   * 2. PULL: GitHub'daki dosyaları şema ve boyut kontrolünden geçirerek güvenli biçimde yerel depoya indirir.
   * Yerelde farklı kullanıcı verisi varsa sessizce ezmez; varsayılan olarak onay ister veya kayıpsız birleştirir.
   */
  public async pull(
    options: { conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote' } = {}
  ): Promise<BidirectionalSyncReport> {
    return this.runSerialized('pull', () =>
      runPullOperation(this.syncOperationHost, options)
    );
  }

  /**
   * 3. PUSH: Yerel dosyaların geçerliliğini doğrulayıp GitHub'a yükler,
   * ardından uzak dosyaları yeniden okuyarak hash ve kayıt sayılarını doğrular (`verifiedEqual`).
   */
  public async push(): Promise<BidirectionalSyncReport> {
    return this.runSerialized('push', () => runPushOperation(this.syncOperationHost));
  }

  /**
   * 4. RECONCILE (İki Yönlü Eşitleme):
   * Yerel ve GitHub verilerini inceler, katalog + kullanıcı verisi + türetilmiş profilleri
   * varsayılan silmesiz (no-deletion) kuralla kayıpsız birleştirir, her iki tarafa uygular
   * ve uzak dosyaları yeniden okuyarak tam eşitliği doğrular.
   */
  public async reconcile(
    options: { includePersonalOverride?: boolean; includeCatalogOverride?: boolean } = {}
  ): Promise<BidirectionalSyncReport> {
    const reconcileHost: ReconcileOperationHost = {
      ...this.syncOperationHost,
      setInitialReconcileCompleted: () => {
        this.initialReconcileCompleted = true;
      },
    };
    return this.runSerialized('reconcile', () =>
      runReconcileOperation(reconcileHost, options)
    );
  }}
