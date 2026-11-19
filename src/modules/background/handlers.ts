/**
 * MIA Faz 4 — Pilot işleyiciler (audit-only).
 *
 * Onaylanan kapsam (docs/mia/faz4-background-manager-tasarim.md §5-A):
 * - `LibraryItemAdded` ve `LibraryRatingChanged` olayları için salt-okunur
 *   doğrulama yapılır; içerik/öneri/zevk algoritmalarına yan etki ÜRETİLMEZ.
 * - Her işleyici önce görevin profilinin hâlâ aktif olduğunu doğrular; profil
 *   değiştiyse HİÇBİR yazma yapılmaz (`ProfileConflictError` → retry/failed).
 *
 * Gerçek yan etkiler (içerik zenginleştirme, türetilmiş önbellek vb.) sonraki
 * fazlarda, mevcut servisler üzerinden eklenecektir; bu dosya onları taklit
 * etmez ve paralel iş üretmez.
 */

import {
  ProfileConflictError,
  type BackgroundTaskHandler,
  type BackgroundTaskHandlerContext,
  type TypedAppEvent,
} from '../../contracts/index.ts';
import { parseMediaKey } from '../../core/keys.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import { PermanentBackgroundError } from './errors.ts';

interface ItemAddedPayload {
  readonly mediaKey?: unknown;
  readonly mediaType?: unknown;
  readonly list?: unknown;
}

interface RatingChangedPayload {
  readonly mediaKey?: unknown;
  readonly mediaType?: unknown;
  readonly rating?: unknown;
}

/** Görevin profili aktif değilse yazma yapılmadan hata fırlatılır. */
function assertActiveProfile(event: TypedAppEvent, context: BackgroundTaskHandlerContext): void {
  const current = context.profileContext.getCurrent();
  if (normalizeProfileId(current.profileId) !== normalizeProfileId(event.profileId)) {
    throw new ProfileConflictError('profile-switched', {
      expectedRevision: event.sourceRevision,
      actualRevision: current.revision,
      message: `Görev '${event.profileId}' profili için başlatıldı; aktif profil '${current.profileId}'.`,
    });
  }
}

function requireMediaKey(
  payload: { mediaKey?: unknown; mediaType?: unknown },
  expectedType: 'movie' | 'tv'
): { mediaKey: string; mediaType: 'movie' | 'tv' } {
  if (typeof payload.mediaKey !== 'string') {
    throw new PermanentBackgroundError('Olay payload\'ında mediaKey yok.');
  }
  const parsed = parseMediaKey(payload.mediaKey);
  if (!parsed) {
    throw new PermanentBackgroundError(`Geçersiz mediaKey: ${payload.mediaKey}`);
  }
  if (parsed.type !== expectedType) {
    throw new PermanentBackgroundError(
      `mediaKey türü (${parsed.type}) olay türüyle (${expectedType}) uyuşmuyor.`
    );
  }
  if (payload.mediaType !== undefined && payload.mediaType !== parsed.type) {
    throw new PermanentBackgroundError('mediaType ile mediaKey türü uyuşmuyor.');
  }
  return { mediaKey: `${parsed.type}:${parsed.id}`, mediaType: parsed.type };
}

export const LIBRARY_ITEM_ADDED_HANDLER_ID = 'library.item-added.audit';
export const LIBRARY_RATING_CHANGED_HANDLER_ID = 'library.rating-changed.audit';

/**
 * `LibraryItemAdded` — kanonik anahtar + liste alanını doğrular, profil
 * izolasyonunu uygular ve tamamlandı kaydı için döner.
 */
export function createLibraryItemAddedHandler(): BackgroundTaskHandler {
  return {
    id: LIBRARY_ITEM_ADDED_HANDLER_ID,
    version: '1.0.0',
    eventTypes: ['LibraryItemAdded'],
    async handle(event, context) {
      const payload = (event.payload ?? {}) as ItemAddedPayload;
      const mediaType = payload.mediaType === 'tv' ? 'tv' : 'movie';
      const { mediaKey } = requireMediaKey(payload, mediaType);
      if (typeof payload.list !== 'string' || !payload.list.trim()) {
        throw new PermanentBackgroundError('Olay payload\'ında liste bilgisi yok.');
      }
      assertActiveProfile(event, context);

      context.logger?.info?.('Kütüphane ekleme olayı doğrulandı (audit-only).', {
        handlerId: LIBRARY_ITEM_ADDED_HANDLER_ID,
        eventId: event.eventId,
        profileId: event.profileId,
        mediaKey,
        list: payload.list,
        at: context.now(),
      });
    },
  };
}

/**
 * `LibraryRatingChanged` — puan aralığını doğrular (1–10 veya null), profil
 * izolasyonunu uygular. Puan ortak içerik deposuna YAZILMAZ.
 */
export function createLibraryRatingChangedHandler(): BackgroundTaskHandler {
  return {
    id: LIBRARY_RATING_CHANGED_HANDLER_ID,
    version: '1.0.0',
    eventTypes: ['LibraryRatingChanged'],
    async handle(event, context) {
      const payload = (event.payload ?? {}) as RatingChangedPayload;
      const mediaType = payload.mediaType === 'tv' ? 'tv' : 'movie';
      const { mediaKey } = requireMediaKey(payload, mediaType);

      const rating = payload.rating;
      if (rating !== null) {
        if (typeof rating !== 'number' || !Number.isFinite(rating) || rating < 1 || rating > 10) {
          throw new PermanentBackgroundError('Puan 1–10 aralığında sayı veya null olmalıdır.');
        }
      }
      assertActiveProfile(event, context);

      context.logger?.info?.('Kütüphane puan olayı doğrulandı (audit-only).', {
        handlerId: LIBRARY_RATING_CHANGED_HANDLER_ID,
        eventId: event.eventId,
        profileId: event.profileId,
        mediaKey,
        rating,
        at: context.now(),
      });
    },
  };
}

/** Faz 4 pilot kaydı — yalnızca iki olay türü. */
export function createDefaultBackgroundHandlers(): readonly BackgroundTaskHandler[] {
  return [createLibraryItemAddedHandler(), createLibraryRatingChangedHandler()];
}
