// ===========================================================================
// Cinethos V1.5 (Feedback Intelligence) — useItemActions Hook
// Puanlama (rateItem -> ratedAt) ve durum tamamlama (status === 'completed' -> completedAt)
// işlemlerinde gerçek zamanlı ISO-8601 zaman damgalarını yönetir.
// MIA Faz 1: Kütüphane mutasyonlarını AppEventBus + ProfileContext üzerinden yayınlar.
// ===========================================================================

import { createAppEvent } from '../app/app-event-bus.ts';
import type {
  IEventPublisher,
  IProfileContext,
  LibraryListId,
  TypedAppEvent,
  WriteProfileRef,
} from '../contracts/index.ts';
import { findSavedItem, normalizeSavedItem, type SavedItem } from '../core/cinetrack-core.ts';
import type { TasteEvent, TasteMetadataInput } from '../core/taste/types.ts';
import {
  extractTasteMetadataFromItem,
  postTasteEvent,
  registerTasteMetadataForEvent,
} from '../services/taste-api.ts';

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
  console.error('[useItemActions] Olay kalıcılık hatası:', error);
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

export function mapWatchStatusToLibraryList(status?: ItemWatchStatus | string | null): LibraryListId {
  switch (status) {
    case 'completed':
      return 'watched';
    case 'watching':
      return 'watching';
    default:
      return 'watchlist';
  }
}

/**
 * İlgilenmiyorum (preferences.disliked -> content_disliked, TP-018 negatif sinyal) olayı üretir.
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

export type ItemWatchStatus = 'watching' | 'watchlist' | 'completed';

export interface ResolvedItemTimestamps {
  effectiveStatus: ItemWatchStatus;
  ratedAt?: string;
  completedAt?: string;
  addedAt: string;
  updatedAt: string;
  personalRatingCleared: boolean;
}

export interface ResolveTimestampOptions {
  /** rateItem doğrudan çağrıldığında mevcut puan aynı olsa bile ratedAt yenilenir */
  forceRatedAt?: boolean;
  /** Test edilebilirlik için opsiyonel ISO zaman damgası (varsayılan: new Date().toISOString()) */
  nowIso?: string;
}

/**
 * Puanlama ve durum geçişleri için V1.5 zaman damgalarını belirler.
 * - Yeni bir puan verildiğinde veya puan değiştiğinde `ratedAt` güncellenir.
 * - `status` 'completed' durumuna geçtiğinde `completedAt` güncellenir.
 * - Eski (imported) kayıtlarda ilgili alan değişmediyse `undefined` korunur.
 */
export function resolveItemActionTimestamps(
  existing: SavedItem | undefined,
  requestedStatus: ItemWatchStatus,
  personalRating: number | '',
  options: ResolveTimestampOptions = {}
): ResolvedItemTimestamps {
  const nowIso = options.nowIso ?? new Date().toISOString();
  const hasValidRating =
    typeof personalRating === 'number' &&
    Number.isFinite(personalRating) &&
    personalRating >= 1 &&
    personalRating <= 10;

  const effectiveStatus: ItemWatchStatus =
    hasValidRating && (requestedStatus === 'watchlist' || !requestedStatus)
      ? 'completed'
      : requestedStatus;

  const existingHasValidRating = Boolean(
    existing &&
      existing.personal_rating !== '' &&
      Number.isFinite(Number(existing.personal_rating)) &&
      Number(existing.personal_rating) >= 1 &&
      Number(existing.personal_rating) <= 10
  );

  const personalRatingCleared = Boolean(existingHasValidRating && !hasValidRating);

  let ratedAt: string | undefined;
  if (hasValidRating) {
    const ratingChanged =
      !existingHasValidRating || Number(existing?.personal_rating) !== personalRating;
    ratedAt = options.forceRatedAt || ratingChanged ? nowIso : existing?.ratedAt;
  } else {
    ratedAt = undefined;
  }

  let completedAt: string | undefined;
  if (effectiveStatus === 'completed') {
    const transitionedToCompleted = !existing || existing.status !== 'completed';
    completedAt = transitionedToCompleted ? nowIso : existing.completedAt;
  } else {
    completedAt = undefined;
  }

  return {
    effectiveStatus,
    ratedAt,
    completedAt,
    addedAt: existing?.addedAt || nowIso,
    updatedAt: nowIso,
    personalRatingCleared,
  };
}

export interface UseItemActionsHandlers {
  getSavedItems: () => SavedItem[];
  onCommitSavedItem: (
    normalized: SavedItem,
    rawItem: any,
    effectiveStatus: ItemWatchStatus
  ) => void;
  profileContext?: IProfileContext | null;
  eventPublisher?: IEventPublisher | null;
  onEventPersistError?: (error: unknown, event?: TypedAppEvent) => void;
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
 * İçerik kaydetme, puanlama (`rateItem`) ve durum değiştirme (`completed`) eylemlerini
 * V1.5 zaman damgalarıyla (`ratedAt`, `completedAt`) ve MIA AppEventBus sözleşmesiyle yürüten hook.
 */
export function useItemActions(handlers: UseItemActionsHandlers): UseItemActionsResult {
  const {
    getSavedItems,
    onCommitSavedItem,
    profileContext,
    eventPublisher,
    onEventPersistError,
  } = handlers;

  const getWritableProfileRef = (): WriteProfileRef => {
    if (profileContext) {
      const current = profileContext.getCurrent();
      profileContext.assertWritable(current);
      return current;
    }
    return { profileId: 'default', revision: 0 };
  };

  const publishDomainEvent = (
    event: TypedAppEvent,
    metadata?: TasteMetadataInput
  ): void => {
    if (!eventPublisher) return;
    if (metadata) {
      registerTasteMetadataForEvent(event.eventId, metadata);
    }
    void eventPublisher.publish(event).catch((error) => {
      reportPersistenceFailure(error, event, onEventPersistError);
    });
  };

  const emitDomainEventsForSave = (
    existing: SavedItem | undefined,
    normalized: SavedItem,
    effectiveStatus: ItemWatchStatus,
    personalRating: number | '',
    prevRating: number | null,
    nowIso: string,
    profileRef: WriteProfileRef
  ): boolean => {
    if (!eventPublisher) return false;
    const mediaType: 'movie' | 'tv' = normalized.media_type === 'tv' ? 'tv' : 'movie';
    const contentId = `${mediaType}:${normalized.id}`;
    const targetList = mapWatchStatusToLibraryList(effectiveStatus);
    const metadata = extractTasteMetadataFromItem(
      normalized as unknown as Record<string, unknown>
    );

    const hasValidRating =
      typeof personalRating === 'number' &&
      Number.isFinite(personalRating) &&
      personalRating >= 1 &&
      personalRating <= 10;

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
      publishDomainEvent(addedEv, metadata);
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
        publishDomainEvent(statusEv, metadata);
      }

      const changedFields: string[] = [];
      if (existing.episodes_watched !== normalized.episodes_watched) changedFields.push('episodes_watched');
      if (existing.current_season !== normalized.current_season) changedFields.push('current_season');
      if (JSON.stringify(existing.season_progress ?? null) !== JSON.stringify(normalized.season_progress ?? null)) {
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
        publishDomainEvent(updatedEv, metadata);
      }
    }

    if (hasValidRating && prevRating !== personalRating) {
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
      publishDomainEvent(ratingEv, metadata);
    } else if (!hasValidRating && prevRating !== null && existing) {
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
      publishDomainEvent(clearedEv, metadata);
    }

    return true;
  };

  const commitWithTimestamps = (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {},
    forceRatedAt: boolean = false
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const profileRef = getWritableProfileRef();
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const targetId = String(item.id);
    const existing = findSavedItem(getSavedItems(), {
      id: targetId,
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });

    const nowIso = new Date().toISOString();
    const timestamps = resolveItemActionTimestamps(existing, status, personalRating, {
      forceRatedAt,
      nowIso,
    });

    const normalized = normalizeSavedItem({
      ...existing,
      ...item,
      media_type: mediaType,
      ...tracking,
      status: timestamps.effectiveStatus,
      personal_rating: personalRating || '',
      personal_rating_cleared: timestamps.personalRatingCleared,
      ratedAt: timestamps.ratedAt,
      completedAt: timestamps.completedAt,
      addedAt: timestamps.addedAt,
      updatedAt: timestamps.updatedAt,
      isDemo: false,
    });
    if (!normalized) return null;

    if (profileContext) {
      profileContext.assertWritable(profileRef);
    }

    onCommitSavedItem(normalized, item, timestamps.effectiveStatus);

    const contentId = `${normalized.media_type}:${normalized.id}`;
    const hasValidRating =
      typeof personalRating === 'number' &&
      Number.isFinite(personalRating) &&
      personalRating >= 1 &&
      personalRating <= 10;
    const prevRating =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : null;

    const publishedViaBus = emitDomainEventsForSave(
      existing,
      normalized,
      timestamps.effectiveStatus,
      personalRating,
      prevRating,
      nowIso,
      profileRef
    );

    if (!publishedViaBus) {
      if (hasValidRating && prevRating !== personalRating) {
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
            experiencedAt: timestamps.ratedAt ?? nowIso,
            timeSource: 'actual',
            timePrecision: 'exact',
          },
          normalized as unknown as Record<string, unknown>,
          onEventPersistError ? (err) => onEventPersistError(err) : undefined
        );
      } else if (!existing || existing.status !== timestamps.effectiveStatus) {
        dispatchLiveTasteEvent(
          {
            eventId: generateTasteEventId(),
            contentId,
            eventType: 'status_changed',
            payload: {
              previousValue: existing?.status ?? null,
              newValue: timestamps.effectiveStatus,
            },
            recordedAt: nowIso,
            experiencedAt: timestamps.completedAt ?? nowIso,
            timeSource: 'actual',
            timePrecision: 'exact',
          },
          normalized as unknown as Record<string, unknown>,
          onEventPersistError ? (err) => onEventPersistError(err) : undefined
        );
      }
    }

    return normalized;
  };

  const saveItem = (
    item: any,
    status: ItemWatchStatus,
    personalRating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    return commitWithTimestamps(item, status, personalRating, tracking, false);
  };

  const rateItem = (
    item: any,
    rating: number | '',
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const profileRef = getWritableProfileRef();
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const existing = findSavedItem(getSavedItems(), {
      id: String(item.id),
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });
    const hasValidRating =
      typeof rating === 'number' && Number.isFinite(rating) && rating >= 1 && rating <= 10;
    const currentStatus: ItemWatchStatus = existing?.status ?? item.status ?? 'watchlist';
    const nextStatus: ItemWatchStatus =
      hasValidRating && currentStatus === 'watchlist' ? 'completed' : currentStatus;

    // rateItem çalıştığında ratedAt alanı new Date().toISOString() ile güncellenir
    const ratedNowIso = new Date().toISOString();
    const timestamps = resolveItemActionTimestamps(existing, nextStatus, rating, {
      forceRatedAt: hasValidRating,
      nowIso: ratedNowIso,
    });

    const normalized = normalizeSavedItem({
      ...existing,
      ...item,
      media_type: mediaType,
      ...tracking,
      status: timestamps.effectiveStatus,
      personal_rating: hasValidRating ? rating : '',
      personal_rating_cleared: timestamps.personalRatingCleared,
      ratedAt: hasValidRating ? ratedNowIso : undefined,
      completedAt:
        timestamps.effectiveStatus === 'completed'
          ? !existing || existing.status !== 'completed'
            ? ratedNowIso
            : existing.completedAt
          : undefined,
      addedAt: timestamps.addedAt,
      updatedAt: ratedNowIso,
      isDemo: false,
    });
    if (!normalized) return null;

    if (profileContext) {
      profileContext.assertWritable(profileRef);
    }

    onCommitSavedItem(normalized, item, timestamps.effectiveStatus);

    const prevRating =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : null;

    const publishedViaBus = emitDomainEventsForSave(
      existing,
      normalized,
      timestamps.effectiveStatus,
      hasValidRating ? rating : '',
      prevRating,
      ratedNowIso,
      profileRef
    );

    if (!publishedViaBus && hasValidRating) {
      dispatchLiveTasteEvent(
        {
          eventId: generateTasteEventId(),
          contentId: `${normalized.media_type}:${normalized.id}`,
          eventType: 'rating_changed',
          payload: {
            previousValue: prevRating,
            newValue: rating,
            ratingSource: 'numeric',
          },
          recordedAt: ratedNowIso,
          experiencedAt: ratedNowIso,
          timeSource: 'actual',
          timePrecision: 'exact',
        },
        normalized as unknown as Record<string, unknown>,
        onEventPersistError ? (err) => onEventPersistError(err) : undefined
      );
    }

    return normalized;
  };

  const setItemStatus = (
    item: any,
    status: ItemWatchStatus,
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    if (!item || item.id == null) return null;
    const mediaType = item.media_type || (item.title ? 'movie' : 'tv');
    const existing = findSavedItem(getSavedItems(), {
      id: String(item.id),
      media_type: mediaType,
      title: item.title,
      name: item.name,
    });
    const preservedRating: number | '' =
      existing && existing.personal_rating !== '' && Number(existing.personal_rating) >= 1
        ? Number(existing.personal_rating)
        : '';

    // status 'completed' olarak değiştiğinde completedAt alanı new Date().toISOString() ile güncellenir
    return commitWithTimestamps(item, status, preservedRating, tracking, false);
  };

  const markCompleted = (
    item: any,
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    return setItemStatus(item, 'completed', tracking);
  };

  const addToWatchlist = (
    item: any,
    tracking: Record<string, any> = {}
  ): SavedItem | null => {
    return setItemStatus(item, 'watchlist', tracking);
  };

  const dislikeItem = (
    contentId: string,
    rawItem?: Record<string, unknown>
  ): TasteEvent | null => {
    if (!/^(movie|tv):[A-Za-z0-9_-]+$/.test(contentId)) return null;
    if (eventPublisher) {
      const profileRef = getWritableProfileRef();
      const mediaType: 'movie' | 'tv' = contentId.startsWith('tv:') ? 'tv' : 'movie';
      const nowIso = new Date().toISOString();
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
      publishDomainEvent(domainEv, meta);
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
  };

  const hideItem = (
    contentId: string,
    rawItem?: Record<string, unknown>
  ): TasteEvent | null => {
    return emitHideTasteEvent(
      contentId,
      rawItem,
      onEventPersistError ? (err) => onEventPersistError(err) : undefined
    );
  };

  return {
    saveItem,
    rateItem,
    setItemStatus,
    markCompleted,
    addToWatchlist,
    dislikeItem,
    hideItem,
  };
}
