/**
 * MIA Faz 1B ③ — TasteRebuildCoordinator görev sınırı (port).
 *
 * GÖREV SINIRI (netleştirme — davranış değişikliği yok):
 * `taste-rebuild-coordinator.ts` zaten şu kurallarla çalışır (kod içi yorumlar
 * doğrulandı, Faz 0 §G):
 *  - `cinetrack-data.json` yalnızca OKUNUR, ASLA yazılmaz (Mutlak Kural).
 *  - Yalnızca taste deposu dosyalarına (`data/taste/*`) yazar.
 *  - Yeniden hesaplama zinciri halihazırda serileştirilmiştir
 *    (`activeRebuildChains` — aynı dataDir için eşzamanlı rebuild yok).
 *
 * Bu port, koordinatörü MIA sözleşmelerine bağlayan DAR yüzeydir:
 *  - Girdi `ProfileRef` (profileId + revision) — profil izolasyonu K1/K2.
 *  - Koordinatör bir Arka Plan Yöneticisi (Faz 4) GÖREVİDİR; kullanıcı
 *    arayüzünden doğrudan çağrılmamalıdır (Faz 6/7'de kancalar üzerinden).
 *  - Hata zinciri bozmaz: bir rebuild başarısız olsa da sonraki çalışır
 *    (mevcut `prevChain.then(…, …)` davranışı korunur).
 */

import type { ProfileRef } from '../contracts/index.ts';

/** Bir rebuild çalışmasının sonucu (mevcut RebuildCoordinatorResult ile uyumlu). */
export interface TasteRebuildOutcome {
  readonly ok: boolean;
  /** Yeniden hesaplama yapıldı mı (değişiklik yoksa false — mevcut davranış). */
  readonly rebuilt: boolean;
  readonly error?: string;
}

/** Enjeksiyon noktası: gerçek koordinatör fonksiyonu (testlerde sahte). */
export type TasteRebuildTrigger = () => Promise<TasteRebuildOutcome>;

/** TasteRebuildCoordinator'ın MIA port'u. */
export interface TasteRebuildPort {
  /**
   * Zevk profili yeniden hesaplamasını tetikler.
   * KURAL: çağıran, döndükten sonra yazım yapacaksa `ProfileContext.assertCurrent`
   * ile güncelliği ayrıca denetlemelidir (profil izolasyonu, K3).
   */
  triggerRebuild(ref: ProfileRef, reason?: string): Promise<TasteRebuildOutcome>;
  /** Koordinatörün mevcut zincirde işi var mı (panel/health için). */
  isBusy(): boolean;
}

/** Boş/uzak profil referansı reddi — K1 (profileId zorunlu). */
export class MissingProfileRefError extends Error {
  constructor() {
    super('triggerRebuild: profileId zorunludur (K1 — profil izolasyonu)');
    this.name = 'MissingProfileRefError';
  }
}

/**
 * Port fabrikası. `trigger` enjekte edilmezse gerçek koordinatör kullanılır
 * (tembel import ile — modül yükleme maliyeti yalnızca gerçek kullanımda).
 */
export function createTasteRebuildPort(trigger?: TasteRebuildTrigger): TasteRebuildPort {
  let busy = false;

  async function runTrigger(impl: TasteRebuildTrigger): Promise<TasteRebuildOutcome> {
    busy = true;
    try {
      return await impl();
    } finally {
      busy = false;
    }
  }

  return {
    async triggerRebuild(ref: ProfileRef, _reason?: string): Promise<TasteRebuildOutcome> {
      if (!ref || !ref.profileId) {
        throw new MissingProfileRefError();
      }
      if (trigger) {
        try {
          return await runTrigger(trigger);
        } catch (error) {
          return {
            ok: false,
            rebuilt: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      // Gerçek koordinatör — dinamik import (döngüsüz, tembel yükleme).
      // RebuildCoordinatorResult: { generationId, profile, eventsCount,
      // indexedItemsCount } — başarısızlık throw ile bildirilir.
      const coordinator = await import('./taste-rebuild-coordinator.ts');
      try {
        await coordinator.triggerTasteProfileRebuild();
        return { ok: true, rebuilt: true };
      } catch (error) {
        return {
          ok: false,
          rebuilt: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },

    isBusy(): boolean {
      return busy;
    },
  };
}
