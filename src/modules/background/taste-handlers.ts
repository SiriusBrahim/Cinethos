/**
 * MIA Faz 5 R2-A4 — Taste telafi işleyicisi (kaçırılmış olayların kuyruktan
 * işlenmesi).
 *
 * Sorun: `AppEventBus.publish`, PUT /api/data gibi akışlarda TÜM profillerin
 * kütüphane farklarını yayınlayabilir. Taste canlı aboneliği yalnızca aktif
 * profile yazabildiği için diğer profillerin olayları atlanıyordu (olay
 * kaybı). Kalıcı `background_events` defteri bu olayları zaten sakladığından,
 * bu işleyici atlanan olayı HEDEF PROFİL AKTİF OLDUĞUNDA kendi profiline yazar.
 *
 * KURALLAR:
 * - İşleyici `profileScoped`'dır: hedef profil aktif değilken görev kiralanmaz,
 *   deneme hakkı tüketilmez ve başka profile yazılmaz.
 * - Yazma idempotenttir (`eventId`): canlı abonelik olayı zaten işlediyse
 *   ikinci kanıt oluşmaz.
 * - Geçmiş olayın `sourceRevision` değeri bugünkü revision'a eşit olmayabilir;
 *   bu yüzden yalnızca profil kimliği doğrulanır (revision eşitliği aranmaz).
 * - Gerçek algoritma/öneri yan etkisi üretmez; mevcut `IMemoryService`
 *   sözleşmesini kullanır.
 */

import {
  ProfileConflictError,
  type BackgroundTaskHandler,
  type BackgroundTaskHandlerContext,
  type IMemoryService,
  type TypedAppEvent,
} from '../../contracts/index.ts';
import { normalizeProfileId } from '../../core/profile-id.ts';
import { PermanentBackgroundError, RetryableBackgroundError } from './errors.ts';

export const TASTE_EVENT_SYNC_HANDLER_ID = 'intelligence.taste-event-sync';

const TASTE_EVENT_TYPES = [
  'LibraryItemAdded',
  'LibraryStatusChanged',
  'LibraryRatingChanged',
  'LibraryItemRemoved',
] as const;

function assertTargetProfile(event: TypedAppEvent, context: BackgroundTaskHandlerContext): void {
  const current = context.profileContext.getCurrent();
  if (normalizeProfileId(current.profileId) !== normalizeProfileId(event.profileId)) {
    throw new ProfileConflictError('profile-switched', {
      expectedRevision: event.sourceRevision,
      actualRevision: current.revision,
      message: `Telafi görevi '${event.profileId}' profili için bekliyor; aktif profil '${current.profileId}'.`,
    });
  }
}

/**
 * Taste telafi işleyicisi. Adapter `processDeferredEvent` sunmuyorsa kayıt
 * aşamasında açık hata verilir (sessiz devre dışı bırakma yok).
 */
export function createTasteEventSyncHandler(
  adapter: Pick<IMemoryService, 'processDeferredEvent'>
): BackgroundTaskHandler {
  if (typeof adapter.processDeferredEvent !== 'function') {
    throw new Error(
      'Taste telafi işleyicisi için IMemoryService.processDeferredEvent zorunludur.'
    );
  }
  const processDeferredEvent = adapter.processDeferredEvent.bind(adapter);

  return {
    id: TASTE_EVENT_SYNC_HANDLER_ID,
    version: '1.0.0',
    eventTypes: TASTE_EVENT_TYPES,
    profileScoped: true,
    async handle(event, context) {
      assertTargetProfile(event, context);
      const outcome = await processDeferredEvent(event);
      if (outcome.ok) return;
      if (outcome.code === 'profile-not-active') {
        throw new ProfileConflictError('profile-switched', {
          expectedRevision: event.sourceRevision,
          actualRevision: context.profileContext.getCurrent().revision,
          message: outcome.error,
        });
      }
      if (outcome.retryable) {
        throw new RetryableBackgroundError(outcome.error);
      }
      throw new PermanentBackgroundError(outcome.error);
    },
  };
}
