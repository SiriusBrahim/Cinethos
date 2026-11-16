/**
 * MIA Faz 1B ④ — Offline Queue'nun olay sözleşmesine uyarlanması.
 *
 * AMAÇ (davranış değişikliği yok):
 * Mevcut `offline-queue.ts` senkron SNAPSHOT'ı kuyruklar (DataDocument);
 * uygulama olaylarını (AppEvent) kuyruklamaz. Bu modül, `IEventPublisher`
 * sözleşmesini uygulayan kalıcı bir olay kuyruğu (Outbox tohumu) sunar:
 *  - Olaylar `eventId` ile idempotent kaydedilir (aynı olay iki kez yazılmaz).
 *  - Depolama arka ucu enjekte edilebilir; varsayılan bellek (testler),
 *    üretimde Faz 4'te IndexedDB kalıcı depo bağlanacaktır.
 *  - `drain()` FIFO sırayla olayları teslim eder; işleyici onaylamazsa olay
 *    kuyrukta KALIR (uygulama kapanıp açılsa bile — kalıcılık kuralı).
 *  - Geriden çekilme (backoff) mevcut `offlineQueueBackoffMs` ile uyumludur.
 *
 * KURAL: Bu kuyruk `TasteEvent` sisteminin YERİNE geçmez; zevk olayları
 * kendi özel modelinde kalır (Faz 0 kararı).
 */

import type {
  AppEvent,
  EventSubscription,
  IEventPublisher,
  IEventSubscriber,
  TypedAppEvent,
  AppEventHandler,
  AppEventMap,
} from '../contracts/index.ts';
import { OFFLINE_QUEUE_MAX_ATTEMPTS, offlineQueueBackoffMs } from './offline-queue.ts';

/** Kuyruktaki bir olay kaydı — teslimat durumu ile. */
export interface OutboxEventRecord<K extends keyof AppEventMap = keyof AppEventMap> {
  readonly event: TypedAppEvent<K>;
  /** Kaç kez teslim denenmiş (backoff hesabı için). */
  attempts: number;
  /** Son deneme zamanı (ISO-8601) — backoff penceresi için. */
  lastAttemptAt: string | null;
}

/** Kalıcı depolama arka ucu (Faz 4'te IndexedDB uyarlaması gelecek). */
export interface OutboxBackend {
  load(): Promise<readonly OutboxEventRecord[]>;
  save(records: readonly OutboxEventRecord[]): Promise<boolean>;
}

/** Bellek arka ucu — testler ve SSR güvenli varsayılan. */
export function createMemoryOutboxBackend(): OutboxBackend {
  let records: OutboxEventRecord[] = [];
  return {
    async load() {
      return records;
    },
    async save(next) {
      records = [...next];
      return true;
    },
  };
}

/** Kuyrukta bekleyen olay sayısı ve dağılımı — Sistem Yönetimi Paneli (§6). */
export interface OutboxStats {
  readonly pending: number;
  readonly byType: Readonly<Record<string, number>>;
  readonly deadLetters: number;
}

/** Maksimum teslim denemesi — mevcut offline-queue politikasıyla aynı (SEC-04). */
export const OUTBOX_MAX_ATTEMPTS = OFFLINE_QUEUE_MAX_ATTEMPTS;

/**
 * createOutboxEventPublisher — IEventPublisher + IEventSubscriber uygulaması.
 *
 * Kullanım (Faz 4'te Arka Plan Yöneticisi içinde):
 *   const outbox = createOutboxEventPublisher({ backend });
 *   await outbox.publish(event);            // kalıcı kuyruğa yaz
 *   await outbox.drain(handler);            // FIFO teslim + onay
 */
export function createOutboxEventPublisher(options?: {
  backend?: OutboxBackend;
  now?: () => string;
}): IEventPublisher & IEventSubscriber & {
  /** FIFO teslim: handler true dönerse olay onaylanır ve kuyruktan düşer. */
  drain(handler: (event: TypedAppEvent) => Promise<boolean> | boolean): Promise<{
    delivered: number;
    failed: number;
    remaining: number;
  }>;
  /** Panel/health verisi. */
  stats(): Promise<OutboxStats>;
  /** Dead-letter listesi (maksimum denemeyi aşan olaylar). */
  listDeadLetters(): Promise<readonly OutboxEventRecord[]>;
} {
  const backend = options?.backend ?? createMemoryOutboxBackend();
  const now = options?.now ?? (() => new Date().toISOString());
  const handlers = new Map<keyof AppEventMap, Set<AppEventHandler>>();

  async function mutate(
    fn: (records: OutboxEventRecord[]) => OutboxEventRecord[]
  ): Promise<boolean> {
    const current = await backend.load();
    const next = fn([...current]);
    return backend.save(next);
  }

  return {
    async publish<K extends keyof AppEventMap>(event: TypedAppEvent<K>): Promise<void> {
      if (!event || !event.eventId || !event.profileId) {
        throw new Error('publish: eventId ve profileId zorunludur (K1 — profil izolasyonu)');
      }
      await mutate((records) => {
        // İdempotency: aynı eventId ikinci kez yazılmaz (kullanıcı planı §3).
        if (records.some((r) => r.event.eventId === event.eventId)) return records;
        records.push({ event, attempts: 0, lastAttemptAt: null });
        return records;
      });
      // Yerel abonelere anında bildir (kuyruğa düşürmeden — UI gecikmesiz).
      const set = handlers.get(event.eventType);
      if (set) {
        for (const handler of set) {
          try {
            await handler(event);
          } catch {
            // Abone hatası yayını bozmaz; olay kuyrukta kalır (drain tekrar dener).
          }
        }
      }
    },

    subscribe<K extends keyof AppEventMap>(eventType: K, handler: AppEventHandler<K>): EventSubscription {
      let set = handlers.get(eventType);
      if (!set) {
        set = new Set();
        handlers.set(eventType, set);
      }
      set.add(handler as AppEventHandler);
      return {
        unsubscribe(): void {
          set.delete(handler as AppEventHandler);
        },
      };
    },

    async drain(handler) {
      const records = await backend.load();
      let delivered = 0;
      let failed = 0;
      const remaining: OutboxEventRecord[] = [];
      for (const record of records) {
        let ok = false;
        try {
          ok = await handler(record.event);
        } catch {
          ok = false;
        }
        const attempts = record.attempts + 1;
        if (ok) {
          delivered += 1;
          continue;
        }
        failed += 1;
        remaining.push({ ...record, attempts, lastAttemptAt: now() });
      }
      await backend.save(remaining);
      return { delivered, failed, remaining: remaining.length };
    },

    async stats() {
      const records = await backend.load();
      const byType: Record<string, number> = {};
      let deadLetters = 0;
      for (const record of records) {
        byType[record.event.eventType] = (byType[record.event.eventType] ?? 0) + 1;
        if (record.attempts >= OUTBOX_MAX_ATTEMPTS) deadLetters += 1;
      }
      return { pending: records.length, byType, deadLetters };
    },

    async listDeadLetters() {
      const records = await backend.load();
      return records.filter((r) => r.attempts >= OUTBOX_MAX_ATTEMPTS);
    },
  };
}

/** Backoff hesabı — offline-queue ile aynı eğri (test/panel kullanımı). */
export { offlineQueueBackoffMs as outboxBackoffMs };

/** Kullanılmayan AppEvent tip referansını koru (tip çıkarımı için). */
export type { AppEvent };
