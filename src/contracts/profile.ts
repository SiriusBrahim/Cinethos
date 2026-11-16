/**
 * MIA Faz 1A ② — Merkezi profil bağlamı sözleşmesi.
 *
 * KRİTİK BULGU TEMELİ (Faz 1 hazırlık denetimi, P1-2):
 * Mevcut uygulamada profil işlemleri `DataDocument.activeProfileId` üzerinden
 * yürür; merkezi bir ProfileContext yoktur. Faz 1A ile sözleşme tanımlanır;
 * Faz 1B'de mevcut profil akışı bu sözleşmeye bağlanır.
 *
 * HEDEF HATA SENARYOSU (engellenecek):
 *   A profilinde öneri hesabı başlar → kullanıcı B'ye geçer → hesap tamamlanır
 *   → sonuç B'nin ekranına yazılır. `ProfileRef.revision` zorunluluğu ve
 *   `assertCurrent` ile bu senaryo kesin olarak reddedilir.
 */

import type { ProfileConflictError, ProfileRef } from './common.ts';

/** Profil değişim bildirimi. */
export interface ProfileChangeEvent {
  readonly previous: ProfileRef | null;
  readonly current: ProfileRef;
}

/** Profil değişim dinleyicisi. */
export type ProfileChangeListener = (event: ProfileChangeEvent) => void | Promise<void>;

/**
 * IProfileContext — aktif profilin ve profil değişimlerinin tek doğruluk
 * kaynağı.
 */
export interface IProfileContext {
  /** Aktif profil referansı (profileId + güncel revision). */
  getCurrent(): ProfileRef;

  /**
   * Verilen referansın hâlâ güncel olup olmadığını denetler.
   * - `profileId` aktif profille uyuşmuyorsa → 'profile-switched'
   * - `revision` belirtilmiş ve güncel revision'dan eskiyse → 'stale-revision'
   * Uyumluysa sessizce geçer; uyuşmazsa `ProfileConflictError` fırlatır.
   *
   * Arka plan işleyicileri ASYNC devam etmeden hemen önce bu çağrıyı yapmak
   * ZORUNDADIR (profil izolasyonu kuralı).
   */
  assertCurrent(ref: ProfileRef): void;

  /**
   * Aktif profilin güncel revision'ını döner (okuma işlemleri için
   * revision damgası almak amacıyla).
   */
  getRevision(): Promise<number>;

  /** Profil değişimlerine abone olur; unsubscribe dönendir. */
  onProfileChange(listener: ProfileChangeListener): { unsubscribe(): void };
}

/** ProfileConflictError'ı dışa da açıyoruz (uygulamalar aynı sınıfı kullanmalı). */
export type { ProfileConflictError };
