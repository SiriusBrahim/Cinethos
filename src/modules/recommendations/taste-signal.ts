/**
 * Sunucu zevk profili → öneri sinyali.
 *
 * Sunucudaki `TasteProfile` (Faz 1/2 metrik motoru) ile istemcideki
 * `scoreCandidatesV3` arasındaki tek köprü burasıdır. Profil yalnızca
 * gösterim amaçlı taşınmaz: üretilen sinyal, puanlamada tür ve ruh hâli
 * bileşenlerini gerçekten etkiler.
 *
 * Sinirlar:
 * - Kullanıcı verisi yazmaz; yalnızca okur.
 * - Düşük güvenli profiller (`confidence < SERVER_TASTE_MIN_CONFIDENCE`)
 *   sıralamayı etkilemez; istemci yerel zevk profili tek başına kalır.
 */

import type { TasteProfile } from '../../core/taste/types.ts';
import { resolveEffectiveMetricView } from '../../core/taste/metric-labels.ts';
export { genreMetricIdFor } from '../../core/taste/genre-metric.ts';

export const SERVER_TASTE_MIN_CONFIDENCE = 0.35;
/** Sunucu sinyalinin tür puanındaki azami ağırlığı. */
export const SERVER_TASTE_GENRE_WEIGHT = 0.25;
/** Sunucu sinyalinin bağlam/ruh hâli puanındaki azami ağırlığı. */
export const SERVER_TASTE_MOOD_WEIGHT = 0.15;

export interface ServerTasteSignal {
  readonly profileId: string;
  readonly generationId: string;
  /** 0..1 — profilin kanıt güveni. */
  readonly confidence: number;
  /** `genre.*` metrik kimliği → -1..1 afinite. */
  readonly genreAffinity: Readonly<Record<string, number>>;
  /** Seçili ruh hâli için -1..1 afinite; ruh hâli yoksa null. */
  readonly moodAffinity: number | null;
  readonly updatedAt: string;
}


function clampAffinity(value: unknown): number | null {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.max(-1, Math.min(1, num / 100));
}

function normalizeMoodKey(mood: string): string {
  return mood
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '_');
}

/**
 * `TasteProfile.metrics` içinden yalnızca sıralamada kullanılabilir
 * (bilinen, dışlanmamış) tür ve ruh hâli afinitelerini çıkarır.
 */
export function buildServerTasteSignal(
  profile: Pick<TasteProfile, 'metrics'> & {
    profileId?: string;
    generationId?: string;
    confidenceLevel?: string;
    updatedAt?: string;
  },
  options: { mood?: string; confidence?: number } = {}
): ServerTasteSignal | null {
  if (!profile || !profile.metrics) return null;

  const genreAffinity: Record<string, number> = {};
  let directionalCount = 0;
  let knownCount = 0;

  for (const [metricId, metric] of Object.entries(profile.metrics)) {
    if (!metric || typeof metric !== 'object') continue;
    // Manuel dışlama (exclude override) ve bilinmeyen metrikler sıralamaya girmez;
    // boost/suppress ise efektif afiniteye yansır (tek yetkili çözümleyici).
    const view = resolveEffectiveMetricView(metric);
    if (view.isExcluded || view.effectiveStatus === 'unknown') continue;
    knownCount += 1;
    if (view.effectiveStatus !== 'directional') continue;
    directionalCount += 1;
    if (!metricId.startsWith('genre.')) continue;
    const affinity = clampAffinity(view.effectiveAffinity);
    if (affinity !== null) genreAffinity[metricId] = affinity;
  }

  if (Object.keys(genreAffinity).length === 0) return null;

  const coverageConfidence =
    knownCount > 0 ? Math.min(1, directionalCount / Math.max(3, knownCount)) : 0;
  const levelBonus =
    profile.confidenceLevel === 'high' ? 0.2 : profile.confidenceLevel === 'medium' ? 0.1 : 0;
  const confidence = Math.max(
    0,
    Math.min(1, options.confidence ?? coverageConfidence * 0.8 + levelBonus)
  );

  const moodKey = options.mood ? normalizeMoodKey(options.mood) : '';
  const moodMetric = moodKey ? profile.metrics[`mood.${moodKey}`] : undefined;
  const moodView = moodMetric ? resolveEffectiveMetricView(moodMetric) : null;
  const moodAffinity =
    moodView && !moodView.isExcluded && moodView.effectiveStatus !== 'unknown'
      ? clampAffinity(moodView.effectiveAffinity)
      : null;

  return {
    profileId: profile.profileId ?? '',
    generationId: profile.generationId ?? '',
    confidence,
    genreAffinity,
    moodAffinity,
    updatedAt: profile.updatedAt ?? new Date().toISOString(),
  };
}

/** Sinyalin sıralamada kullanılabilir olup olmadığı. */
export function isServerTasteSignalUsable(
  signal: ServerTasteSignal | null | undefined
): signal is ServerTasteSignal {
  return Boolean(signal && signal.confidence >= SERVER_TASTE_MIN_CONFIDENCE);
}
