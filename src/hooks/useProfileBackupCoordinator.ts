import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  dedupeItems,
  parseBackupText,
  type FavoriteActorInfo,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import { mergeSavedItemListsLossless } from '../core/user-data-merge.ts';
import {
  enrichSavedItemsFromCinemaKunye,
  extractCinemaKunyeFromItems,
  mergeCinemaKunyeDocumentsLossless,
} from '../core/cinema-kunye.ts';
import {
  buildBackupFileName,
  buildLocalBackupDocument,
  resolveImportedFavoriteActors,
  resolveImportedPreferences,
} from '../app/profile-backup.ts';
import { favActorsStorageKey } from '../app/profile-storage.ts';

export interface UseProfileBackupCoordinatorOptions {
  activeProfileId: string;
  profileName: string;
  savedItems: SavedItem[];
  preferences: Preferences;
  favoriteActors: FavoriteActorInfo[];
  favoriteActorsRef: MutableRefObject<FavoriteActorInfo[]>;
  genresMap: Record<number, string>;
  cinemaKunye: any;
  isDemo: boolean;
  pendingBackup: any | null;
  setPendingBackup: Dispatch<SetStateAction<any | null>>;
  setSavedItems: Dispatch<SetStateAction<SavedItem[]>>;
  savedItemsRef: MutableRefObject<SavedItem[]>;
  lastForYouQueryKeyRef: MutableRefObject<string>;
  setForYouItems: Dispatch<SetStateAction<any[]>>;
  setPreferences: Dispatch<SetStateAction<Preferences>>;
  setFavoriteActors: Dispatch<SetStateAction<FavoriteActorInfo[]>>;
  setProfiles: Dispatch<SetStateAction<Profile[]>>;
  setProfileOpen: Dispatch<SetStateAction<boolean>>;
  confirmNextBulkSyncRef: MutableRefObject<boolean>;
  mergeIncomingCinemaKunye: (document: any) => any;
  replaceCinemaKunye: (document: any) => any;
  handleSaveProfileName: (name: string) => void;
  showToast: (message: string) => void;
}

/** Keeps local JSON backup import/export orchestration out of the App shell. */
export function useProfileBackupCoordinator(options: UseProfileBackupCoordinatorOptions) {
  const handleExportBackup = useCallback(() => {
    const nowIso = new Date().toISOString();
    const exportedKunye = mergeCinemaKunyeDocumentsLossless(
      options.cinemaKunye,
      extractCinemaKunyeFromItems(options.savedItems, options.genresMap)
    );
    const enrichedExportItems = enrichSavedItemsFromCinemaKunye(options.savedItems, exportedKunye);
    const backup = buildLocalBackupDocument({
      profileId: options.activeProfileId,
      profileName: options.profileName,
      items: enrichedExportItems,
      cinemaKunye: exportedKunye,
      preferences: options.preferences,
      favoriteActors: options.favoriteActorsRef.current,
      isDemo: options.isDemo,
      nowIso,
    });
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = buildBackupFileName(nowIso);
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [
    options.cinemaKunye,
    options.savedItems,
    options.genresMap,
    options.activeProfileId,
    options.profileName,
    options.preferences,
    options.favoriteActorsRef,
    options.isDemo,
  ]);

  const handleImportBackupFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      options.setPendingBackup(parseBackupText(text));
    } catch (error) {
      options.showToast(error instanceof Error ? error.message : 'Yedek dosyası okunamadı.');
    }
  }, [options.setPendingBackup, options.showToast]);

  const handleConfirmImport = useCallback((mode: 'overwrite' | 'merge') => {
    const pendingBackup = options.pendingBackup;
    if (!pendingBackup) return;
    if (mode === 'overwrite') options.confirmNextBulkSyncRef.current = true;

    const effectiveKunye = mode === 'merge'
      ? options.mergeIncomingCinemaKunye(pendingBackup.cinemaKunye)
      : options.replaceCinemaKunye(pendingBackup.cinemaKunye);
    const rawImportedItems = mode === 'merge'
      ? mergeSavedItemListsLossless(options.savedItems, pendingBackup.items, options.activeProfileId)
      : dedupeItems(pendingBackup.items);
    const importedItems = enrichSavedItemsFromCinemaKunye(rawImportedItems, effectiveKunye);

    options.savedItemsRef.current = importedItems;
    options.setSavedItems(importedItems);
    options.lastForYouQueryKeyRef.current = '';
    options.setForYouItems([]);
    if (pendingBackup.profileName) options.handleSaveProfileName(pendingBackup.profileName);
    if (pendingBackup.preferences) {
      options.setPreferences((previous) =>
        resolveImportedPreferences(previous, pendingBackup.preferences, mode) ?? previous
      );
    }
    const importedActors = resolveImportedFavoriteActors(
      options.favoriteActors,
      pendingBackup.favoriteActors,
      mode
    );
    options.setFavoriteActors(importedActors);
    try {
      localStorage.setItem(favActorsStorageKey(options.activeProfileId), JSON.stringify(importedActors));
    } catch {}

    if (pendingBackup.isDemo !== undefined) {
      options.setProfiles((previous) =>
        previous.map((profile) => profile.id === options.activeProfileId
          ? { ...profile, isDemo: pendingBackup.isDemo }
          : profile)
      );
    }

    options.setPendingBackup(null);
    options.setProfileOpen(false);
    options.showToast('Yedek başarıyla içe aktarıldı (' + importedItems.length + ' içerik)!');
  }, [
    options.pendingBackup,
    options.confirmNextBulkSyncRef,
    options.mergeIncomingCinemaKunye,
    options.replaceCinemaKunye,
    options.savedItems,
    options.activeProfileId,
    options.savedItemsRef,
    options.setSavedItems,
    options.lastForYouQueryKeyRef,
    options.setForYouItems,
    options.handleSaveProfileName,
    options.setPreferences,
    options.favoriteActors,
    options.setFavoriteActors,
    options.setProfiles,
    options.setPendingBackup,
    options.setProfileOpen,
    options.showToast,
  ]);

  return { handleExportBackup, handleImportBackupFile, handleConfirmImport };
}
