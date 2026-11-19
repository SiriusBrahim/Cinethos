/**
 * MIA Faz 1B — Adım 9: TasteEvent ↔ TasteStore ↔ ITasteService / IMemoryService Entegrasyonu.
 *
 * Kurallar:
 * - `TasteEvent` (`src/core/taste/types.ts`) kendi özel öğrenme olayı modeli
 *   olarak kalır; genel `AppEventMap` içine sokulmaz.
 * - `IMemoryService.processEvent(AppEvent)` uygun kütüphane olaylarını
 *   (`LibraryItemAdded`, `LibraryStatusChanged`, `LibraryRatingChanged`,
 *   `LibraryItemRemoved`) deterministik olarak `TasteEvent`'e dönüştürüp
 *   atomik ve idempotent biçimde `TasteStore`'a işler.
 * - İşlemeden önce `IProfileContext.assertCurrent(...)` çağrılarak profil
 *   izolasyonu ve eski-revision reddi garanti edilir.
 */

import {
  ProfileConflictError,
  type EventSubscription,
  type IEventSubscriber,
  type IMemoryService,
  type IProfileContext,
  type ITasteService,
  type LibraryListId,
  type OperationOutcome,
  type ProfileRef,
  type TasteProfileSummaryView,
  type TypedAppEvent,
  type WriteProfileRef,
} from '../contracts/index.ts';
import type { TasteEvent } from '../core/taste/types.ts';
import { CorruptJsonFileError } from './atomic-json.ts';
import {
  appendTasteEventIdempotentForProfile,
  readTasteEventsForProfile,
  readTasteProfileForProfile,
} from './taste-store.ts';
import { triggerTasteProfileRebuild } from './taste-rebuild-coordinator.ts';
import { TasteProfileScopeError, validateCanonicalProfileId } from './taste-profile-scope.ts';

export interface TasteServiceAdapterOptions {
  dataDir?: string;
  profileContext?: IProfileContext;
  /** İsteğe bağlı olay sonrası rebuild tetiklemesi (varsayılan true). */
  rebuildOnEvent?: boolean;
}

function mapListToTasteStatus(list: LibraryListId | null): string {
  switch (list) {
    case 'watched':
      return 'completed';
    case 'watching':
      return 'watching';
    case 'watchlist':
      return 'watchlist';
    case 'not-interested':
      return 'disliked';
    default:
      return 'removed';
  }
}

function computePillarSummary(
  metrics: Record<string, { status: string; affinity: number }>
): Record<string, number> {
  const buckets: Record<string, { sum: number; count: number }> = {};
  for (const [metricId, metric] of Object.entries(metrics)) {
    if (!metric || metric.status === 'unknown') continue;
    const category = metricId.split('.')[0] || 'other';
    if (!buckets[category]) {
      buckets[category] = { sum: 0, count: 0 };
    }
    buckets[category].sum += metric.affinity;
    buckets[category].count += 1;
  }
  const pillars: Record<string, number> = {};
  for (const [cat, stat] of Object.entries(buckets)) {
    if (stat.count > 0) {
      pillars[cat] = Math.round((stat.sum / stat.count) * 100) / 100;
    }
  }
  return pillars;
}

/**
 * Genel `TypedAppEvent`'i (idempotency anahtarı `eventId` korunarak)
 * `TasteEvent`'e dönüştürür. İlgisiz olaylar için `null` döner.
 */
export function translateAppEventToTasteEvent(event: TypedAppEvent): TasteEvent | null {
  switch (event.eventType) {
    case 'LibraryItemAdded': {
      const ev = event as TypedAppEvent<'LibraryItemAdded'>;
      const status = mapListToTasteStatus(ev.payload.list);
      return {
        eventId: ev.eventId,
        contentId: ev.payload.mediaKey,
        eventType: ev.payload.list === 'not-interested' ? 'content_disliked' : 'status_changed',
        payload: {
          previousValue: null,
          newValue: status,
        },
        recordedAt: ev.occurredAt,
        timeSource: 'actual',
        timePrecision: 'exact',
      };
    }
    case 'LibraryStatusChanged': {
      const ev = event as TypedAppEvent<'LibraryStatusChanged'>;
      const prevStatus = mapListToTasteStatus(ev.payload.from);
      const nextStatus = mapListToTasteStatus(ev.payload.to);
      return {
        eventId: ev.eventId,
        contentId: ev.payload.mediaKey,
        eventType: ev.payload.to === 'not-interested' ? 'content_disliked' : 'status_changed',
        payload: {
          previousValue: prevStatus,
          newValue: nextStatus,
        },
        recordedAt: ev.occurredAt,
        timeSource: 'actual',
        timePrecision: 'exact',
      };
    }
    case 'LibraryRatingChanged': {
      const ev = event as TypedAppEvent<'LibraryRatingChanged'>;
      return {
        eventId: ev.eventId,
        contentId: ev.payload.mediaKey,
        eventType: 'rating_changed',
        payload: {
          previousValue: ev.payload.previousRating ?? null,
          newValue: ev.payload.rating,
          ratingSource: 'numeric',
        },
        recordedAt: ev.occurredAt,
        timeSource: 'actual',
        timePrecision: 'exact',
      };
    }
    case 'LibraryItemRemoved': {
      const ev = event as TypedAppEvent<'LibraryItemRemoved'>;
      return {
        eventId: ev.eventId,
        contentId: ev.payload.mediaKey,
        eventType: 'status_changed',
        payload: {
          previousValue: mapListToTasteStatus(ev.payload.previousList),
          newValue: 'removed',
        },
        recordedAt: ev.occurredAt,
        timeSource: 'actual',
        timePrecision: 'exact',
      };
    }
    default:
      return null;
  }
}

export class ServerTasteServiceAdapter implements ITasteService, IMemoryService {
  private readonly dataDir: string;
  private readonly profileContext?: IProfileContext;
  private readonly rebuildOnEvent: boolean;
  private readonly processedEventIds = new Set<string>();

  constructor(options: TasteServiceAdapterOptions = {}) {
    this.dataDir = options.dataDir ?? 'data';
    this.profileContext = options.profileContext;
    this.rebuildOnEvent = options.rebuildOnEvent ?? true;
  }

  async getProfile(ref: ProfileRef): Promise<TasteProfileSummaryView | null> {
    if (this.profileContext) {
      this.profileContext.assertCurrent(ref);
    }
    const profileId = validateCanonicalProfileId(ref.profileId);
    const stored = await readTasteProfileForProfile(profileId, this.dataDir);
    if (!stored) return null;
    const revision =
      typeof ref.revision === 'number'
        ? ref.revision
        : this.profileContext
          ? await this.profileContext.getRevision()
          : 0;
    return {
      profileId: ref.profileId,
      revision,
      pillars: computePillarSummary(stored.metrics || {}),
      updatedAt: stored.asOf ?? null,
    };
  }

  async refreshProfile(ref: WriteProfileRef): Promise<OperationOutcome> {
    try {
      if (this.profileContext) {
        this.profileContext.assertWritable(ref);
      } else if (!Number.isSafeInteger(ref.revision) || ref.revision < 0) {
        return {
          ok: false,
          error: 'Yazma işlemi için geçerli bir revision zorunludur.',
          retryable: false,
        };
      }

      const profileId = validateCanonicalProfileId(ref.profileId);
      await triggerTasteProfileRebuild(profileId, this.dataDir);

      // Uzun süren worker hesabından sonra profil değişmişse uyarı sinyali üret.
      if (this.profileContext) {
        this.profileContext.assertWritable(ref);
      }
      return { ok: true };
    } catch (error) {
      if (error instanceof ProfileConflictError) {
        return { ok: false, error: error.message, retryable: false };
      }
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }

  async processEvent(event: TypedAppEvent): Promise<OperationOutcome> {
    try {
      const eventProfileId = validateCanonicalProfileId(event.profileId);
      const activeProfileId = this.profileContext?.getCurrent().profileId;
      // R2-A3 S4: kimlik otoritesi sunucudadır — istemcinin `profileId` alanı
      // hedef profili seçemez; yalnızca aktif profille eşleşmesi doğrulanır.
      if (activeProfileId && activeProfileId !== eventProfileId) {
        return {
          ok: false,
          error: `Profil uyuşmazlığı: olay '${eventProfileId}' için geldi, aktif profil '${activeProfileId}'.`,
          retryable: false,
          code: 'profile-not-active',
        };
      }
      const targetProfileId = activeProfileId ?? eventProfileId;

      if (this.profileContext) {
        this.profileContext.assertWritable({
          profileId: targetProfileId,
          revision: event.sourceRevision,
        });
      }

      const memoryKey = `${targetProfileId}:${event.eventId}`;
      if (this.processedEventIds.has(memoryKey)) {
        return { ok: true };
      }

      const tasteEvent = translateAppEventToTasteEvent(event);
      if (!tasteEvent) {
        this.processedEventIds.add(memoryKey);
        return { ok: true };
      }

      // Kalıcı olay deposunda aynı eventId varsa çift kanıt/yeniden yazım yapma.
      const existing = await readTasteEventsForProfile(targetProfileId, this.dataDir);
      if (existing.some((e) => e.eventId === tasteEvent.eventId)) {
        this.processedEventIds.add(memoryKey);
        return { ok: true };
      }

      const { added } = await appendTasteEventIdempotentForProfile(
        targetProfileId,
        tasteEvent,
        this.dataDir
      );
      this.processedEventIds.add(memoryKey);

      if (added && this.rebuildOnEvent) {
        await triggerTasteProfileRebuild(targetProfileId, this.dataDir);
      }

      return { ok: true };
    } catch (error) {
      return toAdapterOutcome(error);
    }
  }

  /**
   * R2-A4 — ertelenmiş (kaçırılmış) olayın telafisi.
   *
   * Canlı abonelik sırasında hedef profil aktif olmadığı için yazılmamış olay,
   * hedef profil aktif olduğunda bu yöntemle işlenir. Fark: olay geçmişe ait
   * olduğundan `sourceRevision` eşitliği ARANMAZ; yalnızca profil kimliği
   * doğrulanır. Yazma `eventId` ile idempotenttir; yeniden hesap tetiklenir.
   */
  async processDeferredEvent(event: TypedAppEvent): Promise<OperationOutcome> {
    try {
      const eventProfileId = validateCanonicalProfileId(event.profileId);
      const activeProfileId = this.profileContext?.getCurrent().profileId;
      if (activeProfileId && activeProfileId !== eventProfileId) {
        return {
          ok: false,
          error: `Telafi için hedef profil aktif değil: olay '${eventProfileId}', aktif profil '${activeProfileId}'.`,
          retryable: false,
          code: 'profile-not-active',
        };
      }
      const targetProfileId = activeProfileId ?? eventProfileId;
      const memoryKey = `${targetProfileId}:${event.eventId}`;
      const tasteEvent = translateAppEventToTasteEvent(event);
      if (!tasteEvent) {
        this.processedEventIds.add(memoryKey);
        return { ok: true };
      }

      // Olay yazımı idempotenttir; fakat önceki denemede rebuild başarısız
      // olmuş olabilir. Mevcut event kaydı bu nedenle yeniden hesaplamayı atlatmaz.
      const existing = await readTasteEventsForProfile(targetProfileId, this.dataDir);
      if (!existing.some((item) => item.eventId === tasteEvent.eventId)) {
        await appendTasteEventIdempotentForProfile(targetProfileId, tasteEvent, this.dataDir);
      }
      this.processedEventIds.add(memoryKey);

      // Telafi görevinin varlık nedeni eksik/başarısız türetilmiş profildir;
      // event zaten kayıtlı olsa bile rebuild her retry'de yeniden denenir.
      if (this.rebuildOnEvent) {
        await triggerTasteProfileRebuild(targetProfileId, this.dataDir);
      }

      return { ok: true };
    } catch (error) {
      return toAdapterOutcome(error);
    }
  }}

/** Hata sınıflarını yapısal `code` alanıyla sonuçlandırır (metin ayrıştırması yok). */
function toAdapterOutcome(error: unknown): OperationOutcome {
  if (error instanceof ProfileConflictError) {
    return { ok: false, error: error.message, retryable: false, code: 'profile-conflict' };
  }
  if (error instanceof TasteProfileScopeError) {
    return { ok: false, error: error.message, retryable: false, code: 'invalid-profile' };
  }
  if (error instanceof CorruptJsonFileError) {
    return { ok: false, error: error.message, retryable: false, code: 'corrupt-store' };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    retryable: true,
    code: 'unavailable',
  };
}

export function createServerTasteServiceAdapter(
  options: TasteServiceAdapterOptions = {}
): ServerTasteServiceAdapter {
  return new ServerTasteServiceAdapter(options);
}

const TASTE_SUBSCRIBED_DOMAIN_EVENTS = [
  'LibraryItemAdded',
  'LibraryStatusChanged',
  'LibraryRatingChanged',
  'LibraryItemRemoved',
] as const;

/**
 * `ServerTasteServiceAdapter` örneğini `AppEventBus` (`IEventSubscriber`) kütüphane
 * olaylarına bağlar; kalıcılık başarısız olursa sessizce yutmak yerine `onError`
 * callback'ini tetikler ve hatayı yukarı iletir.
 */
export function subscribeTasteAdapterToEventBus(
  subscriber: IEventSubscriber,
  adapter: IMemoryService,
  onError?: (event: TypedAppEvent, outcome: OperationOutcome) => void,
  onSkipped?: (event: TypedAppEvent, outcome: OperationOutcome) => void
): EventSubscription {
  const subs: EventSubscription[] = TASTE_SUBSCRIBED_DOMAIN_EVENTS.map((eventType) =>
    subscriber.subscribe(eventType, async (event) => {
      const outcome = await adapter.processEvent(event);
      if (!outcome.ok) {
        // PUT /api/data tüm profillerin library farklarını yayınlayabilir.
        // Taste yalnızca sunucudaki aktif profile yazabilir; başka profile ait
        // iç EventBus olayı beklenen bir kapsam dışı bırakmadır.
        // HTTP /domain-event rotası ayrı olarak 409 döndürmeye devam eder.
        // R2-A4: hata metni ayrıştırılmaz; yapısal kod tek otoritedir.
        const inactiveProfileEvent = !outcome.retryable && outcome.code === 'profile-not-active';
        if (inactiveProfileEvent) {
          onSkipped?.(event, outcome);
          return;
        }
        onError?.(event, outcome);
        throw new Error(outcome.error || `Taste olay kalıcılığı başarısız (${event.eventType})`);
      }
    })
  );
  return {
    unsubscribe: () => {
      for (const sub of subs) {
        sub.unsubscribe();
      }
    },
  };
}
