/**
 * MIA Faz 1A ② — Uygulama olay sistemi sözleşmeleri (§2 event modeli).
 *
 * İKİ KATMANLI OLAY MİMARİSİ (karar):
 *  - `src/app/shell-events.ts`  → UI katmanı, geçici (shell olayları) — KORUNUR.
 *  - `src/contracts/events.ts`  → uygulama olayları; Faz 4'te kalıcı Outbox
 *    kuyruğuna bağlanır — BU DOSYA.
 *
 * ÖNEMLİ AYRIM: `src/core/taste/types.ts` içindeki `TasteEvent` zevk öğrenme
 * olaylarının ÖZEL modelidir; genel uygulama olay sistemiyle karıştırılmaz ve
 * çoğaltılmaz (Faz 0 kararı).
 */

import type { ProfileRef } from './common.ts';

/**
 * Uygulama olayının temel modeli (kullanıcı planı §3 AppEvent ile birebir).
 */
export interface AppEvent<TPayload = Record<string, unknown>> {
  /** Olayın evrensel tekil kimliği (idempotency anahtarı). */
  readonly eventId: string;
  /** Olay türü — `AppEventMap` anahtarlarından biri. */
  readonly eventType: string;
  /** Olayın ait olduğu profil — zorunlu (profil izolasyonu). */
  readonly profileId: string;
  /** İlgili içerik/varlık kimliği (örn. medya anahtarı). Opsiyonel. */
  readonly entityId?: string;
  /** Olayın oluşma zamanı (ISO-8601). */
  readonly occurredAt: string;
  /** Olay şeması sürümü — ileride şema değişikliklerinde zorunlu. */
  readonly schemaVersion: number;
  /** Olay yükü — `AppEventMap` üzerinden türe bağlanır. */
  readonly payload: TPayload;
  /**
   * Olayın kaynağından gelen profil revision'ı (varsa). Outbox işleyicileri
   * işleme başlarken profil hâlâ aynıysa işlem yapar; değilse olayı
   * `profile-switched` gerekçesiyle arşivler.
   */
  readonly sourceRevision?: number;
  /** Profil referansı kısayolu — ProfileRef uyumu. */
  readonly ref?: ProfileRef;
}

/**
 * Uygulama olay türleri → payload eşlemesi.
 *
 * Somut olaylar (`LibraryItemAdded`, `LibraryRatingChanged`, `ProfileSwitched`
 * vb.) Faz 1A ④ adımında bu arayüze declaration-merging ile eklenecek.
 * Şimdilik bilinen ilk iki olay, Faz 4 pilot kapsamıyla uyumlu olarak
 * tanımlıdır (plan: "önce yalnızca LibraryItemAdded + LibraryRatingChanged").
 */
export interface AppEventMap {
  'LibraryItemAdded': {
    readonly mediaType: 'movie' | 'tv';
    readonly list: string;
  };
  'LibraryRatingChanged': {
    readonly mediaType: 'movie' | 'tv';
    readonly rating: number | null;
    readonly previousRating?: number | null;
  };
}

/** Tür güvenli genel olay: eventType, AppEventMap anahtarlarından biri. */
export type TypedAppEvent<K extends keyof AppEventMap = keyof AppEventMap> = AppEvent<AppEventMap[K]> & {
  readonly eventType: K;
};

/** Olay aboneliği — unsubscribe dönendir. */
export interface EventSubscription {
  unsubscribe(): void;
}

/**
 * IEventPublisher — olay YAYINLAMA sözleşmesi.
 *
 * Kural: Yayıncı olayın işlenmesini BEKLEMEZ (fire-and-forget); kalıcılık
 * Outbox'a (Faz 4) aittir. Yayınlama başarısız olursa çağıran modül hatayı
 * alır — sessiz yutma yasaktır (66 sessiz catch dersi).
 */
export interface IEventPublisher {
  /**
   * Olayı yayınlar. Uygulama, olayı kalıcı kuyruğa yazmalıdır; kuyruk
   * yazımı başarısızsa reddeder (throw).
   */
  publish<K extends keyof AppEventMap>(event: TypedAppEvent<K>): Promise<void>;
}

/** Olay işleyici imzası. */
export type AppEventHandler<K extends keyof AppEventMap = keyof AppEventMap> = (
  event: TypedAppEvent<K>
) => Promise<void> | void;

/**
 * IEventSubscriber — olay DİNLEME sözleşmesi.
 *
 * Kural: Aboneler idempotent olmak ZORUNDADIR (aynı olay iki kez işlenirse
 * çift etki oluşmamalı — kullanıcı planı §3 güvenlik kuralları).
 */
export interface IEventSubscriber {
  subscribe<K extends keyof AppEventMap>(eventType: K, handler: AppEventHandler<K>): EventSubscription;
}
