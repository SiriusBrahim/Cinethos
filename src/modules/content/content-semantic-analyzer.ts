/**
 * MIA Faz 2 — Content Semantic Analyzer
 *
 * Sorumluluklar:
 * - Tüm kanonik ruh hâlleri üzerinden sayısal mood/atmosfer vektörü üretme
 * - İki dilli (TR/EN) anlamsal kavram ve TMDB anahtar kelime çıkarımı
 * - Yönetmen / senarist / oyuncu / evren kimlik özeti (görselsiz, kullanıcısız)
 * - İçerikler arası benzerlik (kosinüs, atmosfer, kavram) ve zıtlık (contrast) hesabı
 */

import { cosineSimilarity, tokenizeText } from '../../core/encoding.ts';
import { calculateMoodAffinity } from '../../core/mood-affinity.ts';
import {
  classifyCrewAndCast,
  evaluateAtmosphereCoOccurrence,
  extractKeywordData,
  extractSemanticConcepts,
} from '../../core/relationship-semantics.ts';
import {
  CANONICAL_MOOD_IDS,
  CONTENT_INTELLIGENCE_VERSION,
  type CanonicalMoodId,
  type ContentFeatureBundle,
  type ContentMoodVector,
  type ContentRelationshipLink,
  type ContentSemanticProfile,
  type MoodAffinityDetail,
  type NormalizedContentMetadata,
} from './types.ts';

function round3(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 1000) / 1000;
}

function round2(n: number): number {
  return Math.round(Math.max(0, Math.min(1, n)) * 100) / 100;
}

export class ContentSemanticAnalyzer {
  buildMoodVector(metadata: NormalizedContentMetadata): ContentMoodVector {
    const moodInput = {
      id: metadata.tmdbId,
      media_type: metadata.mediaType,
      title: metadata.title,
      name: metadata.mediaType === 'tv' ? metadata.title : undefined,
      overview: metadata.overview,
      genre_ids: [...metadata.genreIds],
      keywords: metadata.keywords.map((k) => ({ id: k.id, name: k.name })),
    };

    const moodScores: Record<CanonicalMoodId, number> = {
      dark: 0.5,
      thoughtful: 0.5,
      'feel-good': 0.5,
      'mind-bending': 0.5,
      cheerful: 0.5,
      deep: 0.5,
      thrilling: 0.5,
      romantic: 0.5,
    };

    const details: MoodAffinityDetail[] = [];
    let nonNeutralCount = 0;

    for (const moodId of CANONICAL_MOOD_IDS) {
      const res = calculateMoodAffinity(moodInput, moodId);
      moodScores[moodId] = round3(res.atmosphereScore);
      const conf = res.isNeutralFallback
        ? 0.2
        : round2(
            Math.min(
              0.95,
              0.45 +
                res.matchedFeatures.length * 0.1 +
                (metadata.overview ? 0.15 : 0) +
                (metadata.keywords.length > 0 ? 0.15 : 0)
            )
          );
      if (!res.isNeutralFallback) nonNeutralCount += 1;
      details.push({
        moodId,
        label: res.label,
        score: round3(res.atmosphereScore),
        confidence: conf,
        matchedSignals: [...res.matchedFeatures],
        opposingSignals: [...res.opposingFeatures],
      });
    }

    const dominantMoods = [...details]
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    const avgConf =
      details.reduce((acc, d) => acc + d.confidence, 0) / details.length;

    return {
      version: CONTENT_INTELLIGENCE_VERSION,
      moods: moodScores,
      dominantMoods,
      overallConfidence: round2(avgConf),
      isNeutralFallback: nonNeutralCount === 0,
    };
  }

  buildSemanticProfile(
    metadata: NormalizedContentMetadata,
    moodVector: ContentMoodVector
  ): ContentSemanticProfile {
    const kwData = extractKeywordData({ keywords: metadata.keywords });
    const textCombined = `${metadata.title} ${metadata.overview}`;
    const semanticConcepts = extractSemanticConcepts(textCombined, kwData);
    const classified = classifyCrewAndCast(
      metadata.cast.map((c) => ({ id: c.id, name: c.name, character: c.character })),
      metadata.crew.map((c) => ({
        id: c.id,
        name: c.name,
        job: c.job,
        department: c.department,
      }))
    );

    const conceptIdsList = [...semanticConcepts.conceptIds];
    const concepts = conceptIdsList.map((id, idx) => ({
      id,
      label: semanticConcepts.matchedLabels[idx] || id,
      matchedTerms: semanticConcepts.matchedPhrases[idx]
        ? [semanticConcepts.matchedPhrases[idx]]
        : [],
      confidence: round2(metadata.overview && metadata.keywords.length > 0 ? 0.9 : 0.72),
    }));

    // Atmosfer kümelerini belirle
    const atmosphereClusters: string[] = [];
    if (moodVector.moods.dark >= 0.65) atmosphereClusters.push('dark_psychological');
    if (moodVector.moods.thoughtful >= 0.65) atmosphereClusters.push('thoughtful_philosophical');
    if (moodVector.moods['feel-good'] >= 0.65) atmosphereClusters.push('feel_good_warm');
    if (moodVector.moods['mind-bending'] >= 0.65) atmosphereClusters.push('mind_bending_puzzle');
    if (moodVector.moods.thrilling >= 0.65) atmosphereClusters.push('high_tension_thriller');
    if (moodVector.moods.deep >= 0.65) atmosphereClusters.push('deep_dramatic');
    if (moodVector.moods.romantic >= 0.65) atmosphereClusters.push('romantic_emotional');

    // Zıtlık kutupları
    const contrastPoles: string[] = [];
    if (moodVector.moods.dark >= 0.68 && moodVector.moods.cheerful <= 0.4) {
      contrastPoles.push('pole:dark-bleak');
    }
    if (
      (moodVector.moods.cheerful >= 0.68 || moodVector.moods['feel-good'] >= 0.68) &&
      moodVector.moods.dark <= 0.4
    ) {
      contrastPoles.push('pole:warm-uplifting');
    }
    if (moodVector.moods.thrilling >= 0.68) {
      contrastPoles.push('pole:high-adrenaline');
    }
    if (moodVector.moods.deep >= 0.68 && moodVector.moods.thrilling <= 0.55) {
      contrastPoles.push('pole:reflective-drama');
    }
    if (moodVector.moods['mind-bending'] >= 0.68) {
      contrastPoles.push('pole:labyrinthine-puzzle');
    }

    const baseConf =
      0.25 +
      (metadata.overview ? 0.3 : 0) +
      (metadata.keywords.length > 0 ? 0.25 : 0) +
      (metadata.genreIds.length > 0 ? 0.15 : 0);

    return {
      version: CONTENT_INTELLIGENCE_VERSION,
      concepts,
      keywords: {
        ids: [...kwData.ids].sort((a, b) => a - b),
        displayKeywords: [...kwData.displayKeywords],
      },
      atmosphereClusters,
      crewSummary: {
        directorIds: classified.directors.map((d) => d.id),
        writerIds: classified.writers.map((w) => w.id),
        actorIds: classified.actors.map((a) => a.id),
        collectionId: metadata.collection?.id ?? null,
      },
      contrastPoles,
      confidence: round2(baseConf),
    };
  }

  compareAnalyzed(
    sourceMeta: NormalizedContentMetadata,
    sourceFeatures: ContentFeatureBundle,
    sourceMood: ContentMoodVector,
    sourceSemantic: ContentSemanticProfile,
    targetMeta: NormalizedContentMetadata,
    targetFeatures: ContentFeatureBundle,
    targetMood: ContentMoodVector,
    targetSemantic: ContentSemanticProfile
  ): ContentRelationshipLink {
    const denseSim = cosineSimilarity(
      [...sourceFeatures.denseVector],
      [...targetFeatures.denseVector]
    );

    const srcMoodVec = CANONICAL_MOOD_IDS.map((m) => sourceMood.moods[m]);
    const tgtMoodVec = CANONICAL_MOOD_IDS.map((m) => targetMood.moods[m]);
    const moodSim = cosineSimilarity(srcMoodVec, tgtMoodVec);

    const tokensA = tokenizeText(`${sourceMeta.title} ${sourceMeta.overview}`);
    const tokensB = tokenizeText(`${targetMeta.title} ${targetMeta.overview}`);
    const conceptsA = new Set(sourceSemantic.concepts.map((c) => c.id));
    const conceptsB = new Set(targetSemantic.concepts.map((c) => c.id));

    const coOcc = evaluateAtmosphereCoOccurrence(
      new Set(sourceMeta.genreIds),
      new Set(targetMeta.genreIds),
      tokensA,
      tokensB,
      conceptsA,
      conceptsB
    );

    const sharedConcepts = [...conceptsA].filter((c) => conceptsB.has(c));
    const sharedConceptLabels = sourceSemantic.concepts
      .filter((c) => conceptsB.has(c.id))
      .map((c) => c.label);

    const srcTagSet = new Set(sourceFeatures.toneTags);
    const sharedToneTags = targetFeatures.toneTags.filter((t) => srcTagSet.has(t));

    const unionConceptsCount = new Set([...conceptsA, ...conceptsB]).size;
    const conceptSimilarity =
      unionConceptsCount > 0 ? sharedConcepts.length / unionConceptsCount : 0;

    const toneSim = cosineSimilarity(
      [...sourceFeatures.toneVector],
      [...targetFeatures.toneVector]
    );
    const atmosphereSimilarity = coOcc.hasCoherentAtmosphere
      ? Math.max(toneSim, coOcc.score / 100)
      : sharedToneTags.length > 0
        ? Math.min(1, toneSim * 0.65 + moodSim * 0.25 + Math.min(0.2, sharedToneTags.length * 0.05))
        : toneSim * 0.5 + moodSim * 0.5;

    // Zıtlık sinyalleri (contrast)
    const contrastSignals: string[] = [];
    let contrastScore = 0;

    const darkVsLightA = sourceMood.moods.dark >= 0.65 && targetMood.moods['feel-good'] >= 0.65;
    const darkVsLightB = targetMood.moods.dark >= 0.65 && sourceMood.moods['feel-good'] >= 0.65;
    if (darkVsLightA || darkVsLightB) {
      contrastScore += 0.45;
      contrastSignals.push('Zıt atmosfer: Karanlık/Psikolojik ↔ Rahatlatıcı/Sıcak');
    }

    const darkVsCheerful =
      (sourceMood.moods.dark >= 0.65 && targetMood.moods.cheerful >= 0.65) ||
      (targetMood.moods.dark >= 0.65 && sourceMood.moods.cheerful >= 0.65);
    if (darkVsCheerful) {
      contrastScore += 0.35;
      contrastSignals.push('Zıt ton: Karanlık ↔ Neşeli');
    }

    const thrillVsFeelGood =
      (sourceMood.moods.thrilling >= 0.7 && targetMood.moods['feel-good'] >= 0.7) ||
      (targetMood.moods.thrilling >= 0.7 && sourceMood.moods['feel-good'] >= 0.7);
    if (thrillVsFeelGood) {
      contrastScore += 0.25;
      contrastSignals.push('Zıt tempo: Yüksek gerilim ↔ Huzurlu');
    }

    if (sourceMeta.mediaType !== targetMeta.mediaType) {
      contrastSignals.push(`Farklı format: ${sourceMeta.mediaType} ↔ ${targetMeta.mediaType}`);
    }

    contrastScore = round3(Math.min(1, contrastScore));

    let relationKind: ContentRelationshipLink['relationKind'] = 'mixed';
    if (contrastScore >= 0.45 && denseSim < 0.65) {
      relationKind = 'contrast';
    } else if (sharedConcepts.length > 0 && conceptSimilarity >= 0.25) {
      relationKind = 'conceptual';
    } else if (atmosphereSimilarity >= 0.7 && denseSim < 0.8) {
      relationKind = 'atmospheric';
    } else if (denseSim >= 0.65) {
      relationKind = 'similar';
    }

    const confidence = round2(
      Math.min(
        sourceFeatures.confidence.overallConfidence,
        targetFeatures.confidence.overallConfidence
      ) *
        0.5 +
        (sharedConcepts.length > 0 ? 0.25 : 0) +
        (coOcc.hasCoherentAtmosphere ? 0.2 : 0.1)
    );

    return {
      sourceKey: sourceMeta.mediaKey,
      targetKey: targetMeta.mediaKey,
      cosineSimilarity: round3(denseSim),
      moodSimilarity: round3(moodSim),
      atmosphereSimilarity: round3(atmosphereSimilarity),
      conceptSimilarity: round3(conceptSimilarity),
      contrastScore,
      relationKind,
      sharedConcepts: [...new Set([...sharedConceptLabels, ...sharedToneTags])],
      contrastSignals,
      confidence,
    };
  }
}

export function createContentSemanticAnalyzer(): ContentSemanticAnalyzer {
  return new ContentSemanticAnalyzer();
}
