/**
 * F5.3-01 — GitHub "push" işlemi (yerelden uzak depoya).
 * İş kuralları burada; kilit/kuyruk/journal orkestrasyonu koordinatörde kalır.
 * Gövde `github-bidirectional-sync.ts` içinden bire bir taşınmıştır; `this`
 * referansları dar `host` arayüzüne dönüştürülmüştür (any/`as unknown as` yok).
 */

import path from 'node:path';
import { createGithubSyncUnconfiguredReport } from './sync-operation-result.ts';
import { type DataDocument } from '../../core/cinetrack-core.ts';
import { reconcileUserDataDocumentsLossless } from '../../core/user-data-merge.ts';
import { mergeCinemaKunyeDocumentsLossless } from '../../core/cinema-kunye.ts';
import { buildBidirectionalSyncCounters } from '../../core/sync-counters.ts';
import type { BidirectionalSyncReport, SyncErrorCategory, SyncErrorRecord, UserDataConflictItem } from '../../core/sync-display.ts';
import { writeJsonFileAtomic } from '../atomic-json.ts';
import { hashContent, stringifyDeterministic } from '../persistent-store-utils.ts';
import type { CatalogManifest } from '../persistent-store-types.ts';
import { isPlainObject, computeCatalogManifestContentHash, compareSyncSides, buildBlockedPublicPaths } from './sync-core.ts';
import type { SyncOperationHost } from './sync-operation-host.ts';

export async function runPushOperation(host: SyncOperationHost): Promise<BidirectionalSyncReport> {
      const startedAt = new Date().toISOString();
      const cfg = host.deps.getGitHubConfig();
      const localBefore = await host.inspectLocalSide();
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
      const access = await host.deps.store.verifyRemoteRepoAccess();
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
        host.deps.onSyncCompleted?.({
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
        const manifestPath = path.join(host.deps.dataDir, 'catalog', 'manifest.json');
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

      let localReady = await host.inspectLocalSide();
      let localProfilePaths = Object.keys(localReady.derivedProfiles);

      const activeBeforeToken = host.deps.getGitHubConfig().token || cfg.token;
      const remoteBeforeInspect = await host.inspectRemoteSide(
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
            await host.deps.storage.createSafetySnapshotSerialized();
            const mergedUser = reconcileUserDataDocumentsLossless(
              localReady.userData,
              remoteBeforeInspect.bundle.userData
            );
            const saveRes = await host.deps.storage.applySyncedDocumentSerialized(
              mergedUser.mergedDoc
            );
            if (saveRes.ok) {
              pushUpdatedDataDocument = saveRes.document;
              pushServerRevision = saveRes.document.revision;
              pushConflicts.push(...mergedUser.conflicts);
              if (mergedUser.addedToLocal > 0 || mergedUser.updatedItems > 0) {
                pushFilesMerged.push('data/cinetrack-data.json');
              }
              localReady = await host.inspectLocalSide();
              localProfilePaths = Object.keys(localReady.derivedProfiles);
            }
          }
        } else {
          // Yerelde henüz cinetrack-data.json yok ama GitHub'da var: uzak veriyi koru
          const saveRes = await host.deps.storage.applySyncedDocumentSerialized(
            remoteBeforeInspect.bundle.userData
          );
          if (saveRes.ok) {
            pushUpdatedDataDocument = saveRes.document;
            pushServerRevision = saveRes.document.revision;
            localReady = await host.inspectLocalSide();
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
        const kunyeTargetPath = path.join(host.deps.dataDir, 'sinema-kunyesi.json');
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
            localReady = await host.inspectLocalSide();
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
          localReady = await host.inspectLocalSide();
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
      const syncRes = await host.deps.store.syncToGitHub({
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
      const activeAfterToken = host.deps.getGitHubConfig().token || activeBeforeToken;
      const remoteAfterInspect = await host.inspectRemoteSide(
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

      host.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
}
