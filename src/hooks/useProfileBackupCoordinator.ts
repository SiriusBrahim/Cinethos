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
  const {
    activeProfileId, profileName, savedItems, preferences, favoriteActors, favoriteActorsRef,
    genresMap, cinemaKunye, isDemo, pendingBackup, setPendingBackup, setSavedItems,
    savedItemsRef, lastForYouQueryKeyRef, setForYouItems, setPreferences, setFavoriteActors,
    setProfiles, setProfileOpen, confirmNextBulkSyncRef, mergeIncomingCinemaKunye,
    replaceCinemaKunye, handleSaveProfileName, showToast,
  } = options;

  const handleExportBackup = useCallback(() => {
    const nowIso = new Date().toISOString();
    const exportedKunye = mergeCinemaKunyeDocumentsLossless(
      cinemaKunye,
      extractCinemaKunyeFromItems(savedItems, genresMap)
    );
    const enrichedExportItems = enrichSavedItemsFromCinemaKunye(savedItems, exportedKunye);
    const backup = buildLocalBackupDocument({
      profileId: activeProfileId,
      profileName: profileName,
      items: enrichedExportItems,
      cinemaKunye: exportedKunye,
      preferences: preferences,
      favoriteActors: favoriteActorsRef.current,
      isDemo: isDemo,
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
    cinemaKunye,
    savedItems,
    genresMap,
    activeProfileId,
    profileName,
    preferences,
    favoriteActorsRef,
    isDemo,
  ]);

  const handleImportBackupFile = useCallback(async (file: File) => {
    try {
      const text = await file.text();
      setPendingBackup(parseBackupText(text));
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Yedek dosyası okunamadı.');
    }
  }, [setPendingBackup, showToast]);

  const handleConfirmImport = useCallback((mode: 'overwrite' | 'merge') => {
    const pendingBackup = pendingBackup;
    if (!pendingBackup) return;
    if (mode === 'overwrite') confirmNextBulkSyncRef.current = true;

    const effectiveKunye = mode === 'merge'
      ? mergeIncomingCinemaKunye(pendingBackup.cinemaKunye)
      : replaceCinemaKunye(pendingBackup.cinemaKunye);
    const rawImportedItems = mode === 'merge'
      ? mergeSavedItemListsLossless(savedItems, pendingBackup.items, activeProfileId)
      : dedupeItems(pendingBackup.items);
    const importedItems = enrichSavedItemsFromCinemaKunye(rawImportedItems, effectiveKunye);

    savedItemsRef.current = importedItems;
    setSavedItems(importedItems);
    lastForYouQueryKeyRef.current = '';
    setForYouItems([]);
    if (pendingBackup.profileName) handleSaveProfileName(pendingBackup.profileName);
    if (pendingBackup.preferences) {
      setPreferences((previous) =>
        resolveImportedPreferences(previous, pendingBackup.preferences, mode) ?? previous
      );
    }
    const importedActors = resolveImportedFavoriteActors(
      favoriteActors,
      pendingBackup.favoriteActors,
      mode
    );
    setFavoriteActors(importedActors);
    try {
      localStorage.setItem(favActorsStorageKey(activeProfileId), JSON.stringify(importedActors));
    } catch {}

    if (pendingBackup.isDemo !== undefined) {
      setProfiles((previous) =>
        previous.map((profile) => profile.id === activeProfileId
          ? { ...profile, isDemo: pendingBackup.isDemo }
          : profile)
      );
    }

    setPendingBackup(null);
    setProfileOpen(false);
    showToast('Yedek başarıyla içe aktarıldı (' + importedItems.length + ' içerik)!');
  }, [
    pendingBackup,
    confirmNextBulkSyncRef,
    mergeIncomingCinemaKunye,
    replaceCinemaKunye,
    savedItems,
    activeProfileId,
    savedItemsRef,
    setSavedItems,
    lastForYouQueryKeyRef,
    setForYouItems,
    handleSaveProfileName,
    setPreferences,
    favoriteActors,
    setFavoriteActors,
    setProfiles,
    setPendingBackup,
    setProfileOpen,
    showToast,
  ]);

  return { handleExportBackup, handleImportBackupFile, handleConfirmImport };
}
