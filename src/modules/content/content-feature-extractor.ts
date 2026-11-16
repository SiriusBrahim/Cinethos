/**
 * MIA Faz 2 — Content Feature Extractor
 *
 * Normalize edilmiş, görsel ve kullanıcı verilerinden arındırılmış
 * `NormalizedContentMetadata` üzerinden:
 * - 48-boyutlu yoğun öznitelik vektörü (`encodeItemContent`)
 * - Taksonomi sinyalleri (`extractContentTasteItem`)
 * - Alan bazlı anlam katmanları (türler, temalar, atmosfer, anlatı tarzı,
 *   tempo/süre, dönem, mekân/coğrafya, karakter dinamikleri, bilimsel/felsefi
 *   kavramlar, format/yapı)
 * - Eksik alanlarda dürüst güven düşümü (hiçbir eksik boyut sahte veriyle doldurulmaz)
 */

import type { ContentFeatureSignal } from '../../contracts/index.ts';
import {
  ENCODING_LAYOUT_VERSION,
  encodeItemContent,
  type EncodableMediaInput,
} from '../../core/encoding.ts';
import { extractSemanticConcepts, extractKeywordData } from '../../core/relationship-semantics.ts';
import { EXTRACTOR_VERSION } from '../../core/taste/constants.ts';
import { extractContentTasteItem } from '../../core/taste/feature-extractor.ts';
import type { TasteMetadataInput } from '../../core/taste/types.ts';
import type {
  ContentDomainDimensions,
  ContentFeatureBundle,
  ContentPacingKind,
  NormalizedContentMetadata,
} from './types.ts';

function toEncodableInput(metadata: NormalizedContentMetadata): EncodableMediaInput {
  return {
    id: metadata.tmdbId,
    media_type: metadata.mediaType,
    title: metadata.title,
    name: metadata.mediaType === 'tv' ? metadata.title : undefined,
    overview: metadata.overview,
    genre_ids: [...metadata.genreIds],
    release_date: metadata.mediaType === 'movie' ? (metadata.releaseDate ?? undefined) : undefined,
    first_air_date: metadata.mediaType === 'tv' ? (metadata.releaseDate ?? undefined) : undefined,
    vote_average: metadata.externalRating ?? undefined,
    vote_count: metadata.voteCount ?? undefined,
    popularity: metadata.popularity ?? undefined,
    keywords: metadata.keywords.map((k) => ({ id: k.id })),
    cast: metadata.cast.map((c) => ({ id: c.id })),
    crew: metadata.crew.map((c) => ({ id: c.id })),
  };
}

function toTasteMetadataInput(metadata: NormalizedContentMetadata): TasteMetadataInput {
  return {
    contentId: metadata.mediaKey,
    mediaType: metadata.mediaType,
    tmdbId: metadata.tmdbId,
    ...(metadata.genreIds.length > 0 ? { genreIds: [...metadata.genreIds] } : {}),
    ...(metadata.keywords.length > 0
      ? { keywords: metadata.keywords.map((k) => ({ id: k.id, name: k.name })) }
      : {}),
    ...(metadata.originalLanguage ? { originalLanguage: metadata.originalLanguage } : {}),
    ...(metadata.productionCountries.length > 0
      ? { productionCountries: [...metadata.productionCountries] }
      : {}),
    ...(metadata.originCountries.length > 0
      ? { originCountry: [...metadata.originCountries] }
      : {}),
    ...(metadata.runtimeMinutes !== null ? { runtime: metadata.runtimeMinutes } : {}),
    ...(metadata.episodeRunTime.length > 0
      ? { episodeRunTime: [...metadata.episodeRunTime] }
      : {}),
    ...(metadata.numberOfSeasons !== null ? { numberOfSeasons: metadata.numberOfSeasons } : {}),
    ...(metadata.releaseDate
      ? metadata.mediaType === 'tv'
        ? { firstAirDate: metadata.releaseDate }
        : { releaseDate: metadata.releaseDate }
      : {}),
  };
}

function roundConf(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
}

function detectPacing(
  metadata: NormalizedContentMetadata,
  features: Record<string, ContentFeatureSignal>,
  keywordNames: Set<string>,
  overviewLower: string
): { pacing: ContentPacingKind; confidence: number } {
  if (features['narrative.slow_burn'] || keywordNames.has('slow burn') || /\bslow[\s-]burn\b/.test(overviewLower)) {
    return { pacing: 'slow-burn', confidence: 0.85 };
  }
  if (
    metadata.mediaType === 'tv' &&
    metadata.numberOfSeasons !== null &&
    metadata.numberOfSeasons >= 2 &&
    metadata.runtimeMinutes !== null &&
    metadata.runtimeMinutes <= 45
  ) {
    return { pacing: 'episodic', confidence: 0.75 };
  }
  const hasActionThriller = metadata.genreIds.some((id) => id === 28 || id === 53 || id === 10759);
  if (
    hasActionThriller &&
    (keywordNames.has('chase') ||
      keywordNames.has('high octane') ||
      /\b(kovalamaca|adrenalin|chase|race against time)\b/.test(overviewLower) ||
      (metadata.runtimeMinutes !== null && metadata.runtimeMinutes <= 115))
  ) {
    return { pacing: 'fast', confidence: metadata.overview ? 0.78 : 0.6 };
  }
  if (metadata.runtimeMinutes !== null && metadata.runtimeMinutes >= 150 && metadata.genreIds.includes(18)) {
    return { pacing: 'slow-burn', confidence: 0.65 };
  }
  if (metadata.runtimeMinutes !== null && metadata.genreIds.length > 0) {
    return { pacing: 'balanced', confidence: metadata.overview ? 0.65 : 0.45 };
  }
  return { pacing: 'unknown', confidence: 0.15 };
}

function detectEra(metadata: NormalizedContentMetadata): ContentDomainDimensions['era'] {
  if (!metadata.releaseDate) {
    return { year: null, decade: null, bucket: null, confidence: 0 };
  }
  const year = Number(metadata.releaseDate.slice(0, 4));
  if (!Number.isInteger(year) || year < 1880 || year > 2100) {
    return { year: null, decade: null, bucket: null, confidence: 0 };
  }
  const decade = `${Math.floor(year / 10) * 10}s`;
  const bucket = Math.floor(year / 5) * 5;
  return {
    year,
    decade,
    bucket,
    confidence: metadata.releaseDate.length >= 10 ? 1 : 0.8,
  };
}

function detectCharacterDynamics(
  metadata: NormalizedContentMetadata,
  features: Record<string, ContentFeatureSignal>,
  keywordNames: Set<string>,
  overviewLower: string
): { dynamics: string[]; confidence: number } {
  const dynamics = new Set<string>();
  if (features['narrative.character_study'] || keywordNames.has('character study')) {
    dynamics.add('character-study');
  }
  if (metadata.cast.length >= 8 || keywordNames.has('ensemble cast')) {
    dynamics.add('ensemble-cast');
  } else if (metadata.cast.length > 0 && metadata.cast.length <= 4 && metadata.overview) {
    dynamics.add('intimate-small-cast');
  }
  if (/\b(dedektif|detective|ortak|partner|kardeş|sibling|aile|family|rivalry|rekabet)\b/.test(overviewLower)) {
    dynamics.add('interpersonal-conflict-or-bond');
  }
  if (/\b(anti-hero|antihero|anti kahraman|psikopat|protagonist)\b/.test(overviewLower) || keywordNames.has('anti hero')) {
    dynamics.add('complex-protagonist');
  }
  const hasCastOrOverview = metadata.cast.length > 0 || Boolean(metadata.overview);
  const confidence =
    metadata.cast.length > 0 && metadata.overview
      ? dynamics.size > 0
        ? 0.8
        : 0.55
      : hasCastOrOverview
        ? 0.45
        : 0.1;
  return { dynamics: [...dynamics].sort(), confidence: roundConf(confidence) };
}

function detectFormatTag(metadata: NormalizedContentMetadata): string {
  if (metadata.mediaType === 'tv') {
    if (
      metadata.numberOfSeasons === 1 &&
      metadata.runtimeMinutes !== null &&
      metadata.runtimeMinutes > 40
    ) {
      return 'tv-miniseries';
    }
    if (metadata.numberOfSeasons !== null && metadata.numberOfSeasons >= 3) {
      return 'tv-long-running';
    }
    if (metadata.numberOfSeasons !== null) {
      return 'tv-series';
    }
    return 'tv-unclassified';
  }

  if (metadata.runtimeMinutes !== null) {
    if (metadata.runtimeMinutes < 50) return 'movie-short-or-special';
    if (metadata.runtimeMinutes >= 150) return 'movie-epic-feature';
    return 'movie-feature';
  }
  return 'movie-unclassified';
}

export class ContentFeatureExtractor {
  extract(metadata: NormalizedContentMetadata): ContentFeatureBundle {
    const enc = encodeItemContent(toEncodableInput(metadata));
    const tasteExtracted = extractContentTasteItem(toTasteMetadataInput(metadata));

    const signals: Record<string, ContentFeatureSignal> = {};
    for (const [metricId, feat] of Object.entries(tasteExtracted.features)) {
      signals[metricId] = {
        metricId,
        strength: feat.strength,
        confidence: feat.confidence,
        source: feat.source,
        ...(feat.evidence ? { evidence: [...feat.evidence] } : {}),
      };
    }

    const kwData = extractKeywordData({ keywords: metadata.keywords });
    const textCombined = `${metadata.title} ${metadata.overview}`;
    const semanticConcepts = extractSemanticConcepts(textCombined, kwData);
    const overviewLower = textCombined.toLocaleLowerCase('tr-TR');

    const themes = Object.keys(signals)
      .filter((id) => id.startsWith('theme.') || id.startsWith('concept.'))
      .sort();
    const atmosphere = [
      ...new Set([
        ...Object.keys(signals).filter((id) => id.startsWith('mood.')),
        ...enc.tokens.filter((t) =>
          [
            'karanlık',
            'distopya',
            'gizem',
            'psikolojik',
            'gerilim',
            'melankoli',
            'noir',
            'tekinsiz',
            'dark',
            'dystopia',
            'mystery',
            'psychological',
            'noir',
          ].includes(t)
        ),
      ]),
    ].sort();
    const narrativeStyle = Object.keys(signals)
      .filter((id) => id.startsWith('narrative.'))
      .sort();
    const era = detectEra(metadata);
    const pacingRes = detectPacing(metadata, signals, kwData.names, overviewLower);

    const countries = [
      ...new Set([...metadata.originCountries, ...metadata.productionCountries]),
    ].sort();
    const settingScopes = [
      ...Object.keys(signals).filter((id) => id.startsWith('origin.')),
      ...(semanticConcepts.conceptIds.has('concept:space_exploration') ? ['setting:outer-space'] : []),
      ...(semanticConcepts.conceptIds.has('concept:dystopia_totalitarian') ? ['setting:dystopian-society'] : []),
      ...(semanticConcepts.conceptIds.has('concept:post_apocalyptic_survival') ? ['setting:post-apocalyptic'] : []),
    ].sort();

    const charDyn = detectCharacterDynamics(metadata, signals, kwData.names, overviewLower);
    const sciPhilConcepts = [
      ...new Set([
        ...semanticConcepts.conceptIds,
        ...Object.keys(signals).filter((id) => id.startsWith('concept.')),
      ]),
    ].sort();

    const formatTag = detectFormatTag(metadata);

    const missingSignals: string[] = [];
    if (metadata.genreIds.length === 0 && metadata.genres.length === 0) missingSignals.push('genres');
    if (!metadata.overview) missingSignals.push('overview');
    if (metadata.keywords.length === 0) missingSignals.push('keywords');
    if (!metadata.releaseDate) missingSignals.push('releaseDate');
    if (metadata.runtimeMinutes === null) missingSignals.push('runtime');
    if (countries.length === 0 && !metadata.originalLanguage) missingSignals.push('setting');
    if (metadata.cast.length === 0 && metadata.crew.length === 0) missingSignals.push('credits');

    const genresConf = roundConf(
      metadata.genreIds.length > 0
        ? metadata.mediaType === 'tv' && metadata.genreIds.includes(10765) && metadata.genreIds.length === 1
          ? 0.75
          : 0.95
        : metadata.genres.length > 0
          ? 0.8
          : 0.05
    );
    const themesConf = roundConf(
      (metadata.keywords.length > 0 ? 0.55 : 0.15) +
        (metadata.overview ? 0.25 : 0) +
        (themes.length > 0 ? 0.15 : 0)
    );
    const atmosphereConf = roundConf(
      (metadata.genreIds.length > 0 ? 0.35 : 0.05) +
        (metadata.overview ? 0.35 : 0) +
        (metadata.keywords.length > 0 ? 0.25 : 0)
    );
    const narrativeConf = roundConf(
      (metadata.keywords.length > 0 ? 0.5 : 0.1) +
        (metadata.overview ? 0.3 : 0) +
        (narrativeStyle.length > 0 ? 0.15 : 0)
    );
    const settingConf = roundConf(
      (countries.length > 0 ? 0.55 : 0.05) +
        (metadata.originalLanguage ? 0.35 : 0) +
        (settingScopes.length > 0 ? 0.1 : 0)
    );
    const conceptsConf = roundConf(
      (metadata.overview ? 0.45 : 0.05) +
        (metadata.keywords.length > 0 ? 0.4 : 0.05) +
        (sciPhilConcepts.length > 0 ? 0.15 : 0)
    );
    const structureConf = roundConf(
      metadata.mediaType === 'tv'
        ? (metadata.numberOfSeasons !== null ? 0.5 : 0.1) +
            (metadata.episodeRunTime.length > 0 || metadata.runtimeMinutes !== null ? 0.45 : 0.05)
        : metadata.runtimeMinutes !== null
          ? 0.95
          : 0.2
    );

    const confValues = [
      genresConf,
      themesConf,
      atmosphereConf,
      narrativeConf,
      roundConf(pacingRes.confidence),
      roundConf(era.confidence),
      settingConf,
      charDyn.confidence,
      conceptsConf,
      structureConf,
    ];
    const overallConfidence = roundConf(
      confValues.reduce((acc, v) => acc + v, 0) / confValues.length
    );

    return {
      mediaKey: metadata.mediaKey,
      mediaType: metadata.mediaType,
      layoutVersion: ENCODING_LAYOUT_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      signature: enc.signature,
      denseVector: [...enc.denseVector],
      toneVector: [...enc.toneVector],
      completeness: tasteExtracted.completeness,
      toneTags: [...enc.tokens],
      features: signals,
      dimensions: {
        genres: [...metadata.genres],
        genreIds: [...metadata.genreIds],
        themes,
        atmosphere,
        narrativeStyle,
        pacing: pacingRes.pacing,
        era,
        setting: {
          countries,
          language: metadata.originalLanguage,
          scopes: settingScopes,
        },
        characterDynamics: charDyn.dynamics,
        scientificPhilosophicalConcepts: sciPhilConcepts,
        structureFormat: {
          mediaType: metadata.mediaType,
          formatTag,
          runtimeMinutes: metadata.runtimeMinutes,
          numberOfSeasons: metadata.numberOfSeasons,
          episodeRunTime: [...metadata.episodeRunTime],
        },
      },
      confidence: {
        genres: genresConf,
        themes: themesConf,
        atmosphere: atmosphereConf,
        narrativeStyle: narrativeConf,
        pacing: roundConf(pacingRes.confidence),
        era: roundConf(era.confidence),
        setting: settingConf,
        characterDynamics: charDyn.confidence,
        concepts: conceptsConf,
        structure: structureConf,
        overallConfidence,
        missingSignals,
      },
    };
  }
}

export function createContentFeatureExtractor(): ContentFeatureExtractor {
  return new ContentFeatureExtractor();
}
