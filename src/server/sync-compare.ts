import { stringifyDeterministic, type CatalogManifest, type CatalogRecord, type DerivedProfileDocument } from './persistent-store.ts';
import type { CinemaKunyeDocument } from '../core/cinema-kunye.ts';
import type { DataDocument } from '../core/cinetrack-core.ts';
import type {
  SyncComparisonSummary,
  SyncErrorRecord,
  SyncFileCategory,
  SyncFileDiffDetail,
  SyncSideSummary,
  UserDataConflictItem,
} from '../core/sync-display.ts';
import { reconcileUserDataDocumentsLossless } from '../core/user-data-merge.ts';

export interface ParsedSideBundle {
  summary: SyncSideSummary;
  movies: Record<string, CatalogRecord>;
  tv: Record<string, CatalogRecord>;
  manifest: CatalogManifest | null;
  userData: DataDocument | null;
  cinemaKunye: CinemaKunyeDocument | null;
  derivedProfiles: Record<string, DerivedProfileDocument>;
  errors: SyncErrorRecord[];
}

export function compareSyncSides(
  localBundle: ParsedSideBundle,
  remoteBundle: ParsedSideBundle,
  options: { includePersonalFiles: boolean; includeCatalogFiles?: boolean }
): SyncComparisonSummary {
  const includeCatalog = options.includeCatalogFiles !== false;
  const allPaths = new Set<string>([
    ...Object.keys(localBundle.summary.files),
    ...Object.keys(remoteBundle.summary.files),
  ]);

  const differingFiles: SyncFileDiffDetail[] = [];
  const reasons: string[] = [];
  let rawFilesEqual = true;
  let semanticEqual = true;
  let comparedFilesCount = 0;
  let differentRecordsCount = 0;

  const sortedPaths = Array.from(allPaths).sort((a, b) => a.localeCompare(b));
  for (const repoPath of sortedPaths) {
    const lf = localBundle.summary.files[repoPath];
    const rf = remoteBundle.summary.files[repoPath];
    const personal = Boolean(lf?.personal ?? rf?.personal);
    if (personal && !options.includePersonalFiles) continue;
    if (!personal && !includeCatalog) continue;

    const lExists = Boolean(lf?.exists);
    const rExists = Boolean(rf?.exists);
    if (!lExists && !rExists) continue;

    comparedFilesCount++;
    const category: SyncFileCategory = lf?.category || rf?.category || 'catalog_movies';
    const lValid = lExists ? Boolean(lf?.valid) : true;
    const rValid = rExists ? Boolean(rf?.valid) : true;
    const lRecords = lf?.uniqueKeyCount ?? 0;
    const rRecords = rf?.uniqueKeyCount ?? 0;

    const fileRawEqual = Boolean(
      lExists && rExists && lValid && rValid && lf?.rawFileHash && lf.rawFileHash === rf?.rawFileHash
    );
    const fileSemanticEqual = Boolean(
      lExists &&
        rExists &&
        lValid &&
        rValid &&
        lf?.semanticHash &&
        lf.semanticHash === rf?.semanticHash
    );

    if (!fileRawEqual) rawFilesEqual = false;
    if (!fileSemanticEqual) {
      semanticEqual = false;
      let reason = '';
      if (!lValid && lf?.error) {
        reason = `Yerel dosya geçersiz (${lf.error})`;
      } else if (!rValid && rf?.error) {
        reason = `GitHub dosyası geçersiz (${rf.error})`;
      } else if (lExists && !rExists) {
        reason = "Yalnızca yerelde mevcut (GitHub'da henüz yok)";
      } else if (rExists && !lExists) {
        reason = "Yalnızca GitHub'da mevcut (yerelde henüz yok)";
      } else if (lRecords !== rRecords) {
        reason = `Kayıt sayısı farklı (Yerel: ${lRecords}, GitHub: ${rRecords})`;
      } else {
        reason = 'Kayıt içerikleri veya özetleri farklı';
      }

      differingFiles.push({
        repoPath,
        category,
        localExists: lExists,
        remoteExists: rExists,
        localValid: lValid,
        remoteValid: rValid,
        localRecords: lRecords,
        remoteRecords: rRecords,
        rawEqual: fileRawEqual,
        semanticEqual: fileSemanticEqual,
        reason,
      });
      reasons.push(`${repoPath}: ${reason}`);
    }
  }

  // Katalog bazında farklı kayıt sayısını doğrudan anahtar farkından hesapla
  if (includeCatalog) {
    const allMovieKeys = new Set([
      ...Object.keys(localBundle.movies),
      ...Object.keys(remoteBundle.movies),
    ]);
    for (const k of allMovieKeys) {
      const lm = localBundle.movies[k];
      const rm = remoteBundle.movies[k];
      if (!lm || !rm) {
        differentRecordsCount++;
      } else {
        const ls = stringifyDeterministic({ ...lm, firstStoredAt: '', lastUpdatedAt: '' });
        const rs = stringifyDeterministic({ ...rm, firstStoredAt: '', lastUpdatedAt: '' });
        if (ls !== rs) differentRecordsCount++;
      }
    }

    const allTvKeys = new Set([
      ...Object.keys(localBundle.tv),
      ...Object.keys(remoteBundle.tv),
    ]);
    for (const k of allTvKeys) {
      const lt = localBundle.tv[k];
      const rt = remoteBundle.tv[k];
      if (!lt || !rt) {
        differentRecordsCount++;
      } else {
        const ls = stringifyDeterministic({ ...lt, firstStoredAt: '', lastUpdatedAt: '' });
        const rs = stringifyDeterministic({ ...rt, firstStoredAt: '', lastUpdatedAt: '' });
        if (ls !== rs) differentRecordsCount++;
      }
    }
  }

  let localOnlyUserItemsCount = 0;
  let remoteOnlyUserItemsCount = 0;
  let conflictingUserItemsCount = 0;
  let userDataConflicts: UserDataConflictItem[] = [];

  if (options.includePersonalFiles) {
    if (localBundle.userData && remoteBundle.userData) {
      const mergePreview = reconcileUserDataDocumentsLossless(
        localBundle.userData,
        remoteBundle.userData
      );
      localOnlyUserItemsCount = mergePreview.addedToRemote;
      remoteOnlyUserItemsCount = mergePreview.addedToLocal;
      userDataConflicts = mergePreview.conflicts;
      conflictingUserItemsCount = mergePreview.conflicts.length;
      differentRecordsCount +=
        localOnlyUserItemsCount + remoteOnlyUserItemsCount + mergePreview.updatedItems;
    } else if (localBundle.userData && !remoteBundle.userData) {
      localOnlyUserItemsCount = localBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += localOnlyUserItemsCount;
    } else if (remoteBundle.userData && !localBundle.userData) {
      remoteOnlyUserItemsCount = remoteBundle.summary.userUniqueSavedItemsCount;
      differentRecordsCount += remoteOnlyUserItemsCount;
    }

    const allProfilePaths = new Set([
      ...Object.keys(localBundle.derivedProfiles),
      ...Object.keys(remoteBundle.derivedProfiles),
    ]);
    for (const pPath of allProfilePaths) {
      const ld = localBundle.derivedProfiles[pPath];
      const rd = remoteBundle.derivedProfiles[pPath];
      if (!ld && rd) {
        differentRecordsCount += Object.keys(rd.items || {}).length || 1;
      } else if (ld && !rd) {
        differentRecordsCount += Object.keys(ld.items || {}).length || 1;
      } else if (ld && rd && ld.contentHash !== rd.contentHash) {
        const pKeys = new Set([
          ...Object.keys(ld.items || {}),
          ...Object.keys(rd.items || {}),
        ]);
        let pDiff = 0;
        for (const pk of pKeys) {
          if (stringifyDeterministic(ld.items[pk]) !== stringifyDeterministic(rd.items[pk])) {
            pDiff++;
          }
        }
        differentRecordsCount += Math.max(1, pDiff);
      }
    }
  }

  if (differentRecordsCount === 0 && differingFiles.length > 0) {
    differentRecordsCount = differingFiles.length;
  }

  return {
    semanticEqual,
    rawFilesEqual,
    comparedFilesCount,
    differentFilesCount: differingFiles.length,
    differentRecordsCount,
    differingFiles,
    hasUserDataConflict: localOnlyUserItemsCount > 0 || conflictingUserItemsCount > 0,
    localOnlyUserItemsCount,
    remoteOnlyUserItemsCount,
    conflictingUserItemsCount,
    userDataConflicts,
    reasons,
  };
}
