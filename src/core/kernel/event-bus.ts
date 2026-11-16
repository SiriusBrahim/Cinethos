/**
 * MIA Faz 1 — Tipli olay yolu (kernel EventBus).
 *
 * UI katmanındaki `app/shell-events.ts` ile karıştırılmamalıdır: orası yalnız
 * kabuk bildirimleri içindir ve sayfa yenilenince kaybolur. Burası modüller
 * arası sözleşmedir; her olay `profileId`, `schemaVersion` ve `occurredAt` taşır.
 *
 * Kurallar:
 * - Olay adı `domain.action` biçimindedir (ör. `content.added`).
 * - Dinleyici hatası yayını durdurmaz; `onError` ile raporlanır.
 * - Yeni olay eklemek = `KernelEventMap`'e bir satır; string ile yayın yok.
 */

export interface KernelEventMap {
  'content.added': { contentKey: string; mediaType: 'movie' | 'tv'; title?: string };
  'content.updated': { contentKey: string; changed: readonly string[] };
  'content.removed': { contentKey: string };
  'watchlist.changed': { contentKey: string; status: string; previousStatus?: string };
  'profile.changed': { previousProfileId: string; profileId: string; revision: number };
  'taste.updated': { reason: string; evidenceCount: number };
  'recommendations.refreshRequested': { reason: string };
  'content.processed': { contentKey: string; state: string; attempts: number };
  'module.failed': { moduleId: string; message: string };
}

export type KernelEventType = keyof KernelEventMap;

/** Olay şeması sürümü — alan eklendiğinde artırılır, tüketiciler buna göre uyum sağlar. */
export const KERNEL_EVENT_SCHEMA_VERSION = 1;

export interface EventPublishMeta {
  /** Olayı doğuran profil. Profilsiz sistem olaylarında `system`. */
  readonly profileId: string;
  readonly entityId?: string;
  readonly schemaVersion?: number;
}

export interface KernelEvent<T extends KernelEventType = KernelEventType> {
  readonly id: string;
  readonly type: T;
  readonly profileId: string;
  readonly entityId?: string;
  readonly occurredAt: string;
  readonly schemaVersion: number;
  readonly payload: KernelEventMap[T];
}

export interface EventSubscriberError {
  readonly type: KernelEventType;
  readonly profileId: string;
  readonly subscriberId: string;
  readonly error: unknown;
}

export type EventHandler<T extends KernelEventType> = (event: KernelEvent<T>) => void;

export interface SubscribeOptions {
  /** Yalnız bu profile ait olayları al (profil izolasyonu). */
  readonly profileId?: string;
  /** Teşhis için abone kimliği. */
  readonly subscriberId?: string;
}

export interface KernelEventBus {
  publish<T extends KernelEventType>(
    type: T,
    payload: KernelEventMap[T],
    meta: EventPublishMeta
  ): KernelEvent<T>;
  subscribe<T extends KernelEventType>(
    type: T,
    handler: EventHandler<T>,
    options?: SubscribeOptions
  ): () => void;
  once<T extends KernelEventType>(
    type: T,
    handler: EventHandler<T>,
    options?: SubscribeOptions
  ): () => void;
  listenerCount(type: KernelEventType): number;
  clear(): void;
}

export interface EventBusOptions {
  readonly now?: () => Date;
  readonly idFactory?: () => string;
  readonly onError?: (failure: EventSubscriberError) => void;
  readonly logger?: { warn(message: string, meta?: Record<string, unknown>): void };
}

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

interface Subscription {
  readonly id: string;
  readonly handler: (event: KernelEvent) => void;
  readonly profileId?: string;
  readonly once: boolean;
}

/** Olay adı standarda uymuyorsa fırlatılır — sessizce yayınlanmaz. */
export class InvalidEventNameError extends Error {
  readonly eventType: string;
  constructor(eventType: string) {
    super(`Olay adı "domain.action" biçiminde olmalı: ${eventType}`);
    this.name = 'InvalidEventNameError';
    this.eventType = eventType;
  }
}

export function createEventBus(options: EventBusOptions = {}): KernelEventBus {
  const now = options.now ?? (() => new Date());
  const idFactory =
    options.idFactory ??
    (() =>
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `evt-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const subscriptions = new Map<string, Subscription[]>();
  let subscriberSeq = 0;

  const reportError = (failure: EventSubscriberError): void => {
    if (options.onError) {
      options.onError(failure);
      return;
    }
    options.logger?.warn('[EventBus] abone hata fırlattı', {
      type: failure.type,
      subscriberId: failure.subscriberId,
    });
  };

  const addSubscription = <T extends KernelEventType>(
    type: T,
    handler: EventHandler<T>,
    subscribeOptions: SubscribeOptions | undefined,
    once: boolean
  ): (() => void) => {
    if (!EVENT_NAME_PATTERN.test(type)) throw new InvalidEventNameError(String(type));
    const list = subscriptions.get(type as string) ?? [];
    subscriberSeq += 1;
    const subscription: Subscription = {
      id: subscribeOptions?.subscriberId ?? `${String(type)}#${subscriberSeq}`,
      handler: handler as (event: KernelEvent) => void,
      profileId: subscribeOptions?.profileId,
      once,
    };
    list.push(subscription);
    subscriptions.set(type as string, list);

    return () => {
      const current = subscriptions.get(type as string);
      if (!current) return;
      const next = current.filter((entry) => entry !== subscription);
      if (next.length > 0) subscriptions.set(type as string, next);
      else subscriptions.delete(type as string);
    };
  };

  return {
    publish(type, payload, meta) {
      if (!EVENT_NAME_PATTERN.test(type)) throw new InvalidEventNameError(String(type));
      if (!meta || typeof meta.profileId !== 'string' || meta.profileId.length === 0) {
        throw new Error(`Olay "${type}" profileId taşımak zorunda`);
      }

      const event: KernelEvent = {
        id: idFactory(),
        type,
        profileId: meta.profileId,
        ...(meta.entityId ? { entityId: meta.entityId } : {}),
        occurredAt: now().toISOString(),
        schemaVersion: meta.schemaVersion ?? KERNEL_EVENT_SCHEMA_VERSION,
        payload,
      };

      const list = subscriptions.get(type);
      if (!list || list.length === 0) return event as KernelEvent<typeof type>;

      // Kopya üzerinde dolaş: yayın sırasında abone eklenip çıkarılabilir.
      for (const subscription of [...list]) {
        if (subscription.profileId && subscription.profileId !== event.profileId) continue;
        if (subscription.once) {
          const current = subscriptions.get(type);
          if (current) {
            const next = current.filter((entry) => entry !== subscription);
            if (next.length > 0) subscriptions.set(type, next);
            else subscriptions.delete(type);
          }
        }
        try {
          subscription.handler(event);
        } catch (error) {
          reportError({
            type,
            profileId: event.profileId,
            subscriberId: subscription.id,
            error,
          });
        }
      }

      return event as KernelEvent<typeof type>;
    },

    subscribe(type, handler, subscribeOptions) {
      return addSubscription(type, handler, subscribeOptions, false);
    },

    once(type, handler, subscribeOptions) {
      return addSubscription(type, handler, subscribeOptions, true);
    },

    listenerCount(type) {
      return subscriptions.get(type)?.length ?? 0;
    },

    clear() {
      subscriptions.clear();
    },
  };
}
