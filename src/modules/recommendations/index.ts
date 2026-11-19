/**
 * MIA Faz 6 — Öneri ve Keşif Yöneticisi dış yüzü.
 *
 * UI ve sunucu kodu öneri işlevlerine YALNIZCA bu modül üzerinden erişir;
 * çekirdek dosya yollarına doğrudan bağımlılık kurmaz. Alt yöneticiler:
 *
 * - `RecommendationEngine`     — puanlama zenginleştirme + türetilmiş önbellek
 * - `CandidatePoolManager`     — katı film/dizi havuz ayrımı
 * - `ExplanationManager`       — halka çözümleme + gerekçe eşlemesi
 * - `EvaluationManager`        — çevrimdışı değerlendirme metrikleri
 * - `RankingManager`           — oyuncu kaynaklı öneri sıralaması
 */

export {
  buildDerivedProfilePayloadFromTasteMap,
  createRecommendationEngine,
  enrichCatalogItemsWithTaste,
  hydrateTasteMapWithDerivedCache,
  type RecommendationEngine,
} from './RecommendationEngine.ts';

export {
  createCandidatePoolManager,
  enforceStrictMediaTypePool,
  type CandidatePoolManager,
} from './CandidatePoolManager.ts';

export {
  createExplanationManager,
  mapRecommendationBatchToDisplayItems,
  resolveDisplayedLifecycleRing,
  type ExplanationManager,
} from './ExplanationManager.ts';

export {
  createEvaluationManager,
  type EvaluateEngineInput,
  type EvaluationManager,
  type RecommendationEvaluationReport,
  type TasteArchaeologySpearman,
} from './EvaluationManager.ts';

export {
  createRankingManager,
  type ActorRecommendationItem,
  type RankingManager,
  type ScoreActorRecommendationsOptions,
} from './RankingManager.ts';

import { createRecommendationEngine } from './RecommendationEngine.ts';
import { createCandidatePoolManager } from './CandidatePoolManager.ts';
import { createExplanationManager } from './ExplanationManager.ts';
import { createEvaluationManager } from './EvaluationManager.ts';
import { createRankingManager } from './RankingManager.ts';

/** Yönetici kimliği — modül sağlık raporlarında kullanılır. */
export const RECOMMENDATION_MANAGER_ID = 'recommendations';
export const RECOMMENDATION_MANAGER_VERSION = '1.0.0';

export interface RecommendationManager {
  readonly id: typeof RECOMMENDATION_MANAGER_ID;
  readonly version: typeof RECOMMENDATION_MANAGER_VERSION;
  readonly engine: ReturnType<typeof createRecommendationEngine>;
  readonly pool: ReturnType<typeof createCandidatePoolManager>;
  readonly explanations: ReturnType<typeof createExplanationManager>;
  readonly evaluation: ReturnType<typeof createEvaluationManager>;
  readonly ranking: ReturnType<typeof createRankingManager>;
}

/**
 * Bağımsız Öneri Yöneticisi. Saf işlevlerden oluşur; kullanıcı hafızasına
 * yazmaz, profil verisini değiştirmez.
 */
export function createRecommendationManager(): RecommendationManager {
  return {
    id: RECOMMENDATION_MANAGER_ID,
    version: RECOMMENDATION_MANAGER_VERSION,
    engine: createRecommendationEngine(),
    pool: createCandidatePoolManager(),
    explanations: createExplanationManager(),
    evaluation: createEvaluationManager(),
    ranking: createRankingManager(),
  };
}
