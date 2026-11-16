/**
 * MIA Faz 2 — Content Event Subscriber
 *
 * `AppEventBus` üzerinden gelen alan olaylarını dinler ve idempotent biçimde
 * Content Intelligence kuyruğuna aktarır.
 *
 * KESİN KURALLAR:
 * - `LibraryItemRemoved` ortak `content_intelligence` kaydını SİLMEZ.
 * - `not-interested` (ilgilenmiyorum) ve gizlenen içerikler de ortak havuzda işlenir.
 * - `LibraryRatingChanged` ve liste/durum değişiklikleri ortak tabloya kişisel
 *   puan veya izleme durumu YAZMAZ.
 * - Aynı `eventId` ikinci kez geldiğinde tekilleştirilir (kalıcı SQLite `content_processed_events`).
 */

import type {
  EventSubscription,
  IEventSubscriber,
  MediaKind,
  TypedAppEvent,
} from '../contracts/index.ts';
import { parseMediaKey } from '../core/keys.ts';
import { sanitizeRawContentInput } from '../modules/content/content-metadata-processor.ts';
import { ContentIntelligenceRepository } from './content-intelligence-repository.ts';
import { ContentProcessingQueue } from './content-processing-queue.ts';

const WATCH_PROGRESS_ONLY_FIELDS = new Set([
  'episodes_watched',
  'current_season',
  'season_progress',
  'status',
  'completedAt',
  'ratedAt',
  'personal_rating',
  'updatedAt',
]);

export interface ContentEventSubscriberOptions {
  readonly repository: ContentIntelligenceRepository;
  readonly queue: ContentProcessingQueue;
  readonly resolveMetadata?: (mediaKey: string) => Record<string, unknown> | undefined;
}

export interface HandleEventResult {
  readonly handled: boolean;
  readonly deduplicated: boolean;
  readonly action:
    | 'enqueued'
    | 'preserved-on-remove'
    | 'ignored-watch-progress'
    | 'acknowledged-no-content-mutation'
    | 'skipped-invalid';
  readonly mediaKey?: string | null;
}

export class ContentEventSubscriber {
  private readonly repository: ContentIntelligenceRepository;
  private readonly queue: ContentProcessingQueue;
  private readonly resolveMetadata?: (mediaKey: string) => Record<string, unknown> | undefined;
  private readonly eventMetadataHints = new Map<string, Record<string, unknown>>();

  constructor(options: ContentEventSubscriberOptions) {
    this.repository = options.repository;
    this.queue = options.queue;
    this.resolveMetadata = options.resolveMetadata;
  }

  registerMetadataHint(eventId: string, rawMetadata: Record<string, unknown> | undefined): void {
    if (!eventId || !rawMetadata || typeof rawMetadata !== 'object') return;
    const sanitized = sanitizeRawContentInput(rawMetadata).sanitized;
    this.eventMetadataHints.set(eventId, sanitized);
    if (this.eventMetadataHints.size > 300) {
      const oldest = this.eventMetadataHints.keys().next().value;
      if (oldest) this.eventMetadataHints.delete(oldest);
    }
  }

  private resolvePayloadPayloadForKey(
    eventId: string,
    mediaKey: string,
    mediaType: MediaKind,
    tmdbId: number
  ): Record<string, unknown> {
    const hinted = this.eventMetadataHints.get(eventId);
    if (hinted) {
      this.eventMetadataHints.delete(eventId);
    }
    const resolved = hinted ?? this.resolveMetadata?.(mediaKey);
    const sanitized = resolved ? sanitizeRawContentInput(resolved).sanitized : {};
    return {
      ...sanitized,
      id: sanitized.id ?? tmdbId,
      mediaType,
      mediaKey,
    };
  }

  async handleEvent(
    event: TypedAppEvent,
    explicitMetadata?: Record<string, unknown>
  ): Promise<HandleEventResult> {
    if (!event || !event.eventId || !event.eventType) {
      return { handled: false, deduplicated: false, action: 'skipped-invalid' };
    }

    if (explicitMetadata) {
      this.registerMetadataHint(event.eventId, explicitMetadata);
    }

    this.repository.ensureInitialized();

    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const rawKey =
      typeof payload.mediaKey === 'string'
        ? payload.mediaKey
        : typeof event.entityId === 'string'
          ? event.entityId
          : '';
    const parsed = rawKey ? parseMediaKey(rawKey) : null;
    const mediaType: MediaKind | null =
      payload.mediaType === 'tv' || payload.mediaType === 'movie'
        ? payload.mediaType
        : parsed?.type ?? null;
    const tmdbId = parsed && /^\d+$/.test(parsed.id) ? Number(parsed.id) : null;
    const canonicalKey = mediaType && tmdbId ? `${mediaType}:${tmdbId}` : null;

    // MIA Faz 2 — Adım 2.3 (Dilim E): Olay kabulü artık transactional outbox
    // desenindedir. Event, iş kalıcı olarak kuyruğa alınmadan "processed"
    // işaretlenmez; enqueue başarısızsa olay tekrar denenebilir kalır.
    // Önce salt-okunur tekilleştirme kontrolü yapılır; kalıcı INSERT, kuyruk
    // kaydıyla aynı SQLite transaction'ı içinde yapılır.
    if (this.repository.hasProcessedEvent(event.eventId)) {
      return {
        handled: true,
        deduplicated: true,
        action: 'acknowledged-no-content-mutation',
        mediaKey: canonicalKey,
      };
    }

    switch (event.eventType) {
      case 'LibraryItemAdded':
      case 'LibraryStatusChanged':
      case 'CatalogItemEnriched': {
        if (!canonicalKey || !mediaType || !tmdbId) {
          return { handled: false, deduplicated: false, action: 'skipped-invalid' };
        }
        const metaPayload = this.resolvePayloadPayloadForKey(
          event.eventId,
          canonicalKey,
          mediaType,
          tmdbId
        );
        const accepted = this.repository.acceptEventTransactionally({
          eventId: event.eventId,
          eventType: event.eventType,
          mediaKey: canonicalKey,
          job: {
            mediaKey: canonicalKey,
            mediaType,
            tmdbId,
            payload: metaPayload,
            triggerEventId: event.eventId,
          },
        });
        if (accepted.deduplicated) {
          return {
            handled: true,
            deduplicated: true,
            action: 'acknowledged-no-content-mutation',
            mediaKey: canonicalKey,
          };
        }
        this.queue.notifyExternalEnqueue();
        return {
          handled: true,
          deduplicated: false,
          action: 'enqueued',
          mediaKey: canonicalKey,
        };
      }

      case 'LibraryItemUpdated': {
        if (!canonicalKey || !mediaType || !tmdbId) {
          return { handled: false, deduplicated: false, action: 'skipped-invalid' };
        }
        const changedFields = Array.isArray(payload.changedFields)
          ? payload.changedFields.map(String)
          : [];
        const onlyPersonalProgress =
          changedFields.length > 0 &&
          changedFields.every((f) => WATCH_PROGRESS_ONLY_FIELDS.has(f));
        const existing = this.repository.getByMediaKey(canonicalKey);

        if (onlyPersonalProgress && existing?.processing_status === 'completed') {
          return {
            handled: true,
            deduplicated: false,
            action: 'ignored-watch-progress',
            mediaKey: canonicalKey,
          };
        }

        const metaPayload = this.resolvePayloadPayloadForKey(
          event.eventId,
          canonicalKey,
          mediaType,
          tmdbId
        );
        const accepted = this.repository.acceptEventTransactionally({
          eventId: event.eventId,
          eventType: event.eventType,
          mediaKey: canonicalKey,
          job: {
            mediaKey: canonicalKey,
            mediaType,
            tmdbId,
            payload: metaPayload,
            triggerEventId: event.eventId,
          },
        });
        if (accepted.deduplicated) {
          return {
            handled: true,
            deduplicated: true,
            action: 'acknowledged-no-content-mutation',
            mediaKey: canonicalKey,
          };
        }
        this.queue.notifyExternalEnqueue();
        return {
          handled: true,
          deduplicated: false,
          action: 'enqueued',
          mediaKey: canonicalKey,
        };
      }

      case 'LibraryRatingChanged': {
        // Kişisel puan ortak tabloya YAZILMAZ; içerik henüz dizinlenmediyse arka planda eklenir.
        if (!canonicalKey || !mediaType || !tmdbId) {
          return { handled: false, deduplicated: false, action: 'skipped-invalid' };
        }
        const existing = this.repository.getByMediaKey(canonicalKey);
        if (!existing) {
          const metaPayload = this.resolvePayloadPayloadForKey(
            event.eventId,
            canonicalKey,
            mediaType,
            tmdbId
          );
          const accepted = this.repository.acceptEventTransactionally({
            eventId: event.eventId,
            eventType: event.eventType,
            mediaKey: canonicalKey,
            job: {
              mediaKey: canonicalKey,
              mediaType,
              tmdbId,
              payload: metaPayload,
              triggerEventId: event.eventId,
            },
          });
          if (accepted.deduplicated) {
            return {
              handled: true,
              deduplicated: true,
              action: 'acknowledged-no-content-mutation',
              mediaKey: canonicalKey,
            };
          }
          this.queue.notifyExternalEnqueue();
          return {
            handled: true,
            deduplicated: false,
            action: 'enqueued',
            mediaKey: canonicalKey,
          };
        }
        // Kuyruğa iş üretilmeyen sonuçlar için idempotency kaydı yazılır.
        this.repository.markEventProcessed(event.eventId, event.eventType, canonicalKey);
        return {
          handled: true,
          deduplicated: false,
          action: 'acknowledged-no-content-mutation',
          mediaKey: canonicalKey,
        };
      }

      case 'LibraryItemRemoved': {
        // KURAL: Kullanıcı listesinden silse bile ortak content_intelligence kaydı SİLİNMEZ.
        this.repository.markEventProcessed(event.eventId, event.eventType, canonicalKey);
        return {
          handled: true,
          deduplicated: false,
          action: 'preserved-on-remove',
          mediaKey: canonicalKey,
        };
      }

      case 'FavoriteActorChanged': {
        // Kişisel favori oyuncu seçimi ortak tabloya yazılmaz; idempotent onaylanır.
        this.repository.markEventProcessed(event.eventId, event.eventType, canonicalKey);
        return {
          handled: true,
          deduplicated: false,
          action: 'acknowledged-no-content-mutation',
          mediaKey: null,
        };
      }

      default:
        // Kuyruğa iş üretmeyen bilinen olay türleri idempotent onaylanır.
        this.repository.markEventProcessed(event.eventId, event.eventType, canonicalKey);
        return {
          handled: true,
          deduplicated: false,
          action: 'acknowledged-no-content-mutation',
          mediaKey: canonicalKey,
        };
    }
  }

  subscribeToEventBus(subscriber: IEventSubscriber): EventSubscription {
    const subs: EventSubscription[] = [
      subscriber.subscribe('LibraryItemAdded', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('LibraryItemUpdated', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('LibraryItemRemoved', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('LibraryStatusChanged', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('LibraryRatingChanged', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('FavoriteActorChanged', async (ev) => {
        await this.handleEvent(ev);
      }),
      subscriber.subscribe('CatalogItemEnriched', async (ev) => {
        await this.handleEvent(ev);
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
}

export function createContentEventSubscriber(
  options: ContentEventSubscriberOptions
): ContentEventSubscriber {
  return new ContentEventSubscriber(options);
}
