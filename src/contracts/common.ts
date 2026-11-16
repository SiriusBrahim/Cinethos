/**
 * MIA Faz 1A ② — Ortak sözleşme tipleri.
 *
 * Bu dosya KASTEN hiçbir mevcut modülden import yapmaz. Sözleşmeler kendi
 * kendine yeterlidir (self-contained); böylece Faz 1B'de mevcut sistemler
 * bu arayüzleri uygularken contracts ↔ core döngüsü oluşamaz.
 *
 * Buradaki yapısal tipler, mevcut çekirdek tipleriyle (örn. `SavedItem`,
 * `DataDocument`) yapısal uyumludur; gerçek eşleme Faz 1B'de yapılır.
 */

/** Medya türü — olay ve servis sözleşmelerinde ortak kullanılır. */
export type MediaKind = 'movie' | 'tv';

/**
 * Kullanıcı liste kimlikleri (mevcut uygulama alanlarıyla uyumlu).
 * Ortak katmanda tanımlıdır; hem servis hem olay sözleşmeleri kullanır
 * (events ↔ services tip döngüsünü önlemek için).
 */
export type LibraryListId = 'watched' | 'watching' | 'watchlist' | 'not-interested';

/**
 * Profil referansı — profil izolasyonunun temel sözleşmesi.
 *
 * KURAL (MIA planı §7.1, P1-2): Her asenkron işlem `profileId` taşımak
 * ZORUNDADIR; yazma işlemleri ayrıca kaynak `revision` bilgisi taşımalıdır.
 * Profil değiştikten sonra tamamlanan eski-profil sonuçları yeni profile
 * yazılamaz (revision çelişirse işlem reddedilir).
 */
export interface ProfileRef {
  /** İşlemin ait olduğu profil. Boş/geçersiz profil kimliği yasak. */
  readonly profileId: string;
  /**
   * İşlem yapıldığı anda beklenen belge revision'ı. Yazma işlemlerinde
   * zorunlu; okuma işlemlerinde opsiyoneldir (belirtilirse tutarlılık kontrolü
   * için kullanılır).
   */
  readonly revision?: number;
}

/** Bir işlemin revision çelişkisi nedeniyle reddedilme nedeni. */
export type ProfileConflictReason = 'profile-switched' | 'stale-revision' | 'profile-not-found';

/** Revision/profil çelişkisi hatası — arka plan işleyicileri bunu ayrı tutmalı. */
export class ProfileConflictError extends Error {
  readonly reason: ProfileConflictReason;
  readonly expectedRevision?: number;
  readonly actualRevision?: number;

  constructor(
    reason: ProfileConflictReason,
    options?: { expectedRevision?: number; actualRevision?: number; message?: string }
  ) {
    super(
      options?.message ??
        `Profil çelişkisi: ${reason}` +
          (options?.expectedRevision !== undefined
            ? ` (beklenen rev ${options.expectedRevision}, gerçek rev ${options.actualRevision ?? 'bilinmiyor'})`
            : '')
    );
    this.name = 'ProfileConflictError';
    this.reason = reason;
    this.expectedRevision = options?.expectedRevision;
    this.actualRevision = options?.actualRevision;
  }
}

/** Yönetici modül sağlığı — IApplicationModule.healthCheck() sonucu. */
export interface ModuleHealth {
  readonly moduleId: string;
  readonly status: 'healthy' | 'degraded' | 'unhealthy';
  /** Modül çalışma süresi (ms) — Sistem Yönetimi Paneli (§6) için. */
  readonly uptimeMs?: number;
  /** Son başarılı işlem zamanı (ISO-8601) — panel için. */
  readonly lastSuccessfulOperationAt?: string | null;
  /** Birikmiş hata sayısı — panel için. */
  readonly errorCount?: number;
  readonly detail?: string;
}

/** Genel işlem sonucu — servis sözleşmelerinde hata sinyali için. */
export type OperationOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly retryable: boolean };
