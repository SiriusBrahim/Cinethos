import { AsyncLocalStorage } from 'node:async_hooks';
import { normalizeProfileId } from '../core/profile-id.ts';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createGithubSyncUnconfiguredReport } from './github-sync/sync-operation-result.ts';
import { isDerivedDocFreshForContext } from './github-sync/derived-doc-freshness.ts';
import {
  type DataDocument,
} from '../core/cinetrack-core.ts';
import {
  mergeTwoSavedItemsLossless,
  reconcileUserDataDocumentsLossless,
} from '../core/user-data-merge.ts';
export { mergeTwoSavedItemsLossless, reconcileUserDataDocumentsLossless };
import {
  
  mergeCinemaKunyeDocumentsLossless,
  
  type CinemaKunyeDocument,
} from '../core/cinema-kunye.ts';
import { DEFAULT_MAX_DATA_BYTES, formatMaxDataLimitMb, measureUtf8Bytes } from '../core/limits.ts';
import {
  computeDerivedProfileContentHash,
  DERIVED_PROFILE_SCHEMA_VERSION,
  
} from '../core/derived-profile-cache.ts';
import { githubFetch } from './github-request.ts';
import {
  readGitHubBlobPayload,
  readGitHubErrorMessage,
} from './github-response.ts';
import { buildBidirectionalSyncCounters } from '../core/sync-counters.ts';
import {
  SyncOperationQueue,
  type SyncQueueSnapshot,
  type SyncQueueTaskContext,
} from '../core/sync-operation-queue.ts';
import { SyncAttemptJournal, type SyncAttemptRecord } from './sync-attempt-journal.ts';
import { acquireSyncFileLease, tryAcquireSyncFileLease } from './sync-file-lease.ts';
import type {
  BidirectionalSyncReport,
  PullConflictSummary,
  
  SyncErrorCategory,
  SyncErrorRecord,
  
  
  SyncFileInspection,
  SyncOperationKind,
  SyncSideSummary,
  UserDataConflictItem,
} from '../core/sync-display.ts';
import { tryParseValidJson, writeJsonFileAtomic } from './atomic-json.ts';
import { hashContent, redactSecrets, sanitizeProfileId, stringifyDeterministic } from './persistent-store-utils.ts';
import type { CatalogManifest, CatalogRecord, DerivedProfileDocument, DerivedProfileItem } from './persistent-store-types.ts';


import {
  isPlainObject,
  computeRawUtf8Hash,
  classifyGitHubHttpStatus,
  computeCatalogSemanticMapHash,
  computeCatalogManifestContentHash,
  mergeCatalogMapsLossless,
  buildFreshDerivedProfileDocumentOnServer,
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
    return this.runSerialized(
      'pull',
      async () => {
      const conflictStrategy = options.conflictStrategy || 'ask';
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = await this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return createGithubSyncUnconfiguredReport(
          'pull',
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
          operation: 'pull',
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

      if (remoteInspect.transportFailed) {
        const report: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'pull',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteInspect.bundle.summary,
          comparison: null,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: remoteInspect.bundle.errors
            .map((e) => e.repoPath)
            .filter(Boolean) as string[],
          filesPending: [],
          filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: 0,
          conflicts: [],
          warnings: visibility.warning ? [visibility.warning] : [],
          errors: remoteInspect.bundle.errors,
          verifiedEqual: false,
        };
        this.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: remoteInspect.bundle.summary,
          lastComparison: null,
        });
        return report;
      }

      const initialComparison = compareSyncSides(localBefore, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
        includeCatalogFiles: includeCatalog,
      });

      // Yerel kullanıcı verisini sessizce ezme koruması (Spec Bölüm 4.8)
      const localHasLiveUserItems = Boolean(
        localBefore.userData &&
          localBefore.userData.profiles.some(
            (p) => !p.isDemo && Array.isArray(p.items) && p.items.length > 0
          )
      );
      const remoteHasValidUserData = Boolean(
        includePersonal &&
          remoteInspect.bundle.summary.files['data/cinetrack-data.json']?.exists &&
          remoteInspect.bundle.summary.files['data/cinetrack-data.json']?.valid &&
          remoteInspect.bundle.userData
      );

      if (
        conflictStrategy === 'ask' &&
        localHasLiveUserItems &&
        remoteHasValidUserData &&
        localBefore.summary.userDataSemanticHash !==
          remoteInspect.bundle.summary.userDataSemanticHash &&
        (initialComparison.localOnlyUserItemsCount > 0 ||
          initialComparison.conflictingUserItemsCount > 0)
      ) {
        const conflictSummary: PullConflictSummary = {
          localProfilesCount: localBefore.summary.userProfilesCount,
          remoteProfilesCount: remoteInspect.bundle.summary.userProfilesCount,
          localItemsCount: localBefore.summary.userUniqueSavedItemsCount,
          remoteItemsCount: remoteInspect.bundle.summary.userUniqueSavedItemsCount,
          localOnlyItemsCount: initialComparison.localOnlyUserItemsCount,
          conflictingItemsCount: initialComparison.conflictingUserItemsCount,
          message: `Yerelde GitHub'da bulunmayan ${initialComparison.localOnlyUserItemsCount} kayıt ve ${initialComparison.conflictingUserItemsCount} farklı düzenlenmiş kayıt tespit edildi. Yerel verinizin ezilmemesi için "Kayıpsız Birleştir" seçeneğini kullanın veya yedek alarak üzerine yazmayı onaylayın.`,
        };

        const askReport: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          requiresConfirmation: true,
          conflictSummary,
          operation: 'pull',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteInspect.bundle.summary,
          comparison: initialComparison,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: [],
          filesPending: initialComparison.differingFiles.map((d) => d.repoPath),
          filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: initialComparison.conflictingUserItemsCount,
          conflicts: initialComparison.userDataConflicts,
          warnings: [conflictSummary.message],
          errors: [],
          verifiedEqual: false,
        };
        return askReport;
      }

      // İşlemden önce yerel verinin döner yedeğini al (Spec Bölüm 4.7)
      await this.deps.storage.createSafetySnapshotSerialized();

      const filesDownloaded: string[] = [];
      const filesUnchanged: string[] = [];
      const filesMerged: string[] = [];
      const filesFailed: string[] = [];
      const warnings: string[] = [];
      const errors: SyncErrorRecord[] = [];
      const conflicts: UserDataConflictItem[] = [];
      let updatedDataDocument: DataDocument | undefined;
      let serverRevision: number | undefined;

      if (visibility.warning) warnings.push(visibility.warning);

      // Katalog dosyalarını uygula (sağlam olanları atomik yaz, bozuk uzak dosyada yereli koru!)
      let finalMovies = localBefore.movies;
      const rMoviesInfo = remoteInspect.bundle.summary.files['data/catalog/movies.json'];
      if (rMoviesInfo?.exists) {
        if (!rMoviesInfo.valid) {
          filesFailed.push('data/catalog/movies.json');
          errors.push({
            repoPath: 'data/catalog/movies.json',
            category: rMoviesInfo.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/movies.json bozuk olduğu için yerel sağlam dosya korundu (${rMoviesInfo.error}).`,
          });
        } else {
          const remoteMovies = remoteInspect.bundle.movies;
          if (
            localBefore.summary.files['data/catalog/movies.json']?.exists &&
            localBefore.summary.files['data/catalog/movies.json']?.semanticHash ===
              rMoviesInfo.semanticHash
          ) {
            filesUnchanged.push('data/catalog/movies.json');
          } else {
            // Varsayılan silmesiz politika: yereldeki kayıtları da silmeden uzak kayıtlarla birleştir veya uygula
            const mergedMovies =
              conflictStrategy === 'overwrite_with_remote'
                ? {
                    merged: remoteMovies,
                    addedToLocal: Math.max(
                      0,
                      Object.keys(remoteMovies).length - Object.keys(localBefore.movies).length
                    ),
                    updatedLocal: 0,
                  }
                : mergeCatalogMapsLossless(localBefore.movies, remoteMovies, 'movie');
            finalMovies = mergedMovies.merged;
            const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
            writeJsonFileAtomic(moviesPath, stringifyDeterministic(finalMovies), {
              backupPath: `${moviesPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push('data/catalog/movies.json');
          }
        }
      }

      let finalTv = localBefore.tv;
      const rTvInfo = remoteInspect.bundle.summary.files['data/catalog/tv.json'];
      if (rTvInfo?.exists) {
        if (!rTvInfo.valid) {
          filesFailed.push('data/catalog/tv.json');
          errors.push({
            repoPath: 'data/catalog/tv.json',
            category: rTvInfo.errorCategory || 'corrupt_remote_json',
            message: `data/catalog/tv.json bozuk olduğu için yerel sağlam dosya korundu (${rTvInfo.error}).`,
          });
        } else {
          const remoteTv = remoteInspect.bundle.tv;
          if (
            localBefore.summary.files['data/catalog/tv.json']?.exists &&
            localBefore.summary.files['data/catalog/tv.json']?.semanticHash === rTvInfo.semanticHash
          ) {
            filesUnchanged.push('data/catalog/tv.json');
          } else {
            const mergedTv =
              conflictStrategy === 'overwrite_with_remote'
                ? {
                    merged: remoteTv,
                    addedToLocal: Math.max(
                      0,
                      Object.keys(remoteTv).length - Object.keys(localBefore.tv).length
                    ),
                    updatedLocal: 0,
                  }
                : mergeCatalogMapsLossless(localBefore.tv, remoteTv, 'tv');
            finalTv = mergedTv.merged;
            const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
            writeJsonFileAtomic(tvPath, stringifyDeterministic(finalTv), {
              backupPath: `${tvPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push('data/catalog/tv.json');
          }
        }
      }

      // Manifest doğrulaması ve yerel manifest güncellemesi
      const rManifestInfo = remoteInspect.bundle.summary.files['data/catalog/manifest.json'];
      if (rManifestInfo?.exists && !rManifestInfo.valid) {
        warnings.push(
          `GitHub manifest.json tutarsız bulundu (${rManifestInfo.error}); yerel manifest gerçek katalog sayılarıyla doğrulandı.`
        );
      }
      const computedCatalogHash = computeCatalogManifestContentHash(finalMovies, finalTv);
      const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
      const existingLocalManifest = localBefore.manifest;
      if (
        existingLocalManifest &&
        existingLocalManifest.movieCount === Object.keys(finalMovies).length &&
        existingLocalManifest.tvCount === Object.keys(finalTv).length &&
        existingLocalManifest.contentHash === computedCatalogHash
      ) {
        if (rManifestInfo?.exists && rManifestInfo.valid) {
          filesUnchanged.push('data/catalog/manifest.json');
        }
      } else if (Object.keys(finalMovies).length > 0 || Object.keys(finalTv).length > 0 || rManifestInfo?.exists) {
        const nextManifest: CatalogManifest = {
          version: 1,
          updatedAt:
            remoteInspect.bundle.manifest?.contentHash === computedCatalogHash &&
            remoteInspect.bundle.manifest?.updatedAt
              ? remoteInspect.bundle.manifest.updatedAt
              : new Date().toISOString(),
          movieCount: Object.keys(finalMovies).length,
          tvCount: Object.keys(finalTv).length,
          contentHash: computedCatalogHash,
        };
        writeJsonFileAtomic(manifestPath, stringifyDeterministic(nextManifest), {
          backupPath: `${manifestPath}.bak`,
          validateParsed: isPlainObject,
        });
        if (rManifestInfo?.exists && rManifestInfo.valid) {
          filesDownloaded.push('data/catalog/manifest.json');
        }
      }

      // Kişisel dosyalar (cinetrack-data.json ve data/profiles/*.json)
      let finalUserData = localBefore.userData;
      if (includePersonal) {
        const rUserInfo = remoteInspect.bundle.summary.files['data/cinetrack-data.json'];
        if (rUserInfo?.exists) {
          if (!rUserInfo.valid || !remoteInspect.bundle.userData) {
            filesFailed.push('data/cinetrack-data.json');
            errors.push({
              repoPath: 'data/cinetrack-data.json',
              category: rUserInfo.errorCategory || 'corrupt_remote_json',
              message: `data/cinetrack-data.json bozuk olduğu için yerel kullanıcı verisi korundu (${rUserInfo.error}).`,
            });
          } else if (
            localBefore.summary.userDataPresent &&
            localBefore.summary.userDataSemanticHash === rUserInfo.semanticHash
          ) {
            filesUnchanged.push('data/cinetrack-data.json');
          } else {
            let docToWrite: DataDocument;
            if (
              conflictStrategy === 'merge' &&
              localBefore.userData &&
              localBefore.userData.profiles.length > 0
            ) {
              const mergedUser = reconcileUserDataDocumentsLossless(
                localBefore.userData,
                remoteInspect.bundle.userData
              );
              docToWrite = mergedUser.mergedDoc;
              conflicts.push(...mergedUser.conflicts);
              filesMerged.push('data/cinetrack-data.json');
            } else {
              docToWrite = remoteInspect.bundle.userData;
            }

            const saveRes = await this.deps.storage.applySyncedDocumentSerialized(docToWrite);
            if (saveRes.ok) {
              finalUserData = saveRes.document;
              updatedDataDocument = saveRes.document;
              serverRevision = saveRes.document.revision;
              filesDownloaded.push('data/cinetrack-data.json');
            } else {
              filesFailed.push('data/cinetrack-data.json');
              errors.push({
                repoPath: 'data/cinetrack-data.json',
                category: 'corrupt_local_file',
                message: saveRes.message,
              });
            }
          }
        }

        // data/stock.json indirme (yerel eksik/bozuksa indirilir; yerel güncel yükleme korunur)
        const rStockInfo = remoteInspect.bundle.summary.files['data/stock.json'];
        const lStockInfo = localBefore.summary.files['data/stock.json'];
        if (rStockInfo?.exists) {
          if (!rStockInfo.valid) {
            filesFailed.push('data/stock.json');
            errors.push({
              repoPath: 'data/stock.json',
              category: rStockInfo.errorCategory || 'corrupt_remote_json',
              message: `data/stock.json bozuk olduğu için yerel stok korundu (${rStockInfo.error}).`,
            });
          } else if (lStockInfo?.exists && lStockInfo.valid) {
            if (lStockInfo.semanticHash === rStockInfo.semanticHash) {
              filesUnchanged.push('data/stock.json');
            } else {
              warnings.push(
                'data/stock.json: Yerel stok havuzu GitHub sürümünden farklı; yerel (en güncel istemci yüklemesi) korundu.'
              );
            }
          } else {
            const rawStock = remoteInspect.rawRemoteContents['data/stock.json'];
            if (rawStock) {
              try {
                const parsedStock = JSON.parse(rawStock.content);
                const stockTargetPath = path.join(this.deps.dataDir, 'stock.json');
                writeJsonFileAtomic(stockTargetPath, JSON.stringify(parsedStock, null, 2), {
                  backupPath: `${stockTargetPath}.bak`,
                  validateParsed: isPlainObject,
                });
                filesDownloaded.push('data/stock.json');
              } catch {
                filesFailed.push('data/stock.json');
                errors.push({
                  repoPath: 'data/stock.json',
                  category: 'corrupt_remote_json',
                  message: 'data/stock.json GitHub içeriği ayrıştırılamadı.',
                });
              }
            }
          }
        }

        // data/sinema-kunyesi.json indirme ve çakışan künye kayıtlarını kayıpsız birleştirme
        const rKunyeInfo = remoteInspect.bundle.summary.files['data/sinema-kunyesi.json'];
        const lKunyeInfo = localBefore.summary.files['data/sinema-kunyesi.json'];
        if (rKunyeInfo?.exists) {
          if (!rKunyeInfo.valid || !remoteInspect.bundle.cinemaKunye) {
            filesFailed.push('data/sinema-kunyesi.json');
            errors.push({
              repoPath: 'data/sinema-kunyesi.json',
              category: rKunyeInfo.errorCategory || 'corrupt_remote_json',
              message: `data/sinema-kunyesi.json bozuk olduğu için yerel künye verisi korundu (${rKunyeInfo.error}).`,
            });
          } else if (
            lKunyeInfo?.exists &&
            lKunyeInfo.valid &&
            lKunyeInfo.semanticHash === rKunyeInfo.semanticHash
          ) {
            filesUnchanged.push('data/sinema-kunyesi.json');
          } else {
            const kunyeTargetPath = path.join(this.deps.dataDir, 'sinema-kunyesi.json');
            const localKunye = localBefore.cinemaKunye;
            const remoteKunye = remoteInspect.bundle.cinemaKunye;
            const nextKunye =
              conflictStrategy === 'overwrite_with_remote' || !localKunye
                ? remoteKunye
                : mergeCinemaKunyeDocumentsLossless(localKunye, remoteKunye);
            writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(nextKunye), {
              backupPath: `${kunyeTargetPath}.bak`,
              validateParsed: isPlainObject,
            });
            if (localKunye && conflictStrategy !== 'overwrite_with_remote') {
              filesMerged.push('data/sinema-kunyesi.json');
            }
            filesDownloaded.push('data/sinema-kunyesi.json');
          }
        }

        // data/profiles/*.json indirme ve doğrulama
        for (const [repoPath, rFileInfo] of Object.entries(remoteInspect.bundle.summary.files)) {
          if (rFileInfo.category !== 'derived_profile' || !rFileInfo.exists) continue;
          if (!rFileInfo.valid) {
            filesFailed.push(repoPath);
            errors.push({
              repoPath,
              category: rFileInfo.errorCategory || 'corrupt_remote_json',
              message: `${repoPath} bozuk olduğu için yerel dosya korundu (${rFileInfo.error}).`,
            });
            continue;
          }
          const remoteProfDoc = remoteInspect.bundle.derivedProfiles[repoPath];
          if (!remoteProfDoc) continue;

          const matchingProfile = finalUserData?.profiles?.find(
            (p) => normalizeProfileId(p.id) === normalizeProfileId(remoteProfDoc.profileId)
          );
          const freshness = isDerivedDocFreshForContext(
            remoteProfDoc,
            computedCatalogHash,
            matchingProfile
          );
          if (!freshness.valid) {
            warnings.push(
              `${repoPath}: Uzak türetilmiş profil eski/uyumsuz olduğu için geçerli sayılmadı (${freshness.reason}).`
            );
            if (matchingProfile) {
              const regenerated = buildFreshDerivedProfileDocumentOnServer(
                matchingProfile,
                finalMovies,
                finalTv,
                computedCatalogHash
              );
              const targetFile = this.deps.store.getProfileFilePath(matchingProfile.id);
              writeJsonFileAtomic(targetFile, stringifyDeterministic(regenerated), {
                backupPath: `${targetFile}.bak`,
                validateParsed: isPlainObject,
              });
            }
            continue;
          }

          const localProfInfo = localBefore.summary.files[repoPath];
          if (localProfInfo?.exists && localProfInfo.semanticHash === rFileInfo.semanticHash) {
            filesUnchanged.push(repoPath);
            continue;
          }

          const safeFileName = `${sanitizeProfileId(remoteProfDoc.profileId)}.json`;
          const targetPath = path.join(this.deps.dataDir, 'profiles', safeFileName);
          mkdirSync(path.dirname(targetPath), { recursive: true });
          writeJsonFileAtomic(targetPath, stringifyDeterministic(remoteProfDoc), {
            backupPath: `${targetPath}.bak`,
            validateParsed: isPlainObject,
          });
          filesDownloaded.push(repoPath);
        }
      }

      // Yeniden yerel durumu oku ve gerçek uzak durumla karşılaştır (Spec Bölüm 4.9 & Bölüm 7)
      const localAfter = await this.inspectLocalSide();
      const postComparison = compareSyncSides(localAfter, remoteInspect.bundle, {
        includePersonalFiles: includePersonal,
        includeCatalogFiles: includeCatalog,
      });

      const ok = errors.length === 0 && localAfter.errors.length === 0;
      const partialFailure =
        !ok && (filesDownloaded.length > 0 || filesUnchanged.length > 0) && filesFailed.length > 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      // B-39: sayaçlar ad hoc artışlardan değil, işlem öncesi/sonrası gerçek
      // belgelerden türetilir. Türetilmiş profil önbelleği sayılmaz.
      const recordCounts = buildBidirectionalSyncCounters({
        localBefore,
        localAfter,
        remoteBefore: remoteInspect.bundle,
        remoteAfter: remoteInspect.bundle,
      });

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure,
        operation: 'pull',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteInspect.bundle.summary,
        localAfter: localAfter.summary,
        remoteAfter: remoteInspect.bundle.summary,
        comparison: postComparison,
        filesDownloaded,
        filesUploaded: [],
        filesUnchanged,
        filesMerged,
        filesFailed,
        filesPending: postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
        recordsAdded: recordCounts.added,
        recordsUpdated: recordCounts.updated,
        recordsSkipped: recordCounts.skipped,
        recordsConflicted: conflicts.length,
        conflicts,
        warnings,
        errors: [...errors, ...localAfter.errors],
        verifiedEqual,
        ...(updatedDataDocument ? { updatedDataDocument } : {}),
        ...(serverRevision !== undefined ? { serverRevision } : {}),
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteInspect.bundle.summary,
        lastComparison: postComparison,
      });

      return report;
      }
    );
  }

  /**
   * 3. PUSH: Yerel dosyaların geçerliliğini doğrulayıp GitHub'a yükler,
   * ardından uzak dosyaları yeniden okuyarak hash ve kayıt sayılarını doğrular (`verifiedEqual`).
   */
  public async push(): Promise<BidirectionalSyncReport> {
    return this.runSerialized(
      'push',
      async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = await this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return createGithubSyncUnconfiguredReport(
          'push',
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
        const failedReport: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'push',
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
        this.deps.onSyncCompleted?.({
          report: failedReport,
          lastRemoteSummary: null,
          lastComparison: null,
        });
        return failedReport;
      }
      const visibility = {
        effectiveIsPublicRepo: access.effectiveIsPublicRepo,
        warning: access.warning,
      };
      const includePersonal = !visibility.effectiveIsPublicRepo || allowPersonalOnPublic;
      const includeCatalog = !visibility.effectiveIsPublicRepo || allowCatalogOnPublic;
      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);

      // Yerel manifest tutarsızsa ve katalog dosyaları sağlamsa önce yerel manifest'i onar
      const moviesValid = localBefore.summary.files['data/catalog/movies.json']?.valid !== false;
      const tvValid = localBefore.summary.files['data/catalog/tv.json']?.valid !== false;
      if (includeCatalog && moviesValid && tvValid && !localBefore.summary.manifestValid) {
        const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
        const repairedManifest: CatalogManifest = {
          version: 1,
          updatedAt: new Date().toISOString(),
          movieCount: Object.keys(localBefore.movies).length,
          tvCount: Object.keys(localBefore.tv).length,
          contentHash: computeCatalogManifestContentHash(localBefore.movies, localBefore.tv),
        };
        writeJsonFileAtomic(manifestPath, stringifyDeterministic(repairedManifest), {
          backupPath: `${manifestPath}.bak`,
          validateParsed: isPlainObject,
        });
        warnings.push(
          `Yerel manifest.json sayım/hash uyumsuzluğu gönderim öncesinde düzeltildi (${
            localBefore.summary.manifestMismatchReason || 'yeniden üretildi'
          }).`
        );
      }

      let localReady = await this.inspectLocalSide();
      let localProfilePaths = Object.keys(localReady.derivedProfiles);

      const activeBeforeToken = this.deps.getGitHubConfig().token || cfg.token;
      const remoteBeforeInspect = await this.inspectRemoteSide(
        { token: activeBeforeToken, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          includeCatalogFiles: includeCatalog,
          localProfilePaths,
        }
      );

      // Push sırasında GitHub'da mevcut kullanıcı listesi varsa üzerine yazmak yerine kayıpsız birleştir!
      const pushFilesMerged: string[] = [];
      const pushConflicts: UserDataConflictItem[] = [];
      let pushUpdatedDataDocument: DataDocument | undefined;
      let pushServerRevision: number | undefined;

      if (
        includePersonal &&
        !remoteBeforeInspect.transportFailed &&
        remoteBeforeInspect.bundle.userData &&
        remoteBeforeInspect.bundle.summary.files['data/cinetrack-data.json']?.valid &&
        localReady.summary.files['data/cinetrack-data.json']?.valid !== false
      ) {
        if (localReady.userData) {
          if (
            localReady.summary.userDataSemanticHash !==
            remoteBeforeInspect.bundle.summary.userDataSemanticHash
          ) {
            await this.deps.storage.createSafetySnapshotSerialized();
            const mergedUser = reconcileUserDataDocumentsLossless(
              localReady.userData,
              remoteBeforeInspect.bundle.userData
            );
            const saveRes = await this.deps.storage.applySyncedDocumentSerialized(
              mergedUser.mergedDoc
            );
            if (saveRes.ok) {
              pushUpdatedDataDocument = saveRes.document;
              pushServerRevision = saveRes.document.revision;
              pushConflicts.push(...mergedUser.conflicts);
              if (mergedUser.addedToLocal > 0 || mergedUser.updatedItems > 0) {
                pushFilesMerged.push('data/cinetrack-data.json');
              }
              localReady = await this.inspectLocalSide();
              localProfilePaths = Object.keys(localReady.derivedProfiles);
            }
          }
        } else {
          // Yerelde henüz cinetrack-data.json yok ama GitHub'da var: uzak veriyi koru
          const saveRes = await this.deps.storage.applySyncedDocumentSerialized(
            remoteBeforeInspect.bundle.userData
          );
          if (saveRes.ok) {
            pushUpdatedDataDocument = saveRes.document;
            pushServerRevision = saveRes.document.revision;
            localReady = await this.inspectLocalSide();
            localProfilePaths = Object.keys(localReady.derivedProfiles);
          }
        }
      }

      if (
        includePersonal &&
        !remoteBeforeInspect.transportFailed &&
        remoteBeforeInspect.bundle.cinemaKunye &&
        remoteBeforeInspect.bundle.summary.files['data/sinema-kunyesi.json']?.valid &&
        localReady.summary.files['data/sinema-kunyesi.json']?.valid !== false
      ) {
        const kunyeTargetPath = path.join(this.deps.dataDir, 'sinema-kunyesi.json');
        const rKunyeHash =
          remoteBeforeInspect.bundle.summary.files['data/sinema-kunyesi.json']?.semanticHash;
        const lKunyeHash = localReady.summary.files['data/sinema-kunyesi.json']?.semanticHash;
        if (localReady.cinemaKunye) {
          if (lKunyeHash !== rKunyeHash) {
            const mergedKunye = mergeCinemaKunyeDocumentsLossless(
              localReady.cinemaKunye,
              remoteBeforeInspect.bundle.cinemaKunye
            );
            writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(mergedKunye), {
              backupPath: `${kunyeTargetPath}.bak`,
              validateParsed: isPlainObject,
            });
            pushFilesMerged.push('data/sinema-kunyesi.json');
            localReady = await this.inspectLocalSide();
          }
        } else {
          writeJsonFileAtomic(
            kunyeTargetPath,
            stringifyDeterministic(remoteBeforeInspect.bundle.cinemaKunye),
            {
              backupPath: `${kunyeTargetPath}.bak`,
              validateParsed: isPlainObject,
            }
          );
          localReady = await this.inspectLocalSide();
        }
      }

      const verifiedRemoteHashes: Record<string, string | null> = {};
      for (const [repoPath, rawObj] of Object.entries(remoteBeforeInspect.rawRemoteContents)) {
        const rFile = remoteBeforeInspect.bundle.summary.files[repoPath];
        if (rFile?.exists && rFile.valid) {
          verifiedRemoteHashes[repoPath] = hashContent(rawObj.content.trim());
        } else {
          verifiedRemoteHashes[repoPath] = null;
        }
      }

      // Gönderim öncesi yerel bozuk dosyalar dışındaki dosyaları GitHub'a gönder (uzakta zaten doğrulanmış eşit dosyaları yeniden yazmaz)
      const syncRes = await this.deps.store.syncToGitHub({
        verifiedRemoteHashes,
        allowPersonalDataInPublicRepo: includePersonal,
        allowCatalogInPublicRepo: includeCatalog,
      });
      const pushErrors: SyncErrorRecord[] = [...localReady.errors];
      for (const failedPath of syncRes.filesFailed) {
        const st = syncRes.fileStates[failedPath];
        if (!pushErrors.some((e) => e.repoPath === failedPath)) {
          pushErrors.push({
            repoPath: failedPath,
            category: (st?.errorCategory as SyncErrorCategory) || 'http_error',
            message: st?.error || `${failedPath} yüklenemedi.`,
          });
        }
      }
      if (!syncRes.ok && pushErrors.length === 0 && syncRes.errors.length > 0) {
        for (const msg of syncRes.errors) {
          pushErrors.push({ category: 'http_error', message: msg });
        }
      }

      // Push tamamlandıktan sonra uzak dosyaları YENİDEN oku ve doğrula (Spec Bölüm 2 & 5.6)
      const activeAfterToken = this.deps.getGitHubConfig().token || activeBeforeToken;
      const remoteAfterInspect = await this.inspectRemoteSide(
        { token: activeAfterToken, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          includeCatalogFiles: includeCatalog,
          localProfilePaths,
        }
      );

      for (const reErr of remoteAfterInspect.bundle.errors) {
        if (!pushErrors.some((e) => e.repoPath === reErr.repoPath && e.message === reErr.message)) {
          pushErrors.push(reErr);
        }
      }

      const postComparison = compareSyncSides(localReady, remoteAfterInspect.bundle, {
        includePersonalFiles: includePersonal,
        includeCatalogFiles: includeCatalog,
      });

      const ok =
        syncRes.ok &&
        !remoteAfterInspect.transportFailed &&
        pushErrors.length === 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      // B-39: pull/push/reconcile aynı otoriteyi kullanır (bkz. sync-counters.ts).
      const recordCounts = buildBidirectionalSyncCounters({
        localBefore,
        localAfter: localReady,
        remoteBefore: remoteBeforeInspect.bundle,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle,
      });

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure: syncRes.partialFailure,
        operation: 'push',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteBeforeInspect.transportFailed ? null : remoteBeforeInspect.bundle.summary,
        localAfter: localReady.summary,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle.summary,
        comparison: remoteAfterInspect.transportFailed ? null : postComparison,
        filesDownloaded: [],
        filesUploaded: syncRes.filesCommitted,
        filesUnchanged: syncRes.filesSkipped,
        filesMerged: pushFilesMerged,
        filesFailed: syncRes.filesFailed,
        filesPending: remoteAfterInspect.transportFailed
          ? []
          : postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: syncRes.filesBlockedPublic,
        recordsAdded: recordCounts.added,
        recordsUpdated: recordCounts.updated,
        recordsSkipped: recordCounts.skipped,
        recordsConflicted: pushConflicts.length,
        conflicts: pushConflicts,
        warnings,
        errors: pushErrors,
        verifiedEqual,
        ...(pushUpdatedDataDocument ? { updatedDataDocument: pushUpdatedDataDocument } : {}),
        ...(pushServerRevision !== undefined ? { serverRevision: pushServerRevision } : {}),
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
      }
    );
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
    return this.runSerialized(
      'reconcile',
      async () => {
      const startedAt = new Date().toISOString();
      const cfg = this.deps.getGitHubConfig();
      const localBefore = await this.inspectLocalSide();
      const remoteTarget =
        cfg.owner && cfg.repo
          ? { owner: cfg.owner, repo: cfg.repo, branch: cfg.branch }
          : undefined;

      if (!cfg.token || !cfg.owner || !cfg.repo) {
        return createGithubSyncUnconfiguredReport(
          'reconcile',
          startedAt,
          localBefore.summary,
          cfg.isPublicRepo,
          remoteTarget
        );
      }

      const allowPersonalOnPublic =
        options.includePersonalOverride !== undefined
          ? options.includePersonalOverride
          : cfg.allowPublicPersonalSync !== undefined
            ? cfg.allowPublicPersonalSync
            : Boolean(cfg.isPublicRepo);
      const allowCatalogOnPublic =
        options.includeCatalogOverride !== undefined
          ? options.includeCatalogOverride
          : Boolean(cfg.allowPublicCatalogSync);
      const access = await this.deps.store.verifyRemoteRepoAccess();
      if (!access.ok) {
        const report: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'reconcile',
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
        this.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: null,
          lastComparison: null,
        });
        return report;
      }
      const visibility = {
        effectiveIsPublicRepo: access.effectiveIsPublicRepo,
        warning: access.warning,
      };
      const includePersonal =
        options.includePersonalOverride !== undefined
          ? options.includePersonalOverride
          : !visibility.effectiveIsPublicRepo || allowPersonalOnPublic;
      const includeCatalog =
        options.includeCatalogOverride !== undefined
          ? options.includeCatalogOverride
          : !visibility.effectiveIsPublicRepo || allowCatalogOnPublic;
      const localProfilePaths = Object.keys(localBefore.derivedProfiles);

      const activeBeforeToken = this.deps.getGitHubConfig().token || cfg.token;
      const remoteBeforeInspect = await this.inspectRemoteSide(
        { token: activeBeforeToken, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          includeCatalogFiles: includeCatalog,
          localProfilePaths,
        }
      );

      const warnings: string[] = [];
      if (visibility.warning) warnings.push(visibility.warning);

      // Ağ/yetki/rate-limit hatası varsa hiçbir veriyi değiştirmeden durdur
      if (remoteBeforeInspect.transportFailed) {
        const report: BidirectionalSyncReport = {
          ok: false,
          partialFailure: false,
          operation: 'reconcile',
          startedAt,
          completedAt: new Date().toISOString(),
          remoteTarget,
          isPublicRepo: visibility.effectiveIsPublicRepo,
          ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
          localBefore: localBefore.summary,
          remoteBefore: remoteBeforeInspect.bundle.summary,
          localAfter: localBefore.summary,
          remoteAfter: remoteBeforeInspect.bundle.summary,
          comparison: null,
          filesDownloaded: [],
          filesUploaded: [],
          filesUnchanged: [],
          filesMerged: [],
          filesFailed: remoteBeforeInspect.bundle.errors
            .map((e) => e.repoPath)
            .filter(Boolean) as string[],
          filesPending: [],
          filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
          recordsAdded: 0,
          recordsUpdated: 0,
          recordsConflicted: 0,
          conflicts: [],
          warnings,
          errors: remoteBeforeInspect.bundle.errors,
          verifiedEqual: false,
        };
        this.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: remoteBeforeInspect.bundle.summary,
          lastComparison: null,
        });
        return report;
      }

      // Yerel güvenlik yedeği al
      await this.deps.storage.createSafetySnapshotSerialized();

      const filesDownloaded: string[] = [];
      const filesUploaded: string[] = [];
      const filesUnchanged: string[] = [];
      const filesMerged: string[] = [];
      const filesFailed: string[] = [];
      const errors: SyncErrorRecord[] = [];
      const conflicts: UserDataConflictItem[] = [];
      let updatedDataDocument: DataDocument | undefined;
      let serverRevision: number | undefined;

      const pathsBlockedFromPush = new Set<string>();

      // --- A. KATALOG İKİ YÖNLÜ BİRLEŞTİRME ---
      let reconciledMovies = localBefore.movies;
      let reconciledTv = localBefore.tv;

      if (includeCatalog) {
        const lMoviesInfo = localBefore.summary.files['data/catalog/movies.json'];
        const rMoviesInfo = remoteBeforeInspect.bundle.summary.files['data/catalog/movies.json'];

        if (!lMoviesInfo.valid) {
          filesFailed.push('data/catalog/movies.json');
          pathsBlockedFromPush.add('data/catalog/movies.json');
          errors.push({
            repoPath: 'data/catalog/movies.json',
            category: 'corrupt_local_file',
            message: `Yerel movies.json bozuk olduğu için birleştirilmedi (${lMoviesInfo.error}).`,
          });
        } else if (rMoviesInfo?.exists && !rMoviesInfo.valid) {
          filesFailed.push('data/catalog/movies.json');
          pathsBlockedFromPush.add('data/catalog/movies.json');
          errors.push({
            repoPath: 'data/catalog/movies.json',
            category: rMoviesInfo.errorCategory || 'corrupt_remote_json',
            message: `GitHub movies.json bozuk olduğu için yerel sağlam dosya korundu (${rMoviesInfo.error}).`,
          });
        } else {
          const movieMerge = mergeCatalogMapsLossless(
            localBefore.movies,
            remoteBeforeInspect.bundle.movies,
            'movie'
          );
          reconciledMovies = movieMerge.merged;

          const serializedMergedMovies = stringifyDeterministic(reconciledMovies);
          const moviesPath = path.join(this.deps.dataDir, 'catalog', 'movies.json');
          const localRawMatches =
            lMoviesInfo.exists &&
            lMoviesInfo.rawFileHash === computeRawUtf8Hash(serializedMergedMovies);

          if (
            !localRawMatches &&
            (Object.keys(reconciledMovies).length > 0 ||
              lMoviesInfo.exists ||
              Boolean(rMoviesInfo?.exists))
          ) {
            writeJsonFileAtomic(moviesPath, serializedMergedMovies, {
              backupPath: `${moviesPath}.bak`,
              validateParsed: isPlainObject,
            });
            if (movieMerge.addedToLocal > 0 && movieMerge.addedToRemote > 0) {
              filesMerged.push('data/catalog/movies.json');
            } else if (
              movieMerge.addedToLocal > 0 ||
              movieMerge.updatedLocal > 0 ||
              (!lMoviesInfo.exists && rMoviesInfo?.exists)
            ) {
              filesDownloaded.push('data/catalog/movies.json');
            }
          }
        }

        const lTvInfo = localBefore.summary.files['data/catalog/tv.json'];
        const rTvInfo = remoteBeforeInspect.bundle.summary.files['data/catalog/tv.json'];

        if (!lTvInfo.valid) {
          filesFailed.push('data/catalog/tv.json');
          pathsBlockedFromPush.add('data/catalog/tv.json');
          errors.push({
            repoPath: 'data/catalog/tv.json',
            category: 'corrupt_local_file',
            message: `Yerel tv.json bozuk olduğu için birleştirilmedi (${lTvInfo.error}).`,
          });
        } else if (rTvInfo?.exists && !rTvInfo.valid) {
          filesFailed.push('data/catalog/tv.json');
          pathsBlockedFromPush.add('data/catalog/tv.json');
          errors.push({
            repoPath: 'data/catalog/tv.json',
            category: rTvInfo.errorCategory || 'corrupt_remote_json',
            message: `GitHub tv.json bozuk olduğu için yerel sağlam dosya korundu (${rTvInfo.error}).`,
          });
        } else {
          const tvMerge = mergeCatalogMapsLossless(
            localBefore.tv,
            remoteBeforeInspect.bundle.tv,
            'tv'
          );
          reconciledTv = tvMerge.merged;

          const serializedMergedTv = stringifyDeterministic(reconciledTv);
          const tvPath = path.join(this.deps.dataDir, 'catalog', 'tv.json');
          const localTvRawMatches =
            lTvInfo.exists && lTvInfo.rawFileHash === computeRawUtf8Hash(serializedMergedTv);

          if (
            !localTvRawMatches &&
            (Object.keys(reconciledTv).length > 0 || lTvInfo.exists || Boolean(rTvInfo?.exists))
          ) {
            writeJsonFileAtomic(tvPath, serializedMergedTv, {
              backupPath: `${tvPath}.bak`,
              validateParsed: isPlainObject,
            });
            if (tvMerge.addedToLocal > 0 && tvMerge.addedToRemote > 0) {
              filesMerged.push('data/catalog/tv.json');
            } else if (
              tvMerge.addedToLocal > 0 ||
              tvMerge.updatedLocal > 0 ||
              (!lTvInfo.exists && rTvInfo?.exists)
            ) {
              filesDownloaded.push('data/catalog/tv.json');
            }
          }
        }
      }

      // Manifest yeniden üretimi (eğer katalog senkronizasyonu izinli ve katalog dosyalarından biri bozuk değilse)
      const reconciledCatalogHash = computeCatalogManifestContentHash(
        reconciledMovies,
        reconciledTv
      );
      if (
        includeCatalog &&
        !pathsBlockedFromPush.has('data/catalog/movies.json') &&
        !pathsBlockedFromPush.has('data/catalog/tv.json')
      ) {
        if (localBefore.summary.manifestMismatchReason) {
          warnings.push(
            `Yerel manifest.json tutarsızlığı düzeltildi: ${localBefore.summary.manifestMismatchReason}`
          );
        }
        if (remoteBeforeInspect.bundle.summary.manifestMismatchReason) {
          warnings.push(
            `GitHub manifest.json tutarsızlığı düzeltildi: ${remoteBeforeInspect.bundle.summary.manifestMismatchReason}`
          );
        }

        const movieCount = Object.keys(reconciledMovies).length;
        const tvCount = Object.keys(reconciledTv).length;
        const hasAnyCatalog =
          movieCount > 0 ||
          tvCount > 0 ||
          localBefore.summary.manifestPresent ||
          remoteBeforeInspect.bundle.summary.manifestPresent;

        if (hasAnyCatalog) {
          // Idempotent zaman damgası: sayılar ve contentHash aynıysa mevcut updatedAt'i koru
          const reusableUpdatedAt =
            localBefore.manifest &&
            localBefore.manifest.movieCount === movieCount &&
            localBefore.manifest.tvCount === tvCount &&
            localBefore.manifest.contentHash === reconciledCatalogHash
              ? localBefore.manifest.updatedAt
              : remoteBeforeInspect.bundle.manifest &&
                remoteBeforeInspect.bundle.manifest.movieCount === movieCount &&
                remoteBeforeInspect.bundle.manifest.tvCount === tvCount &&
                remoteBeforeInspect.bundle.manifest.contentHash === reconciledCatalogHash
              ? remoteBeforeInspect.bundle.manifest.updatedAt
              : new Date().toISOString();

          const manifestObj: CatalogManifest = {
            version: 1,
            updatedAt: reusableUpdatedAt,
            movieCount,
            tvCount,
            contentHash: reconciledCatalogHash,
          };
          const serializedManifest = stringifyDeterministic(manifestObj);
          const manifestPath = path.join(this.deps.dataDir, 'catalog', 'manifest.json');
          if (
            !localBefore.summary.manifestPresent ||
            localBefore.summary.files['data/catalog/manifest.json']?.rawFileHash !==
              computeRawUtf8Hash(serializedManifest)
          ) {
            writeJsonFileAtomic(manifestPath, serializedManifest, {
              backupPath: `${manifestPath}.bak`,
              validateParsed: isPlainObject,
            });
          }
        }
      } else {
        pathsBlockedFromPush.add('data/catalog/manifest.json');
      }

      // --- B. KULLANICI VERİSİ (`data/cinetrack-data.json`) İKİ YÖNLÜ BİRLEŞTİRME ---
      let reconciledUserData: DataDocument | null = localBefore.userData;
      if (includePersonal) {
        const lUserInfo = localBefore.summary.files['data/cinetrack-data.json'];
        const rUserInfo = remoteBeforeInspect.bundle.summary.files['data/cinetrack-data.json'];

        if (!lUserInfo.valid) {
          filesFailed.push('data/cinetrack-data.json');
          pathsBlockedFromPush.add('data/cinetrack-data.json');
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: 'corrupt_local_file',
            message: `Yerel cinetrack-data.json bozuk olduğu için birleştirilmedi (${lUserInfo.error}).`,
          });
        } else if (rUserInfo?.exists && !rUserInfo.valid) {
          filesFailed.push('data/cinetrack-data.json');
          pathsBlockedFromPush.add('data/cinetrack-data.json');
          errors.push({
            repoPath: 'data/cinetrack-data.json',
            category: rUserInfo.errorCategory || 'corrupt_remote_json',
            message: `GitHub cinetrack-data.json bozuk olduğu için yerel sağlam dosya korundu (${rUserInfo.error}).`,
          });
        } else if (localBefore.userData && remoteBeforeInspect.bundle.userData) {
          if (lUserInfo.semanticHash !== rUserInfo?.semanticHash) {
            const mergedUser = reconcileUserDataDocumentsLossless(
              localBefore.userData,
              remoteBeforeInspect.bundle.userData
            );
            conflicts.push(...mergedUser.conflicts);

            const saveRes = await this.deps.storage.applySyncedDocumentSerialized(
              mergedUser.mergedDoc
            );
            if (saveRes.ok) {
              reconciledUserData = saveRes.document;
              updatedDataDocument = saveRes.document;
              serverRevision = saveRes.document.revision;
              filesMerged.push('data/cinetrack-data.json');
            } else {
              filesFailed.push('data/cinetrack-data.json');
              pathsBlockedFromPush.add('data/cinetrack-data.json');
              errors.push({
                repoPath: 'data/cinetrack-data.json',
                category: 'corrupt_local_file',
                message: saveRes.message,
              });
            }
          }
        } else if (!localBefore.userData && remoteBeforeInspect.bundle.userData) {
          const remoteDoc = remoteBeforeInspect.bundle.userData;
          const saveRes = await this.deps.storage.applySyncedDocumentSerialized(remoteDoc);
          if (saveRes.ok) {
            reconciledUserData = saveRes.document;
            updatedDataDocument = saveRes.document;
            serverRevision = saveRes.document.revision;
            filesDownloaded.push('data/cinetrack-data.json');
          }
        }

        // --- C. PROFİL BAZLI TÜRETİLMİŞ VERİLER (`data/profiles/*.json`) ---
        const allDerivedPaths = new Set<string>([
          ...Object.keys(localBefore.summary.files).filter(
            (p) => localBefore.summary.files[p]?.category === 'derived_profile'
          ),
          ...Object.keys(remoteBeforeInspect.bundle.summary.files).filter(
            (p) => remoteBeforeInspect.bundle.summary.files[p]?.category === 'derived_profile'
          ),
        ]);

        for (const repoPath of Array.from(allDerivedPaths).sort()) {
          const lInfo = localBefore.summary.files[repoPath];
          const rInfo = remoteBeforeInspect.bundle.summary.files[repoPath];

          if (lInfo?.exists && !lInfo.valid) {
            filesFailed.push(repoPath);
            pathsBlockedFromPush.add(repoPath);
            errors.push({
              repoPath,
              category: 'corrupt_local_file',
              message: `Yerel ${repoPath} bozuk (${lInfo.error}).`,
            });
            continue;
          }
          if (rInfo?.exists && !rInfo.valid) {
            filesFailed.push(repoPath);
            pathsBlockedFromPush.add(repoPath);
            errors.push({
              repoPath,
              category: rInfo.errorCategory || 'corrupt_remote_json',
              message: `GitHub ${repoPath} bozuk olduğu için yerel dosya korundu (${rInfo.error}).`,
            });
            continue;
          }

          const localProf = localBefore.derivedProfiles[repoPath];
          const remoteProf = remoteBeforeInspect.bundle.derivedProfiles[repoPath];
          const profileId = normalizeProfileId(
            localProf?.profileId ||
            remoteProf?.profileId ||
            path.posix.basename(repoPath, '.json')
          ) || '';
          const matchingUserProfile = reconciledUserData?.profiles?.find(
            (p) => normalizeProfileId(p.id) === profileId
          );

          const localFresh = localProf
            ? isDerivedDocFreshForContext(
                localProf,
                reconciledCatalogHash,
                matchingUserProfile
              )
            : { valid: false, reason: 'yok' };
          const remoteFresh = remoteProf
            ? isDerivedDocFreshForContext(
                remoteProf,
                reconciledCatalogHash,
                matchingUserProfile
              )
            : { valid: false, reason: 'yok' };

          // İkisi de geçerli ve içerik özeti aynıysa hiçbir işlem yapma
          if (localProf && remoteProf && localFresh.valid && remoteFresh.valid) {
            if (localProf.contentHash === remoteProf.contentHash) {
              continue;
            }
            // Aynı imza/sürüm altında içerikler farklıysa öğeleri deterministik birleştir
            const combinedItems: Record<string, DerivedProfileItem> = {
              ...remoteProf.items,
              ...localProf.items,
            };
            const nextHash = computeDerivedProfileContentHash({
              schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
              profileId,
              algorithmVersion: localProf.algorithmVersion,
              profileFingerprint: localProf.profileFingerprint,
              sourceCatalogHash: reconciledCatalogHash,
              items: combinedItems,
            });
            const mergedDerived: DerivedProfileDocument = {
              schemaVersion: DERIVED_PROFILE_SCHEMA_VERSION,
              profileId,
              algorithmVersion: localProf.algorithmVersion,
              profileFingerprint: localProf.profileFingerprint,
              sourceCatalogHash: reconciledCatalogHash,
              contentHash: nextHash,
              generatedAt:
                localProf.generatedAt > remoteProf.generatedAt
                  ? localProf.generatedAt
                  : remoteProf.generatedAt,
              items: combinedItems,
            };
            const targetFile = this.deps.store.getProfileFilePath(profileId);
            writeJsonFileAtomic(targetFile, stringifyDeterministic(mergedDerived), {
              backupPath: `${targetFile}.bak`,
              validateParsed: isPlainObject,
            });
            filesMerged.push(repoPath);
            continue;
          }

          if (!localFresh.valid && remoteProf && remoteFresh.valid) {
            if (localProf) {
              warnings.push(
                `${repoPath}: Yerel türetilmiş profil eski/uyumsuz bulundu (${localFresh.reason}); geçerli uzak önbellek alındı.`
              );
            }
            const targetFile = this.deps.store.getProfileFilePath(profileId);
            writeJsonFileAtomic(targetFile, stringifyDeterministic(remoteProf), {
              backupPath: `${targetFile}.bak`,
              validateParsed: isPlainObject,
            });
            filesDownloaded.push(repoPath);
            continue;
          }

          if (localProf && localFresh.valid && !remoteFresh.valid) {
            if (remoteProf) {
              warnings.push(
                `${repoPath}: GitHub'daki türetilmiş profil eski/uyumsuz bulundu (${remoteFresh.reason}); geçerli yerel sürüm korunup yüklenecek.`
              );
            }
            continue;
          }

          // Her iki taraf da güncel profil/algoritma/şema ile uyumsuzsa kaynak veriden yeniden üret!
          if (!localFresh.valid && !remoteFresh.valid) {
            if (matchingUserProfile) {
              warnings.push(
                `${repoPath}: Türetilmiş profil önbelleği güncel profil/algoritma sürümüyle eşleşmediği için kaynak veriden yeniden üretildi.`
              );
              const regenerated = buildFreshDerivedProfileDocumentOnServer(
                matchingUserProfile,
                reconciledMovies,
                reconciledTv,
                reconciledCatalogHash
              );
              const targetFile = this.deps.store.getProfileFilePath(profileId);
              writeJsonFileAtomic(targetFile, stringifyDeterministic(regenerated), {
                backupPath: `${targetFile}.bak`,
                validateParsed: isPlainObject,
              });
              filesMerged.push(repoPath);
            } else {
              // Kaynak profil cinetrack-data.json içinde yoksa eski türetilmiş veriyi geçerli kabul etme!
              warnings.push(
                `${repoPath}: Algoritma/şema sürümü güncel olmayan türetilmiş profil geçersiz sayıldı ve üzerine yazılmadı.`
              );
              pathsBlockedFromPush.add(repoPath);
            }
          }
        }
      }

      // --- C2. STOK DEPOSU (data/stock.json) ---
      if (includePersonal) {
        const stockRepoPath = 'data/stock.json';
        const lStock = localBefore.summary.files[stockRepoPath];
        const rStock = remoteBeforeInspect.bundle.summary.files[stockRepoPath];
        if (lStock?.exists && !lStock.valid) {
          filesFailed.push(stockRepoPath);
          pathsBlockedFromPush.add(stockRepoPath);
          errors.push({
            repoPath: stockRepoPath,
            category: 'corrupt_local_file',
            message: `Yerel ${stockRepoPath} bozuk (${lStock.error}).`,
          });
        } else if (!lStock?.exists && rStock?.exists && rStock.valid) {
          const rawStock = remoteBeforeInspect.rawRemoteContents[stockRepoPath];
          if (rawStock) {
            try {
              const parsedStock = JSON.parse(rawStock.content);
              const stockTargetPath = path.join(this.deps.dataDir, 'stock.json');
              writeJsonFileAtomic(stockTargetPath, JSON.stringify(parsedStock, null, 2), {
                backupPath: `${stockTargetPath}.bak`,
                validateParsed: isPlainObject,
              });
              filesDownloaded.push(stockRepoPath);
            } catch {
              filesFailed.push(stockRepoPath);
              errors.push({
                repoPath: stockRepoPath,
                category: 'corrupt_remote_json',
                message: 'data/stock.json GitHub içeriği ayrıştırılamadı.',
              });
            }
          }
        } else if (lStock?.exists && rStock?.exists && lStock.valid && !rStock.valid) {
          warnings.push(
            `data/stock.json: GitHub sürümü bozuk/tekrarlı kayıt içerdiği için yerel stok korunup yüklenecek (${rStock.error}).`
          );
        }

        // --- C3. SİNEMA KÜNYESİ (`data/sinema-kunyesi.json`) İKİ YÖNLÜ KAYIPSIZ BİRLEŞTİRME ---
        const kunyeRepoPath = 'data/sinema-kunyesi.json';
        const lKunye = localBefore.summary.files[kunyeRepoPath];
        const rKunye = remoteBeforeInspect.bundle.summary.files[kunyeRepoPath];
        if (lKunye?.exists && !lKunye.valid) {
          filesFailed.push(kunyeRepoPath);
          pathsBlockedFromPush.add(kunyeRepoPath);
          errors.push({
            repoPath: kunyeRepoPath,
            category: 'corrupt_local_file',
            message: `Yerel ${kunyeRepoPath} bozuk olduğu için birleştirilmedi (${lKunye.error}).`,
          });
        } else if (rKunye?.exists && !rKunye.valid) {
          filesFailed.push(kunyeRepoPath);
          pathsBlockedFromPush.add(kunyeRepoPath);
          errors.push({
            repoPath: kunyeRepoPath,
            category: rKunye.errorCategory || 'corrupt_remote_json',
            message: `GitHub ${kunyeRepoPath} bozuk olduğu için yerel sağlam dosya korundu (${rKunye.error}).`,
          });
        } else if (localBefore.cinemaKunye && remoteBeforeInspect.bundle.cinemaKunye) {
          if (lKunye?.semanticHash !== rKunye?.semanticHash) {
            const mergedKunye = mergeCinemaKunyeDocumentsLossless(
              localBefore.cinemaKunye,
              remoteBeforeInspect.bundle.cinemaKunye
            );
            const kunyeTargetPath = path.join(this.deps.dataDir, 'sinema-kunyesi.json');
            writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(mergedKunye), {
              backupPath: `${kunyeTargetPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesMerged.push(kunyeRepoPath);
          }
        } else if (!localBefore.cinemaKunye && remoteBeforeInspect.bundle.cinemaKunye) {
          const remoteKunye = remoteBeforeInspect.bundle.cinemaKunye;
          const kunyeTargetPath = path.join(this.deps.dataDir, 'sinema-kunyesi.json');
          writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(remoteKunye), {
            backupPath: `${kunyeTargetPath}.bak`,
            validateParsed: isPlainObject,
          });
          filesDownloaded.push(kunyeRepoPath);
        }
      }

      // --- D. BİRLEŞTİRİLMİŞ GÜNCEL YEREL DOSYALARI GITHUB'A YÜKLE ---
      const localPrepared = await this.inspectLocalSide();
      const uploadCandidates: Array<{ repoPath: string; localPath: string; commitMsg: string }> = [];

      if (includeCatalog) {
        uploadCandidates.push(
          {
            repoPath: 'data/catalog/movies.json',
            localPath: path.join(this.deps.dataDir, 'catalog', 'movies.json'),
            commitMsg: 'chore(sync): reconcile movies.json [skip ci]',
          },
          {
            repoPath: 'data/catalog/tv.json',
            localPath: path.join(this.deps.dataDir, 'catalog', 'tv.json'),
            commitMsg: 'chore(sync): reconcile tv.json [skip ci]',
          },
          {
            repoPath: 'data/catalog/manifest.json',
            localPath: path.join(this.deps.dataDir, 'catalog', 'manifest.json'),
            commitMsg: 'chore(sync): reconcile manifest.json [skip ci]',
          }
        );
      }

      if (includePersonal) {
        uploadCandidates.push({
          repoPath: 'data/cinetrack-data.json',
          localPath: path.join(this.deps.dataDir, 'cinetrack-data.json'),
          commitMsg: 'chore(sync): reconcile cinetrack-data.json [skip ci]',
        });
        if (existsSync(path.join(this.deps.dataDir, 'stock.json'))) {
          uploadCandidates.push({
            repoPath: 'data/stock.json',
            localPath: path.join(this.deps.dataDir, 'stock.json'),
            commitMsg: 'chore(sync): reconcile stock.json [skip ci]',
          });
        }
        if (existsSync(path.join(this.deps.dataDir, 'sinema-kunyesi.json'))) {
          uploadCandidates.push({
            repoPath: 'data/sinema-kunyesi.json',
            localPath: path.join(this.deps.dataDir, 'sinema-kunyesi.json'),
            commitMsg: 'chore(sync): reconcile sinema-kunyesi.json [skip ci]',
          });
        }
        for (const repoPath of Object.keys(localPrepared.derivedProfiles).sort()) {
          uploadCandidates.push({
            repoPath,
            localPath: path.join(this.deps.dataDir, repoPath.replace(/^data\//, '')),
            commitMsg: `chore(sync): reconcile ${path.posix.basename(repoPath)} [skip ci]`,
          });
        }
      }

      for (const candidate of uploadCandidates) {
        if (pathsBlockedFromPush.has(candidate.repoPath)) continue;

        let localContent: string;
        if (candidate.repoPath === 'data/cinetrack-data.json') {
          // MIA Faz 1 — Adım 1.4 GEREKÇE: Senkron katmanı düşük seviye ham belge
          // okuma istisnasıdır (yukarıdaki sınıf açıklamasına bakınız).
          const storedDoc = await this.deps.storage.readDataAsync();
          if (storedDoc.profiles.length === 0 && (storedDoc.revision ?? 0) === 0) continue;
          localContent = JSON.stringify(storedDoc, null, 2);
        } else {
          if (!existsSync(candidate.localPath)) continue;

          const validCheck = tryParseValidJson(candidate.localPath);
          if (!validCheck.ok) {
            filesFailed.push(candidate.repoPath);
            errors.push({
              repoPath: candidate.repoPath,
              category: 'corrupt_local_file',
              message: `${candidate.repoPath}: Yerel dosya geçerli JSON değil (${validCheck.error}).`,
            });
            continue;
          }

          localContent = readFileSync(candidate.localPath, 'utf8');
        }
        const localInspection = localPrepared.summary.files[candidate.repoPath];
        const remoteBeforeFile = remoteBeforeInspect.bundle.summary.files[candidate.repoPath];

        // Uzak tarafla semantik (ve katalog manifest tutarlılığı için ham) özet zaten birebir aynıysa gereksiz GitHub isteği/commit üretme
        const isCatalogDataFile =
          candidate.repoPath === 'data/catalog/movies.json' ||
          candidate.repoPath === 'data/catalog/tv.json';
        const rawMatchesWhenRequired =
          !isCatalogDataFile || remoteBeforeFile?.rawFileHash === localInspection?.rawFileHash;
        if (
          remoteBeforeFile?.exists &&
          remoteBeforeFile.valid &&
          localInspection?.semanticHash &&
          remoteBeforeFile.semanticHash === localInspection.semanticHash &&
          rawMatchesWhenRequired
        ) {
          if (
            !filesDownloaded.includes(candidate.repoPath) &&
            !filesMerged.includes(candidate.repoPath)
          ) {
            filesUnchanged.push(candidate.repoPath);
          }
          continue;
        }

        const commitRes = await this.deps.store.commitFileToGitHub(
          candidate.repoPath,
          localContent,
          candidate.commitMsg,
          { isEmptyRepo: access.isEmptyRepo, branchToUse: cfg.branch }
        );
        if (commitRes.ok) {
          access.isEmptyRepo = false;
          if (commitRes.skippedNoop) {
            if (
              !filesDownloaded.includes(candidate.repoPath) &&
              !filesMerged.includes(candidate.repoPath) &&
              !filesUnchanged.includes(candidate.repoPath)
            ) {
              filesUnchanged.push(candidate.repoPath);
            }
          } else {
            filesUploaded.push(candidate.repoPath);
          }
        } else {
          filesFailed.push(candidate.repoPath);
          errors.push({
            repoPath: candidate.repoPath,
            category: (commitRes.errorCategory as SyncErrorCategory) || 'http_error',
            message: `${candidate.repoPath}: ${commitRes.error || 'GitHub yükleme hatası'}`,
          });
        }
      }

      // --- E. İŞLEM SONRASI GERÇEK UZAK DOSYALARI YENİDEN OKU VE DOĞRULA ---
      const localAfter = await this.inspectLocalSide();
      const activeAfterToken = this.deps.getGitHubConfig().token || activeBeforeToken;
      const remoteAfterInspect = await this.inspectRemoteSide(
        { token: activeAfterToken, owner: cfg.owner, repo: cfg.repo, branch: cfg.branch },
        {
          includePersonalFiles: includePersonal,
          includeCatalogFiles: includeCatalog,
          localProfilePaths: Object.keys(localAfter.derivedProfiles),
        }
      );

      for (const reErr of remoteAfterInspect.bundle.errors) {
        if (!errors.some((e) => e.repoPath === reErr.repoPath && e.message === reErr.message)) {
          errors.push(reErr);
        }
      }

      const postComparison = compareSyncSides(localAfter, remoteAfterInspect.bundle, {
        includePersonalFiles: includePersonal,
        includeCatalogFiles: includeCatalog,
      });

      const uniqueFailed = Array.from(new Set(filesFailed));
      const ok =
        !remoteAfterInspect.transportFailed &&
        uniqueFailed.length === 0 &&
        errors.length === 0;
      const anyProcessed =
        filesDownloaded.length > 0 ||
        filesUploaded.length > 0 ||
        filesMerged.length > 0 ||
        filesUnchanged.length > 0;
      const partialFailure = !ok && anyProcessed && uniqueFailed.length > 0;
      const verifiedEqual = ok && postComparison.semanticEqual;

      if (ok && !postComparison.semanticEqual) {
        // Faz 3: eşitlik doğrulaması başarısız olduğunda veri ezilmez; uyuşmazlık
        // açıkça raporlanır ve yeniden eşitleme önerilir.
        const differing = postComparison.differingFiles.map((d) => d.repoPath).join(', ');
        warnings.push(
          `Doğrulama uyuşmazlığı: işlem sonrası uzak dosyalar yerelle eşleşmiyor (${differing || 'bilinmeyen dosya'}). Veri ezilmedi; yeniden eşitleme önerilir.`
        );
      }

      if (verifiedEqual) {
        this.initialReconcileCompleted = true;
      }

      // B-39: aynı otorite — gerçek öncesi/sonrası belgeler.
      const recordCounts = buildBidirectionalSyncCounters({
        localBefore,
        localAfter,
        remoteBefore: remoteBeforeInspect.bundle,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle,
      });

      const report: BidirectionalSyncReport = {
        ok,
        partialFailure,
        operation: 'reconcile',
        startedAt,
        completedAt: new Date().toISOString(),
        remoteTarget,
        isPublicRepo: visibility.effectiveIsPublicRepo,
        ...(visibility.warning ? { repoVisibilityWarning: visibility.warning } : {}),
        localBefore: localBefore.summary,
        remoteBefore: remoteBeforeInspect.bundle.summary,
        localAfter: localAfter.summary,
        remoteAfter: remoteAfterInspect.transportFailed ? null : remoteAfterInspect.bundle.summary,
        comparison: remoteAfterInspect.transportFailed ? null : postComparison,
        filesDownloaded: Array.from(new Set(filesDownloaded)),
        filesUploaded: Array.from(new Set(filesUploaded)),
        filesUnchanged: Array.from(new Set(filesUnchanged)),
        filesMerged: Array.from(new Set(filesMerged)),
        filesFailed: uniqueFailed,
        filesPending: remoteAfterInspect.transportFailed
          ? []
          : postComparison.differingFiles.map((d) => d.repoPath),
        filesBlockedPublic: buildBlockedPublicPaths(includeCatalog, includePersonal),
        recordsAdded: recordCounts.added,
        recordsUpdated: recordCounts.updated,
        recordsSkipped: recordCounts.skipped,
        recordsConflicted: conflicts.length,
        conflicts,
        warnings,
        errors,
        verifiedEqual,
        ...(updatedDataDocument ? { updatedDataDocument } : {}),
        ...(serverRevision !== undefined ? { serverRevision } : {}),
      };

      this.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
      }
    );
  }
}
