// ===========================================================================
// Cinethos Taste Engine — Server Rebuild Coordinator (v1.6)
// Olay güdümlü (event-driven) arka plan profil yeniden hesaplama koordinatörü.
//
// SINIR KURALI (TasteRebuildCoordinator ↔ TasteEventProjector):
// - TasteRebuildCoordinator: sunucu tarafı G/Ç ve yaşam döngüsü koordinatörüdür
//   (depo okuma/yazma, bootstrap, arka plan TMDB hidrasyonu, worker dispatch).
// - Saf olay→durum indirgeme ve kanıt matematiği YALNIZCA `core/taste/`
//   içindeki `TasteEventProjector` ve `profile-aggregator` tarafından yapılır.
//
// MUTLAK KURALLAR:
// - data/cinetrack-data.json ASLA değiştirilmez (yalnızca ilk soğuk başlatmada okunur)
// - Ağır profil hesaplaması worker_threads (taste-profile-worker.ts) üzerinde çalışır
// - Tüm data/taste/ yazımları atomik ve kilitlidir (taste-store üzerinden)
// ===========================================================================

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { CorruptJsonFileError, readJsonFileWithRecoveryAsync } from "./atomic-json.ts";
import {
  readTasteEventsForProfile,
  writeTasteEventsForProfile,
  readTasteIndexForProfile,
  writeTasteIndexForProfile,
  readTasteProfileForProfile,
  writeTasteProfileForProfile,
  readTasteManifestForProfile,
  readTasteObjectionsForProfile,
  ensureTasteProfileIdMapEntry,
} from "./taste-store.ts";
import {
  resolveTastePathsForProfile,
  validateCanonicalProfileId,
} from "./taste-profile-scope.ts";
import {
  buildTasteIndex,
  createEmptyTasteIndex,
} from "../core/taste/taste-index-builder.ts";
import { migrateExistingData } from "../core/taste/migration.ts";
import {
  aggregateProfiles,
  type AggregatedProfiles,
} from "../core/taste/profile-aggregator.ts";
import { projectLearningSnapshot } from "../core/taste/taste-event-projector.ts";
import {
  EXTRACTOR_VERSION,
  CONFIG_VERSION,
  TAXONOMY_VERSION,
  TMDB_MAPPING_VERSION,
} from "../core/taste/constants.ts";
import {
  hydrateTasteMetadataBatch,
  readTasteMetadataCache,
  type CachedTasteMetadata,
  type HydrationBatchResult,
} from "./taste-metadata-hydrator.ts";
import type {
  ContentTasteItem,
  TasteEvent,
  TasteMetadataInput,
  TasteMetric,
  TasteProfile,
} from "../core/taste/types.ts";
import type { DataDocument } from "../core/cinetrack-core.ts";

export interface RebuildCoordinatorResult {
  generationId: string;
  profile: TasteProfile;
  eventsCount: number;
  indexedItemsCount: number;
}

const activeRebuildChains = new Map<string, Promise<RebuildCoordinatorResult>>();
const bootstrapPromises = new Map<string, Promise<void>>();
const bootstrapSignatures = new Map<string, string>();
/** TMDB API anahtarı profil-agnostik bir süreç kimlik bilgisidir: anahtar `dataDir`'dir. */
const hydrationApiKeys = new Map<string, string>();
const activeHydrations = new Map<string, Promise<void>>();

/**
 * Profil kapsamlı süreç içi Map anahtarı (R2-A3).
 * `hydrationApiKeys` bilinçli olarak bu anahtarı KULLANMAZ (profil-agnostik kimlik bilgisi).
 */
function scopedTasteKey(dataDir: string, profileId: string): string {
  return `${dataDir}:${profileId}`;
}

/** Taste indeksine daha zengin alanları tercih ederek iki metadata kaydını birleştirir. */
function mergeTasteMetadata(
  base: TasteMetadataInput | undefined,
  incoming: TasteMetadataInput
): TasteMetadataInput {
  if (!base) return incoming;
  return {
    ...base,
    ...incoming,
    genreIds: incoming.genreIds?.length ? incoming.genreIds : base.genreIds,
    keywords: incoming.keywords?.length ? incoming.keywords : base.keywords,
    originCountry: incoming.originCountry?.length ? incoming.originCountry : base.originCountry,
    productionCountries: incoming.productionCountries?.length
      ? incoming.productionCountries
      : base.productionCountries,
    originalLanguage: incoming.originalLanguage || base.originalLanguage,
    runtime: incoming.runtime ?? base.runtime,
    episodeRunTime: incoming.episodeRunTime?.length
      ? incoming.episodeRunTime
      : base.episodeRunTime,
    numberOfSeasons: incoming.numberOfSeasons ?? base.numberOfSeasons,
    releaseDate: incoming.releaseDate || base.releaseDate,
    firstAirDate: incoming.firstAirDate || base.firstAirDate,
  };
}

/** Aynı içerik+durum için migration olayının ikinci kez yazılmasını engeller. */
function migratedEventKey(event: TasteEvent): string {
  const status =
    event.eventType === "status_changed" ? String(event.payload?.newValue ?? "") : "";
  return `${event.eventType}::${event.contentId}::${status}`;
}

function collectNewEvents(existing: TasteEvent[], migrated: TasteEvent[]): TasteEvent[] {
  const seen = new Set(existing.map(migratedEventKey));
  const additions: TasteEvent[] = [];
  for (const event of migrated) {
    const key = migratedEventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(event);
  }
  return additions;
}

/** Profil hesaplamasına kanıt sağlayan içerik kimlikleri (hidrasyon kapsamı). */
function collectEvidenceContentIds(events: TasteEvent[]): string[] {
  const ids = new Set<string>();
  for (const event of events) {
    if (!event?.contentId) continue;
    if (
      event.eventType === "rating_changed" ||
      event.eventType === "content_disliked" ||
      (event.eventType === "status_changed" && event.payload?.newValue === "completed")
    ) {
      ids.add(event.contentId);
    }
  }
  return Array.from(ids);
}

function tasteMetadataCacheToInput(
  cached: CachedTasteMetadata
): TasteMetadataInput | null {
  const { fetchedAt: _fetchedAt, source: _source, ...meta } = cached;
  return coerceItemToTasteMetadata(meta as unknown as Record<string, unknown>);
}

/** TMDB anahtarını bu veri dizini için kaydeder (anahtar yoksa hidrasyon çalışmaz). */
export function configureTasteHydration(
  dataDir: string = "data",
  tmdbApiKey?: string
): void {
  const key = (tmdbApiKey || "").trim();
  if (key) {
    hydrationApiKeys.set(dataDir, key);
  }
}

export type HydrationStopReason =
  | "no-content"
  | "no-api-key"
  | "cache-only"
  | "fetch-failed"
  | "completed"
  | "max-rounds";

export interface HydrationOutcome {
  seededFromCache: number;
  fetched: number;
  failed: number;
  stopReason: HydrationStopReason;
}

export type HydrationRoundClassification = "progress" | "fetch-failed" | "cache-only";

/**
 * Bir hidrasyon turunun sonucunu sınıflandırır.
 * `fetched === 0` tek başına "cache hit" DEĞİLDİR: ağ hatası ve tamamlanmış
 * cache birbirinden ayrılır (R2-A3 S6).
 */
export function classifyHydrationRound(
  result: Pick<HydrationBatchResult, "fetched" | "failed" | "remaining">
): HydrationRoundClassification {
  if (result.fetched > 0) return "progress";
  if (result.failed > 0) return "fetch-failed";
  return "cache-only";
}

/**
 * Ortak (shared) TMDB metadata cache'inden profil indeksine girdi besler.
 * Cache tüm profillerle paylaşılır; yazılan index ve manifest profil kapsamlıdır.
 */
export async function seedProfileIndexFromCache(
  profileId: string,
  dataDir: string = "data",
  contentIds: string[] = []
): Promise<number> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  if (contentIds.length === 0) return 0;
  const cache = await readTasteMetadataCache(dataDir);
  const inputs: TasteMetadataInput[] = [];
  for (const contentId of contentIds) {
    const cached = cache.items[contentId];
    if (!cached) continue;
    const meta = tasteMetadataCacheToInput(cached);
    if (meta) inputs.push(meta);
  }
  if (inputs.length === 0) return 0;
  const stats = await upsertTasteMetadataInputs(canonicalProfileId, inputs, dataDir);
  return stats.created + stats.updated;
}

/**
 * Bir profilin index'ini ortak cache'ten tohumlar ve (anahtar varsa) TMDB'den
 * eksik metadata'yı tamamlar. Tüm yazımlar profil kapsamlıdır.
 */
export async function hydrateProfileTasteIndex(
  profileId: string,
  dataDir: string = "data",
  contentIds: string[] = []
): Promise<HydrationOutcome> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  const seededFromCache = await seedProfileIndexFromCache(canonicalProfileId, dataDir, contentIds);
  if (contentIds.length === 0) {
    return { seededFromCache, fetched: 0, failed: 0, stopReason: "no-content" };
  }

  const apiKey = hydrationApiKeys.get(dataDir);
  if (!apiKey) {
    return { seededFromCache, fetched: 0, failed: 0, stopReason: "no-api-key" };
  }

  let fetched = 0;
  let failed = 0;
  // Her turda bir parti çekip indeksi büyütür; içerik bitene kadar devam eder.
  for (let round = 0; round < 24; round += 1) {
    const result = await hydrateTasteMetadataBatch({
      dataDir,
      apiKey,
      contentIds,
    });
    fetched += result.fetched;
    failed += result.failed;
    if (result.inputs.length > 0) {
      await upsertTasteMetadataInputs(canonicalProfileId, result.inputs, dataDir);
      await triggerTasteProfileRebuild(canonicalProfileId, dataDir);
    }
    if (result.fetched === 0) {
      const classification = classifyHydrationRound(result);
      return {
        seededFromCache,
        fetched,
        failed,
        stopReason: classification === "fetch-failed" ? "fetch-failed" : "cache-only",
      };
    }
    if (result.remaining <= 0) {
      return { seededFromCache, fetched, failed, stopReason: "completed" };
    }
  }
  return { seededFromCache, fetched, failed, stopReason: "max-rounds" };
}

/** Arka planda (istekleri bloklamadan) eksik TMDB metadata'sını toplar. */
export function scheduleTasteMetadataHydration(
  profileId: string,
  dataDir: string = "data",
  contentIds: string[] = []
): void {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  if (contentIds.length === 0) return;
  const chainKey = scopedTasteKey(dataDir, canonicalProfileId);
  if (activeHydrations.has(chainKey)) return;

  const run = hydrateProfileTasteIndex(canonicalProfileId, dataDir, contentIds)
    .then(() => undefined)
    .catch(() => {
      // Hidrasyon hatası profil akışını bloklamaz
    })
    .finally(() => {
      if (activeHydrations.get(chainKey) === run) {
        activeHydrations.delete(chainKey);
      }
    });
  activeHydrations.set(chainKey, run);
}

async function fileSignature(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
  } catch {
    return "0";
  }
}

/**
 * Bootstrap imzası: global kaynaklar (kullanıcı belgesi, katalog, stok, ortak
 * metadata cache) + çağrılan PROFİLİN kendi event/index/profile dosyaları.
 * Böylece bir profildeki değişiklik diğer profilin bootstrap'ini tetiklemez,
 * ama kendi profilindeki değişiklik algılanır (R2-A3 S3).
 */
async function computeBootstrapSignature(
  profileId: string,
  dataDir: string
): Promise<string> {
  const globalFiles =
    dataDir === "data"
      ? [
          "data/cinetrack-data.json",
          "data/catalog/movies.json",
          "data/catalog/tv.json",
          "data/stock.json",
          "data/taste/cinetrack-taste-metadata-cache.json",
        ]
      : [
          path.join(dataDir, "cinetrack-data.json"),
          path.join(dataDir, "catalog", "movies.json"),
          path.join(dataDir, "catalog", "tv.json"),
          path.join(dataDir, "stock.json"),
          path.join(dataDir, "taste", "cinetrack-taste-metadata-cache.json"),
        ];
  await ensureTasteProfileIdMapEntry(profileId, dataDir);
  const profilePaths = resolveTastePathsForProfile(profileId, dataDir).paths;
  const files = [
    ...globalFiles,
    profilePaths.events,
    profilePaths.index,
    profilePaths.profile,
  ];
  const parts = await Promise.all(files.map(fileSignature));
  return [CONFIG_VERSION, EXTRACTOR_VERSION, profileId, ...parts].join("|");
}

/**
 * Herhangi bir SavedItem / TMDB kaydını güvenli şekilde TasteMetadataInput'a dönüştürür.
 */
export function coerceItemToTasteMetadata(raw: Record<string, unknown> | null | undefined): TasteMetadataInput | null {
  if (!raw || typeof raw !== "object") return null;

  const rawId = raw.tmdbId ?? raw.id;
  const numericId = Number(rawId);
  if (!Number.isFinite(numericId) || numericId <= 0) return null;

  const mediaType: "movie" | "tv" =
    raw.mediaType === "tv" ||
    raw.media_type === "tv" ||
    (!raw.mediaType && !raw.media_type && Boolean(raw.name) && !raw.title)
      ? "tv"
      : "movie";

  const contentId =
    typeof raw.contentId === "string" && /^(movie|tv):[A-Za-z0-9_-]+$/.test(raw.contentId)
      ? raw.contentId
      : `${mediaType}:${Math.trunc(numericId)}`;

  const genreIds = Array.isArray(raw.genreIds)
    ? raw.genreIds.map(Number).filter(Number.isFinite)
    : Array.isArray(raw.genre_ids)
      ? raw.genre_ids.map(Number).filter(Number.isFinite)
      : Array.isArray(raw.genres)
        ? (raw.genres as Array<{ id?: unknown }>)
            .map((g) => Number(g?.id))
            .filter(Number.isFinite)
        : undefined;

  const rawKeywords = Array.isArray(raw.keywords)
    ? raw.keywords
    : raw.keywords && typeof raw.keywords === "object"
      ? ((raw.keywords as { keywords?: unknown[]; results?: unknown[] }).keywords ??
         (raw.keywords as { keywords?: unknown[]; results?: unknown[] }).results)
      : undefined;

  const keywords = Array.isArray(rawKeywords)
    ? rawKeywords
        .map((kw) => {
          if (!kw || typeof kw !== "object") return null;
          const id = Number((kw as { id?: unknown }).id);
          if (!Number.isFinite(id) || id <= 0) return null;
          const name = typeof (kw as { name?: unknown }).name === "string"
            ? (kw as { name: string }).name
            : undefined;
          return name ? { id, name } : { id };
        })
        .filter((kw): kw is { id: number; name?: string } => kw !== null)
    : undefined;

  const originCountry = Array.isArray(raw.originCountry)
    ? raw.originCountry.filter((c): c is string => typeof c === "string")
    : Array.isArray(raw.origin_country)
      ? raw.origin_country.filter((c): c is string => typeof c === "string")
      : undefined;

  const productionCountries = Array.isArray(raw.productionCountries)
    ? raw.productionCountries.filter((c): c is string => typeof c === "string")
    : Array.isArray(raw.production_countries)
      ? raw.production_countries
          .map((c) =>
            typeof c === "string"
              ? c
              : c && typeof c === "object" && typeof (c as { iso_3166_1?: unknown }).iso_3166_1 === "string"
                ? (c as { iso_3166_1: string }).iso_3166_1
                : ""
          )
          .filter(Boolean)
      : undefined;

  const episodeRunTime = Array.isArray(raw.episodeRunTime)
    ? raw.episodeRunTime.map(Number).filter(Number.isFinite)
    : Array.isArray(raw.episode_run_time)
      ? raw.episode_run_time.map(Number).filter(Number.isFinite)
      : undefined;

  const runtimeVal = Number(raw.runtime);
  const seasonsVal = Number(raw.numberOfSeasons ?? raw.number_of_seasons);

  return {
    contentId,
    mediaType,
    tmdbId: Math.trunc(numericId),
    ...(genreIds && genreIds.length > 0 ? { genreIds } : {}),
    ...(keywords && keywords.length > 0 ? { keywords } : {}),
    ...(typeof (raw.originalLanguage ?? raw.original_language) === "string"
      ? { originalLanguage: String(raw.originalLanguage ?? raw.original_language) }
      : {}),
    ...(productionCountries && productionCountries.length > 0 ? { productionCountries } : {}),
    ...(originCountry && originCountry.length > 0 ? { originCountry } : {}),
    ...(Number.isFinite(runtimeVal) && runtimeVal > 0 ? { runtime: runtimeVal } : {}),
    ...(episodeRunTime && episodeRunTime.length > 0 ? { episodeRunTime } : {}),
    ...(Number.isFinite(seasonsVal) && seasonsVal > 0 ? { numberOfSeasons: seasonsVal } : {}),
    ...(typeof (raw.releaseDate ?? raw.release_date) === "string"
      ? { releaseDate: String(raw.releaseDate ?? raw.release_date) }
      : {}),
    ...(typeof (raw.firstAirDate ?? raw.first_air_date) === "string"
      ? { firstAirDate: String(raw.firstAirDate ?? raw.first_air_date) }
      : {}),
  };
}

/**
 * İçerik metadata girdilerini cinetrack-taste-index.json deposuna ekler/günceller.
 */
export async function upsertTasteMetadataInputs(
  profileId: string,
  inputs: TasteMetadataInput[],
  dataDir: string = "data"
): Promise<{ created: number; updated: number }> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  if (!inputs.length) return { created: 0, updated: 0 };
  const [existingIndexRaw, objections] = await Promise.all([
    readTasteIndexForProfile(canonicalProfileId, dataDir),
    readTasteObjectionsForProfile(canonicalProfileId, dataDir),
  ]);
  const existingIndex = existingIndexRaw ?? createEmptyTasteIndex();
  const asOf = new Date().toISOString();
  const { index, stats } = buildTasteIndex(inputs, existingIndex, {
    asOf,
    extractorVersion: EXTRACTOR_VERSION,
    taxonomyVersion: TAXONOMY_VERSION,
    mappingVersion: TMDB_MAPPING_VERSION,
  });

  let prunedObjections = false;
  for (const obj of objections) {
    const item = index.items[obj.contentId];
    if (item?.features && obj.metricId in item.features) {
      delete item.features[obj.metricId];
      prunedObjections = true;
    }
  }

  if (stats.created > 0 || stats.updated > 0 || prunedObjections) {
    await writeTasteIndexForProfile(canonicalProfileId, index, dataDir);
  }

  return { created: stats.created, updated: stats.updated };
}

/**
 * Worker thread üzerinde profil hesaplamasını çalıştırır; worker başlatılamazsa
 * kesintisiz fallback ile aynı deterministik hesabı tamamlar.
 */
async function executeAggregationOffMainThread(
  generationId: string,
  events: TasteEvent[],
  asOf: string,
  contentIndex: Record<string, ContentTasteItem>,
  existingOverrides: Record<string, NonNullable<TasteMetric["manualOverride"]>>
): Promise<AggregatedProfiles> {
  try {
    return await new Promise<AggregatedProfiles>((resolve, reject) => {
      const workerUrl = new URL("../workers/taste-profile-worker.ts", import.meta.url);
      const worker = new Worker(workerUrl, {
        execArgv: ["--import", "tsx"],
      });

      const timer = setTimeout(() => {
        void worker.terminate();
        reject(new Error("Taste worker rebuild zaman aşımı"));
      }, 6000);

      worker.on("message", (msg: { type?: string; payload?: { profiles?: AggregatedProfiles }; error?: string }) => {
        if (msg?.type === "done" && msg.payload?.profiles) {
          clearTimeout(timer);
          void worker.terminate();
          resolve(msg.payload.profiles);
        } else if (msg?.type === "error") {
          clearTimeout(timer);
          void worker.terminate();
          reject(new Error(msg.error || "Worker hatası"));
        }
      });

      worker.on("error", (err) => {
        clearTimeout(timer);
        void worker.terminate();
        reject(err);
      });

      worker.postMessage({
        type: "rebuild",
        generationId,
        payload: {
          events,
          asOf,
          contentIndex,
          existingOverrides,
        },
      });
    });
  } catch {
    // Fallback: tsx yükleyici olmadan çalışan test ortamları için deterministik aynı hesap
    const profiles = aggregateProfiles(events, asOf, contentIndex);
    for (const [metricId, override] of Object.entries(existingOverrides)) {
      if (override && profiles.unified.metrics[metricId]) {
        profiles.unified.metrics[metricId].manualOverride = override;
      }
    }
    return profiles;
  }
}

async function performRebuildOnce(
  profileId: string,
  dataDir: string = "data"
): Promise<RebuildCoordinatorResult> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  const [events, index, existingProfile, objections] = await Promise.all([
    readTasteEventsForProfile(canonicalProfileId, dataDir),
    readTasteIndexForProfile(canonicalProfileId, dataDir),
    readTasteProfileForProfile(canonicalProfileId, dataDir),
    readTasteObjectionsForProfile(canonicalProfileId, dataDir),
  ]);

  const existingOverrides: Record<string, NonNullable<TasteMetric["manualOverride"]>> = {};
  if (existingProfile?.metrics) {
    for (const [metricId, metric] of Object.entries(existingProfile.metrics)) {
      if (metric?.manualOverride) {
        existingOverrides[metricId] = metric.manualOverride;
      }
    }
  }

  const generationId = randomUUID();
  const asOf = new Date().toISOString();
  const rawItems = index?.items ?? {};
  const contentItems: Record<string, ContentTasteItem> = {};
  const objectionSet = new Set(objections.map((o) => `${o.contentId}::${o.metricId}`));

  for (const [contentId, item] of Object.entries(rawItems)) {
    if (!item?.features || objectionSet.size === 0) {
      contentItems[contentId] = item;
      continue;
    }
    const filteredFeatures: ContentTasteItem["features"] = {};
    for (const [mId, feat] of Object.entries(item.features)) {
      if (!objectionSet.has(`${contentId}::${mId}`)) {
        filteredFeatures[mId] = feat;
      }
    }
    contentItems[contentId] = {
      ...item,
      features: filteredFeatures,
    };
  }

  const projection = projectLearningSnapshot(events);
  const profiles = await executeAggregationOffMainThread(
    generationId,
    events,
    asOf,
    contentItems,
    existingOverrides
  );

  await writeTasteProfileForProfile(
    canonicalProfileId,
    profiles.unified,
    dataDir,
    projection.eventWatermark
  );
  const manifest = await readTasteManifestForProfile(canonicalProfileId, dataDir);

  return {
    generationId: manifest?.generationId ?? generationId,
    profile: profiles.unified,
    eventsCount: events.length,
    indexedItemsCount: Object.keys(contentItems).length,
  };
}

/**
 * Kuyruklanmış arka plan profil yeniden hesaplamasını tetikler.
 */
export function triggerTasteProfileRebuild(
  profileId: string,
  dataDir: string = "data"
): Promise<RebuildCoordinatorResult> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  const chainKey = scopedTasteKey(dataDir, canonicalProfileId);
  const prevChain = activeRebuildChains.get(chainKey) ?? Promise.resolve(null);
  const nextRun = prevChain.then(
    () => performRebuildOnce(canonicalProfileId, dataDir),
    () => performRebuildOnce(canonicalProfileId, dataDir)
  );
  activeRebuildChains.set(chainKey, nextRun);
  void nextRun.finally(() => {
    if (activeRebuildChains.get(chainKey) === nextRun) {
      activeRebuildChains.delete(chainKey);
    }
  });
  return nextRun;
}

/**
 * Taste indeksini ve olaylarını güncel veriden artımlı olarak senkronize eder.
 *
 * - cinetrack-data.json yalnızca OKUNUR (ASLA yazılmaz — Mutlak Kural)
 * - Katalog, stok ve TMDB metadata önbelleği indeks girdilerine katılır
 * - Yeni tamamlanmış/puanlanmış kayıtlar olay olarak eklenir (idempotent)
 * - Değişiklik varsa profil yeniden hesaplanır; yoksa ağır iş atlanır
 */
export async function ensureInitialTasteBootstrap(
  profileId: string,
  dataDir: string = "data"
): Promise<void> {
  const canonicalProfileId = validateCanonicalProfileId(profileId);
  const chainKey = scopedTasteKey(dataDir, canonicalProfileId);
  const running = bootstrapPromises.get(chainKey);
  if (running) {
    return running;
  }

  const task = (async () => {
    try {
      const signature = await computeBootstrapSignature(canonicalProfileId, dataDir);
      if (bootstrapSignatures.get(chainKey) === signature) {
        return;
      }

      const [existingEvents, existingProfile, manifest, metadataCache] = await Promise.all([
        readTasteEventsForProfile(canonicalProfileId, dataDir),
        readTasteProfileForProfile(canonicalProfileId, dataDir),
        readTasteManifestForProfile(canonicalProfileId, dataDir),
        readTasteMetadataCache(dataDir),
      ]);

      // cinetrack-data.json SADECE OKUNUR (ASLA yazılmaz — Mutlak Kural)
      const userDataPath =
        dataDir === "data" ? "data/cinetrack-data.json" : path.join(dataDir, "cinetrack-data.json");
      const dataDocRes = await readJsonFileWithRecoveryAsync<DataDocument>(userDataPath);
      if (dataDocRes.status !== "ok" && dataDocRes.status !== "recovered") {
        return;
      }
      const doc = dataDocRes.data;
      if (!doc || !Array.isArray(doc.profiles)) {
        return;
      }

      // R2-A3 S2: bootstrap hedefi belgenin aktif profiliyle birebir eşleşmek zorundadır.
      // `profiles[0]` sessiz fallback'i YOKTUR; uyuşmazlıkta hiçbir şey yazılmaz.
      if (doc.activeProfileId !== canonicalProfileId) {
        console.warn(
          `[taste-bootstrap] Hedef profil belgenin aktif profiliyle eşleşmiyor (hedef: ${canonicalProfileId}, belge: ${String(doc.activeProfileId)}); bootstrap atlandı.`
        );
        return;
      }
      const activeProfile = doc.profiles.find(
        (p) => p && p.id === canonicalProfileId
      );
      if (!activeProfile) {
        return;
      }

      const metadataMap = new Map<string, TasteMetadataInput>();

      // 1) Yerel katalog dosyaları (salt-okunur)
      const moviesCatPath =
        dataDir === "data" ? "data/catalog/movies.json" : path.join(dataDir, "catalog", "movies.json");
      const tvCatPath =
        dataDir === "data" ? "data/catalog/tv.json" : path.join(dataDir, "catalog", "tv.json");
      const [moviesCatalog, tvCatalog] = await Promise.all([
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(moviesCatPath),
        readJsonFileWithRecoveryAsync<Record<string, Record<string, unknown>>>(tvCatPath),
      ]);
      const rawCatalogByKey = new Map<string, Record<string, unknown>>();
      for (const catalogRes of [moviesCatalog, tvCatalog]) {
        if ((catalogRes.status === "ok" || catalogRes.status === "recovered") && catalogRes.data) {
          for (const [k, entry] of Object.entries(catalogRes.data)) {
            if (entry && typeof entry === "object") {
              rawCatalogByKey.set(k, entry);
              const meta = coerceItemToTasteMetadata(entry);
              if (meta) {
                metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
              }
            }
          }
        }
      }

      // 2) Stok dosyasındaki dil/ülke/tür alanları (salt-okunur)
      const stockPath =
        dataDir === "data" ? "data/stock.json" : path.join(dataDir, "stock.json");
      const stockRes = await readJsonFileWithRecoveryAsync<{
        movies?: Array<Record<string, unknown>>;
        tv?: Array<Record<string, unknown>>;
      }>(stockPath);
      if ((stockRes.status === "ok" || stockRes.status === "recovered") && stockRes.data) {
        for (const entry of [...(stockRes.data.movies || []), ...(stockRes.data.tv || [])]) {
          const meta = coerceItemToTasteMetadata(entry);
          if (meta) {
            metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
          }
        }
      }

      // 3) Kullanıcının kayıtlı öğeleri (katalogla birleşik)
      for (const item of activeProfile.items || []) {
        const rawItem = item as unknown as Record<string, unknown>;
        const prelim = coerceItemToTasteMetadata(rawItem);
        if (!prelim) continue;
        const catEntry = rawCatalogByKey.get(prelim.contentId);
        const mergedRaw = catEntry ? { ...catEntry, ...rawItem } : rawItem;
        const mergedMeta = coerceItemToTasteMetadata(mergedRaw);
        if (mergedMeta) {
          metadataMap.set(
            mergedMeta.contentId,
            mergeTasteMetadata(metadataMap.get(mergedMeta.contentId), mergedMeta)
          );
        }
      }

      // 4) TMDB hidrasyon önbelleği (en zengin alanlar; en son uygulanır)
      for (const cached of Object.values(metadataCache.items)) {
        const meta = tasteMetadataCacheToInput(cached);
        if (meta) {
          metadataMap.set(meta.contentId, mergeTasteMetadata(metadataMap.get(meta.contentId), meta));
        }
      }

      const indexStats =
        metadataMap.size > 0
          ? await upsertTasteMetadataInputs(
              canonicalProfileId,
              Array.from(metadataMap.values()),
              dataDir
            )
          : { created: 0, updated: 0 };

      // Yeni olayları mevcutlarla birleştir (idempotent)
      const asOf = new Date().toISOString();
      const migrated = migrateExistingData({ dataDocument: doc, asOf });
      const additions = collectNewEvents(existingEvents, migrated.events);
      let allEvents = existingEvents;
      if (additions.length > 0) {
        allEvents = [...existingEvents, ...additions];
        await writeTasteEventsForProfile(canonicalProfileId, allEvents, dataDir);
      }

      const versionChanged =
        !manifest || manifest.configVersion !== CONFIG_VERSION;
      const needsRebuild =
        indexStats.created + indexStats.updated > 0 ||
        additions.length > 0 ||
        !existingProfile ||
        versionChanged;

      if (needsRebuild) {
        await triggerTasteProfileRebuild(canonicalProfileId, dataDir);
      }

      // Eksik keyword/dil/ülke alanlarını arka planda tamamla
      scheduleTasteMetadataHydration(
        canonicalProfileId,
        dataDir,
        collectEvidenceContentIds(allEvents)
      );

      bootstrapSignatures.set(
        chainKey,
        await computeBootstrapSignature(canonicalProfileId, dataDir)
      );
    } catch (err) {
      if (err instanceof CorruptJsonFileError) {
        throw err;
      }
      // Soğuk başlatma hatası ana uygulamayı bloklamaz
    } finally {
      bootstrapPromises.delete(chainKey);
    }
  })();

  bootstrapPromises.set(chainKey, task);
  return task;
}
