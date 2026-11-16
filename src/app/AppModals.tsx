import React from 'react';
import { DetailModal } from '../components/DetailModal.tsx';
import { QuickSaveModal } from '../components/QuickSaveModal.tsx';
import { PersonDrawer } from '../components/PersonDrawer.tsx';
import { AddCustomModal } from '../components/AddCustomModal.tsx';
import { CommandPalette } from '../components/CommandPalette.tsx';
import { ProfileModal } from '../components/ProfileModal.tsx';
import { ImportChoiceModal } from '../components/ImportChoiceModal.tsx';
import { ArchiveRestorePreviewModal } from '../components/ArchiveRestorePreviewModal.tsx';
import { AuthTokenModal } from '../components/AuthTokenModal.tsx';
import { Toast, type ToastEntry, type ToastKind } from '../components/Toast.tsx';
import {
  findSavedItem,
  type DataDocument,
  type FavoriteActorInfo,
  type PersistentTasteMapData,
  type Preferences,
  type Profile,
  type SavedItem,
} from '../core/cinetrack-core.ts';
import type { CinemaKunyeDocument } from '../core/cinema-kunye.ts';
import type { CsvProfileBlock } from '../core/exporters.ts';
import type { SqliteArchiveInspect, SqliteArchivePrepareResult } from '../services/api.ts';
import { displayTitle } from '../utils/helpers.ts';
import type { MainTab } from './MobileTabBar.tsx';

export interface ArchivePreviewState {
  fileName: string;
  inspect: SqliteArchiveInspect;
  current?: SqliteArchivePrepareResult['current'];
}

export interface AuthPromptState {
  status: number;
}

export interface AppModalsProps {
  detailItem: SavedItem | null;
  quickSaveItem: SavedItem | null;
  personId: number | null;
  personName: string;
  addCustomOpen: boolean;
  commandPaletteOpen: boolean;
  profileOpen: boolean;
  pendingBackup: unknown;
  archivePreview: ArchivePreviewState | null;
  archiveRestoreBusy: boolean;
  authPrompt: AuthPromptState | null;
  toasts: ToastEntry[];
  isMobileViewport: boolean;
  /** Profil modalındaki kompakt kimlik kartından menüdeki geniş görünüme geçiş. */
  onOpenIdentityTab: () => void;

  profiles: Profile[];
  activeProfile?: Profile;
  activeProfileId: string;
  profileName: string;
  preferences: Preferences;
  savedItems: SavedItem[];
  favoriteActors: FavoriteActorInfo[];
  dislikedItems: Array<Record<string, unknown>>;
  genresMap: Record<number, string>;
  cinemaKunye?: CinemaKunyeDocument | null;
  tasteMap: PersistentTasteMapData;
  syncStatus: string;

  onCloseDetail: () => void;
  onSelectDetail: (item: any) => void;
  onCloseQuickSave: () => void;
  onOpenQuickSave: (item: any) => void;
  onClosePerson: () => void;
  onOpenPerson: (id: number, name: string) => void;
  onCloseAddCustom: () => void;
  onCloseCommandPalette: () => void;
  onCloseProfile: () => void;
  onClosePendingBackup: () => void;
  onDismissArchivePreview: () => void;
  onConfirmArchiveRestore: () => Promise<void>;
  onCloseAuthPrompt: () => void;
  onDismissToast: (id: number) => void;
  showToast: (msg: string, kind?: ToastKind) => void;

  onSaveItem: (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    rating: number | '',
    tracking?: any
  ) => void;
  onRemoveItem: (item: any) => void;
  onQuickAdd: (item: any) => void;
  onMarkCompleted: (item: any) => void;
  onToggleDislike: (key: string) => void;
  onToggleHide: (key: string) => void;
  onToggleFavoriteActor: (actor: { id: number; name: string; profile_path?: string | null }) => void;
  onSelectTab: (tab: MainTab) => void;
  onOpenProfile: () => void;
  onOpenAddCustom: () => void;
  onFocusSearch: () => void;
  onOpenRelationshipForKey: (mediaKey: string) => void;
  onPushToServer: () => Promise<void> | void;

  onSaveProfileName: (name: string) => void;
  onSwitchProfile: (id: string) => void;
  onCreateProfile: (name: string) => void;
  onSavePreferences: (providers: string[], mood: string) => void;
  onToggleReminders: () => void;
  onExportBackup: () => void;
  onImportBackupFile: (file: File) => void;
  onConfirmImport: (mode: 'overwrite' | 'merge') => void;
  onImportCsvItems: (
    items: SavedItem[],
    importedKunye?: CinemaKunyeDocument,
    profileBlock?: CsvProfileBlock | null
  ) => void;
  onCreateSqliteArchive: () => Promise<void>;
  onRestoreSqliteArchive: (file: File) => Promise<void>;
  onApplyRestoredDocument: (doc: DataDocument) => void;
  onBeforeSyncFlush: () => Promise<void>;
  onMergeSyncedDocument: (doc: DataDocument) => void;
  onCinemaKunyeSynced: (syncMode: 'merge' | 'overwrite') => void;
  onMergeDuplicates: (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => void;
  onToggleDemoMode: () => void;
}

export const AppModals: React.FC<AppModalsProps> = ({
  detailItem,
  quickSaveItem,
  personId,
  personName,
  addCustomOpen,
  commandPaletteOpen,
  profileOpen,
  pendingBackup,
  archivePreview,
  archiveRestoreBusy,
  authPrompt,
  toasts,
  isMobileViewport,
  onOpenIdentityTab,
  profiles,
  activeProfile,
  activeProfileId,
  profileName,
  preferences,
  savedItems,
  favoriteActors,
  dislikedItems,
  genresMap,
  cinemaKunye,
  tasteMap,
  syncStatus,
  onCloseDetail,
  onSelectDetail,
  onCloseQuickSave,
  onOpenQuickSave,
  onClosePerson,
  onOpenPerson,
  onCloseAddCustom,
  onCloseCommandPalette,
  onCloseProfile,
  onClosePendingBackup,
  onDismissArchivePreview,
  onConfirmArchiveRestore,
  onCloseAuthPrompt,
  onDismissToast,
  showToast,
  onSaveItem,
  onRemoveItem,
  onQuickAdd,
  onMarkCompleted,
  onToggleDislike,
  onToggleHide,
  onToggleFavoriteActor,
  onSelectTab,
  onOpenProfile,
  onOpenAddCustom,
  onFocusSearch,
  onOpenRelationshipForKey,
  onPushToServer,
  onSaveProfileName,
  onSwitchProfile,
  onCreateProfile,
  onSavePreferences,
  onToggleReminders,
  onExportBackup,
  onImportBackupFile,
  onConfirmImport,
  onImportCsvItems,
  onCreateSqliteArchive,
  onRestoreSqliteArchive,
  onApplyRestoredDocument,
  onBeforeSyncFlush,
  onMergeSyncedDocument,
  onCinemaKunyeSynced,
  onMergeDuplicates,
  onToggleDemoMode,
}) => {
  const detailMediaKey = detailItem
    ? `${detailItem.media_type || (detailItem.title ? 'movie' : 'tv')}:${detailItem.id}`
    : '';

  return (
    <>
      <DetailModal
        item={detailItem}
        savedItem={detailItem ? findSavedItem(savedItems, detailItem) : undefined}
        savedItems={savedItems}
        isOpen={Boolean(detailItem)}
        genresMap={genresMap}
        isDisliked={detailMediaKey ? preferences.disliked.includes(detailMediaKey) : false}
        isHidden={detailMediaKey ? Boolean(preferences.hidden?.includes(detailMediaKey)) : false}
        favoriteActors={favoriteActors}
        onClose={onCloseDetail}
        onSave={onSaveItem}
        onRemove={onRemoveItem}
        onToggleDislike={onToggleDislike}
        onToggleHide={onToggleHide}
        onToggleFavoriteActor={onToggleFavoriteActor}
        onSelectMedia={onSelectDetail}
        onOpenPerson={onOpenPerson}
      />

      <QuickSaveModal
        item={quickSaveItem}
        savedItem={quickSaveItem ? findSavedItem(savedItems, quickSaveItem) : undefined}
        isOpen={Boolean(quickSaveItem)}
        onClose={onCloseQuickSave}
        onSave={(item, status, rating) => {
          onSaveItem(item, status, rating);
          showToast(`"${displayTitle(item)}" listenize kaydedildi.`);
        }}
        onRemove={onRemoveItem}
      />

      <PersonDrawer
        personId={personId}
        personName={personName}
        profileId={activeProfileId}
        isOpen={Boolean(personId)}
        savedItems={savedItems}
        isFavoriteActor={favoriteActors.some((a) => a.id === personId)}
        onClose={onClosePerson}
        onOpenDetails={onSelectDetail}
        onQuickAdd={onQuickAdd}
        onMarkCompleted={onMarkCompleted}
        onQuickSave={onOpenQuickSave}
        onToggleFavoriteActor={onToggleFavoriteActor}
        onOpenInRelationships={isMobileViewport ? undefined : onOpenRelationshipForKey}
      />

      <AddCustomModal
        isOpen={addCustomOpen}
        onClose={onCloseAddCustom}
        onAdd={(item, status) => {
          onSaveItem(item, status, '');
          showToast(`"${item.title}" listenize eklendi.`);
        }}
      />

      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={onCloseCommandPalette}
        savedItems={savedItems}
        onSelectTab={onSelectTab}
        onOpenProfile={onOpenProfile}
        onOpenAddCustom={onOpenAddCustom}
        onQuickSave={() => {
          void onPushToServer();
          showToast('Değişiklikler kaydedildi ve yerel sunucuyla eşitlendi.');
        }}
        onFocusSearch={onFocusSearch}
        onOpenItem={onSelectDetail}
      />

      <ProfileModal
        isOpen={profileOpen}
        profiles={profiles}
        activeProfile={activeProfile}
        activeProfileId={activeProfileId}
        activeProfileName={profileName}
        preferences={preferences}
        savedItems={savedItems}
        favoriteActors={favoriteActors}
        dislikedItems={dislikedItems}
        genresMap={genresMap}
        cinemaKunye={cinemaKunye}
        tasteEntries={tasteMap.entries}
        syncStatus={syncStatus}
        onClose={onCloseProfile}
        onOpenIdentity={onOpenIdentityTab}
        onSaveProfileName={onSaveProfileName}
        onSwitchProfile={onSwitchProfile}
        onCreateProfile={onCreateProfile}
        onSavePreferences={onSavePreferences}
        onToggleReminders={onToggleReminders}
        onExportBackup={onExportBackup}
        onImportBackupFile={onImportBackupFile}
        onImportCsvItems={onImportCsvItems}
        onCreateSqliteArchive={onCreateSqliteArchive}
        onRestoreSqliteArchive={onRestoreSqliteArchive}
        onApplyRestoredDocument={onApplyRestoredDocument}
        onBeforeSyncFlush={onBeforeSyncFlush}
        onMergeSyncedDocument={onMergeSyncedDocument}
        onCinemaKunyeSynced={onCinemaKunyeSynced}
        onMergeDuplicates={onMergeDuplicates}
        isDemo={Boolean(activeProfile?.isDemo)}
        onToggleDemoMode={onToggleDemoMode}
      />

      <ImportChoiceModal
        isOpen={Boolean(pendingBackup)}
        onClose={onClosePendingBackup}
        onConfirm={onConfirmImport}
      />

      <ArchiveRestorePreviewModal
        open={Boolean(archivePreview)}
        fileName={archivePreview?.fileName || ''}
        inspect={archivePreview?.inspect || null}
        current={archivePreview?.current}
        busy={archiveRestoreBusy}
        onConfirm={() => {
          void onConfirmArchiveRestore().catch(() => {
            /* hata toast ile bildirildi */
          });
        }}
        onCancel={() => {
          if (!archiveRestoreBusy) onDismissArchivePreview();
        }}
      />

      <AuthTokenModal
        open={Boolean(authPrompt)}
        status={authPrompt?.status ?? 401}
        onClose={onCloseAuthPrompt}
        onSubmit={() => {
          onCloseAuthPrompt();
          showToast('Erişim anahtarı bu oturum için kaydedildi; veriler yeniden yükleniyor…', 'info');
          window.setTimeout(() => window.location.reload(), 600);
        }}
      />

      <Toast toasts={toasts} onDismiss={onDismissToast} />
    </>
  );
};
