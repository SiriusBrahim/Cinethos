// ===========================================================================
// Cinethos Taste Engine — Taste Event Projector (v1.1)
// Olay → geçerli öğrenme durumu (TP-005)
//
// SINIR KURALI (TasteEventProjector ↔ TasteRebuildCoordinator — Faz 1B):
// - TasteEventProjector (core/taste): SAF, deterministik, yan-etkisiz alan
//   indirgeyicisidir. Yalnızca `TasteEvent[]` girdisini alır; içerik başına
//   son `LearningState` haritasını ve `eventWatermark`'ı üretir. Dosya G/Ç,
//   TMDB hidrasyonu, worker thread veya store yazımı ASLA YAPMAZ.
// - TasteRebuildCoordinator (server): Orkestratördür; store okumaları,
//   arka plan TMDB hidrasyonu, worker dispatch ve manifest/profil yazımı
//   yalnızca ona aittir.
// ===========================================================================

import type { TasteEvent } from "./types.ts";

export interface LearningState {
  contentId: string;
  currentRating?: number;
  currentStatus?: string;
  isHidden: boolean;
  isDisliked: boolean;       // content_disliked olayından (Faz 1 kapanış düzeltmesi)
  lastEventId: string;
  lastUpdatedAt: string;
}

export interface TasteProjectionSnapshot {
  states: Map<string, LearningState>;
  eventWatermark: string;
  eventCount: number;
}

function sortEventsChronologically(events: TasteEvent[]): TasteEvent[] {
  return [...events].sort((a, b) => {
    const ta = new Date(a.recordedAt).getTime();
    const tb = new Date(b.recordedAt).getTime();
    const safeA = Number.isFinite(ta) ? ta : 0;
    const safeB = Number.isFinite(tb) ? tb : 0;
    return safeA - safeB;
  });
}

/**
 * Olayları içerik başına geçerli öğrenme durumuna indirge (TP-005) + watermark üret.
 */
export function projectLearningSnapshot(events: TasteEvent[]): TasteProjectionSnapshot {
  const stateMap = new Map<string, LearningState>();
  const sortedEvents = sortEventsChronologically(events);
  let lastEventId = "";

  for (const event of sortedEvents) {
    const contentId = event.contentId;
    if (!contentId) continue;

    let state = stateMap.get(contentId);
    if (!state) {
      state = {
        contentId,
        isHidden: false,
        isDisliked: false,
        lastEventId: event.eventId,
        lastUpdatedAt: event.recordedAt,
      };
      stateMap.set(contentId, state);
    }

    if (event.eventType === "rating_changed") {
      state.currentRating = event.payload.newValue as number;
    } else if (event.eventType === "status_changed") {
      state.currentStatus = event.payload.newValue as string;
    } else if (event.eventType === "content_hidden") {
      state.isHidden = true;
    } else if (event.eventType === "content_disliked") {
      state.isDisliked = true;
    }

    state.lastEventId = event.eventId;
    state.lastUpdatedAt = event.recordedAt;
    lastEventId = event.eventId;
  }

  return {
    states: stateMap,
    eventWatermark: lastEventId,
    eventCount: sortedEvents.length,
  };
}

/**
 * Olayları içerik başına geçerli öğrenme durumuna indirge (TP-005)
 *
 * KRİTİK: Olay ≠ kanıt. Aynı içeriğin beş işlemi beş bağımsız kanıt değil.
 * Bu fonksiyon yalnızca her içerik için SON geçerli durumu döndürür;
 * kanıt ağırlıkları EvidenceLedger tarafından hesaplanır.
 */
export function projectEventsToLearningState(events: TasteEvent[]): Map<string, LearningState> {
  return projectLearningSnapshot(events).states;
}
