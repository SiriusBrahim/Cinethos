import { normalizeProfileId } from '../core/profile-id.ts';
/**
 * MIA Faz 1B — Adım 8: Uygulama Olay Yolu (IEventPublisher / IEventSubscriber).
 *
 * İki katmanlı olay mimarisinin domain katmanıdır:
 * - `src/app/shell-events.ts` UI kabuğu için geçici kanal olarak kalır.
 * - Bu modül `AppEventMap` sözleşmesi üzerinden tipli domain olaylarını
 *   taşır; kalıcı kuyruğa/Outbox'a bağlandığında yazım başarısız olursa
 *   hatayı yutmaz, çağıranı reddeder (throw).
 * - `TasteEvent` (`src/core/taste/types.ts`) bu genel veriyoluna KARIŞTIRILMAZ.
 */

import type {
  AppEventHandler,
  AppEventMap,
  EventSubscription,
  IEventPublisher,
  IEventSubscriber,
  TypedAppEvent,
  WriteProfileRef,
} from '../contracts/index.ts';
import { emitShellEvent } from './shell-events.ts';

export interface AppEventBusOptions {
  /**
   * İsteğe bağlı kalıcı yazım kancası (örn. Outbox kuyruğu).
   * Hata fırlatırsa `publish()` reddedilir — sessiz yutma yasaktır.
   */
  persistEvent?: (event: TypedAppEvent) => Promise<void> | void;
  /** Hata ayıklama / izleme için son olay geçmişi sınırı (varsayılan 100). */
  historyLimit?: number;
}

export interface CreateAppEventInput<K extends keyof AppEventMap> {
  eventType: K;
  ref: WriteProfileRef;
  payload: AppEventMap[K];
  entityId?: string;
  eventId?: string;
  occurredAt?: string;
  schemaVersion?: number;
}

export function createAppEvent<K extends keyof AppEventMap>(
  input: CreateAppEventInput<K>
): TypedAppEvent<K> {
  const profileId = normalizeProfileId(input.ref?.profileId) ?? '';
  if (!profileId) {
    throw new Error(`Olay üretilemedi (${String(input.eventType)}): profileId boş olamaz.`);
  }
  if (!Number.isSafeInteger(input.ref?.revision) || input.ref.revision < 0) {
    throw new Error(
      `Olay üretilemedi (${String(input.eventType)}): geçerli sourceRevision zorunludur.`
    );
  }
  return {
    eventId:
      input.eventId ||
      (typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    eventType: input.eventType,
    profileId,
    ...(input.entityId ? { entityId: input.entityId } : {}),
    occurredAt: input.occurredAt || new Date().toISOString(),
    schemaVersion: input.schemaVersion ?? 1,
    payload: input.payload,
    sourceRevision: input.ref.revision,
    ref: { ...input.ref, profileId },
  };
}

export class AppEventBus implements IEventPublisher, IEventSubscriber {
  private readonly handlers = new Map<keyof AppEventMap, Set<AppEventHandler<any>>>();
  private readonly persistEvent?: (event: TypedAppEvent) => Promise<void> | void;
  private readonly history: TypedAppEvent[] = [];
  private readonly historyLimit: number;

  constructor(options: AppEventBusOptions = {}) {
    this.persistEvent = options.persistEvent;
    this.historyLimit = Math.max(0, options.historyLimit ?? 100);
  }

  async publish<K extends keyof AppEventMap>(event: TypedAppEvent<K>): Promise<void> {
    const eventId = typeof event?.eventId === 'string' ? event.eventId.trim() : '';
    const profileId = normalizeProfileId(event?.profileId) ?? '';
    if (!eventId) {
      throw new Error(`Olay yayınlanamadı (${String(event?.eventType)}): eventId zorunludur.`);
    }
    if (!profileId) {
      throw new Error(`Olay yayınlanamadı (${String(event?.eventType)}): profileId zorunludur.`);
    }
    if (!Number.isSafeInteger(event.sourceRevision) || event.sourceRevision < 0) {
      throw new Error(
        `Olay yayınlanamadı (${String(event.eventType)}): geçerli sourceRevision zorunludur.`
      );
    }

    // Kalıcılık kancası başarısızsa hata çağıran modüle iletilir (sessiz catch yok).
    const canonicalEvent = {
      ...event,
      profileId,
      ref: event.ref ? { ...event.ref, profileId } : event.ref,
    } as TypedAppEvent<K>;
    if (this.persistEvent) {
      await this.persistEvent(canonicalEvent);
    }

    if (this.historyLimit > 0) {
      this.history.push(canonicalEvent);
      if (this.history.length > this.historyLimit) {
        this.history.splice(0, this.history.length - this.historyLimit);
      }
    }

    const set = this.handlers.get(event.eventType);
    if (!set || set.size === 0) return;

    // Tüm aboneleri çalıştır; bir abonenin hatası diğerlerini durdurmasın.
    // Ancak kritik teslimat hataları publish() sonucunda çağırana dönmelidir.
    const results = await Promise.allSettled([...set].map((handler) => handler(canonicalEvent)));
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `[AppEventBus] ${String(event.eventType)} olayı ${failures.length} abone tarafından işlenemedi.`
      );
    }
  }

  subscribe<K extends keyof AppEventMap>(
    eventType: K,
    handler: AppEventHandler<K>
  ): EventSubscription {
    let set = this.handlers.get(eventType);
    if (!set) {
      set = new Set();
      this.handlers.set(eventType, set);
    }
    set.add(handler);
    return {
      unsubscribe: () => {
        set?.delete(handler);
      },
    };
  }

  getRecentEvents(): readonly TypedAppEvent[] {
    return [...this.history];
  }

  clearHandlers(): void {
    this.handlers.clear();
  }
}

export function createAppEventBus(options: AppEventBusOptions = {}): AppEventBus {
  return new AppEventBus(options);
}

/**
 * Domain olaylarından yalnızca UI kabuğunu ilgilendiren özet bildirimleri
 * `shell-events.ts` kanalına köprüler (iki katman birbirine karıştırılmadan).
 */
export function bridgeAppEventsToShellEvents(
  subscriber: IEventSubscriber
): EventSubscription {
  const subs: EventSubscription[] = [
    subscriber.subscribe('LibraryItemAdded', (ev) => {
      emitShellEvent('item:saved', { key: ev.payload.mediaKey });
    }),
    subscriber.subscribe('ProfileSwitched', (ev) => {
      emitShellEvent('profile:changed', { profileId: ev.payload.toProfileId });
    }),
  ];

  return {
    unsubscribe: () => {
      for (const s of subs) {
        s.unsubscribe();
      }
    },
  };
}
