/**
 * MIA Faz 6 — Değerlendirme Yöneticisi.
 *
 * Öneri motorunun çevrimdışı değerlendirme koşumunu (`core/evaluation.ts`)
 * yönetici yüzeyine taşır. Metrik formülleri DEĞİŞTİRİLMEZ; tek kaynak
 * çekirdek değerlendirme koşumudur.
 */

import {
  evaluateRecommendationEngine,
  tasteCoverage,
  tasteUnknownRate,
  type EvaluateEngineInput,
  type RecommendationEvaluationReport,
  type TasteArchaeologySpearman,
} from '../../core/evaluation.ts';

export type {
  EvaluateEngineInput,
  RecommendationEvaluationReport,
  TasteArchaeologySpearman,
};

export interface EvaluationManager {
  evaluate(input: EvaluateEngineInput): RecommendationEvaluationReport;
  tasteCoverage: typeof tasteCoverage;
  tasteUnknownRate: typeof tasteUnknownRate;
}

/** Değerlendirme yöneticisi (tek örnek; durum tutmaz). */
export function createEvaluationManager(): EvaluationManager {
  return {
    evaluate: (input) => evaluateRecommendationEngine(input),
    tasteCoverage,
    tasteUnknownRate,
  };
}
