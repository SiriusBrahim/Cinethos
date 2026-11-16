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

import type { LibraryListId, MediaKind, WriteProfileRef } from './common.ts';

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
   * Olayın kaynağından gelen profil revision'ı (ZORUNLU). Outbox işleyicileri
   * işleme başlarken profil hâlâ aynıysa işlem yapar; değilse olayı
   * `profile-switched` / `stale-revision` gerekçesiyle arşivler.
   */
  readonly sourceRevision: number;
  /** Profil referansı kısayolu — WriteProfileRef uyumu. */
  readonly ref?: WriteProfileRef;
}

/**
 * AppEventMap — UYGULAMA OLAY KATALOĞU (Faz 1A ④).
 *
 * Kullanıcı planı §3 olay tablosunun tamamı. Kurallar:
 * - Her olay payload'ı salt-okunurdur; işleyiciler payload'ı DEĞİŞTİREMEZ.
 * - Yeni olay eklemek = bu eşlemeye yeni anahtar + payload tipi.
 * - Faz 4 pilotu yalnızca `LibraryItemAdded` + `LibraryRatingChanged`
 *   işleyecektir; diğer olaylar katalogda TANIMLI ama henüz yayınlanmaz
 *   (yayınlanma Faz 3-7'de kademeli açılır).
 * - `TasteEvent` (zevk öğrenme) bu katalogda YOKTUR — özel model kalır.
 */
export interface AppEventMap {
  /** İçerik bir listeye eklendi (Faz 4 pilotu) — kanonik mediaKey zorunlu. */
  'LibraryItemAdded': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    readonly list: LibraryListId;
  };
  /** İçerik bilgisi değişti (başlık notu, bölüm ilerlemesi vb. alan yazımları). */
  'LibraryItemUpdated': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    /** Değişen alan adları — artımlı işleme girdisi. */
    readonly changedFields: readonly string[];
  };
  /** İzleme durumu değişti (liste değişimi). */
  'LibraryStatusChanged': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    readonly from: LibraryListId | null;
    readonly to: LibraryListId;
  };
  /** Puan değişti (Faz 4 pilotu). `null` = puan kaldırıldı. */
  'LibraryRatingChanged': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    readonly rating: number | null;
    readonly previousRating?: number | null;
  };
  /** İçerik silindi (tombstone'a düştü — geri alma penceresi açık). */
  'LibraryItemRemoved': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    /** Silinmeden önceki liste — sinyal geri alma için. */
    readonly previousList: LibraryListId | null;
  };
  /** Favori oyuncu listesi değişti. */
  'FavoriteActorChanged': {
    readonly change: 'added' | 'removed' | 'updated';
    readonly actorId?: number;
  };
  /** Aktif profil değişti — arka plan işleyicileri uçuştaki işleri arşivler. */
  'ProfileSwitched': {
    readonly fromProfileId: string | null;
    readonly toProfileId: string;
  };
  /** İçerik metaverisi tamamlandı (arka plan zenginleştirme işi bitti). */
  'CatalogItemEnriched': {
    readonly mediaKey: string;
    readonly mediaType: MediaKind;
    /** Tamamlanan alanlar (örn. ['posterPath','overview']). */
    readonly enrichedFields: readonly string[];
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
