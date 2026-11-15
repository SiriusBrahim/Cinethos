// ===========================================================================
// Cinethos Taste Engine — Taste API (v1.0)
// İstemci tarafı API çağrıları — /api/taste/* uç noktaları
// ===========================================================================

import type {
  ManualOverrideMode,
  TasteProfile,
  TasteManifest,
  TasteEvent,
  TasteMetadataInput,
} from "../core/taste/types.ts";
import type { MetricExplanation } from "../core/taste/profile-explainer.ts";
import { ApiError, apiFetch, readApiErrorMessage } from "./api-client.ts";

const BASE = "/api/taste";
const TASTE_CHANNEL_NAME = "cinetrack-taste-profile-sync";

export interface TasteProfileUpdateSignal {
  generationId?: string;
  reason?: string;
  updatedAt: string;
}

const localUpdateListeners = new Set<(signal: TasteProfileUpdateSignal) => void>();
let broadcastChannelInstance: BroadcastChannel | null = null;

function getTasteBroadcastChannel(): BroadcastChannel | null {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return null;
  }
  if (!broadcastChannelInstance) {
    try {
      broadcastChannelInstance = new BroadcastChannel(TASTE_CHANNEL_NAME);
      (broadcastChannelInstance as unknown as { unref?: () => void }).unref?.();
      broadcastChannelInstance.onmessage = (ev: MessageEvent<TasteProfileUpdateSignal>) => {
        if (ev?.data) {
          for (const listener of localUpdateListeners) {
            try {
              listener(ev.data);
            } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
          }
        }
      };
    } catch {
      broadcastChannelInstance = null;
    }
  }
  return broadcastChannelInstance;
}

/**
 * Arka planda profil yeniden hesaplandığında veya manuel override değiştiğinde
 * açık olan tüm useTasteProfile kancalarını bilgilendirir.
 */
export function notifyTasteProfileUpdated(
  partial: { generationId?: string; reason?: string } = {}
): void {
  const signal: TasteProfileUpdateSignal = {
    generationId: partial.generationId,
    reason: partial.reason,
    updatedAt: new Date().toISOString(),
  };

  for (const listener of localUpdateListeners) {
    try {
      listener(signal);
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  }

  const channel = getTasteBroadcastChannel();
  if (channel) {
    try {
      channel.postMessage(signal);
    } catch { /* opsiyonel adım: hata ana akışı etkilemez */ }
  }
}

/**
 * Canlı profil güncelleme sinyallerini dinler (Sorun 2 — Adım 3).
 */
export function subscribeTasteProfileUpdated(
  listener: (signal: TasteProfileUpdateSignal) => void
): () => void {
  getTasteBroadcastChannel();
  localUpdateListeners.add(listener);
  return () => {
    localUpdateListeners.delete(listener);
  };
}

/**
 * İstemcideki SavedItem / TmdbItem nesnesinden TasteMetadataInput çıkarır.
 */
export function extractTasteMetadataFromItem(
  raw: Record<string, unknown> | null | undefined
): TasteMetadataInput | undefined {
  if (!raw || typeof raw !== "object" || raw.id == null) return undefined;
  const tmdbId = Number(raw.id);
  if (!Number.isFinite(tmdbId) || tmdbId <= 0) return undefined;

  const mediaType: "movie" | "tv" =
    raw.media_type === "tv" ||
    (!raw.media_type && Boolean(raw.name) && !raw.title)
      ? "tv"
      : "movie";

  const genreIds = Array.isArray(raw.genre_ids)
    ? raw.genre_ids.map(Number).filter(Number.isFinite)
    : Array.isArray(raw.genres)
      ? (raw.genres as Array<{ id?: unknown }>).map((g) => Number(g?.id)).filter(Number.isFinite)
      : undefined;

  const episodeRunTime = Array.isArray(raw.episode_run_time)
    ? raw.episode_run_time.map(Number).filter(Number.isFinite)
    : undefined;

  const originCountry = Array.isArray(raw.origin_country)
    ? raw.origin_country.filter((c): c is string => typeof c === "string")
    : undefined;

  const runtime = Number(raw.runtime);
  const numberOfSeasons = Number(raw.number_of_seasons);

  return {
    contentId: `${mediaType}:${Math.trunc(tmdbId)}`,
    mediaType,
    tmdbId: Math.trunc(tmdbId),
    ...(genreIds && genreIds.length > 0 ? { genreIds } : {}),
    ...(typeof raw.original_language === "string"
      ? { originalLanguage: raw.original_language }
      : {}),
    ...(originCountry && originCountry.length > 0 ? { originCountry } : {}),
    ...(Number.isFinite(runtime) && runtime > 0 ? { runtime } : {}),
    ...(episodeRunTime && episodeRunTime.length > 0 ? { episodeRunTime } : {}),
    ...(Number.isFinite(numberOfSeasons) && numberOfSeasons > 0
      ? { numberOfSeasons }
      : {}),
    ...(typeof raw.release_date === "string" ? { releaseDate: raw.release_date } : {}),
    ...(typeof raw.first_air_date === "string" ? { firstAirDate: raw.first_air_date } : {}),
  };
}

/**
 * P0-02: Tüm istekler ortak `apiFetch` üzerinden gider; böylece LAN modunda
 * `X-CineTrack-Token` başlığı eklenir ve 401/503'te token istemi açılır.
 * Durum kodu ve sunucu hata kodu `ApiError` ile korunur.
 */
async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await apiFetch(url, options);
  if (!res.ok) {
    const { message, code } = await readApiErrorMessage(res, `HTTP ${res.status}: ${url}`);
    throw new ApiError(message, res.status, code);
  }
  return res.json() as Promise<T>;
}

// === Profil & Kimliğim Genel Bakış ===

export interface MonthlyTasteSnapshotClient {
  month: string;
  eventCount: number;
  contentCount: number;
  topMetrics: Array<{ metricId: string; affinity: number }>;
}

export interface TasteDriftAlertClient {
  metricId: string;
  longTermAffinity: number;
  recentAffinity: number;
  delta: number;
}

export interface TasteOverviewClientResponse {
  unified: TasteProfile;
  movie: TasteProfile;
  series: TasteProfile;
  analyzedContentCount: number;
  movieAnalyzedCount: number;
  seriesAnalyzedCount: number;
  eventsCount: number;
  confidenceLevel: "high" | "medium" | "low";
  monthlySnapshots: MonthlyTasteSnapshotClient[];
  drifts: TasteDriftAlertClient[];
}

/** Taste profilini sunucudan çek */
export async function fetchTasteProfile(): Promise<TasteProfile> {
  return requestJson<TasteProfile>(`${BASE}/profile`);
}

/** Kimliğim genel bakış, Film vs Dizi karşılaştırması ve aylık evrim verilerini çek */
export async function fetchTasteOverview(): Promise<TasteOverviewClientResponse> {
  return requestJson<TasteOverviewClientResponse>(`${BASE}/overview`);
}

// === Metrik Detayı ===

export interface MetricDetailResponse {
  metric: TasteProfile["metrics"][string];
  explanation: MetricExplanation | null;
}

/** Metrik detayı + kanıt açıklamasını çek */
export async function fetchMetricDetail(
  metricId: string
): Promise<MetricDetailResponse> {
  return requestJson<MetricDetailResponse>(`${BASE}/metric/${encodeURIComponent(metricId)}`);
}

// === Kanıt ===

export interface EvidenceResponse {
  positiveContentIds: string[];
  negativeContentIds: string[];
  posMass: number;
  negMass: number;
  uncertainMass: number;
}

/** Metrik için kanıt listesini çek */
export async function fetchEvidence(
  metricId: string
): Promise<EvidenceResponse> {
  return requestJson<EvidenceResponse>(
    `${BASE}/evidence/${encodeURIComponent(metricId)}`
  );
}

// === Manifest ===

/** Taste manifest'ini çek */
export async function fetchTasteManifest(): Promise<TasteManifest> {
  return requestJson<TasteManifest>(`${BASE}/manifest`);
}

// === Manuel Kontrol (TP-028) ===

export interface OverrideRequest {
  metricId: string;
  value: number;           // -100...+100
  mode: ManualOverrideMode;
}

export interface OverrideResponse {
  success: boolean;
  metric: TasteProfile["metrics"][string];
}

/** Manuel metrik kontrolü uygula */
export async function postManualOverride(
  req: OverrideRequest
): Promise<OverrideResponse> {
  const res = await requestJson<OverrideResponse>(`${BASE}/override`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  notifyTasteProfileUpdated({ reason: "override_applied" });
  return res;
}

/** Manuel metrik kontrolünü geri al */
export async function deleteManualOverride(
  metricId: string
): Promise<OverrideResponse> {
  const res = await requestJson<OverrideResponse>(
    `${BASE}/override/${encodeURIComponent(metricId)}`,
    { method: "DELETE" }
  );
  notifyTasteProfileUpdated({ reason: "override_removed" });
  return res;
}

// === V1.5 İçerik Etiket İtirazı ("Bu film aslında X değil") ===

export interface FeatureObjectionResponse {
  success: boolean;
  contentId: string;
  metricId: string;
  generationId?: string;
}

export async function postFeatureObjection(
  contentId: string,
  metricId: string
): Promise<FeatureObjectionResponse> {
  const res = await requestJson<FeatureObjectionResponse>(`${BASE}/objection`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ contentId, metricId }),
  });
  notifyTasteProfileUpdated({
    generationId: res.generationId,
    reason: "feature_objection",
  });
  return res;
}

// === Olay & Canlı Yeniden Hesaplama ===

export interface PostEventResponse {
  success: boolean;
  eventId: string;
  generationId?: string;
}

/** Yeni taste olayı gönder + sunucu worker yeniden hesaplaması bitince dinleyicileri tetikle */
export async function postTasteEvent(
  event: TasteEvent,
  metadata?: TasteMetadataInput
): Promise<PostEventResponse> {
  const payload = metadata ? { event, metadata } : event;
  const res = await requestJson<PostEventResponse>(`${BASE}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  notifyTasteProfileUpdated({
    generationId: res.generationId,
    reason: event.eventType,
  });
  return res;
}

/** Arka plan profil yeniden hesaplamasını manuel tetikle */
export async function triggerTasteRebuild(): Promise<{
  success: boolean;
  generationId: string;
}> {
  const res = await requestJson<{ success: boolean; generationId: string }>(
    `${BASE}/rebuild`,
    { method: "POST" }
  );
  notifyTasteProfileUpdated({
    generationId: res.generationId,
    reason: "manual_rebuild",
  });
  return res;
}
