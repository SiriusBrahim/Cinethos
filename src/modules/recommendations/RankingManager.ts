/**
 * MIA Faz 6 — Sıralama Yöneticisi.
 *
 * Oyuncu/favori kaynaklı önerilerin puanlama ve çeşitlendirme adımlarını
 * yönetici yüzeyine taşır. Algoritma `core/actor-recommendations.ts` içinde
 * KORUNUR; burada yeniden uygulanmaz.
 */

import {
  calculateActorRoleBonus,
  diversifyActorRecommendations,
  scoreActorRecommendations,
  type ActorRecommendationItem,
  type ScoreActorRecommendationsOptions,
} from '../../core/actor-recommendations.ts';

export type { ActorRecommendationItem, ScoreActorRecommendationsOptions };

export interface RankingManager {
  scoreActorRecommendations(options: ScoreActorRecommendationsOptions): ActorRecommendationItem[];
  diversifyActorRecommendations: typeof diversifyActorRecommendations;
  calculateActorRoleBonus: typeof calculateActorRoleBonus;
}

/** Sıralama yöneticisi (tek örnek; durum tutmaz). */
export function createRankingManager(): RankingManager {
  return {
    scoreActorRecommendations,
    diversifyActorRecommendations,
    calculateActorRoleBonus,
  };
}
