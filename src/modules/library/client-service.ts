/**
 * MIA Faz 7 — İstemci Kütüphane Servisi (UI'nin TEK yazma hattı).
 *
 * Sorumluluk:
 * - Kullanıcı kütüphanesine dokunan bütün UI komutlarını (kaydet, puanla,
 *   durum değiştir, kaldır, bölüm ilerlet, çift kayıt birleştir, ilgilenmiyorum,
 *   gizle) tek bir hattan geçirmek. Mobil ve masaüstü arayüzü aynı servis
 *   örneğini kullanır; ikinci bir iş kuralı seti oluşmaz.
 * - Kurallar `modules/library/operations.ts` (sunucu Library Manager ile ortak
 *   tek kaynak) üzerinden uygulanır.
 * - Olay üretimi mevcut `AppEventBus` sözleşmesine (`createAppEvent`) göredir;
 *   servis ikinci bir olay/kuyruk katmanı KURMAZ.
 * - Kalıcılık ve yan etkiler enjekte edilir (`applySavedItem`, `applySavedItems`,
 *   `applyTombstone`, `onItemRemoved`); servis React, ağ ya da depo ayrıntısı
 *   bilmez (server → istemci sınırı korunur).
 *
 * SINIR: Bu servis zevk/hafıza verisine doğrudan yazmaz. Kütüphane yazımı
 * yalnızca kullanıcı kaydını değiştirir; ortak içerik metaverisi ve hafıza
 * katmanı bu hattın dışındadır.
 */

import { createAppEvent } from '../../shared/runtime/app-event-bus.ts';
import type {
  IEventPublisher,
  IProfileContext,
  TypedAppEvent,
  WriteProfileRef,
} from '../../contracts/index.ts';
import { findSavedItem, type SavedItem } from '../../core/cinetrack-core.ts';
import { mergeDuplicateSavedPair } from '../../core/duplicate-detector.ts';
import { makeMediaKey } from '../../core/keys.ts';
import type { TasteEvent, TasteMetadataInput } from '../../core/taste/types.ts';
import { advanceTvEpisodeProgress } from '../../core/tv-progress.ts';
import {
  extractTasteMetadataFromItem,
  postTasteEvent,
  registerTasteMetadataForEvent,
} from '../../services/taste-api.ts';
import {
  buildLibraryItem,
  mapWatchStatusToLibraryList,
  type ItemWatchStatus,
} from './operations.ts';

/** UI'nin kütüphane üzerinde çalıştırabildiği komutların tam listesi. */
export type ClientLibraryCommand =
  | 'save'
  | 'rate'
  | 'set-status'
  | 'remove'
  | 'advance-episode'
  | 'merge-duplicates'
  | 'dislike'
  | 'hide';

/** Tek hat üzerinden yürüyen komutlar (sözleşme/test kaydı). */
export const CLIENT_LIBRARY_COMMANDS: readonly ClientLibraryCommand[] = [
  'save',
  'rate',
  'set-status',
  'remove',
  'advance-episode',
  'merge-duplicates',
  'dislike',
  'hide',
];

/** Kütüphane komutlarının yönettiği toplam adım sayısı — hattın kimliği. */
export const CLIENT_LIBRARY_PIPELINE_ID = 'library-client';

export interface ClientLibraryServiceOptions {
  /** Güncel kütüphane listesi (profil izolasyonu çağıranın sorumluluğunda). */
  readonly getSavedItems: () => SavedItem[];
  /**
   * ZORUNLU kalıcılık kancası: normalleştirilmiş kaydı uygular. Mevcut
   * uygulama davranışı gereği olay yayımından ÖNCE çağrılır.
   */
  readonly applySavedItem: (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: ItemWatchStatus
  ) => void;
  /** Liste bütünüyle değiştiğinde (kaldırma/birleştirme/ilerleme) tek sink. */
  readonly applySavedItems: (items: SavedItem[]) => void;
  /** Silme tombstone'u (profil bazlı; mevcut `deleted_keys` biçimi). */
  readonly applyTombstone?: (mediaKey: string, deletedAtIso: string) => void;
  /** Kaldırma sonrası profil yan etkileri (zevk haritası, yedek vb.). */
  readonly onItemRemoved?: (removed: SavedItem, mediaKey: string) => void;
  readonly profileContext?: IProfileContext | null;
  readonly eventPublisher?: IEventPublisher | null;
  readonly onEventPersistError?: (error: unknown, event?: TypedAppEvent) => void;
  /** Deterministik test için zaman kaynağı. */
  readonly now?: () => string;
}

export interface AdvanceEpisodeResult {
  readonly item: SavedItem;
  readonly transitionedToCompleted: boolean;
}

export interface MergeDuplicatesResult {
  readonly mergedItem: SavedItem;
  readonly mergedItems: SavedItem[];
  readonly dropKey: string;
}

function generateTasteEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function reportPersistenceFailure(
  error: unknown,
  event?: TypedAppEvent,
  onError?: (error: unknown, event?: TypedAppEvent) => void
): void {
  if (onError) {
    onError(error, event);
    return;
  }
  console.error('[client-library] Olay kalıcılık hatası:', error);
}

function dispatchLiveTasteEvent(
  event: TasteEvent,
  rawItem?: Record<string, unknown>,
  onError?: (error: unknown) => void
): void {
  if (typeof window === 'undefined' || typeof fetch !== 'function') {
    return;
  }
  const metadata = rawItem ? extractTasteMetadataFromItem(rawItem) : undefined;
  void postTasteEvent(event, metadata).catch((error) => {
    reportPersistenceFailure(error, undefined, onError ? (e) => onError(e) : undefined);
  });
}

function hasValidRating(rating: number | '' | null | undefined): rating is number {
  return (
    typeof rating === 'number' && Number.isFinite(rating) && rating >= 1 && rating <= 10
  );
}

/**
 * İlgilenmiyorum (preferences.disliked -> content_disliked, TP-018 negatif sinyal)
 * olayı üretir.
 */
export function emitDislikeTasteEvent(
  contentId: string,
  rawItem?: Record<string, unknown>,
  onError?: (error: unknown) => void
): TasteEvent | null {
  if (!/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)) return null;
  const nowIso = new Date().toISOString();
  const event: TasteEvent = {
    eventId: generateTasteEventId(),
    contentId,
    eventType: 'content_disliked',
    payload: {
      newValue: true,
      reason: 'disliked',
    },
    recordedAt: nowIso,
    experiencedAt: nowIso,
    timeSource: 'actual',
    timePrecision: 'exact',
  };
  dispatchLiveTasteEvent(event, rawItem, onError);
  return event;
}

/**
 * Gizle (preferences.hidden -> content_hidden, TP-018 nötr dışlama) olayı üretir.
 */
export function emitHideTasteEvent(
  contentId: string,
  rawItem?: Record<string, unknown>,
  onError?: (error: unknown) => void
): TasteEvent | null {
  if (!/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)) return null;
  const nowIso = new Date().toISOString();
  const event: TasteEvent = {
    eventId: generateTasteEventId(),
    contentId,
    eventType: 'content_hidden',
    payload: {
      newValue: true,
    },
    recordedAt: nowIso,
    experiencedAt: nowIso,
    timeSource: 'actual',
    timePrecision: 'exact',
  };
  dispatchLiveTasteEvent(event, rawItem, onError);
  return event;
}

/**
 * Kütüphane komutlarının tek uygulayıcısı. Arayüz yalnızca bu sınıfın
 * metotlarını çağırır; kayıt üretimi, zaman damgaları ve olaylar buradadır.
 */
export class ClientLibraryService {
  readonly pipelineId = CLIENT_LIBRARY_PIPELINE_ID;
  readonly commandNames = CLIENT_LIBRARY_COMMANDS;

  private readonly options: ClientLibraryServiceOptions;
  private readonly now: () => string;

  constructor(options: ClientLibraryServiceOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  private getWritableProfileRef(): WriteProfileRef {
    const { profileContext } = this.options;
    if (profileContext) {
      const current = profileContext.getCurrent();
      profileContext.assertWritable(current);
      return current;
    }
    return { profileId: 'default', revision: 0 };
  }

  private publishDomainEvent(event: TypedAppEvent, metadata?: TasteMetadataInput): void {
    const { eventPublisher, onEventPersistError } = this.options;
    if (!eventPublisher) return;
    if (metadata) {
      registerTasteMetadataForEvent(event.eventId, metadata);
    }
    void eventPublisher.publish(event).catch((error) => {
      reportPersistenceFailure(error, event, onEventPersistError);
    });
  }

  private emitDomainEventsForSave(
    existing: SavedItem | undefined,
    normalized: SavedItem,
    effectiveStatus: ItemWatchStatus,
    personalRating: number | '',
    prevRating: number | null,
    nowIso: string,
    profileRef: WriteProfileRef
  ): boolean {
    if (!this.options.eventPublisher) return false;
    const mediaType: 'movie' | 'tv' = normalized.media_type === 'tv' ? 'tv' : 'movie';
    const contentId = `${mediaType}:${normalized.id}`;
    const targetList = mapWatchStatusToLibraryList(effectiveStatus);
    const metadata = extractTasteMetadataFromItem(
      normalized as unknown as Record<string, unknown>
    );

    if (!existing) {
      const addedEv = createAppEvent({
        eventType: 'LibraryItemAdded',
        ref: profileRef,
        entityId: contentId,
        occurredAt: nowIso,
        payload: {
          mediaKey: contentId,
          mediaType,
          list: targetList,
        },
      });
      this.publishDomainEvent(addedEv, metadata);
    } else {
      if (existing.status !== effectiveStatus) {
        const statusEv = createAppEvent({
          eventType: 'LibraryStatusChanged',
          ref: profileRef,
          entityId: contentId,
          occurredAt: nowIso,
          payload: {
            mediaKey: contentId,
            mediaType,
            from: mapWatchStatusToLibraryList(existing.status),
            to: targetList,
          },
        });
        this.publishDomainEvent(statusEv, metadata);
      }

      const changedFields: string[] = [];
      if (existing.episodes_watched !== normalized.episodes_watched) {
        changedFields.push('episodes_watched');
      }
      if (existing.current_season !== normalized.current_season) {
        changedFields.push('current_season');
      }
      if (
        JSON.stringify(existing.season_progress ?? null) !==
        JSON.stringify(normalized.season_progress ?? null)
      ) {
        changedFields.push('season_progress');
      }
      if (changedFields.length > 0) {
        const updatedEv = createAppEvent({
          eventType: 'LibraryItemUpdated',
          ref: profileRef,
          entityId: contentId,
          occurredAt: nowIso,
          payload: {
            mediaKey: contentId,
            mediaType,
            changedFields,
          },
        });
        this.publishDomainEvent(updatedEv, metadata);
      }
    }

    if (hasValidRating(personalRating) && prevRating !== personalRating) {
      const ratingEv = createAppEvent({
        eventType: 'LibraryRatingChanged',
        ref: profileRef,
        entityId: contentId,
        occurredAt: normalized.ratedAt ?? nowIso,
        payload: {
          mediaKey: contentId,
          mediaType,
          rating: personalRating,
          previousRating: prevRating,
        },
      });
      this.publishDomainEvent(ratingEv, metadata);
    } else if (!hasValidRating(personalRating) && prevRating !== null && existing) {
      const clearedEv = createAppEvent({
        eventType: 'LibraryRatingChanged',
        ref: profileRef,
        entityId: contentId,
        occurredAt: nowIso,
        payload: {
          mediaKey: contentId,
          mediaType,
          rating: null,
          previousRating: prevRating,
        },
      });
      this.publishDomainEvent(clearedEv, metadata);
    }

    return true;
  }

  private findExisting(item: any): SavedItem | undefined {
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    return findSavedItem(this.options.getSavedItems(), {
      id: String(item.id),
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });
  }

  private commitWithTimestamps(
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {},
    forceRatedAt: boolean = false
  ): SavedItem | null {
    if (!item || item.id == null) return null;
    const profileRef = this.getWritableProfileRef();
    const existing = this.findExisting(item);

    const nowIso = this.now();
    const normalized = buildLibraryItem({
      existing,
      incoming: item,
      status,
      rating: personalRating,
      tracking,
      forceRatedAt,
      nowIso,
    });
    if (!normalized) return null;

    this.options.profileContext?.assertWritable(profileRef);
    this.options.applySavedItem(normalized, item, normalized.status as ItemWatchStatus);

    const contentId = `${normalized.media_type}:${normalized.id}`;
    const prevRating =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : null;

    const publishedViaBus = this.emitDomainEventsForSave(
      existing,
      normalized,
      normalized.status as ItemWatchStatus,
      personalRating,
      prevRating,
      nowIso,
      profileRef
    );

    if (!publishedViaBus) {
      if (hasValidRating(personalRating) && prevRating !== personalRating) {
        dispatchLiveTasteEvent(
          {
            eventId: generateTasteEventId(),
            contentId,
            eventType: 'rating_changed',
            payload: {
              previousValue: prevRating,
              newValue: personalRating,
              ratingSource: 'numeric',
            },
            recordedAt: nowIso,
            experiencedAt: normalized.ratedAt ?? nowIso,
            timeSource: 'actual',
            timePrecision: 'exact',
          },
          normalized as unknown as Record<string, unknown>,
          this.options.onEventPersistError ? (err) => this.options.onEventPersistError!(err) : undefined
        );
      } else if (!existing || existing.status !== normalized.status) {
        dispatchLiveTasteEvent(
          {
            eventId: generateTasteEventId(),
            contentId,
            eventType: 'status_changed',
            payload: {
              previousValue: existing?.status ?? null,
              newValue: normalized.status,
            },
            recordedAt: nowIso,
            experiencedAt: normalized.completedAt ?? nowIso,
            timeSource: 'actual',
            timePrecision: 'exact',
          },
          normalized as unknown as Record<string, unknown>,
          this.options.onEventPersistError ? (err) => this.options.onEventPersistError!(err) : undefined
        );
      }
    }

    return normalized;
  }

  /** `save` — yeni kayıt veya mevcut kaydın durum/puan güncellemesi. */
  saveItem(
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null {
    return this.commitWithTimestamps(item, status, personalRating, tracking, false);
  }

  /** `rate` — puanlama; izlenecekler durumundaki kayıt izlendiye geçer. */
  rateItem(
    item: any,
    rating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null {
    if (!item || item.id == null) return null;
    const existing = this.findExisting(item);
    const valid = hasValidRating(rating);
    const currentStatus: ItemWatchStatus = existing?.status ?? item.status ?? 'watchlist';
    const nextStatus: ItemWatchStatus =
      valid && currentStatus === 'watchlist' ? 'completed' : currentStatus;

    return this.commitWithTimestamps(
      item,
      nextStatus,
      valid ? rating : '',
      tracking,
      valid
    );
  }

  /** `set-status` — durum değişikliği, mevcut puan korunur. */
  setItemStatus(
    item: any,
    status: ItemWatchStatus,
    tracking: Record<string, any> = {}
  ): SavedItem | null {
    if (!item || item.id == null) return null;
    const existing = this.findExisting(item);
    const preservedRating: number | '' =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : '';

    return this.commitWithTimestamps(item, status, preservedRating, tracking, false);
  }

  markCompleted(item: any, tracking: Record<string, any> = {}): SavedItem | null {
    return this.setItemStatus(item, 'completed', tracking);
  }

  addToWatchlist(item: any, tracking: Record<string, any> = {}): SavedItem | null {
    return this.setItemStatus(item, 'watchlist', tracking);
  }

  /** `remove` — kullanıcı kaydını kaldırır, tombstone yazar; içeriğe dokunmaz. */
  removeItem(item: any): SavedItem | null {
    if (!item) return null;
    const itemKey = makeMediaKey(item);
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetTitle = (item.title || item.name || '').trim().toLowerCase();
    const current = this.options.getSavedItems();
    const removed =
      current.find((entry) => makeMediaKey(entry) === itemKey) ??
      current.find(
        (entry) =>
          Boolean(targetTitle) &&
          entry.media_type === mediaType &&
          (entry.title || '').trim().toLowerCase() === targetTitle
      ) ??
      null;

    const next = current.filter(
      (entry) =>
        makeMediaKey(entry) !== itemKey &&
        (!targetTitle ||
          entry.media_type !== mediaType ||
          (entry.title || '').trim().toLowerCase() !== targetTitle)
    );

    if (removed && /^(movie|tv):/.test(itemKey)) {
      this.options.applyTombstone?.(itemKey, this.now());
    }
    this.options.applySavedItems(next);
    if (removed) {
      this.options.onItemRemoved?.(removed, itemKey);
    }
    return removed;
  }

  /** `advance-episode` — dizi ilerlemesi (mevcut `core/tv-progress` kuralı). */
  advanceEpisode(targetItem: SavedItem): AdvanceEpisodeResult | null {
    if (!targetItem) return null;
    const nowIso = this.now();
    const progressedItem = advanceTvEpisodeProgress(targetItem, nowIso);
    const transitionedToCompleted =
      targetItem.status !== 'completed' && progressedItem.status === 'completed';
    const updatedItem: SavedItem = transitionedToCompleted
      ? { ...progressedItem, completedAt: nowIso }
      : progressedItem;

    const next = this.options
      .getSavedItems()
      .map((entry) =>
        makeMediaKey(entry) === makeMediaKey(targetItem) ? updatedItem : entry
      );
    this.options.applySavedItems(next);
    return { item: updatedItem, transitionedToCompleted };
  }

  /** `merge-duplicates` — çift kaydı birleştirir, düşen anahtarı tombstone'lar. */
  mergeDuplicates(
    keepId: SavedItem['id'],
    dropId: SavedItem['id'],
    mediaType: 'movie' | 'tv'
  ): MergeDuplicatesResult | null {
    const { mergedItems, mergedItem, removedKey } = mergeDuplicateSavedPair(
      this.options.getSavedItems(),
      keepId,
      dropId,
      mediaType
    );
    if (!mergedItem) return null;

    const dropKey = removedKey || makeMediaKey(mediaType, dropId);
    this.options.applyTombstone?.(dropKey, this.now());
    this.options.applySavedItems(mergedItems);
    return { mergedItem, mergedItems, dropKey };
  }

  /** `dislike` — ilgilenmiyorum; olay yayımcısı varsa domain + zevk olayı. */
  dislikeItem(contentId: string, rawItem?: Record<string, unknown>): TasteEvent | null {
    if (!/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)) return null;
    const { eventPublisher, onEventPersistError } = this.options;
    if (eventPublisher) {
      const profileRef = this.getWritableProfileRef();
      const mediaType: 'movie' | 'tv' = contentId.startsWith('tv:') ? 'tv' : 'movie';
      const nowIso = this.now();
      const eventId = generateTasteEventId();
      const domainEv = createAppEvent({
        eventId,
        eventType: 'LibraryStatusChanged',
        ref: profileRef,
        entityId: contentId,
        occurredAt: nowIso,
        payload: {
          mediaKey: contentId,
          mediaType,
          from: null,
          to: 'not-interested',
        },
      });
      const meta = rawItem ? extractTasteMetadataFromItem(rawItem) : undefined;
      this.publishDomainEvent(domainEv, meta);
      return {
        eventId,
        contentId,
        eventType: 'content_disliked',
        payload: {
          newValue: true,
          reason: 'disliked',
        },
        recordedAt: nowIso,
        experiencedAt: nowIso,
        timeSource: 'actual',
        timePrecision: 'exact',
      };
    }
    return emitDislikeTasteEvent(
      contentId,
      rawItem,
      onEventPersistError ? (err) => onEventPersistError(err) : undefined
    );
  }

  /** `hide` — gizle; nötr dışlama olayı. */
  hideItem(contentId: string, rawItem?: Record<string, unknown>): TasteEvent | null {
    return emitHideTasteEvent(
      contentId,
      rawItem,
      this.options.onEventPersistError
        ? (err) => this.options.onEventPersistError!(err)
        : undefined
    );
  }
}

export function createClientLibraryService(
  options: ClientLibraryServiceOptions
): ClientLibraryService {
  return new ClientLibraryService(options);
}
