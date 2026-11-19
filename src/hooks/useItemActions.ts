// ===========================================================================
// Cinethos V1.5 (Feedback Intelligence) — useItemActions Hook
//
// MIA Faz 7: Bu hook artık bir UYUMLULUK ADAPTÖRÜDÜR. Kütüphane yazma
// kuralları, zaman damgaları ve olay üretimi tek hatta
// (`src/modules/library/client-service.ts`) yaşar. Mobil ve masaüstü arayüzü
// aynı `ClientLibraryService` örneğini paylaşır; hook yalnızca mevcut API'yi
// (saveItem/rateItem/...) korur.
//
// MIA Faz 3: kayıt üretimi `modules/library/operations.ts` üzerinden yapılır
// (sunucu Library Manager ile ortak tek kaynak).
// ===========================================================================

import type {
  IEventPublisher,
  IProfileContext,
  TypedAppEvent,
} from '../contracts/index.ts';
import type { SavedItem } from '../core/cinetrack-core.ts';
import type { TasteEvent } from '../core/taste/types.ts';
import type { ItemWatchStatus } from '../modules/library/operations.ts';
import {
  createClientLibraryService,
  type ClientLibraryService,
} from '../modules/library/client-service.ts';

// MIA Faz 3/7: kurallar ve zil olayları tek kaynakta; eski import yolları
// bozulmasın diye buradan yeniden dışa açılır.
export {
  emitDislikeTasteEvent,
  emitHideTasteEvent,
} from '../modules/library/client-service.ts';
export { mapWatchStatusToLibraryList, resolveItemActionTimestamps } from '../modules/library/operations.ts';
export type {
  ItemWatchStatus,
  ResolvedItemTimestamps,
  ResolveTimestampOptions,
} from '../modules/library/operations.ts';
export type { ClientLibraryCommand } from '../modules/library/client-service.ts';

export interface UseItemActionsHandlers {
  getSavedItems: () => SavedItem[];
  onCommitSavedItem: (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: ItemWatchStatus
  ) => void;
  /** Faz 7: liste bütünüyle değiştiğinde (kaldırma/birleştirme/ilerleme) sink. */
  applySavedItems?: (items: SavedItem[]) => void;
  profileContext?: IProfileContext | null;
  eventPublisher?: IEventPublisher | null;
  onEventPersistError?: (error: unknown, event?: TypedAppEvent) => void;
  /**
   * Faz 7: uygulamanın tek kütüphane hattı. Verilirse hook yeni bir örnek
   * KURMAZ; arayüzün tamamı aynı hattı paylaşır.
   */
  service?: ClientLibraryService;
}

export interface UseItemActionsResult {
  saveItem: (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking?: Record<string, any>
  ) => SavedItem | null;
  rateItem: (
    item: any,
    rating: number | '',
    tracking?: Record<string, any>
  ) => SavedItem | null;
  setItemStatus: (
    item: any,
    status: ItemWatchStatus,
    tracking?: Record<string, any>
  ) => SavedItem | null;
  markCompleted: (
    item: any,
    tracking?: Record<string, any>
  ) => SavedItem | null;
  addToWatchlist: (
    item: any,
    tracking?: Record<string, any>
  ) => SavedItem | null;
  dislikeItem: (
    contentId: string,
    rawItem?: Record<string, unknown>
  ) => TasteEvent | null;
  hideItem: (
    contentId: string,
    rawItem?: Record<string, unknown>
  ) => TasteEvent | null;
}

/**
 * İçerik kaydetme, puanlama (`rateItem`) ve durum değiştirme (`completed`)
 * eylemlerini V1.5 zaman damgalarıyla (`ratedAt`, `completedAt`) ve MIA
 * AppEventBus sözleşmesiyle yürüten adaptör.
 *
 * Kural: Kendi kayıt üretim kopyasını BULUNDURMAZ; her çağrı
 * `ClientLibraryService` hattına düşer.
 */
export function useItemActions(handlers: UseItemActionsHandlers): UseItemActionsResult {
  const service =
    handlers.service ??
    createClientLibraryService({
      getSavedItems: handlers.getSavedItems,
      applySavedItem: handlers.onCommitSavedItem,
      applySavedItems: handlers.applySavedItems ?? (() => {}),
      profileContext: handlers.profileContext,
      eventPublisher: handlers.eventPublisher,
      onEventPersistError: handlers.onEventPersistError,
    });

  return {
    saveItem: (item, status, personalRating, tracking) =>
      service.saveItem(item, status, personalRating, tracking),
    rateItem: (item, rating, tracking) => service.rateItem(item, rating, tracking),
    setItemStatus: (item, status, tracking) =>
      service.setItemStatus(item, status, tracking),
    markCompleted: (item, tracking) => service.markCompleted(item, tracking),
    addToWatchlist: (item, tracking) => service.addToWatchlist(item, tracking),
    dislikeItem: (contentId, rawItem) => service.dislikeItem(contentId, rawItem),
    hideItem: (contentId, rawItem) => service.hideItem(contentId, rawItem),
  };
}
