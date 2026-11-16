/**
 * MIA Faz 1B ⑤b — Öneri motorunun servis sözleşmesine hazırlanması.
 *
 * BAĞLAMA STRATEJİSİ (işlev kaybı yok, puanlar değişmez):
 * Mevcut öneri motoru (`recommendation-orchestrator.ts`, `scoring.ts`)
 * UI toplu-işlem odaklı çalışır ve Faz 6'da "önce/sonra aynı sonuç" testiyle
 * bağımsızlaştırılacak. Bu adaptör, motoru ENJEKTE edilmiş bir hesaplayıcı
 * üzerinden `IRecommendationService` sözleşmesine bağlar:
 *  - `computeRecommendations` Faz 6'da gerçek motor bağlanana kadar
 *    boş sonuç döner (sessiz başarı yerine AÇIK durum).
 *  - Öneri motoru kullanıcı hafızasına YAZAMAZ (sözleşme kuralı) — adaptör
 *    yalnızca okuma + önbellek geçersizleştirme sunar.
 *  - Profil izolasyonu: sonuçlar profileId + revision damgasıyla önbelleklenir;
 *    revision değişince önbellek otomatik geçersizleşir.
 */

import type {
  IRecommendationService,
  OperationOutcome,
  ProfileRef,
  RecommendationView,
} from '../contracts/index.ts';

/** Gerçek motorun Faz 6'da bağlanacağı hesaplayıcı imzası. */
export type RecommendationComputer = (
  ref: ProfileRef,
  limit: number
) => Promise<readonly RecommendationView[]> | readonly RecommendationView[];

export interface CreateRecommendationServiceAdapterOptions {
  /** Öneri hesaplayıcı (Faz 6'da gerçek motor; varsayılan boş). */
  readonly computeRecommendations?: RecommendationComputer;
  /** Önbellek boyutu (profil başına tek girdi — son hesap saklanır). */
}

export function createRecommendationServiceAdapter(
  options: CreateRecommendationServiceAdapterOptions = {}
): IRecommendationService {
  const compute = options.computeRecommendations;

  // Profil başına tek girdi: { revision, sonuç } — revision değişince geçersiz.
  let cache: { profileId: string; revision: number | undefined; results: readonly RecommendationView[] } | null =
    null;

  return {
    async getRecommendations(ref: ProfileRef, limit = 20): Promise<readonly RecommendationView[]> {
      if (!ref?.profileId) {
        throw new Error('getRecommendations: profileId zorunludur (K1 — profil izolasyonu)');
      }
      if (
        cache &&
        cache.profileId === ref.profileId &&
        cache.revision === ref.revision &&
        cache.results.length > 0
      ) {
        return cache.results.slice(0, Math.max(1, limit));
      }
      if (!compute) {
        // Faz 6'ya kadar motor bağlanmadı — boş sonuç AÇIK davranıştır.
        return [];
      }
      const results = await compute(ref, Math.max(1, limit));
      cache = { profileId: ref.profileId, revision: ref.revision, results };
      return results.slice(0, Math.max(1, limit));
    },

    async refresh(ref: ProfileRef): Promise<OperationOutcome> {
      if (!ref?.profileId) {
        return { ok: false, error: 'profileId zorunludur', retryable: false };
      }
      // Önbelleği geçersizleştir; yeniden hesaplama Faz 4'te kuyruk görevi olur.
      cache = null;
      return { ok: true };
    },
  };
}
