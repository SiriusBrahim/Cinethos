/**
 * F5.3-01 — GitHub "pull" işlemi (uzaktan yerel uygulamaya).
 * İş kuralları burada; kilit/kuyruk/journal orkestrasyonu koordinatörde kalır.
 * Gövde `github-bidirectional-sync.ts` içinden bire bir taşınmıştır; `this`
 * referansları dar `host` arayüzüne dönüştürülmüştür (any/`as unknown as` yok).
 */

import { normalizeProfileId } from '../../core/profile-id.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createGithubSyncUnconfiguredReport } from './sync-operation-result.ts';
import { isDerivedDocFreshForContext } from './derived-doc-freshness.ts';
import { type DataDocument } from '../../core/cinetrack-core.ts';
import { reconcileUserDataDocumentsLossless } from '../../core/user-data-merge.ts';
import { mergeCinemaKunyeDocumentsLossless } from '../../core/cinema-kunye.ts';
import { buildBidirectionalSyncCounters } from '../../core/sync-counters.ts';
import type { BidirectionalSyncReport, PullConflictSummary, SyncErrorRecord, UserDataConflictItem } from '../../core/sync-display.ts';
import { writeJsonFileAtomic } from '../atomic-json.ts';
import { sanitizeProfileId, stringifyDeterministic } from '../persistent-store-utils.ts';
import type { CatalogManifest } from '../persistent-store-types.ts';
import { isPlainObject, computeCatalogManifestContentHash, mergeCatalogMapsLossless, buildFreshDerivedProfileDocumentOnServer, compareSyncSides, buildBlockedPublicPaths } from './sync-core.ts';
import type { SyncOperationHost } from './sync-operation-host.ts';

export async function runPullOperation(
  host: SyncOperationHost,
  options: { conflictStrategy?: 'ask' | 'merge' | 'overwrite_with_remote' } = {}
): Promise<BidirectionalSyncReport> {
      const conflictStrategy = options.conflictStrategy || 'ask';
      const startedAt = new Date().toISOString();
      const cfg = host.deps.getGitHubConfig();
      const localBefore = await host.inspectLocalSide();
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
      const access = await host.deps.store.verifyRemoteRepoAccess();
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

      const activeToken = host.deps.getGitHubConfig().token || cfg.token;
      const remoteInspect = await host.inspectRemoteSide(
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
        host.deps.onSyncCompleted?.({
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
      await host.deps.storage.createSafetySnapshotSerialized();

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
            const moviesPath = path.join(host.deps.dataDir, 'catalog', 'movies.json');
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
            const tvPath = path.join(host.deps.dataDir, 'catalog', 'tv.json');
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
      const manifestPath = path.join(host.deps.dataDir, 'catalog', 'manifest.json');
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

            const saveRes = await host.deps.storage.applySyncedDocumentSerialized(docToWrite);
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
                const stockTargetPath = path.join(host.deps.dataDir, 'stock.json');
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
            const kunyeTargetPath = path.join(host.deps.dataDir, 'sinema-kunyesi.json');
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
              const targetFile = host.deps.store.getProfileFilePath(matchingProfile.id);
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
          const targetPath = path.join(host.deps.dataDir, 'profiles', safeFileName);
          mkdirSync(path.dirname(targetPath), { recursive: true });
          writeJsonFileAtomic(targetPath, stringifyDeterministic(remoteProfDoc), {
            backupPath: `${targetPath}.bak`,
            validateParsed: isPlainObject,
          });
          filesDownloaded.push(repoPath);
        }
      }

      // Yeniden yerel durumu oku ve gerçek uzak durumla karşılaştır (Spec Bölüm 4.9 & Bölüm 7)
      const localAfter = await host.inspectLocalSide();
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

      host.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteInspect.bundle.summary,
        lastComparison: postComparison,
      });

      return report;
}
