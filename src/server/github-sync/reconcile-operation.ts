/**
 * F5.3-01 — GitHub "reconcile" işlemi (iki yönlü eşitleme).
 * İş kuralları burada; kilit/kuyruk/journal orkestrasyonu koordinatörde kalır.
 * Gövde `github-bidirectional-sync.ts` içinden bire bir taşınmıştır; `this`
 * referansları dar `host` arayüzüne dönüştürülmüştür (any/`as unknown as` yok).
 */

import { normalizeProfileId } from '../../core/profile-id.ts';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createGithubSyncUnconfiguredReport } from './sync-operation-result.ts';
import { isDerivedDocFreshForContext } from './derived-doc-freshness.ts';
import { type DataDocument } from '../../core/cinetrack-core.ts';
import { reconcileUserDataDocumentsLossless } from '../../core/user-data-merge.ts';
import { mergeCinemaKunyeDocumentsLossless } from '../../core/cinema-kunye.ts';
import { computeDerivedProfileContentHash, DERIVED_PROFILE_SCHEMA_VERSION } from '../../core/derived-profile-cache.ts';
import { buildBidirectionalSyncCounters } from '../../core/sync-counters.ts';
import type { BidirectionalSyncReport, SyncErrorCategory, SyncErrorRecord, UserDataConflictItem } from '../../core/sync-display.ts';
import { tryParseValidJson, writeJsonFileAtomic } from '../atomic-json.ts';
import { stringifyDeterministic } from '../persistent-store-utils.ts';
import type { CatalogManifest, DerivedProfileDocument, DerivedProfileItem } from '../persistent-store-types.ts';
import { isPlainObject, computeRawUtf8Hash, computeCatalogManifestContentHash, mergeCatalogMapsLossless, buildFreshDerivedProfileDocumentOnServer, compareSyncSides, buildBlockedPublicPaths } from './sync-core.ts';
import type { ReconcileOperationHost } from './sync-operation-host.ts';

export async function runReconcileOperation(
  host: ReconcileOperationHost,
  options: { includePersonalOverride?: boolean; includeCatalogOverride?: boolean } = {}
): Promise<BidirectionalSyncReport> {
      const startedAt = new Date().toISOString();
      const cfg = host.deps.getGitHubConfig();
      const localBefore = await host.inspectLocalSide();
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
      const access = await host.deps.store.verifyRemoteRepoAccess();
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
        host.deps.onSyncCompleted?.({
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

      const activeBeforeToken = host.deps.getGitHubConfig().token || cfg.token;
      const remoteBeforeInspect = await host.inspectRemoteSide(
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
        host.deps.onSyncCompleted?.({
          report,
          lastRemoteSummary: remoteBeforeInspect.bundle.summary,
          lastComparison: null,
        });
        return report;
      }

      // Yerel güvenlik yedeği al
      await host.deps.storage.createSafetySnapshotSerialized();

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
          const moviesPath = path.join(host.deps.dataDir, 'catalog', 'movies.json');
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
          const tvPath = path.join(host.deps.dataDir, 'catalog', 'tv.json');
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
          const manifestPath = path.join(host.deps.dataDir, 'catalog', 'manifest.json');
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

            const saveRes = await host.deps.storage.applySyncedDocumentSerialized(
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
          const saveRes = await host.deps.storage.applySyncedDocumentSerialized(remoteDoc);
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
            const targetFile = host.deps.store.getProfileFilePath(profileId);
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
            const targetFile = host.deps.store.getProfileFilePath(profileId);
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
              const targetFile = host.deps.store.getProfileFilePath(profileId);
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
              const stockTargetPath = path.join(host.deps.dataDir, 'stock.json');
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
            const kunyeTargetPath = path.join(host.deps.dataDir, 'sinema-kunyesi.json');
            writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(mergedKunye), {
              backupPath: `${kunyeTargetPath}.bak`,
              validateParsed: isPlainObject,
            });
            filesMerged.push(kunyeRepoPath);
          }
        } else if (!localBefore.cinemaKunye && remoteBeforeInspect.bundle.cinemaKunye) {
          const remoteKunye = remoteBeforeInspect.bundle.cinemaKunye;
          const kunyeTargetPath = path.join(host.deps.dataDir, 'sinema-kunyesi.json');
          writeJsonFileAtomic(kunyeTargetPath, stringifyDeterministic(remoteKunye), {
            backupPath: `${kunyeTargetPath}.bak`,
            validateParsed: isPlainObject,
          });
          filesDownloaded.push(kunyeRepoPath);
        }
      }

      // --- D. BİRLEŞTİRİLMİŞ GÜNCEL YEREL DOSYALARI GITHUB'A YÜKLE ---
      const localPrepared = await host.inspectLocalSide();
      const uploadCandidates: Array<{ repoPath: string; localPath: string; commitMsg: string }> = [];

      if (includeCatalog) {
        uploadCandidates.push(
          {
            repoPath: 'data/catalog/movies.json',
            localPath: path.join(host.deps.dataDir, 'catalog', 'movies.json'),
            commitMsg: 'chore(sync): reconcile movies.json [skip ci]',
          },
          {
            repoPath: 'data/catalog/tv.json',
            localPath: path.join(host.deps.dataDir, 'catalog', 'tv.json'),
            commitMsg: 'chore(sync): reconcile tv.json [skip ci]',
          },
          {
            repoPath: 'data/catalog/manifest.json',
            localPath: path.join(host.deps.dataDir, 'catalog', 'manifest.json'),
            commitMsg: 'chore(sync): reconcile manifest.json [skip ci]',
          }
        );
      }

      if (includePersonal) {
        uploadCandidates.push({
          repoPath: 'data/cinetrack-data.json',
          localPath: path.join(host.deps.dataDir, 'cinetrack-data.json'),
          commitMsg: 'chore(sync): reconcile cinetrack-data.json [skip ci]',
        });
        if (existsSync(path.join(host.deps.dataDir, 'stock.json'))) {
          uploadCandidates.push({
            repoPath: 'data/stock.json',
            localPath: path.join(host.deps.dataDir, 'stock.json'),
            commitMsg: 'chore(sync): reconcile stock.json [skip ci]',
          });
        }
        if (existsSync(path.join(host.deps.dataDir, 'sinema-kunyesi.json'))) {
          uploadCandidates.push({
            repoPath: 'data/sinema-kunyesi.json',
            localPath: path.join(host.deps.dataDir, 'sinema-kunyesi.json'),
            commitMsg: 'chore(sync): reconcile sinema-kunyesi.json [skip ci]',
          });
        }
        for (const repoPath of Object.keys(localPrepared.derivedProfiles).sort()) {
          uploadCandidates.push({
            repoPath,
            localPath: path.join(host.deps.dataDir, repoPath.replace(/^data\//, '')),
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
          const storedDoc = await host.deps.storage.readDataAsync();
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

        const commitRes = await host.deps.store.commitFileToGitHub(
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
      const localAfter = await host.inspectLocalSide();
      const activeAfterToken = host.deps.getGitHubConfig().token || activeBeforeToken;
      const remoteAfterInspect = await host.inspectRemoteSide(
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
        host.setInitialReconcileCompleted();
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

      host.deps.onSyncCompleted?.({
        report,
        lastRemoteSummary: remoteAfterInspect.transportFailed
          ? null
          : remoteAfterInspect.bundle.summary,
        lastComparison: remoteAfterInspect.transportFailed ? null : postComparison,
      });

      return report;
}
