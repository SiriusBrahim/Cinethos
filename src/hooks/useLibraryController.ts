/**
 * Kütüphane yazma denetleyicisi.
 *
 * App.tsx içindeki kütüphane eylemleri (ekleme, durum, puan, bölüm ilerletme,
 * silme, beğenmeme/gizleme) buraya taşındı. Tüm yazımlar tek
 * `createClientLibraryService` örneğinden geçer; ikinci bir yazma yolu yoktur.
 * Kanca, React durumunu yalnızca verilen setter'lar üzerinden günceller.
 */

import type React from 'react';
import { makeMediaKey, markTasteMapItemStatus, loadPersistentTasteMap, savePersistentTasteMap, type PersistentTasteMapData, type Preferences, type SavedItem, normalizeFavoriteActors, normalizeDeletedKeys } from '../core/cinetrack-core.ts';
import { createClientLibraryService } from '../modules/library/client-service.ts';
import { useItemActions } from './useItemActions.ts';
import { clearServerTasteSignalCache, loadServerTasteSignal } from '../services/taste-signal-service.ts';
import { fetchTmdb } from '../services/api.ts';
import { consumeStockItem } from '../services/stock-engine.ts';
import { removeSurfacedKey, removeSkippedKeyIdb } from '../services/storage-idb.ts';
import { indexItemForSeries } from '../services/series-service.ts';
import { recordProfileChangeAndMaybeBackup } from '../services/auto-backup-service.ts';
import { displayTitle } from '../utils/helpers.ts';
import type { ServerTasteSignal } from '../modules/recommendations/index.ts';

export interface LibraryControllerContext {
  readonly activeProfile: { id: string; isDemo?: boolean } | undefined;
  readonly activeProfileId: string;
  readonly catalogItems: any[];
  readonly forYouItems: any[];
  readonly savedItems: SavedItem[];
  readonly preferences: Preferences;
  readonly deletedKeys: Record<string, string>;
  readonly setFavoriteActors: React.Dispatch<React.SetStateAction<any[]>>;
  readonly tasteMapRef: { current: PersistentTasteMapData };
  readonly activeProfileIdRef: { current: string };
  readonly savedItemsRef: { current: SavedItem[] };
  readonly preferencesRef: { current: Preferences };
  readonly deletedKeysRef: { current: Record<string, string> };
  readonly showToast: (message: string) => void;
  readonly setProfiles: React.Dispatch<React.SetStateAction<any[]>>;
  readonly setSavedItems: React.Dispatch<React.SetStateAction<SavedItem[]>>;
  readonly setDeletedKeys: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  readonly setForYouItems: React.Dispatch<React.SetStateAction<any[]>>;
  readonly setTasteMap: (value: PersistentTasteMapData) => void;
  readonly setPreferences: React.Dispatch<React.SetStateAction<Preferences>>;
  readonly setDislikedItems: React.Dispatch<React.SetStateAction<any[]>>;
  readonly setServerTasteSignal: (value: ServerTasteSignal | null) => void;
}

export function useLibraryController(ctx: LibraryControllerContext) {
  const {
    activeProfile,
    activeProfileId,
    catalogItems,
    forYouItems,
    savedItems,
    preferences,
    deletedKeys,
    tasteMapRef,
    activeProfileIdRef,
    savedItemsRef,
    preferencesRef,
    deletedKeysRef,
    showToast,
    setProfiles,
    setSavedItems,
    setDeletedKeys,
    setForYouItems,
    setTasteMap,
    setPreferences,
    setDislikedItems,
    setServerTasteSignal,
    setFavoriteActors,
  } = ctx;

  void deletedKeys;
  void preferences;

    const commitSavedItem = (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: 'watching' | 'watchlist' | 'completed'
  ) => {
    const mediaType = normalized.media_type;
    const targetId = String(normalized.id);
    const targetTitle = (rawItem.title || rawItem.name || normalized.title || '').trim().toLowerCase();

    if (activeProfile?.isDemo) {
      setProfiles((prev) =>
        prev.map((p) => (p.id === activeProfileId ? { ...p, isDemo: false } : p))
      );
    }

    const itemKey = makeMediaKey(mediaType, targetId);
    if (deletedKeysRef.current[itemKey]) {
      setDeletedKeys((prev) => {
        if (!prev[itemKey]) return prev;
        const copy = { ...prev };
        delete copy[itemKey];
        deletedKeysRef.current = copy;
        return copy;
      });
    }
    setSavedItems((currentSaved) => {
      const existingIndex = currentSaved.findIndex(
        (entry) =>
          makeMediaKey(entry) === itemKey ||
          (Boolean(targetTitle) &&
            entry.media_type === mediaType &&
            (entry.title || '').trim().toLowerCase() === targetTitle)
      );

      let next: SavedItem[];
      if (existingIndex >= 0) {
        next = [...currentSaved];
        next[existingIndex] = normalized;
      } else {
        next = [normalized, ...currentSaved];
      }
      savedItemsRef.current = next;
      return next;
    });

    // Immediately remove from recommendations (Sana Özel) so it NEVER lingers!
    setForYouItems((prev) =>
      prev.filter((i) => makeMediaKey(i) !== itemKey)
    );

    // Sorun D: Kalıcı Zevk Haritasında yapımı 'saved' olarak işaretle
    try {
      const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
      markTasteMapItemStatus(currentTasteMap, itemKey, 'saved');
      savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
      const nextMap = { ...currentTasteMap };
      tasteMapRef.current = nextMap;
      setTasteMap(nextMap);
    } catch {}

    // Aşama 3 & 4: Stoktan düş, ct:surfaced & ct:skip-log geçmişinden çıkar ve seri indeksini güncelle
    void consumeStockItem(normalized, activeProfileIdRef.current);
    void removeSurfacedKey(itemKey);
    void removeSkippedKeyIdb(activeProfileIdRef.current, itemKey);
    void indexItemForSeries(normalized);
    void recordProfileChangeAndMaybeBackup();

    // Kütüphane değişikliği → sunucu zevk profili → öneri sinyali zinciri:
    // önbellek düşürülür ve sinyal bir sonraki koşuda tazelenir.
    clearServerTasteSignalCache(activeProfileIdRef.current);
    void loadServerTasteSignal({
      profileId: activeProfileIdRef.current,
      mood: preferencesRef.current.mood,
      force: true,
    }).then((signal) => setServerTasteSignal(signal));

    const title = displayTitle(rawItem);
    if (effectiveStatus === 'completed') {
      showToast(`✓ "${title}" izlendi listesine kaydedildi! 🎉`);
    } else if (effectiveStatus === 'watching') {
      showToast(`▶ "${title}" izleniyor olarak kaydedildi! 🍿`);
    } else {
      showToast(`✓ "${title}" izlenecekler listesine kaydedildi! ✨`);
    }

    // Auto-enrich TV show metadata if episode count or runtime is missing
    if (normalized.media_type === 'tv' && !normalized.custom && !normalized.number_of_episodes) {
      const tvId = normalized.id;
      fetchTmdb(`/tv/${tvId}`)
        .then((tvDetails) => {
          if (tvDetails) {
            setSavedItems((currentList) =>
              currentList.map((entry) => {
                if (entry.id === tvId && entry.media_type === 'tv') {
                  return {
                    ...entry,
                    number_of_episodes: Number(tvDetails.number_of_episodes) || 10,
                    number_of_seasons: Number(tvDetails.number_of_seasons) || 1,
                    episode_run_time: tvDetails.episode_run_time || [45],
                    runtime: tvDetails.episode_run_time?.[0] || 45,
                  };
                }
                return entry;
              })
            );
          }
        })
        .catch(() => {});
    }
  };

  // MIA Faz 7 — TEK veri hattı: bütün kütüphane yazımları bu servis örneğinden
  // geçer. Mobil alt gezinme, masaüstü sekmeleri, kartlar, modallar ve
  // çekmece aynı örneği kullanır; ikinci bir yazma yolu yoktur.
  const libraryService = createClientLibraryService({
    getSavedItems: () => savedItemsRef.current,
    applySavedItem: commitSavedItem,
    applySavedItems: (next) => {
      savedItemsRef.current = next;
      setSavedItems(next);
    },
    applyTombstone: (mediaKey, deletedAtIso) => {
      const nextDeleted = normalizeDeletedKeys({
        ...deletedKeysRef.current,
        [mediaKey]: deletedAtIso,
      });
      deletedKeysRef.current = nextDeleted;
      setDeletedKeys(nextDeleted);
    },
  });

  const { saveItem, setItemStatus, markCompleted, dislikeItem, hideItem } = useItemActions({
    getSavedItems: () => savedItemsRef.current,
    onCommitSavedItem: commitSavedItem,
    service: libraryService,
  });

  const handleSaveItem = (
    item: any,
    status: 'watching' | 'watchlist' | 'completed',
    personalRating: number | '',
    tracking: any = {}
  ) => {
    saveItem(item, status, personalRating, tracking);
  };

  const handleQuickAdd = (item: any) => {
    saveItem(item, 'watchlist', '');
    showToast(`✓ "${displayTitle(item)}" izlenecekler listesine eklendi! ✨`);
  };

  const handleMarkCompleted = (item: any) => {
    markCompleted(item);
    showToast(`✓ "${displayTitle(item)}" izlendi listesine eklendi! 🎉`);
  };

  const handleSetStatus = (item: any, status: 'watching' | 'watchlist' | 'completed') => {
    setItemStatus(item, status);
    const title = displayTitle(item);
    if (status === 'completed') {
      showToast(`✓ "${title}" izlendi listesine eklendi! 🎉`);
    } else if (status === 'watching') {
      showToast(`▶ "${title}" izleniyor olarak işaretlendi! 🍿`);
    } else {
      showToast(`✓ "${title}" izlenecekler listesine eklendi! ✨`);
    }
  };

  const handleToggleFavoriteActor = (actor: any) => {
    const actorId = Number(actor?.id);
    if (!Number.isInteger(actorId) || actorId <= 0) return;
    setFavoriteActors((prev) => {
      const normalizedPrev = normalizeFavoriteActors(prev);
      const exists = normalizedPrev.some((a) => a.id === actorId);
      if (exists) {
        showToast(`"${actor.name || 'Oyuncu'}" favori oyuncularınızdan çıkarıldı.`);
        return normalizedPrev.filter((a) => a.id !== actorId);
      } else {
        showToast(`"${actor.name || 'Oyuncu'}" favori oyuncularınıza eklendi!`);
        return normalizeFavoriteActors([
          {
            id: actorId,
            name: actor.name || 'Bilinmeyen Oyuncu',
            profile_path: actor.profile_path || '',
            character: actor.character || '',
          },
          ...normalizedPrev,
        ]);
      }
    });
    void recordProfileChangeAndMaybeBackup();
  };

  const handleIncrementTvEpisode = (targetItem: SavedItem) => {
    const result = libraryService.advanceEpisode(targetItem);
    if (!result) return;
    const updatedItem = result.item;
    void recordProfileChangeAndMaybeBackup();
    const seriesTitle = displayTitle(updatedItem);
    if (result.transitionedToCompleted) {
      showToast(`✓ "${seriesTitle}" tüm bölümler izlendi olarak tamamlandı!`);
    } else {
      showToast(
        `▶ "${seriesTitle}" S${updatedItem.current_season || 1} · B${
          (updatedItem.season_progress || {})[updatedItem.current_season || 1] || 1
        } kaydedildi.`
      );
    }
  };

  const handleMergeDuplicates = (
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ) => {
    const result = libraryService.mergeDuplicates(keepId, dropId, mediaType);
    if (!result) return;

    void recordProfileChangeAndMaybeBackup();
    showToast(`✓ "${displayTitle(result.mergedItem)}" çift kaydı başarıyla birleştirildi.`);
  };

  const handleRemoveItem = (item: any) => {
    const itemKey = makeMediaKey(item);
    libraryService.removeItem(item);

    try {
      const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
      markTasteMapItemStatus(currentTasteMap, itemKey, 'active');
      savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
      const nextMap = { ...currentTasteMap };
      tasteMapRef.current = nextMap;
      setTasteMap(nextMap);
    } catch {}

    void recordProfileChangeAndMaybeBackup();
    showToast(`"${displayTitle(item)}" listeden kaldırıldı.`);
  };

  const handleToggleDislike = (key: string) => {
    setPreferences((prev) => {
      const isCurrentlyDisliked = prev.disliked.includes(key);
      const disliked = isCurrentlyDisliked
        ? prev.disliked.filter((k) => k !== key)
        : [...prev.disliked, key].slice(-500);

      // Cache disliked item details so "İlgilenmediklerim" tab can display posters & details
      if (!isCurrentlyDisliked) {
        const target =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        if (target) {
          setDislikedItems((current) => {
            if (current.some((item) => `${item.media_type}:${item.id}` === key)) return current;
            const updated = [target, ...current];
            try {
              const cache: Record<string, any> = {};
              updated.forEach((item) => {
                cache[`${item.media_type}:${item.id}`] = item;
              });
              localStorage.setItem('cinetrack_disliked_cache', JSON.stringify(cache));
            } catch {}
            return updated;
          });
        }
      }

      showToast(
        isCurrentlyDisliked
          ? 'İlgilenmiyorum listesinden kaldırıldı.'
          : '🚫 İlgilenmiyorum olarak işaretlendi (Önerilerden gizlendi).'
      );

      // Sorun D: Kalıcı Zevk Haritasında yapımı 'disliked' veya 'active' olarak güncelle
      try {
        const currentTasteMap = loadPersistentTasteMap(activeProfileIdRef.current);
        markTasteMapItemStatus(currentTasteMap, key, isCurrentlyDisliked ? 'active' : 'disliked');
        savePersistentTasteMap(activeProfileIdRef.current, currentTasteMap);
        const nextMap = { ...currentTasteMap };
        tasteMapRef.current = nextMap;
        setTasteMap(nextMap);
      } catch {}

      if (!isCurrentlyDisliked) {
        const [mType, rawId] = key.split(':');
        if (mType && rawId) {
          void consumeStockItem({ id: rawId, media_type: mType }, activeProfileIdRef.current);
        }
        const targetMeta =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        dislikeItem(key, targetMeta as Record<string, unknown> | undefined);
      }

      return { ...prev, disliked };
    });
    void recordProfileChangeAndMaybeBackup();
  };

  const handleToggleHide = (key: string) => {
    setPreferences((prev) => {
      const currentHidden = Array.isArray(prev.hidden) ? prev.hidden : [];
      const isCurrentlyHidden = currentHidden.includes(key);
      const hidden = isCurrentlyHidden
        ? currentHidden.filter((k) => k !== key)
        : [...currentHidden, key].slice(-500);

      showToast(
        isCurrentlyHidden
          ? 'Gizlenenler listesinden kaldırıldı.'
          : 'İçerik zevk profilinizi etkilemeden keşfet akışından gizlendi.'
      );

      if (!isCurrentlyHidden) {
        const [mType, rawId] = key.split(':');
        if (mType && rawId) {
          void consumeStockItem({ id: rawId, media_type: mType }, activeProfileIdRef.current);
        }
        const targetMeta =
          catalogItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          forYouItems.find((c) => `${c.media_type}:${c.id}` === key) ||
          savedItems.find((s) => `${s.media_type}:${s.id}` === key);
        hideItem(key, targetMeta as Record<string, unknown> | undefined);
      }

      return { ...prev, hidden };
    });
    void recordProfileChangeAndMaybeBackup();
  };

  return {
    commitSavedItem,
    handleSaveItem,
    handleQuickAdd,
    handleMarkCompleted,
    handleSetStatus,
    handleToggleFavoriteActor,
    handleIncrementTvEpisode,
    handleMergeDuplicates,
    handleRemoveItem,
    handleToggleDislike,
    handleToggleHide,
  };
}
